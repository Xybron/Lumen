import test from 'node:test';
import assert from 'node:assert/strict';
import { listDisplays, openDisplayOutput, requestDisplayFullscreen, type DetailedDisplay, type DisplayBrowser } from '../../frontend/src/lib/studio/display-outputs.js';

function fixture() {
  const laptop: DetailedDisplay = { label: 'Laptop', isInternal: true, isPrimary: true, left: 0, top: 0, width: 1512, height: 982, availLeft: 0, availTop: 25, availWidth: 1512, availHeight: 930 };
  const projector: DetailedDisplay = { label: 'Auditorium projector', left: -1920, top: 0, width: 1920, height: 1080, availLeft: -1920, availTop: 0, availWidth: 1920, availHeight: 1080 };
  const listeners = new Map<string, Set<EventListener>>();
  const details = { screens: [laptop, projector], currentScreen: laptop,
    addEventListener(type: string, listener: EventListener) { if (!listeners.has(type)) listeners.set(type, new Set()); listeners.get(type)!.add(listener); },
    removeEventListener(type: string, listener: EventListener) { listeners.get(type)?.delete(listener); },
  };
  let queries = 0;
  const calls: { url: string; name: string; features: string }[] = [];
  const popup = { opener: {} as unknown, focused: false, focus() { this.focused = true; } };
  const browser: DisplayBrowser = { isSecureContext: true, location: { href: 'http://127.0.0.1:5173/studio', origin: 'http://127.0.0.1:5173' },
    async getScreenDetails() { queries++; return details; },
    open(url, name, features) { calls.push({ url, name, features }); return popup as unknown as Window; },
  };
  return { details, listeners, calls, browser, popup, queries: () => queries };
}

test('display enumeration is explicit, runtime-only and identifies actual current/primary screens', async () => {
  const value = fixture(); assert.equal(value.queries(), 0);
  const result = await listDisplays(value.browser);
  assert.equal(value.queries(), 1); assert.equal(result.status, 'available');
  assert.deepEqual(result.displays.map(display => [display.label, display.isCurrent, display.isPrimary]), [['Laptop', true, true], ['Auditorium projector', false, false]]);
  assert.equal('screen' in result.displays[0], false, 'native display object is never in serializable UI choices');
  assert.equal(result.displays[1].width, 1920);
});

test('plug/unplug refresh keeps existing runtime display identity and removes event listeners', async () => {
  const value = fixture(), result = await listDisplays(value.browser), updates: string[][] = [];
  const stop = result.subscribe(displays => updates.push(displays.map(display => display.id)));
  value.details.screens = [value.details.screens[0]];
  for (const listener of value.listeners.get('screenschange')!) listener(new Event('screenschange'));
  assert.deepEqual(updates, [[result.displays[0].id]]);
  stop(); assert.ok([...value.listeners.values()].every(listeners => listeners.size === 0));
});

test('unsupported, insecure and denied browsers have clear manual-display fallbacks without eager calls', async () => {
  const value = fixture();
  assert.equal((await listDisplays({ ...value.browser, isSecureContext: false })).status, 'insecure');
  assert.equal((await listDisplays({ ...value.browser, getScreenDetails: undefined })).status, 'unsupported');
  assert.equal(value.queries(), 0);
  const denied = await listDisplays({ ...value.browser, getScreenDetails: async () => { throw Object.assign(new Error(), { name: 'NotAllowedError' }); } });
  assert.equal(denied.status, 'denied'); assert.match(denied.message, /move it manually/);
  assert.equal((await listDisplays(null)).status, 'unavailable');
});

test('selected output opens synchronously with negative monitor coordinates and no operator opener', async () => {
  const value = fixture(), result = await listDisplays(value.browser);
  const opened = openDisplayOutput('/studio/output/auditorium?clean=1', result.displays[1], { browser: value.browser, windowName: 'lumen-output-auditorium' });
  assert.equal(opened.status, 'opened'); assert.equal(opened.placed, true); assert.equal(opened.fullscreenRequired, true);
  assert.equal(value.queries(), 1, 'opening never requests another permission or awaits enumeration');
  assert.match(value.calls[0].features, /left=-1920,top=0,width=1920,height=1080/);
  assert.equal(value.calls[0].name, 'lumen-output-auditorium'); assert.equal(value.popup.opener, null); assert.equal(value.popup.focused, true);
});

test('unplugged or forged display choices never silently route onto a different monitor', async () => {
  const value = fixture(), result = await listDisplays(value.browser), selected = result.displays[1];
  value.details.screens.pop();
  assert.equal(openDisplayOutput('/studio/output/a', selected, { browser: value.browser }).status, 'disconnected');
  assert.equal(openDisplayOutput('/studio/output/a', { ...result.displays[0] }, { browser: value.browser }).status, 'disconnected');
  assert.equal(value.calls.length, 0);
});

test('manual output fallback, blocked popup and unsafe URL handling are explicit', () => {
  const value = fixture();
  const manual = openDisplayOutput('/studio/output/a', null, { browser: value.browser });
  assert.equal(manual.status, 'opened'); assert.equal(manual.placed, false); assert.match(manual.message, /Move its window/);
  openDisplayOutput('/studio/output/a', null, { browser: value.browser, windowName: '_self' });
  assert.equal(value.calls[1].name, '_blank', 'an output cannot replace the operator window via a reserved target');
  assert.equal(openDisplayOutput('/studio/output/a', null, { browser: { ...value.browser, open: () => null } }).status, 'blocked');
  for (const url of ['javascript:alert(1)', 'data:text/html,anything', 'https://example.com/output', 'http://user:password@127.0.0.1:5173/studio/output/a']) {
    assert.equal(openDisplayOutput(url, null, { browser: value.browser }).status, 'invalid-url');
  }
  assert.equal(openDisplayOutput('/studio/output/a', null, { browser: null }).status, 'unavailable');
});

test('fullscreen is requested only by an explicit receiving-page action and degrades gracefully', async () => {
  const value = fixture(), result = await listDisplays(value.browser), requests: unknown[] = [];
  const element = { requestFullscreen: async (options: unknown) => { requests.push(options); } } as unknown as HTMLElement;
  assert.deepEqual(await requestDisplayFullscreen(element, result.displays[1]), { entered: true, message: '' });
  assert.equal((requests[0] as { screen: unknown }).screen, value.details.screens[1]);
  assert.equal((await requestDisplayFullscreen({ requestFullscreen: async () => { throw new Error('gesture'); } } as unknown as HTMLElement)).entered, false);
  assert.match((await requestDisplayFullscreen({} as HTMLElement)).message, /browser/);
});
