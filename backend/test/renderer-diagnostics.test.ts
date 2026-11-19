import test from 'node:test';
import assert from 'node:assert/strict';
import { createRendererDiagnosticsSampler } from '../src/renderer-diagnostics.js';

test('a nonresponding renderer returns bounded partial diagnostics without accumulating evaluations', async t => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  let reads = 0;
  const sample = createRendererDiagnosticsSampler(async () => { reads++; return new Promise(() => {}); });
  const renderer = {};
  const first = sample(renderer), concurrent = sample(renderer);
  assert.equal(first, concurrent);
  await Promise.resolve();
  assert.equal(reads, 1);
  t.mock.timers.tick(1500);
  assert.deepEqual(await first, { details: null, state: 'timeout' });
  for (let i = 0; i < 20; i++) assert.deepEqual(await sample(renderer), { details: null, state: 'timeout' });
  assert.equal(reads, 1, 'requests after the timeout reuse the outstanding renderer evaluation');
});

test('diagnostics resume after a delayed renderer settles and a restarted renderer is independent', async t => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const stalled = {}, replacement = {};
  let settle!: (value: unknown) => void, reads = 0;
  const sample = createRendererDiagnosticsSampler(async target => {
    reads++;
    if (target === stalled && reads === 1) return new Promise(resolve => { settle = resolve; });
    return { fps: 30 };
  });
  const timedOut = sample(stalled);
  await Promise.resolve();
  t.mock.timers.tick(1500);
  assert.equal((await timedOut).state, 'timeout');
  assert.deepEqual(await sample(replacement), { details: { fps: 30 }, state: 'available' });
  settle({ fps: 1 });
  // Allow the read's adopted promise and its completion handler to settle.
  await Promise.resolve(); await Promise.resolve(); await Promise.resolve();
  assert.deepEqual(await sample(stalled), { details: { fps: 30 }, state: 'available' });
  assert.equal(reads, 3);
});

test('missing diagnostics and reader errors are explicit and do not prevent later samples', async () => {
  const renderer = {};
  let reads = 0;
  const sample = createRendererDiagnosticsSampler(async () => {
    reads++;
    if (reads === 1) throw new Error('renderer closed');
    if (reads === 2) return null;
    return { fps: 30 };
  });
  assert.deepEqual(await sample(null), { details: null, state: 'unavailable' });
  assert.equal(reads, 0);
  assert.deepEqual(await sample(renderer), { details: null, state: 'unavailable' });
  assert.deepEqual(await sample(renderer), { details: null, state: 'unavailable' });
  assert.deepEqual(await sample(renderer), { details: { fps: 30 }, state: 'available' });
});
