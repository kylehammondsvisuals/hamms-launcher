const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('hamms', {
  getLibrary: (refresh) => ipcRenderer.invoke('get-library', { refresh }),
  install: (id, build) => ipcRenderer.invoke('install', id, build),
  setBuild: (id, build) => ipcRenderer.invoke('set-build', id, build),
  cancel: (id) => ipcRenderer.invoke('cancel', id),
  uninstall: (id) => ipcRenderer.invoke('uninstall', id),
  play: (id) => ipcRenderer.invoke('play', id),
  openFolder: (id) => ipcRenderer.invoke('open-folder', id),
  openLink: (url) => ipcRenderer.invoke('open-link', url),
  saveSettings: (patch) => ipcRenderer.invoke('save-settings', patch),
  checkUpdates: () => ipcRenderer.invoke('check-updates'),
  restartToUpdate: () => ipcRenderer.invoke('restart-to-update'),
  auth: {
    state: () => ipcRenderer.invoke('auth-state'),
    signIn: (a) => ipcRenderer.invoke('auth-sign-in', a),
    signUp: (a) => ipcRenderer.invoke('auth-sign-up', a),
    reset: (a) => ipcRenderer.invoke('auth-reset', a),
    signOut: () => ipcRenderer.invoke('auth-sign-out'),
    nameFree: (n) => ipcRenderer.invoke('auth-name-free', n),
    onChange: (fn) => ipcRenderer.on('auth-changed', (_e, s) => fn(s)),
  },
  takePendingLaunch: () => ipcRenderer.invoke('take-pending-launch'),
  onLaunchRequest: (fn) => ipcRenderer.on('launch-request', (_e, id) => fn(id)),
  onProgress: (fn) => ipcRenderer.on('progress', (_e, p) => fn(p)),
  onLibraryChanged: (fn) => ipcRenderer.on('library-changed', () => fn()),
  onLauncherUpdate: (fn) => ipcRenderer.on('launcher-update', (_e, p) => fn(p)),
});
