'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');
const { registerDisplayOutputs } = require('../app/display-outputs.cjs');
function fixture(t, platform = 'darwin') {
  const laptop = { id: 1, label: 'Laptop', internal: true, bounds: { x: 0, y: 0, width: 1512, height: 982 }, workArea: { x: 0, y: 25, width: 1512, height: 930 } };
  const projector = { id: 2, label: 'Projector', bounds: { x: -1920, y: -100, width: 1920, height: 1080 }, workArea: { x: -1920, y: -100, width: 1920, height: 1080 } };
  let displays = [laptop, projector]; const windows = [], handlers = new Map();
  class Window extends EventEmitter {
    constructor(options) { super(); this.options = options; this.bounds = { ...laptop.bounds }; this.webContents = new EventEmitter(); this.webContents.send = () => {}; this.full = false; this.destroyed = false; this.events = []; windows.push(this); }
    getBounds() { return this.bounds; } setBounds(bounds) { this.bounds = bounds; this.events.push('bounds'); }
    isSimpleFullScreen() { return this.full; } isFullScreen() { return this.full; }
    setSimpleFullScreen(value) { this.full = value; this.events.push('simple:' + value); }
    setFullScreen(value) { this.full = value; this.events.push('native:' + value); }
    isDestroyed() { return this.destroyed; } isMinimized() { return false; }
    show() {} focus() {} async loadURL(url) { this.url = url; }
    destroy() { this.destroyed = true; this.emit('closed'); }
    static fromWebContents(sender) { return windows.find(w => w.webContents === sender); }
    static getAllWindows() { return windows.filter(w => !w.destroyed); }
  }
  const operator = new Window({}); const screen = new EventEmitter();
  Object.assign(screen, { getAllDisplays: () => displays, getPrimaryDisplay: () => laptop, getDisplayMatching: bounds => bounds.x < 0 ? projector : laptop });
  const ipcMain = { handle: (key, fn) => handlers.set(key, fn), removeHandler: key => handlers.delete(key) };
  const manager = registerDisplayOutputs({ BrowserWindow: Window, screen, ipcMain, origin: 'http://127.0.0.1:43117', trustedSender: e => e.trusted === true, webPreferences: () => ({ sandbox: true }), attachWindow() {}, platform });
  t.after(() => manager.close());
  const call = (name, args, sender = operator.webContents, trusted = true) => handlers.get('lumen:displays:' + name)({ sender, trusted }, args);
  return { operator, windows, projector, screen, call, removeProjector() { displays = [laptop]; screen.emit('display-removed'); } };
}
for (const platform of ['darwin', 'win32']) test(`${platform}: assigned outputs place before fullscreen, reuse their window, and leave operator untouched`, async t => {
  const f = fixture(t, platform); assert.equal(f.call('list')[1].id, 'desktop-2');
  const result = await f.call('open', { outputId: 'screen_main', displayId: 'desktop-2' });
  assert.equal(result.status, 'opened'); assert.equal(result.fullscreenRequired, false);
  const output = f.windows[1]; assert.deepEqual(output.bounds, f.projector.bounds); assert.equal(output.full, true); assert.equal(f.operator.full, false);
  const eventCount = output.events.length; f.screen.emit('display-metrics-changed');
  assert.equal(output.events.length, eventCount, 'Unrelated display events must not interrupt fullscreen');
  assert.ok(output.events.indexOf('bounds') < output.events.indexOf(platform === 'darwin' ? 'simple:true' : 'native:true'));
  assert.match(output.url, /^http:\/\/127.0.0.1:43117\/studio\/output\/screen_main\?display=1$/);
  f.call('exit-fullscreen', undefined, output.webContents); assert.equal(output.full, false);
  f.call('toggle-fullscreen', undefined, output.webContents); assert.equal(output.full, true);
  f.call('toggle-fullscreen', undefined, output.webContents); assert.equal(output.full, false);
  await f.call('open', { outputId: 'screen_main', displayId: 'desktop-2' }); assert.equal(f.windows.length, 2); assert.equal(output.full, true);
  f.removeProjector(); assert.equal(output.destroyed, true); assert.equal(f.operator.destroyed, false);
  assert.equal((await f.call('open', { outputId: 'screen_main', displayId: 'desktop-2' })).status, 'disconnected'); assert.equal(f.windows.length, 2);
});
test('manual outputs remain windowed and privilege checks reject foreign senders and unsafe destinations', async t => {
  const f = fixture(t);
  assert.throws(() => f.call('list', undefined, f.operator.webContents, false), /main frame/);
  for (const outputId of ['../studio', 'https://example.com', 'a/b', '']) assert.equal((await f.call('open', { outputId, displayId: null })).status, 'invalid-url');
  assert.equal((await f.call('open', { outputId: 'program', displayId: null })).status, 'opened');
  assert.equal(f.windows[1].full, false);
  assert.deepEqual(f.call('toggle-fullscreen', undefined, f.operator.webContents), { managed: false });
});
