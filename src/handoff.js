// Launcher → game handoff.
//
// When the launcher starts a game it:
//   1. writes a one-time ticket to  %APPDATA%\HAMMS Studios\launch\<gameId>.json
//   2. starts the game with:  -- --hamms-launch=<ticket> --hamms-user=<HAMMS name> --hamms-uid=<account id>
// The game (HAMMS kit) checks the ticket matches the file and is fresh, then deletes it.
// No ticket = the game was opened directly, so it opens the launcher instead (hamms://launch/<gameId>).

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const TICKET_SECONDS = 120;

function launchDir(appData) {
  return path.join(appData, 'HAMMS Studios', 'launch');
}

function issueTicket({ appData, gameId, profile }) {
  const dir = launchDir(appData);
  fs.mkdirSync(dir, { recursive: true });
  const ticket = crypto.randomBytes(24).toString('hex');
  const now = Math.floor(Date.now() / 1000);
  const record = { ticket, game: gameId, username: profile.username, uid: profile.id, issued: now, expires: now + TICKET_SECONDS };
  fs.writeFileSync(path.join(dir, `${gameId}.json`), JSON.stringify(record));
  // Godot reads user args after "--"; other engines just see them as normal args.
  const args = ['--', `--hamms-launch=${ticket}`, `--hamms-user=${profile.username}`, `--hamms-uid=${profile.id}`];
  return { ticket, args, record };
}

// hamms://launch/sweetfang  →  'sweetfang'
function parseProtocolUrl(argv) {
  for (const a of argv || []) {
    const m = /^hamms:\/\/(?:launch|play|game)\/([a-z0-9-]+)\/?/i.exec(String(a));
    if (m) return m[1].toLowerCase();
  }
  return null;
}

module.exports = { issueTicket, parseProtocolUrl, launchDir, TICKET_SECONDS };
