'use strict';

// All destinations are constructed here, never supplied as renderer URLs.
function registerDisplayOutputs({ BrowserWindow, screen, ipcMain, origin, trustedSender, webPreferences, attachWindow, platform = process.platform }) {
  const outputs = new Map();
  const liveDisplays = () => screen.getAllDisplays();
  const displayById = id => liveDisplays().find(display => `desktop-${display.id}` === id);
  const isFullscreen = window => platform === 'darwin' ? window.isSimpleFullScreen() : window.isFullScreen();
  const setFullscreen = (window, value) => platform === 'darwin' ? window.setSimpleFullScreen(value) : window.setFullScreen(value);
  function list(sender) {
    const window = BrowserWindow.fromWebContents(sender);
    const current = window && screen.getDisplayMatching(window.getBounds());
    const primary = screen.getPrimaryDisplay();
    return liveDisplays().map((display, index) => ({ id: `desktop-${display.id}`, label: display.label || (display.internal ? 'Built-in display' : `Display ${index + 1}`),
      width: display.bounds.width, height: display.bounds.height, isPrimary: display.id === primary.id,
      isCurrent: display.id === current?.id, isInternal: display.internal === true }));
  }
  function enter(entry, display) {
    // Place the window before entering fullscreen; on macOS simple fullscreen
    // keeps the output on that display without creating a separate Space.
    if (isFullscreen(entry.window)) setFullscreen(entry.window, false);
    entry.window.setBounds({ ...display.bounds });
    setFullscreen(entry.window, true);
  }
  async function open(sender, request) {
    const failed = (status, message) => ({ status, message, placed: false, fullscreenRequired: false });
    if (!request || typeof request.outputId !== 'string' || !/^[a-zA-Z0-9_-]{1,80}$/.test(request.outputId)
      || !(request.displayId === null || typeof request.displayId === 'string')) return failed('invalid-url', 'Choose an output from this station.');
    const display = request.displayId === null ? null : displayById(request.displayId);
    if (request.displayId !== null && !display) return failed('disconnected', 'That display is disconnected. Find displays again or choose Manual window.');
    let entry = outputs.get(request.outputId);
    if (!entry || entry.window.isDestroyed()) {
      const area = (display || screen.getDisplayMatching(BrowserWindow.fromWebContents(sender).getBounds())).workArea;
      const window = new BrowserWindow({ title: 'Lumen output', x: area.x, y: area.y,
        width: Math.min(1280, area.width), height: Math.min(800, area.height), show: false,
        backgroundColor: '#000000', autoHideMenuBar: true, fullscreenable: true, webPreferences: webPreferences() });
      entry = { window, displayId: request.displayId }; outputs.set(request.outputId, entry);
      attachWindow(window);
      window.on('closed', () => { if (outputs.get(request.outputId) === entry) outputs.delete(request.outputId); });
      try { await window.loadURL(`${origin}/studio/output/${encodeURIComponent(request.outputId)}?display=1`); }
      catch { if (!window.isDestroyed()) window.destroy(); return failed('unavailable', 'The output could not be loaded. Try opening it again.'); }
    }
    if (entry.window.isDestroyed()) return failed('disconnected', 'The output was closed or its display disconnected.');
    // Recheck after navigation: a display can be unplugged while the page loads.
    const connected = request.displayId === null ? null : displayById(request.displayId);
    if (request.displayId !== null && !connected) { entry.window.destroy(); return failed('disconnected', 'That display is disconnected. Find displays again.'); }
    entry.displayId = request.displayId;
    if (entry.window.isMinimized()) entry.window.restore();
    entry.window.show();
    if (connected) enter(entry, connected); else setFullscreen(entry.window, false);
    entry.window.focus();
    return { status: 'opened', placed: !!connected, fullscreenRequired: !connected,
      message: connected ? `Opened fullscreen on ${connected.label || 'the assigned display'}. Press Esc to exit or F to toggle fullscreen.` : 'Output opened. Move it to a screen, then press F for fullscreen.' };
  }
  function toggle(sender, exit = false) {
    const entry = [...outputs.values()].find(value => value.window.webContents === sender && !value.window.isDestroyed());
    if (!entry) return { managed: false };
    if (exit || isFullscreen(entry.window)) setFullscreen(entry.window, false);
    else {
      const display = entry.displayId ? displayById(entry.displayId) : screen.getDisplayMatching(entry.window.getBounds());
      if (!display) return { managed: true, fullscreen: false };
      enter(entry, display);
    }
    return { managed: true, fullscreen: isFullscreen(entry.window) };
  }
  const handlers = {
    'lumen:displays:list': event => list(event.sender),
    'lumen:displays:open': (event, request) => open(event.sender, request),
    'lumen:displays:toggle-fullscreen': event => toggle(event.sender),
    'lumen:displays:exit-fullscreen': event => toggle(event.sender, true),
  };
  for (const [channel, handler] of Object.entries(handlers)) ipcMain.handle(channel, (event, ...args) => {
    if (!trustedSender(event)) throw new Error('Display controls require this station’s main frame.');
    return handler(event, ...args);
  });
  function changed() {
    for (const entry of outputs.values()) {
      if (!entry.displayId || entry.window.isDestroyed()) continue;
      const display = displayById(entry.displayId);
      if (!display) entry.window.destroy(); // Never move live output onto the operator display.
      else if (isFullscreen(entry.window)) {
        const bounds = entry.window.getBounds();
        if (['x', 'y', 'width', 'height'].some(key => bounds[key] !== display.bounds[key])) enter(entry, display);
      }
    }
    for (const window of BrowserWindow.getAllWindows()) if (!window.isDestroyed()) window.webContents.send('lumen:displays:changed');
  }
  for (const name of ['display-added', 'display-removed', 'display-metrics-changed']) screen.on(name, changed);
  return { close() {
    for (const name of ['display-added', 'display-removed', 'display-metrics-changed']) screen.removeListener(name, changed);
    for (const channel of Object.keys(handlers)) ipcMain.removeHandler(channel);
    for (const { window } of [...outputs.values()]) if (!window.isDestroyed()) window.destroy();
    outputs.clear();
  } };
}
module.exports = { registerDisplayOutputs };
