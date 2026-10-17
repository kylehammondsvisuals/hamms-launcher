// HAMMS Studios Launcher — game manager
// Pure Node (no Electron imports) so it can be tested on its own.
//
// How it works:
//  1. Fetch catalog.json from the HAMMS store (GitHub). If offline, use the last
//     copy, or the copy bundled inside the launcher on first run.
//  2. Each game can have two builds: "standard" (High) and "lite" (Low Spec).
//     The launcher recommends one from this PC's specs; players can switch.
//  3. Install/update = download zip -> check SHA-256 -> unzip to a staging
//     folder -> swap it in. The old version is only removed after the new
//     one is fully in place, so a failed update never breaks a game.

const fs = require('fs');
const fsp = fs.promises;
const path = require('path');
const crypto = require('crypto');
const http = require('http');
const https = require('https');
const { spawn } = require('child_process');
const extract = require('extract-zip');

class GameManager {
  constructor({ dataDir, catalogUrl, bundledDir = null, launcherVersion = '0.0.0', localAppData = null, appData = null, pcSpecs = null }) {
    this.launcherVersion = launcherVersion;
    this.localAppData = localAppData;
    this.appData = appData;
    this.dataDir = dataDir;
    this.gamesDir = path.join(dataDir, 'games');
    this.tmpDir = path.join(dataDir, 'downloads');
    this.stateFile = path.join(dataDir, 'installed.json');
    this.settingsFile = path.join(dataDir, 'settings.json');
    this.catalogCache = path.join(dataDir, 'catalog-cache.json');
    this.catalogUrl = catalogUrl;
    this.bundledDir = bundledDir; // folder with catalog.json + games/ media shipped in the app
    this.catalog = null;
    this.mediaBase = '';
    this.pcSpecs = pcSpecs;
    this.uid = null; // signed-in HAMMS account: each account has its own library
    this.busy = new Map(); // gameId -> AbortController
    this.running = new Map(); // gameId -> child process
    fs.mkdirSync(this.gamesDir, { recursive: true });
    fs.mkdirSync(this.tmpDir, { recursive: true });
  }

  // ---------- state ----------
  readJson(file, fallback) {
    try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch { return fallback; }
  }
  writeJson(file, data) {
    const tmp = file + '.tmp';
    fs.writeFileSync(tmp, JSON.stringify(data, null, 2));
    fs.renameSync(tmp, file);
  }
  getInstalled() { return this.readJson(this.stateFile, {}); }

  // ---------- accounts ----------
  // Game files are shared by everyone on this PC, but each game remembers which HAMMS
  // accounts added it ("owners"). A game shows as yours only if your account is one of them.
  setUser(uid) {
    this.uid = uid || null;
    if (!this.uid) return;
    // Installs from before accounts had their own library go to the first account that signs in.
    const s = this.getInstalled();
    let changed = false;
    for (const rec of Object.values(s)) {
      if (!Array.isArray(rec.owners)) { rec.owners = [this.uid]; changed = true; }
    }
    if (changed) this.writeJson(this.stateFile, s);
  }
  isMine(rec) {
    if (!rec) return false;
    if (!Array.isArray(rec.owners)) return true;
    return !!this.uid && rec.owners.includes(this.uid);
  }
  ownersWith(rec) {
    const owners = new Set(Array.isArray(rec?.owners) ? rec.owners : []);
    if (this.uid) owners.add(this.uid);
    return [...owners];
  }
  setInstalled(id, info) {
    const s = this.getInstalled();
    if (info) s[id] = info; else delete s[id];
    this.writeJson(this.stateFile, s);
  }
  getSettings() {
    return { autoUpdate: true, buildChoice: {}, ...this.readJson(this.settingsFile, {}) };
  }
  saveSettings(patch) {
    const s = { ...this.getSettings(), ...patch };
    this.writeJson(this.settingsFile, s);
    return s;
  }
  setBuildChoice(id, buildId) {
    const s = this.getSettings();
    s.buildChoice = { ...(s.buildChoice || {}), [id]: buildId };
    return this.saveSettings(s);
  }

  // ---------- catalog ----------
  get catalogConfigured() { return !!this.catalogUrl && !/YOUR_GITHUB_NAME/.test(this.catalogUrl); }

  async refreshCatalog() {
    if (this.catalogConfigured) {
      try {
        const sep = this.catalogUrl.includes('?') ? '&' : '?';
        const text = await fetchText(this.catalogUrl + sep + 't=' + Date.now());
        const cat = JSON.parse(text);
        if (!Array.isArray(cat.games)) throw new Error('catalog has no games list');
        this.catalog = normalizeCatalog(cat);
        this.mediaBase = this.catalogUrl.replace(/[^/]*$/, '');
        this.writeJson(this.catalogCache, { catalog: cat, mediaBase: this.mediaBase });
        this.online = true;
        return { offline: false, source: 'online' };
      } catch (err) {
        this.lastError = err.message;
      }
    }
    // Offline (or store not set up yet): last good copy, then the copy shipped inside the app.
    this.online = false;
    const cached = this.readJson(this.catalogCache, null);
    const bundled = this.bundledDir ? this.readJson(path.join(this.bundledDir, 'catalog.json'), null) : null;
    if (cached?.catalog && (!bundled || (cached.catalog.generatedAt || '') >= (bundled.generatedAt || ''))) {
      this.catalog = normalizeCatalog(cached.catalog);
      // offline: prefer art shipped in the app when it exists, so the store still looks right
      this.mediaBase = cached.mediaBase;
    } else if (bundled) {
      this.catalog = normalizeCatalog(bundled);
      this.mediaBase = '';
    } else {
      this.catalog = { studio: 'HAMMS Studios', games: [] };
    }
    return { offline: this.catalogConfigured, source: cached ? 'cache' : 'bundled' };
  }

  // Turn "games/sweetfang/cover.jpg" into a URL the window can load.
  mediaUrl(p) {
    if (!p) return '';
    if (/^(https?:|file:|data:)/.test(p)) return p;
    // Online: always use the store's copy, so art you replace on GitHub shows up for everyone.
    if (this.online && this.mediaBase) return this.mediaBase + p;
    // Offline or first run: use the art shipped inside the launcher.
    if (this.bundledDir) {
      const local = path.join(this.bundledDir, p);
      if (fs.existsSync(local)) return 'file:///' + local.replace(/\\/g, '/').replace(/^\/+/, '');
    }
    return this.mediaBase ? this.mediaBase + p : '';
  }

  // ---------- PC check ----------
  // Returns 'great' (meets recommended), 'ok' (meets minimum), 'low' (below minimum) or 'unknown'.
  rate(game) {
    const pc = this.pcSpecs;
    const req = game.requirements;
    if (!pc || !req) return { rating: 'unknown', details: [] };
    const meets = (level) => {
      const c = req[level]?.check;
      if (!c) return { ok: true, fails: [] };
      const fails = [];
      if (c.ramGB && pc.ramGB + 0.6 < c.ramGB) fails.push('ram');
      if (c.cores && pc.cores < c.cores) fails.push('cpu');
      if (c.dedicatedGPU && !pc.dedicatedGPU) fails.push('gpu');
      return { ok: fails.length === 0, fails };
    };
    const rec = meets('recommended'), min = meets('minimum');
    const rating = rec.ok ? 'great' : min.ok ? 'ok' : 'low';
    return { rating, fails: rating === 'great' ? [] : rating === 'ok' ? rec.fails : min.fails };
  }

  recommendedBuild(game) {
    const b = game.builds || {};
    if (!b.lite) return 'standard';
    if (!b.standard) return 'lite';
    return this.rate(game).rating === 'low' ? 'lite' : 'standard';
  }

  selectedBuild(game, inst) {
    const choice = this.getSettings().buildChoice?.[game.id];
    const b = game.builds || {};
    if (choice && b[choice]) return choice;
    if (inst?.build && b[inst.build]) return inst.build;
    return this.recommendedBuild(game);
  }

  // Merge catalog + installed state into what the UI shows.
  library() {
    const installed = this.getInstalled();
    return (this.catalog?.games || []).map((g) => {
      const rec = installed[g.id];
      const inst = this.isMine(rec) ? rec : null; // someone else's install isn't in your library
      const onDevice = !!rec && !inst;
      const buildId = this.selectedBuild(g, inst);
      const build = g.builds?.[buildId] || null;
      let status = 'not-installed';
      if (g.type === 'web') status = g.playUrl ? 'web' : 'coming-soon';
      else if (!build && !inst) status = 'coming-soon';
      else if (inst && build && inst.build !== buildId) status = 'switch-build';
      else if (inst && build) status = compareVersions(build.version, inst.version) > 0 ? 'update-available' : 'installed';
      else if (inst) status = 'installed';
      // Battle.net style: a game build can demand a newer launcher.
      const launcherTooOld = !!g.minLauncherVersion && compareVersions(g.minLauncherVersion, this.launcherVersion) > 0;
      if (this.busy.has(g.id)) status = 'working';
      if (this.running.has(g.id)) status = 'running';
      const m = g.media || {};
      return {
        ...g,
        media: {
          cover: this.mediaUrl(m.cover), banner: this.mediaUrl(m.banner), hero: this.mediaUrl(m.hero || m.banner), logo: this.mediaUrl(m.logo),
          screenshots: (m.screenshots || []).map((s) => this.mediaUrl(s)),
          trailer: this.mediaUrl(m.trailer), trailerPoster: this.mediaUrl(m.trailerPoster), logoInBanner: !!m.logoInBanner,
        },
        selectedBuild: buildId,
        recommendedBuild: this.recommendedBuild(g),
        build,
        version: build?.version || g.version || null,
        size: build?.size || 0,
        patchNotes: build?.patchNotes || [],
        installedVersion: inst?.version || null,
        installedBuild: inst?.build || null,
        onDevice, // the files are on this PC (another account installed it): adding it is instant
        deviceVersion: rec?.version || null,
        needsPrepare: !!inst?.needsPrepare,
        pcCheck: this.rate(g),
        launcherTooOld,
        status,
      };
    });
  }

  findGame(id) {
    const g = (this.catalog?.games || []).find((x) => x.id === id);
    if (!g) throw new Error(`Unknown game: ${id}`);
    return g;
  }

  // ---------- install / update ----------
  async install(id, onProgress = () => {}, buildId = null) {
    const game = this.findGame(id);
    if (game.type === 'web') throw new Error('Web games do not need installing');
    if (this.busy.has(id)) throw new Error('Already downloading');
    if (this.running.has(id)) throw new Error('Close the game before updating it');
    const existing = this.getInstalled()[id];
    buildId = buildId || this.selectedBuild(game, existing);
    const build = game.builds?.[buildId];
    if (!build) throw new Error(`${game.title} doesn't have a ${buildId === 'lite' ? 'Low Spec' : 'High'} build yet`);

    // Already on this PC from another account, same build and up to date: just add it to this library.
    if (existing && !this.isMine(existing) && existing.build === buildId && compareVersions(build.version, existing.version) <= 0
        && fs.existsSync(path.join(this.gameFolder(id), existing.executable || ''))) {
      this.setInstalled(id, { ...existing, owners: this.ownersWith(existing) });
      onProgress({ phase: 'done', percent: 100 });
      return { ok: true, version: existing.version, build: buildId, added: true };
    }

    const ac = new AbortController();
    this.busy.set(id, ac);
    const zipPath = path.join(this.tmpDir, `${id}-${buildId}-${build.version}.zip`);
    const stageDir = path.join(this.gamesDir, `.${id}-staging`);
    const finalDir = path.join(this.gamesDir, id);
    const oldDir = path.join(this.gamesDir, `.${id}-old`);

    try {
      onProgress({ phase: 'download', percent: 0, total: build.size || 0 });
      const hash = await downloadFile(build.downloadUrl, zipPath, ac.signal, (done, total) => {
        total = total || build.size || 0;
        onProgress({ phase: 'download', percent: total ? Math.min(100, Math.round((done / total) * 100)) : null, done, total });
      });

      if (build.sha256 && hash.toLowerCase() !== build.sha256.toLowerCase()) {
        throw new Error('Download was corrupted (checksum mismatch). Try again.');
      }

      onProgress({ phase: 'extract', percent: null });
      await fsp.rm(stageDir, { recursive: true, force: true });
      // Builds can be a .zip of the export folder, or a single .exe (Godot with the .pck embedded).
      if (fileKind(zipPath) === 'exe') {
        await fsp.mkdir(stageDir, { recursive: true });
        const exeName = path.basename(build.executable || game.executable || `${id}.exe`);
        await fsp.copyFile(zipPath, path.join(stageDir, exeName));
      } else {
        await extract(zipPath, { dir: stageDir });
      }

      let exeRel = build.executable || game.executable;
      if (!exeRel || !fs.existsSync(path.join(stageDir, exeRel))) {
        // Zips made by right-click → "Send to → Compressed folder" often have one extra folder level.
        const found = findExe(stageDir, exeRel);
        if (!found) throw new Error(`Couldn't find the game's .exe inside the download`);
        exeRel = path.relative(stageDir, found);
      }

      // Swap: current -> old, staging -> current, then delete old.
      await fsp.rm(oldDir, { recursive: true, force: true });
      if (fs.existsSync(finalDir)) await fsp.rename(finalDir, oldDir);
      await fsp.rename(stageDir, finalDir);
      await fsp.rm(oldDir, { recursive: true, force: true });

      // New build = old shaders are stale. Wipe the caches listed in the catalog
      // so the game rebuilds them (this is the "shaders re-upload" step).
      await this.clearShaderCaches(game);

      const prev = this.getInstalled()[id];
      this.setInstalled(id, {
        version: build.version,
        build: buildId,
        installedAt: new Date().toISOString(),
        executable: exeRel,
        needsPrepare: !!game.prepare, // run the shader step on next Play
        owners: this.ownersWith(prev),
        ...(prev?.shortcut ? { shortcut: prev.shortcut } : {}),
      });
      onProgress({ phase: 'done', percent: 100 });
      return { ok: true, version: build.version, build: buildId };
    } catch (err) {
      await fsp.rm(stageDir, { recursive: true, force: true }).catch(() => {});
      // If a swap was interrupted, put the old version back.
      if (!fs.existsSync(finalDir) && fs.existsSync(oldDir)) await fsp.rename(oldDir, finalDir).catch(() => {});
      if (ac.signal.aborted) return { ok: false, cancelled: true };
      throw err;
    } finally {
      await fsp.rm(zipPath, { force: true }).catch(() => {});
      this.busy.delete(id);
    }
  }

  cancel(id) {
    const ac = this.busy.get(id);
    if (ac) ac.abort();
  }

  // fromDevice: delete the files for everyone on this PC. Otherwise only take the game out of
  // this account's library, and delete the files once no account has it any more.
  // Returns { removedFiles } so the caller knows whether to remove the desktop icon.
  async uninstall(id, { fromDevice = false } = {}) {
    if (this.running.has(id)) throw new Error('Close the game first');
    const rec = this.getInstalled()[id];
    const others = (Array.isArray(rec?.owners) ? rec.owners : []).filter((o) => o !== this.uid);
    if (!fromDevice && rec && others.length) {
      this.setInstalled(id, { ...rec, owners: others });
      return { removedFiles: false };
    }
    await fsp.rm(path.join(this.gamesDir, id), { recursive: true, force: true });
    this.setInstalled(id, null);
    return { removedFiles: true };
  }

  // Everything installed on this PC, for the "Games on this PC" page.
  async deviceGames() {
    const installed = this.getInstalled();
    const out = [];
    for (const [id, rec] of Object.entries(installed)) {
      const g = (this.catalog?.games || []).find((x) => x.id === id);
      const owners = Array.isArray(rec.owners) ? rec.owners : [];
      out.push({
        id,
        title: g?.title || id,
        banner: g ? this.mediaUrl(g.media?.banner) : '',
        version: rec.version,
        build: rec.build,
        installedAt: rec.installedAt,
        sizeBytes: await dirSize(this.gameFolder(id)),
        mine: this.isMine(rec),
        otherAccounts: owners.filter((o) => o !== this.uid).length,
        running: this.running.has(id),
        busy: this.busy.has(id),
      });
    }
    let freeBytes = null;
    try { const st = fs.statfsSync(this.gamesDir); freeBytes = st.bavail * st.bsize; } catch {}
    return { games: out.sort((a, b) => a.title.localeCompare(b.title)), freeBytes, folder: this.gamesDir };
  }

  // Installed games whose version is older than the store's.
  pendingUpdates() {
    return this.library().filter((g) => g.status === 'update-available').map((g) => g.id);
  }

  // Folders to wipe after an update. Paths may use {game} (the game's install
  // folder), {appdata} (Roaming) or {localappdata} (Local).
  resolveCachePath(p, id) {
    const tokens = { '{game}': this.gameFolder(id), '{localappdata}': this.localAppData, '{appdata}': this.appData };
    let out = p;
    for (const [tok, val] of Object.entries(tokens)) {
      if (out.includes(tok)) { if (!val) return null; out = out.split(tok).join(val); }
    }
    // Safety: only ever delete inside the game folder or the user's app data folders.
    const resolved = path.resolve(out);
    const roots = Object.values(tokens).filter(Boolean).map((r) => path.resolve(r) + path.sep);
    return roots.some((r) => resolved.startsWith(r)) ? resolved : null;
  }

  async clearShaderCaches(game) {
    for (const p of game.shaderCacheDirs || []) {
      const dir = this.resolveCachePath(p, game.id);
      if (dir) await fsp.rm(dir, { recursive: true, force: true }).catch(() => {});
    }
  }

  // First launch after an update: run the game once with its "prepare" args
  // (e.g. --compile-shaders) and wait for it to exit, like CoD's shader step.
  prepare(id) {
    const inst = this.getInstalled()[id];
    const game = this.findGame(id);
    if (!inst?.needsPrepare || !game.prepare) return Promise.resolve({ skipped: true });
    const exe = path.join(this.gameFolder(id), inst.executable);
    return new Promise((resolve) => {
      const child = spawn(exe, game.prepare.args || [], { cwd: path.dirname(exe), stdio: 'ignore', windowsHide: true });
      this.running.set(id, child);
      const finish = (ok) => {
        this.running.delete(id);
        this.setInstalled(id, { ...this.getInstalled()[id], needsPrepare: false });
        resolve({ ok });
      };
      child.on('exit', (code) => finish(code === 0));
      child.on('error', () => finish(false)); // never lock the player out over this step
    });
  }

  // ---------- play ----------
  launch(id, onExit = () => {}, extraArgs = []) {
    const inst = this.getInstalled()[id];
    if (!inst || !this.isMine(inst)) throw new Error('Game is not installed');
    const game = this.findGame(id);
    const dir = this.gameFolder(id);
    const exe = path.join(dir, inst.executable);
    if (!fs.existsSync(exe)) throw new Error('Game files are missing. Try Repair.');
    const buildArgs = game.builds?.[inst.build]?.launchArgs || game.launchArgs || [];
    const child = spawn(exe, [...buildArgs, ...extraArgs], { cwd: path.dirname(exe), detached: true, stdio: 'ignore' });
    this.running.set(id, child);
    child.on('exit', () => { this.running.delete(id); onExit(); });
    child.on('error', (e) => { this.running.delete(id); onExit(e); });
    child.unref();
    return { ok: true };
  }

  gameFolder(id) { return path.join(this.gamesDir, id); }

  // ---------- settings guard ----------
  // A game can ask the launcher to keep some of its own settings fixed before every launch,
  // e.g. Brick Workshop: "only the studio desktop may be the Brick Net server".
  // game.json:
  //   "settingsGuard": [{ "dir": "{appdata}/Godot/app_userdata/Brick Workshop",
  //     "files": "^brick_workshop_.*\\.json$", "create": "brick_workshop_default.json",
  //     "set": { "settings.server_host": false }, "exceptHosts": ["DESKTOP-3373MN4"],
  //     "home": { "publicIp": "24.166.115.216", "set": { "settings.server_address": "192.168.1.196" },
  //               "away": { "settings.server_address": "" } } }]
  async applySettingsGuard(id, { hostname = require('os').hostname(), publicIp = null } = {}) {
    const game = this.findGame(id);
    const rules = (game && game.settingsGuard) || [];
    const done = [];
    for (const r of rules) {
      try {
        if ((r.exceptHosts || []).some((h) => String(h).toLowerCase() === String(hostname).toLowerCase())) continue;
        const dir = this.resolveCachePath(r.dir || '', id);
        if (!dir) continue;
        const re = new RegExp(r.files || '^$');
        let files = fs.existsSync(dir) ? fs.readdirSync(dir).filter((f) => re.test(f)) : [];
        if (!files.length && r.create) { fs.mkdirSync(dir, { recursive: true }); files = [r.create]; }
        let set = { ...(r.set || {}) };
        if (r.home && r.home.publicIp) {
          let ip = publicIp;
          if (ip == null) ip = await this.publicIp().catch(() => '');
          if (ip) Object.assign(set, ip === r.home.publicIp ? (r.home.set || {}) : (r.home.away || {}));
        }
        for (const f of files) {
          const fp = path.join(dir, f);
          let data = {};
          if (fs.existsSync(fp)) {
            try { data = JSON.parse(fs.readFileSync(fp, 'utf8')); } catch { continue; } // never clobber a file we can't read
          }
          let changed = !fs.existsSync(fp);
          for (const [key, val] of Object.entries(set)) {
            const parts = key.split('.');
            let o = data;
            for (const k of parts.slice(0, -1)) { if (typeof o[k] !== 'object' || o[k] === null) o[k] = {}; o = o[k]; }
            const last = parts[parts.length - 1];
            if (JSON.stringify(o[last]) !== JSON.stringify(val)) { o[last] = val; changed = true; }
          }
          if (changed) { fs.writeFileSync(fp, JSON.stringify(data, null, '\t')); done.push(fp); }
        }
      } catch { /* a guard must never stop the game from launching */ }
    }
    return done;
  }

  publicIp() {
    return new Promise((resolve, reject) => {
      const req = https.get('https://api.ipify.org', { timeout: 4000 }, (res) => {
        let b = ''; res.on('data', (d) => (b += d)); res.on('end', () => resolve(/^[\d.]+$/.test(b.trim()) ? b.trim() : ''));
      });
      req.on('timeout', () => req.destroy(new Error('timeout')));
      req.on('error', reject);
    });
  }
}

// ---------- helpers ----------
async function dirSize(dir) {
  let total = 0;
  let entries = [];
  try { entries = await fsp.readdir(dir, { withFileTypes: true }); } catch { return 0; }
  for (const e of entries) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) total += await dirSize(p);
    else if (e.isFile()) { try { total += (await fsp.stat(p)).size; } catch {} }
  }
  return total;
}

// Older catalogs had download fields on the game itself; treat those as the "standard" build.
function normalizeCatalog(cat) {
  for (const g of cat.games || []) {
    if (!g.builds) g.builds = {};
    if (g.downloadUrl && !g.builds.standard) {
      g.builds.standard = { label: 'High', version: g.version, downloadUrl: g.downloadUrl, sha256: g.sha256, size: g.size, executable: g.executable, patchNotes: g.patchNotes || [] };
    }
    if (!g.media) g.media = { cover: g.cover, banner: g.banner, screenshots: [] };
  }
  return cat;
}

// 'zip' (PK..), 'exe' (MZ..) or 'unknown', from the first bytes of the file.
function fileKind(file) {
  const fd = fs.openSync(file, 'r');
  const b = Buffer.alloc(2);
  try { fs.readSync(fd, b, 0, 2, 0); } finally { fs.closeSync(fd); }
  if (b[0] === 0x50 && b[1] === 0x4b) return 'zip';
  if (b[0] === 0x4d && b[1] === 0x5a) return 'exe';
  return 'unknown';
}

function findExe(dir, preferred, depth = 0) {
  if (depth > 3) return null;
  let entries = [];
  try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { return null; }
  const exes = entries.filter((e) => e.isFile() && e.name.toLowerCase().endsWith('.exe') && !/crash|unins|redist|setup|vc_?redist|ue4prereq|dxsetup/i.test(e.name));
  const pick = preferred ? exes.find((e) => e.name.toLowerCase() === path.basename(preferred).toLowerCase()) : null;
  if (pick) return path.join(dir, pick.name);
  if (exes.length === 1) return path.join(dir, exes[0].name);
  for (const e of entries.filter((x) => x.isDirectory() && !x.name.startsWith('.'))) {
    const f = findExe(path.join(dir, e.name), preferred, depth + 1);
    if (f) return f;
  }
  return exes[0] ? path.join(dir, exes[0].name) : null;
}

function compareVersions(a, b) {
  const pa = String(a).replace(/^v/, '').split(/[.\-+]/).map((x) => parseInt(x, 10) || 0);
  const pb = String(b).replace(/^v/, '').split(/[.\-+]/).map((x) => parseInt(x, 10) || 0);
  for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
    const d = (pa[i] || 0) - (pb[i] || 0);
    if (d) return d > 0 ? 1 : -1;
  }
  return 0;
}

function get(url, signal, redirects = 0) {
  return new Promise((resolve, reject) => {
    if (redirects > 8) return reject(new Error('Too many redirects'));
    const lib = url.startsWith('https') ? https : http;
    const req = lib.get(url, { signal, headers: { 'User-Agent': 'HAMMS-Launcher' } }, (res) => {
      if ([301, 302, 303, 307, 308].includes(res.statusCode) && res.headers.location) {
        res.resume();
        return resolve(get(new URL(res.headers.location, url).toString(), signal, redirects + 1));
      }
      if (res.statusCode !== 200) {
        res.resume();
        return reject(new Error(`Server returned ${res.statusCode}`));
      }
      resolve(res);
    });
    req.setTimeout(30000, () => req.destroy(new Error('Connection timed out')));
    req.on('error', reject);
  });
}

async function fetchText(url) {
  const res = await get(url);
  let body = '';
  res.setEncoding('utf8');
  for await (const chunk of res) body += chunk;
  return body;
}

async function downloadFile(url, dest, signal, onProgress) {
  const res = await get(url, signal);
  const total = parseInt(res.headers['content-length'] || '0', 10);
  const hash = crypto.createHash('sha256');
  const out = fs.createWriteStream(dest);
  let done = 0, lastTick = 0;
  try {
    for await (const chunk of res) {
      hash.update(chunk);
      done += chunk.length;
      if (!out.write(chunk)) await new Promise((r) => out.once('drain', r));
      const now = Date.now();
      if (now - lastTick > 150) { lastTick = now; onProgress(done, total); }
    }
  } finally {
    await new Promise((r) => out.end(r));
  }
  if (signal?.aborted) throw new Error('cancelled');
  onProgress(done, total);
  return hash.digest('hex');
}

module.exports = { GameManager, compareVersions, normalizeCatalog };
