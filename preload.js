const { contextBridge, ipcRenderer } = require('electron');

// Seules les fonctions propres au bureau passent par IPC.
// Les données (profils, portail, flux) passent par l'API HTTP du serveur intégré,
// commune avec l'iPhone (voir renderer/api.js).
contextBridge.exposeInMainWorld('electronAPI', {
  isElectron:       true,
  platform:         process.platform,

  vlcPlay:          (p)   => ipcRenderer.invoke('vlc-play', p),
  browseFile:       (p)   => ipcRenderer.invoke('browse-file', p),
  openExternal:     (url) => ipcRenderer.invoke('open-external', url),
  setTrayEnabled:   (on)  => ipcRenderer.invoke('tray-setting', on),

  windowMinimize:   ()    => ipcRenderer.send('window-minimize'),
  windowMaximize:   ()    => ipcRenderer.send('window-maximize'),
  windowClose:      ()    => ipcRenderer.send('window-close'),
  onWindowStateChanged: (callback) =>
      ipcRenderer.on('window-state-changed', (_event, data) => callback(data)),
});
