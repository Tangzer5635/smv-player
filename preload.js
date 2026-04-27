const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('electronAPI', {
  openFileDialog:   ()    => ipcRenderer.invoke('open-file-dialog'),
  stalkerConnect:   (p)   => ipcRenderer.invoke('stalker-connect', p),
  stalkerGetStream: (p)   => ipcRenderer.invoke('stalker-get-stream', p),
  stalkerSeriesEpisodes: (p) => ipcRenderer.invoke('stalker-series-episodes', p),
  proxySetTarget:   (p)   => ipcRenderer.invoke('proxy-set-target', p),
  vlcPlay:          (p)   => ipcRenderer.invoke('vlc-play', p),
  getConfig:        ()    => ipcRenderer.invoke('get-config'),
  updateConfig:     (cfg) => ipcRenderer.invoke('update-config', cfg),

  profilesList:     ()    => ipcRenderer.invoke('profiles-list'),
  profileSave:      (p)   => ipcRenderer.invoke('profile-save', p),
  profileLoad:      (id)  => ipcRenderer.invoke('profile-load', id),
  profileDelete:    (id)  => ipcRenderer.invoke('profile-delete', id),
  profileUpdate:    (p)   => ipcRenderer.invoke('profile-update', p),
  profileRename:    (p)   => ipcRenderer.invoke('profile-rename', p),
  browseVlcPath:    ()    => ipcRenderer.invoke('browse-vlc-path'),

  windowMinimize:   ()    => ipcRenderer.send('window-minimize'),
  windowMaximize:   ()    => ipcRenderer.send('window-maximize'),
  windowClose:      ()    => ipcRenderer.send('window-close'),
  onWindowStateChanged: (callback) =>
      ipcRenderer.on('window-state-changed', (_event, data) => callback(data)),
});