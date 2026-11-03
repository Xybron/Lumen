import test from 'node:test';
import assert from 'node:assert/strict';
import { ProgramFrameTiming } from '../../frontend/src/lib/studio/program-frame-timing.js';

test('Program measures actual draw intervals and keeps pauses visible after frame rate recovers', () => {
  const timing = new ProgramFrameTiming();
  timing.record(0);
  for (let i = 1; i <= 30; i++) timing.record(i * 1000 / 30);
  assert.equal(timing.fps, 30);
  assert.equal(timing.pauses, 0);
  timing.record(1250);
  for (let i = 1; i <= 60; i++) timing.record(1250 + i * 1000 / 30);
  assert.equal(timing.fps, 30);
  assert.equal(timing.pauses, 1);
  assert.equal(timing.longestPauseMs, 250);
  assert.ok(timing.lastPauseAt);
});
