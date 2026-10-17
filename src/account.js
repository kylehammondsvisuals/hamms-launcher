// HAMMS Studios accounts — talks to Supabase Auth + a `profiles` table.
// Pure Node so it can be tested against a fake server (tools/test-accounts.js).
//
// Session handling:
//  • Sign in → Supabase returns an access token (1 hour) + refresh token (long-lived).
//  • We keep both in userData/session.bin, encrypted with Windows' own data protection
//    (Electron safeStorage), so a copied file is useless on another PC.
//  • On every launcher start we refresh the session; if that fails the player signs in again.

const fs = require('fs');
const http = require('http');
const https = require('https');

const USERNAME_RE = /^[A-Za-z0-9_]{3,16}$/;

class AccountError extends Error {
  constructor(message, code) { super(message); this.code = code; }
}

class Accounts {
  constructor({ url, anonKey, sessionFile, encrypt = (s) => Buffer.from(s), decrypt = (b) => b.toString() }) {
    this.url = (url || '').replace(/\/+$/, '');
    this.anonKey = anonKey || '';
    this.sessionFile = sessionFile;
    this.encrypt = encrypt;
    this.decrypt = decrypt;
    this.session = null; // { access_token, refresh_token, expires_at, user: { id, email }, username }
  }

  get configured() { return !!this.url && !!this.anonKey && !/YOUR_/.test(this.url + this.anonKey); }
  get signedIn() { return !!this.session?.access_token; }
  get profile() {
    if (!this.session) return null;
    return { id: this.session.user.id, email: this.session.user.email, username: this.session.username };
  }

  // ---------- HTTP ----------
  request(method, path, body, token) {
    const u = new URL(this.url + path);
    const lib = u.protocol === 'https:' ? https : http;
    const data = body ? JSON.stringify(body) : null;
    return new Promise((resolve, reject) => {
      const req = lib.request(u, {
        method,
        headers: {
          apikey: this.anonKey,
          // New-style publishable keys go in apikey only; a signed-in player's token goes in Authorization.
          ...(token ? { Authorization: `Bearer ${token}` } : {}),
          'Content-Type': 'application/json',
          Accept: 'application/json',
          ...(data ? { 'Content-Length': Buffer.byteLength(data) } : {}),
        },
      }, (res) => {
        let text = '';
        res.setEncoding('utf8');
        res.on('data', (c) => (text += c));
        res.on('end', () => {
          let json = null;
          try { json = text ? JSON.parse(text) : null; } catch { json = { raw: text }; }
          if (res.statusCode >= 400) {
            const msg = json?.msg || json?.error_description || json?.message || json?.error || `Server error ${res.statusCode}`;
            return reject(new AccountError(friendly(msg), json?.error_code || json?.code || res.statusCode));
          }
          resolve(json);
        });
      });
      req.setTimeout(20000, () => req.destroy(new AccountError('Could not reach HAMMS servers. Check your internet.', 'offline')));
      req.on('error', (e) => reject(e instanceof AccountError ? e : new AccountError('Could not reach HAMMS servers. Check your internet.', 'offline')));
      if (data) req.write(data);
      req.end();
    });
  }

  // ---------- session storage ----------
  load() {
    try {
      const raw = fs.readFileSync(this.sessionFile);
      this.session = JSON.parse(this.decrypt(raw));
    } catch { this.session = null; }
    return this.session;
  }
  save() {
    if (!this.session) { try { fs.rmSync(this.sessionFile, { force: true }); } catch {} return; }
    fs.writeFileSync(this.sessionFile, this.encrypt(JSON.stringify(this.session)));
  }
  adopt(res, username) {
    this.session = {
      access_token: res.access_token,
      refresh_token: res.refresh_token,
      expires_at: res.expires_at || Math.floor(Date.now() / 1000) + (res.expires_in || 3600),
      user: { id: res.user.id, email: res.user.email },
      username: username || res.user.user_metadata?.username || this.session?.username || null,
    };
    this.save();
  }

  // ---------- actions ----------
  static validateUsername(name) {
    if (!USERNAME_RE.test(name || '')) throw new AccountError('HAMMS names are 3–16 characters: letters, numbers and _ only.', 'bad_username');
  }

  async usernameAvailable(name) {
    Accounts.validateUsername(name);
    const r = await this.request('POST', '/rest/v1/rpc/username_available', { name });
    return r === true;
  }

  async signUp({ email, password, username }) {
    Accounts.validateUsername(username);
    if (!email || !/.+@.+\..+/.test(email)) throw new AccountError('Enter a valid email address.', 'bad_email');
    if (!password || password.length < 8) throw new AccountError('Passwords need at least 8 characters.', 'weak_password');
    if (!(await this.usernameAvailable(username))) throw new AccountError(`"${username}" is taken. Try another HAMMS name.`, 'username_taken');
    const res = await this.request('POST', '/auth/v1/signup', { email, password, data: { username } });
    // If email confirmation is on, Supabase returns the user but no session yet.
    if (!res.access_token) return { needsConfirmation: true };
    this.adopt(res, username);
    await this.loadProfile();
    return { ok: true, profile: this.profile };
  }

  async signIn({ email, password }) {
    if (!email || !password) throw new AccountError('Enter your email and password.', 'missing');
    const res = await this.request('POST', '/auth/v1/token?grant_type=password', { email, password });
    this.adopt(res);
    await this.loadProfile();
    return { ok: true, profile: this.profile };
  }

  // Called on launcher start: turns the saved refresh token into a fresh session.
  async resume() {
    if (!this.load()) return { ok: false };
    try {
      const res = await this.request('POST', '/auth/v1/token?grant_type=refresh_token', { refresh_token: this.session.refresh_token });
      this.adopt(res);
      await this.loadProfile().catch(() => {});
      return { ok: true, profile: this.profile };
    } catch (e) {
      // Offline: keep the saved identity so installed games still launch.
      if (e.code === 'offline' && this.session?.username) return { ok: true, offline: true, profile: this.profile };
      this.session = null; this.save();
      return { ok: false };
    }
  }

  async ensureFresh() {
    if (this.session && this.session.expires_at - 60 < Date.now() / 1000) await this.resume();
  }

  async loadProfile() {
    const rows = await this.request('GET', `/rest/v1/profiles?id=eq.${encodeURIComponent(this.session.user.id)}&select=username`, null, this.session.access_token);
    if (Array.isArray(rows) && rows[0]?.username) { this.session.username = rows[0].username; this.save(); }
    return this.profile;
  }

  async resetPassword(email) {
    if (!email) throw new AccountError('Enter your email first.', 'missing');
    await this.request('POST', '/auth/v1/recover', { email });
    return { ok: true };
  }

  async signOut() {
    const token = this.session?.access_token;
    this.session = null; this.save();
    if (token) await this.request('POST', '/auth/v1/logout', {}, token).catch(() => {});
    return { ok: true };
  }
}

function friendly(msg) {
  const m = String(msg);
  if (/invalid login credentials/i.test(m)) return 'Wrong email or password.';
  if (/already registered|already exists/i.test(m)) return 'That email already has a HAMMS account. Sign in instead.';
  if (/email not confirmed/i.test(m)) return 'Confirm your email first. Check your inbox for the link.';
  if (/rate limit/i.test(m)) return 'Too many tries. Wait a minute and try again.';
  if (/database error saving new user/i.test(m)) return 'That HAMMS name was just taken. Try another.';
  return m;
}

module.exports = { Accounts, AccountError, USERNAME_RE };
