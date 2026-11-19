'use strict';
const { contextBridge, ipcRenderer } = require('electron');
contextBridge.exposeInMainWorld('lumenProgramSink', {
  video: bytes => ipcRenderer.invoke('lumen:devices:video', bytes),
  audio: bytes => ipcRenderer.invoke('lumen:devices:audio', bytes),
  fail: message => ipcRenderer.send('lumen:devices:receiver-error', String(message)),
});
