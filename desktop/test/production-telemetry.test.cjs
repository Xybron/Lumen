'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { desktopMemory, registerProductionTelemetry } = require('../app/production-telemetry.cjs');

test('desktop memory is scoped working-set bytes; incomplete or invalid samples are not presented as totals', () => {
  const result = desktopMemory([{ pid: 1, memory: { workingSetSize: 100 } }, { pid: 2, memory: { workingSetSize: 200 } }, { pid: 1, memory: { workingSetSize: 100 } }], 77);
  assert.deepEqual(result, { available: true, bytes: 300 * 1024, processes: 2, sampledAt: 77, scope: 'desktop-processes', metric: 'working-set' });
  for (const value of [null, [], [{ pid: 1 }], [{ pid: 1, memory: { workingSetSize: NaN } }], [{ pid: 1, memory: { workingSetSize: -1 } }], [{ pid: 1, memory: { workingSetSize: 0 } }], [{ pid: 1, memory: { workingSetSize: Number.MAX_VALUE } }]]) {
    const sample = desktopMemory(value);
    assert.equal(sample.available, false); assert.equal(sample.bytes, null);
  }
  assert.equal(desktopMemory([{ pid: 1, memory: { workingSetSize: 100 } }, { pid: 2 }]).available, false);
});

function fixture(t) {
  const handlers = new Map(); let identity = { user: { id: 'operator', isAdmin: true }, grants: [] }, time = 1000, samples = 0, authentications = 0;
  let pending = null, fail = false;
  const api = registerProductionTelemetry({ app: { getAppMetrics() { samples++; if (fail) throw new Error('metrics unavailable'); return [{ pid: 1, memory: { workingSetSize: 123 } }]; } },
    ipcMain: { handle: (name, handler) => handlers.set(name, handler), removeHandler: name => handlers.delete(name) },
    session: { async fetch() { authentications++; if (pending) await pending; return { ok: true, json: async () => identity }; } },
    origin: 'http://127.0.0.1:43117', trustedSender: event => event.trusted === true, now: () => time });
  t.after(() => api.close());
  const event = { trusted: true, senderFrame: { url: 'http://127.0.0.1:43117/studio' } };
  return { event, api, handlers, call: value => handlers.get('lumen:production:memory')(value || event),
    identity: value => { identity = value; }, time: value => { time = value; }, pending: value => { pending = value; }, fail: () => { fail = true; }, counts: () => ({ samples, authentications }) };
}

test('memory IPC requires the trusted operator frame and current global author access, even for a cached sample', async t => {
  const f = fixture(t);
  await assert.rejects(f.call({ ...f.event, trusted: false }), /operator window/);
  for (const pathname of ['/studio/output/program', '/output/program', '/live/presentation', '/studio/engine']) {
    await assert.rejects(f.call({ ...f.event, senderFrame: { url: 'http://127.0.0.1:43117' + pathname } }), /operator window/);
  }
  assert.deepEqual(f.counts(), { samples: 0, authentications: 0 });
  assert.equal((await f.call()).bytes, 123 * 1024);
  assert.equal((await f.call()).bytes, 123 * 1024);
  assert.deepEqual(f.counts(), { samples: 1, authentications: 2 });
  f.identity({ user: { id: 'viewer', isAdmin: false }, grants: [{ channelId: '*', role: 'viewer' }] });
  await assert.rejects(f.call(), /operator access/);
  f.identity({ user: { id: 'author', isAdmin: false }, grants: [{ channelId: 'presentation', role: 'author' }] });
  await assert.rejects(f.call(), /operator access/);
  f.identity({ user: { id: 'author', isAdmin: false }, grants: [{ channelId: '*', role: 'author' }] });
  f.time(3000); assert.equal((await f.call()).available, true); assert.equal(f.counts().samples, 2);
  f.time(5000); f.fail(); assert.equal((await f.call()).available, false);
});

test('navigation or shutdown during authentication prevents a native memory read', async t => {
  for (const shutdown of [false, true]) {
    const f = fixture(t); let resolve; f.pending(new Promise(done => { resolve = done; }));
    const read = f.call();
    if (shutdown) f.api.close(); else f.event.senderFrame.url = 'http://127.0.0.1:43117/output/program';
    resolve(); await assert.rejects(read, /no longer available/); assert.equal(f.counts().samples, 0);
    if (shutdown) assert.equal(f.handlers.size, 0);
  }
});
