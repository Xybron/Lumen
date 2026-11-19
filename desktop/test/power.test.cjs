'use strict';
const assert = require('node:assert/strict');
const test = require('node:test');
const { preventDisplaySleepWhileLive } = require('../app/power.cjs');

async function flush() { for (let i = 0; i < 8; i++) await Promise.resolve(); }

test('live engine protects the display across status errors and releases it when stopped', async t => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  let status = { state: 'offline' }, calls = 0;
  const started = [], stopped = [];
  const close = preventDisplaySleepWhileLive({
    powerSaveBlocker: { start: type => { started.push(type); return started.length - 1; }, stop: id => stopped.push(id) },
    readStatus: async () => { calls++; if (status instanceof Error) throw status; return status; },
  });
  t.after(close);
  await flush();
  assert.deepEqual(started, []);
  status = { state: 'starting' }; t.mock.timers.tick(3000); await flush();
  assert.deepEqual(started, ['prevent-display-sleep']);
  status = { state: 'running' }; t.mock.timers.tick(3000); await flush();
  status = new Error('temporary outage'); t.mock.timers.tick(3000); await flush();
  status = { state: 'error' }; t.mock.timers.tick(3000); await flush();
  status = {}; t.mock.timers.tick(3000); await flush();
  assert.deepEqual(stopped, []);
  assert.equal(started.length, 1, 'An existing assertion is reused');
  status = { state: 'offline' }; t.mock.timers.tick(3000); await flush();
  assert.deepEqual(stopped, [0]);
  status = { state: 'error', recording: { status: 'stopping' } }; t.mock.timers.tick(3000); await flush();
  assert.equal(started.length, 2, 'A recording still finishing keeps protection');
  close(); close();
  assert.deepEqual(stopped, [0, 1]);
  const before = calls; t.mock.timers.tick(30_000); await flush();
  assert.equal(calls, before);
});

test('closing aborts a pending status read and ignores its late active result', async t => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  let resolve, signal, calls = 0;
  const close = preventDisplaySleepWhileLive({
    powerSaveBlocker: { start() { assert.fail('A closed monitor cannot acquire a blocker'); }, stop() {} },
    readStatus: value => { signal = value; calls++; return new Promise(done => { resolve = done; }); },
  });
  t.mock.timers.tick(30_000); await flush();
  assert.equal(calls, 1, 'Status reads never overlap');
  close();
  assert.equal(signal.aborted, true);
  resolve({ state: 'running' }); await flush();
  t.mock.timers.tick(30_000); await flush();
  assert.equal(calls, 1);
});
