// HAMMS Studios Launcher — main process
const { app, BrowserWindow, ipcMain, shell, dialog, safeStorage } = require('electron');
const path = require('path');
const fs = require('fs');
const os = require('os');
const { GameManager } = require('./src/gameManager');
const { Accounts } = require('./src/account');
const { issueTicket, parseProtocolUrl } = require('./src/handoff');

let autoUpdater = null;
try { autoUpdater = require('electron-updater').autoUpdater; } catch { /* dev without updater */ }

const config = JSON.parse(fs.readFileSync(path.join(__dirname, 'config.json'), 'utf8'));
const catalogUrl = process.env.HAMMS_CATALOG_URL || config.catalogUrl;
// The store snapshot shipped inside the app (catalog + art), used on first run / offline.
const bundledDir = app.isPackaged ? path.join(process.resourcesPath, 'store') : path.join(__dirname, 'store-bundle');

let win;
let gm;
let launcherUpdateReady = false;
let pcSpecs = null;
let accounts;
// A game opened directly asks for itself via hamms://launch/<id>; we hold it until sign-in + update check.
let pendingLaunch = parseProtocolUrl(process.argv);

function send(channel, payload) {
  if (win && !win.isDestroyed()) win.webContents.send(channel, payload);
}

// ---------- this PC's specs (for the Minimum / Recommended check) ----------
async function readPcSpecs() {
  const cpus = os.cpus();
  const specs = {
    os: `${os.type() === 'Windows_NT' ? 'Windows' : os.type()} ${os.release()}`,
    cpu: (cpus[0]?.model || 'Unknown CPU').replace(/\s+/g, ' ').trim(),
    cores: cpus.length,
    ramGB: Math.round((os.totalmem() / 1024 ** 3) * 10) / 10,
    gpu: 'Unknown graphics',
    dedicatedGPU: null,
    freeDiskGB: null,
  };
  try {
    const st = fs.statfsSync(app.getPath('userData'));
    specs.freeDiskGB = Math.round((st.bavail * st.bsize) / 1024 ** 3);
  } catch {}
  try {
    const info = await app.getGPUInfo('complete');
    const devices = info.gpuDevice || [];
    const renderer = info.auxAttributes?.glRenderer || '';
    // "ANGLE (NVIDIA, NVIDIA GeForce RTX 2060 Direct3D11 vs_5_0 ps_5_0, D3D11)" → "NVIDIA GeForce RTX 2060"
    const m = /ANGLE \(([^,]+),\s*([^,]+?)(?:\s+Direct3D.*?)?(?:\s*\(0x[0-9A-F]+\))?,/i.exec(renderer);
    if (m) specs.gpu = m[2].trim();
    else if (devices[0]?.deviceString) specs.gpu = devices[0].deviceString;
    const isDedicated = (vendorId, name) => {
      if (vendorId === 0x10de || /nvidia|geforce|quadro|rtx|gtx/i.test(name)) return true;
      if (/intel/i.test(name) || vendorId === 0x8086) return /\barc\b/i.test(name);
      if (vendorId === 0x1002 || /radeon|amd/i.test(name)) return !/radeon\(tm\) graphics|radeon graphics|vega \d+ graphics|vega graphics/i.test(name);
      return false;
    };
    specs.dedicatedGPU = devices.some((d) => isDedicated(d.vendorId, d.deviceString || '')) || isDedicated(-1, specs.gpu);
  } catch {}
  return specs;
}

function createWindow() {
  win = new BrowserWindow({
    width: 1360,
    height: 820,
    minWidth: 1040,
    minHeight: 640,
    backgroundColor: '#05070a',
    title: 'HAMMS Studios',
    icon: path.join(__dirname, 'build', 'icon.png'),
    autoHideMenuBar: true,
    show: false,
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
    },
  });
  win.once('ready-to-show', () => win.show());
  win.loadFile(path.join(__dirname, 'renderer', 'index.html'));
}

// ---------- desktop icons ----------
// Installing a game puts "<Game>.lnk" on the desktop. It opens the launcher straight to that game
// (hamms://launch/<id>), so players always go through sign-in + update check. Uninstall removes it.
function shortcutPath(id) {
  const game = gm.findGame(id);
  const safe = String(game.title || id).replace(/[\\/:*?"<>|]/g, '').trim() || id;
  return path.join(app.getPath('desktop'), `${safe}.lnk`);
}
function createGameShortcut(id) {
  if (process.platform !== 'win32') return;
  try {
    const inst = gm.getInstalled()[id];
    const exe = inst ? path.join(gm.gameFolder(id), inst.executable) : null;
    const args = app.isPackaged ? `hamms://launch/${id}` : `"${path.resolve(process.argv[1] || '.')}" hamms://launch/${id}`;
    const ok = shell.writeShortcutLink(shortcutPath(id), 'create', {
      target: process.execPath,
      args,
      cwd: path.dirname(process.execPath),
      icon: exe && fs.existsSync(exe) ? exe : process.execPath,
      iconIndex: 0,
      description: `Play ${gm.findGame(id).title} with HAMMS Studios`,
    });
    if (ok) gm.setInstalled(id, { ...gm.getInstalled()[id], shortcut: shortcutPath(id) });
  } catch {}
}
function removeGameShortcut(id, record) {
  for (const p of [record?.shortcut, (() => { try { return shortcutPath(id); } catch { return null; } })()]) {
    if (p && p.toLowerCase().endsWith('.lnk')) { try { fs.rmSync(p, { force: true }); } catch {} }
  }
}

// Install or update one game and stream progress to the UI.
async function runInstall(id, buildId) {
  try {
    const res = await gm.install(id, (p) => send('progress', { id, ...p }), buildId);
    if (res?.ok) createGameShortcut(id);
    send('library-changed');
    return res;
  } catch (err) {
    send('progress', { id, phase: 'error', message: err.message });
    send('library-changed');
    return { ok: false, error: err.message };
  }
}

// After the catalog loads: quietly update installed games if the setting is on.
async function autoUpdateGames() {
  if (!gm.getSettings().autoUpdate) return;
  for (const id of gm.pendingUpdates()) await runInstall(id);
}

function setupSelfUpdate() {
  if (!autoUpdater || !app.isPackaged) return;
  autoUpdater.autoDownload = true;
  autoUpdater.autoInstallOnAppQuit = true;
  autoUpdater.on('update-available', (i) => send('launcher-update', { state: 'downloading', version: i.version }));
  autoUpdater.on('download-progress', (p) => send('launcher-update', { state: 'downloading', percent: Math.round(p.percent) }));
  autoUpdater.on('update-downloaded', (i) => {
    launcherUpdateReady = true; // games stay locked until the restart
    send('launcher-update', { state: 'ready', version: i.version });
    send('library-changed');
  });
  autoUpdater.on('error', () => {}); // never block the launcher over a failed self-update
  autoUpdater.checkForUpdates().catch(() => {});
  setInterval(() => autoUpdater.checkForUpdates().catch(() => {}), 60 * 60 * 1000);
}

ipcMain.handle('get-library', async (_e, { refresh } = {}) => {
  let offline = false;
  if (refresh || !gm.catalog) offline = (await gm.refreshCatalog()).offline;
  return {
    studio: gm.catalog.studio || 'HAMMS Studios',
    games: gm.library(),
    settings: gm.getSettings(),
    pc: pcSpecs,
    launcherUpdateReady,
    offline: offline || !gm.online,
    storeConfigured: gm.catalogConfigured,
    launcherVersion: app.getVersion(),
  };
});

// ---------- accounts ----------
const authState = () => ({ configured: accounts.configured, signedIn: accounts.signedIn, profile: accounts.profile, pendingLaunch });
const wrap = (fn) => async (_e, arg) => { try { const r = await fn(arg); send('auth-changed', authState()); return { ok: true, ...r, state: authState() }; } catch (err) { return { ok: false, error: err.message, code: err.code }; } };
ipcMain.handle('auth-state', () => authState());
ipcMain.handle('auth-sign-in', wrap((a) => accounts.signIn(a)));
ipcMain.handle('auth-sign-up', wrap((a) => accounts.signUp(a)));
ipcMain.handle('auth-reset', wrap((a) => accounts.resetPassword(a.email)));
ipcMain.handle('auth-sign-out', wrap(() => accounts.signOut()));
ipcMain.handle('auth-name-free', async (_e, name) => { try { return { ok: true, free: await accounts.usernameAvailable(name) }; } catch (err) { return { ok: false, error: err.message }; } });
// The window asks for the pending game once the player is signed in; we clear it so it fires once.
ipcMain.handle('take-pending-launch', () => { const id = pendingLaunch; pendingLaunch = null; return id; });

ipcMain.handle('install', (_e, id, buildId) => runInstall(id, buildId));
ipcMain.handle('cancel', (_e, id) => { gm.cancel(id); return true; });
ipcMain.handle('set-build', (_e, id, buildId) => { gm.setBuildChoice(id, buildId); send('library-changed'); return true; });

ipcMain.handle('uninstall', async (_e, id) => {
  const game = gm.findGame(id);
  const { response } = await dialog.showMessageBox(win, {
    type: 'question', buttons: ['Uninstall', 'Cancel'], defaultId: 1, cancelId: 1,
    message: `Uninstall ${game.title}?`, detail: 'The game files will be removed from this PC.',
  });
  if (response !== 0) return { ok: false };
  const record = gm.getInstalled()[id];
  await gm.uninstall(id);
  removeGameShortcut(id, record);
  send('library-changed');
  return { ok: true };
});

ipcMain.handle('play', async (_e, id) => {
  if (!accounts.signedIn) return { ok: false, blocked: 'auth', error: 'Sign in to your HAMMS account to play.' };
  // Battle.net rule: always check for a new build the moment Play is pressed.
  await gm.refreshCatalog();
  const entry = gm.library().find((g) => g.id === id);
  if (!entry) return { ok: false, error: 'Game not found' };
  const game = gm.findGame(id);

  if (entry.status === 'coming-soon') return { ok: false, error: `${game.title} isn't out yet.` };
  if (launcherUpdateReady || entry.launcherTooOld) {
    send('library-changed');
    return { ok: false, blocked: 'launcher', error: 'Restart the launcher to finish updating before you play.' };
  }
  if (['update-available', 'not-installed', 'switch-build'].includes(entry.status)) {
    send('library-changed');
    runInstall(id); // start the required download right away
    return { ok: false, blocked: 'update', error: `Update required: downloading v${entry.version}.` };
  }

  if (game.type === 'web') {
    const w = new BrowserWindow({
      width: 1280, height: 760, backgroundColor: '#000', title: game.title,
      autoHideMenuBar: true, icon: path.join(__dirname, 'build', 'icon.png'),
    });
    w.loadURL(game.playUrl);
    return { ok: true };
  }
  try {
    if (entry.needsPrepare && game.prepare) {
      send('progress', { id, phase: 'prepare', label: game.prepare.label || 'Optimizing shaders' });
      send('library-changed');
      await gm.prepare(id);
      send('progress', { id, phase: 'done' });
    }
    await accounts.ensureFresh().catch(() => {});
    await gm.applySettingsGuard(id).catch(() => {});
    const { args } = issueTicket({ appData: app.getPath('appData'), gameId: id, profile: accounts.profile });
    gm.launch(id, () => send('library-changed'), args);
    send('library-changed');
    return { ok: true };
  } catch (err) {
    return { ok: false, error: err.message };
  }
});

ipcMain.handle('open-folder', (_e, id) => shell.openPath(gm.gameFolder(id)));
ipcMain.handle('open-link', (_e, url) => { if (/^https?:\/\//.test(url)) shell.openExternal(url); });
ipcMain.handle('save-settings', (_e, patch) => gm.saveSettings(patch));
ipcMain.handle('restart-to-update', () => {
  if (autoUpdater && launcherUpdateReady) autoUpdater.quitAndInstall();
  else { app.relaunch(); app.exit(0); }
});
ipcMain.handle('check-updates', async () => {
  await gm.refreshCatalog();
  send('library-changed');
  autoUpdateGames();
  if (autoUpdater && app.isPackaged) autoUpdater.checkForUpdates().catch(() => {});
  return true;
});

// Only one launcher open at a time.
if (!app.requestSingleInstanceLock()) {
  app.quit();
} else {
  app.on('second-instance', (_e, argv) => {
    const id = parseProtocolUrl(argv);
    if (id) { pendingLaunch = id; send('launch-request', id); }
    if (win) { if (win.isMinimized()) win.restore(); win.focus(); }
  });

  // Games open the launcher through hamms://launch/<gameId>
  if (process.defaultApp && process.argv.length >= 2) app.setAsDefaultProtocolClient('hamms', process.execPath, [path.resolve(process.argv[1])]);
  else app.setAsDefaultProtocolClient('hamms');

  app.whenReady().then(async () => {
    pcSpecs = await readPcSpecs();
    const acc = config.accounts || {};
    accounts = new Accounts({
      url: process.env.HAMMS_AUTH_URL || acc.supabaseUrl,
      anonKey: process.env.HAMMS_AUTH_KEY || acc.supabaseAnonKey,
      sessionFile: path.join(app.getPath('userData'), 'session.bin'),
      encrypt: (s) => (safeStorage.isEncryptionAvailable() ? safeStorage.encryptString(s) : Buffer.from(s)),
      decrypt: (b) => (safeStorage.isEncryptionAvailable() ? safeStorage.decryptString(b) : b.toString()),
    });
    await accounts.resume().catch(() => {});
    gm = new GameManager({
      dataDir: app.getPath('userData'),
      catalogUrl,
      bundledDir,
      launcherVersion: app.getVersion(),
      localAppData: process.env.LOCALAPPDATA || null,
      appData: process.env.APPDATA || null,
      pcSpecs,
    });
    await gm.refreshCatalog();
    createWindow();
    setupSelfUpdate();
    send('library-changed');
    autoUpdateGames();
    // Re-check the store every 15 minutes while the launcher is open.
    setInterval(async () => { await gm.refreshCatalog(); send('library-changed'); autoUpdateGames(); }, 15 * 60 * 1000);
  });

  app.on('window-all-closed', () => app.quit());
}
