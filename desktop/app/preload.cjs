'use strict';

const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('lumenDisplays', {
  list: () => ipcRenderer.invoke('lumen:displays:list'),
  open: request => ipcRenderer.invoke('lumen:displays:open', request),
  toggleFullscreen: () => ipcRenderer.invoke('lumen:displays:toggle-fullscreen'),
  exitFullscreen: () => ipcRenderer.invoke('lumen:displays:exit-fullscreen'),
  onChanged: listener => {
    const changed = () => listener();
    ipcRenderer.on('lumen:displays:changed', changed);
    return () => ipcRenderer.removeListener('lumen:displays:changed', changed);
  },
});

// Narrow desktop capabilities only; no general IPC, filesystem or Node access.
contextBridge.exposeInMainWorld('lumenVirtualDevices', {
  status: () => ipcRenderer.invoke('lumen:devices:control', 'status'),
  start: () => ipcRenderer.invoke('lumen:devices:control', 'start'),
  stop: () => ipcRenderer.invoke('lumen:devices:control', 'stop'),
  activateCamera: () => ipcRenderer.invoke('lumen:devices:control', 'activate'),
  installAudio: () => ipcRenderer.invoke('lumen:devices:control', 'install-audio'),
});

contextBridge.exposeInMainWorld('lumenProduction', {
  memory: () => ipcRenderer.invoke('lumen:production:memory'),
});

// Only trusted clicks open external links; programmatic navigation is denied.
function externalClick(event) {
  if (!event.isTrusted || event.defaultPrevented || event.button > 1) return;
  const anchor = event.composedPath().find(node => node instanceof HTMLAnchorElement);
  if (!anchor) return;
  let target;
  try { target = new URL(anchor.href); } catch { return; }
  if (!['https:', 'http:'].includes(target.protocol) || target.origin === window.location.origin) return;
  event.preventDefault(); event.stopImmediatePropagation();
  ipcRenderer.send('lumen:open-external', target.href);
}
window.addEventListener('click', externalClick, true);
window.addEventListener('auxclick', externalClick, true);
