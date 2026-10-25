'use strict';

const { ipcRenderer } = require('electron');

// No Node or Electron API is exposed to the application. Only trusted clicks
// on external links reach the main process; programmatic navigation is denied.
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
