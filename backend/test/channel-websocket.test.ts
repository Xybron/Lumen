import test from 'node:test';
import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';
import vm from 'node:vm';

const clientBundle = (async () => {
  const { default: esbuild } = await import('../../frontend/node_modules/esbuild/lib/main.js');
  const frontend = fileURLToPath(new URL('../../frontend/', import.meta.url));
  const result = await esbuild.build({ absWorkingDir: frontend, entryPoints: ['src/lib/ws.ts'],
    bundle: true, write: false, format: 'iife', globalName: 'LumenWs', platform: 'browser',
    define: { 'process.env.NODE_ENV': '"production"' } });
  return result.outputFiles[0].text;
})();

async function fixture() {
  const sockets: Socket[] = [];
  class Socket extends EventTarget {
    static CONNECTING = 0; static OPEN = 1; static CLOSING = 2; static CLOSED = 3;
    readyState = Socket.CONNECTING;
    sent: string[] = [];
    closes = 0;
    constructor(readonly url: string) { super(); sockets.push(this); }
    send(value: string) { assert.equal(this.readyState, Socket.OPEN); this.sent.push(value); }
    open() { this.readyState = Socket.OPEN; this.dispatchEvent(new Event('open')); }
    receive(message: unknown) { this.dispatchEvent(new MessageEvent('message', { data: JSON.stringify(message) })); }
    close() { this.closes++; this.readyState = Socket.CLOSING; }
    finishClose() { this.readyState = Socket.CLOSED; this.dispatchEvent(new Event('close')); }
  }
  const window = Object.assign(new EventTarget(), { setInterval, setTimeout });
  const context = vm.createContext({ window, WebSocket: Socket, location: { protocol: 'http:', host: 'station.test' },
    setTimeout, setInterval, clearTimeout, clearInterval });
  vm.runInContext(await clientBundle, context);
  const client = context.LumenWs as {
    startWs(): void;
    subscribeTopics(channels: string[]): void;
    subscribeWs(callback: (message: unknown) => void): () => void;
    useConnection(): { value: string };
  };
  return { client, window, sockets };
}

test('a silent open channel socket expires despite repeated pings and replays subscriptions after reconnect', async t => {
  t.mock.timers.enable({ apis: ['setInterval', 'setTimeout'] });
  const { client, sockets } = await fixture();
  client.subscribeTopics(['scripture', 'lyrics']); client.startWs();
  const first = sockets[0]; first.open();
  t.mock.timers.tick(20_000); t.mock.timers.tick(20_000);
  assert.equal(first.sent.filter(value => JSON.parse(value).t === 'ping').length, 2);
  t.mock.timers.tick(4_999); assert.equal(first.closes, 0);
  t.mock.timers.tick(1); assert.equal(first.closes, 1, 'The second ping must not extend the first unanswered deadline');
  first.finishClose(); assert.equal(client.useConnection().value, 'offline');
  t.mock.timers.tick(499); assert.equal(sockets.length, 1);
  t.mock.timers.tick(1); assert.equal(sockets.length, 2);
  sockets[1].open(); assert.equal(client.useConnection().value, 'online');
  assert.deepEqual(JSON.parse(sockets[1].sent[0]), { t: 'subscribe', channels: ['scripture', 'lyrics'] });
});

test('pong and ordinary cue traffic acknowledge the current deadline without suppressing future liveness checks', async t => {
  t.mock.timers.enable({ apis: ['setInterval', 'setTimeout'] });
  const { client, sockets } = await fixture(), messages: unknown[] = [];
  client.subscribeWs(message => messages.push(message)); client.startWs();
  const socket = sockets[0]; socket.open();
  t.mock.timers.tick(20_000); t.mock.timers.tick(10_000); socket.receive({ t: 'pong' });
  t.mock.timers.tick(10_000); t.mock.timers.tick(10_000);
  assert.equal(socket.closes, 0, 'The acknowledged first deadline cannot close a healthy connection');
  socket.receive({ t: 'state', channel: 'scripture', payload: { channelRevision: 7 } });
  assert.equal(messages.length, 1, 'Only the ordinary cue reaches subscribers');
  t.mock.timers.tick(10_000); t.mock.timers.tick(20_000); t.mock.timers.tick(5_000);
  assert.equal(socket.closes, 1, 'Subsequent unanswered pings still expire');
});

test('late events from a closing socket cannot disconnect or acknowledge its replacement', async t => {
  t.mock.timers.enable({ apis: ['setInterval', 'setTimeout'] });
  const { client, window, sockets } = await fixture(), messages: unknown[] = [];
  client.subscribeWs(message => messages.push(message)); client.startWs();
  const first = sockets[0]; first.open();
  t.mock.timers.tick(20_000); first.close();
  window.dispatchEvent(new Event('online'));
  const replacement = sockets[1]; replacement.open();
  t.mock.timers.tick(20_000);
  first.receive({ t: 'state', channel: 'scripture', payload: { channelRevision: 1 } });
  first.finishClose();
  assert.equal(messages.length, 0, 'Obsolete sockets cannot replay old cues');
  assert.equal(client.useConnection().value, 'online');
  t.mock.timers.tick(20_000); t.mock.timers.tick(5_000);
  assert.equal(first.closes, 1, 'Replacement clears the old socket heartbeat');
  assert.equal(replacement.closes, 1, 'Late traffic cannot acknowledge the replacement heartbeat');
  assert.equal(sockets.length, 2, 'A late close cannot schedule a redundant reconnect');
});
