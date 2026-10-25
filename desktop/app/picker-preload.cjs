'use strict';
const { contextBridge, ipcRenderer } = require('electron');
contextBridge.exposeInMainWorld('lumenPicker', {
  sources: () => ipcRenderer.invoke('lumen:picker:sources'),
  choose: (id, audio) => ipcRenderer.send('lumen:picker:choose', { id, audio }),
  cancel: () => ipcRenderer.send('lumen:picker:cancel'),
});
