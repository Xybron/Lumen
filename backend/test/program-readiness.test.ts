import test from 'node:test';
import assert from 'node:assert/strict';
import { prepareProgramMedia } from '../../frontend/src/lib/studio/program-readiness.js';

test('a resolved resume promise is not ready until the audio clock advances', async t => {
  t.mock.timers.enable({ apis: ['setInterval', 'setTimeout'] });
  let clock = 0, ready = false;
  const program = { audio: { state: 'running' as const, get currentTime() { return clock; }, resume: async () => {} }, close() { assert.fail('Healthy Program is retained'); } };
  const pending = prepareProgramMedia(() => program).then(value => { ready = true; return value; });
  t.mock.timers.tick(500); await Promise.resolve(); assert.equal(ready, false);
  clock = 0.02; t.mock.timers.tick(25);
  const result = await pending; assert.equal(result.program, program); assert.equal(result.attempts, 1);
});

test('a stalled audio engine is closed and rebuilt before startup is declared ready', async t => {
  t.mock.timers.enable({ apis: ['setInterval', 'setTimeout'] });
  let created = 0, closed = 0, clock = 0;
  const pending = prepareProgramMedia(() => {
    const number = ++created;
    return { audio: { state: 'running' as const, get currentTime() { return number === 1 ? 0 : clock; }, resume: () => new Promise<void>(() => {}) }, close() { closed++; } };
  });
  t.mock.timers.tick(4000); await Promise.resolve();
  assert.equal(closed, 1); assert.equal(created, 2);
  clock = 0.02; t.mock.timers.tick(25);
  assert.equal((await pending).attempts, 2); assert.equal(closed, 1);
});

test('permanent failure is bounded and cancellation cannot recreate an unmounted renderer', async t => {
  t.mock.timers.enable({ apis: ['setInterval', 'setTimeout'] });
  let created = 0, closed = 0;
  const create = () => { created++; return { audio: { state: 'suspended' as const, currentTime: 0, resume: () => new Promise<void>(() => {}) }, close() { closed++; } }; };
  const pending = prepareProgramMedia(create), rejected = assert.rejects(pending, /audio clock did not start/);
  t.mock.timers.tick(4000); await Promise.resolve(); t.mock.timers.tick(4000); await rejected;
  assert.equal(created, 2); assert.equal(closed, 2);
  const controller = new AbortController();
  const cancelled = assert.rejects(prepareProgramMedia(create, { signal: controller.signal }), /cancelled/);
  controller.abort(); await cancelled;
  assert.equal(created, 3); assert.equal(closed, 3);
});

test('unmount immediately after the first clock tick still releases the prepared compositor', async t => {
  t.mock.timers.enable({ apis: ['setInterval', 'setTimeout'] });
  const controller = new AbortController(); let clock = 0, closed = 0;
  const pending = prepareProgramMedia(() => ({ audio: { state: 'running' as const, get currentTime() { return clock; }, resume: async () => {} }, close() { closed++; } }), { signal: controller.signal });
  const cancelled = assert.rejects(pending, /cancelled/);
  clock = 0.02; t.mock.timers.tick(25); controller.abort(); await cancelled; assert.equal(closed, 1);
});
