import test from 'node:test';
import assert from 'node:assert/strict';
import { Writable } from 'node:stream';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { writeBroadcastInput } from '../src/broadcast-input.js';
import { createBroadcastHealth } from '../src/broadcast-health.js';
import type { BroadcastIncident } from '../../shared/broadcast.js';

test('a busy encoder that is still producing media can finish a write beyond the old eight-second cutoff', async t => {
  t.mock.timers.enable({ apis: ['Date', 'setInterval'], now: 1000 });
  let done!: () => void, progress = 0;
  const input = new Writable({ write(_bytes, _encoding, callback) { done = callback; } });
  const operation = writeBroadcastInput(input, Buffer.alloc(4096), { limit: 8192, progress: () => progress });
  for (let second = 0; second < 10; second++) { progress++; t.mock.timers.tick(1000); }
  done(); await operation;
  assert.equal(input.listenerCount('close'), 0); input.destroy();
});

test('a completely stalled encoder still fails at eight seconds and a busy encoder has a hard sixteen-second cap', async t => {
  t.mock.timers.enable({ apis: ['Date', 'setInterval'], now: 1000 });
  for (const progressing of [false, true]) {
    const input = new Writable({ write() {} }); let progress = 0;
    const operation = writeBroadcastInput(input, Buffer.alloc(4096), { limit: 8192, progress: () => progress });
    const rejected = assert.rejects(operation, { reason: 'input-stalled' });
    for (let second = 0; second < (progressing ? 16 : 8); second++) {
      if (progressing) progress++;
      t.mock.timers.tick(1000);
    }
    await rejected; assert.equal(input.listenerCount('close'), 0); input.destroy();
  }
});

test('closed encoder pipes and full queues have distinct bounded failures', async () => {
  const input = new Writable({ write() {} });
  await assert.rejects(writeBroadcastInput(input, Buffer.alloc(8193), { limit: 8192, progress: () => 0 }), { reason: 'input-backlog' });
  const operation = writeBroadcastInput(input, Buffer.alloc(4096), { limit: 8192, progress: () => 0 });
  const rejected = assert.rejects(operation, { reason: 'encoder-exit' }); input.destroy(); await rejected;
  assert.equal(input.listenerCount('close'), 0);
});

test('last stream failure survives restart with bounded, private diagnostics and no arbitrary fields', async () => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'lumen-stream-health-'));
  const incident: BroadcastIncident = { at: new Date().toISOString(), reason: 'input-stalled', encoder: 'worker-h264', encoderFailure: 'unknown',
    profile: '720p', destinations: 3, queuedBytes: 4096, pendingInputBytes: 4096, maxInputWaitMs: 8000, inputAgeMs: 8000, outputAgeMs: 8000 };
  try {
    const health = await createBroadcastHealth(directory); assert.equal(health.latest(), null);
    health.record(incident); await health.flush();
    assert.deepEqual((await createBroadcastHealth(directory)).latest(), incident);
    assert.equal((await fs.stat(path.join(directory, 'broadcast-health.json'))).mode & 0o777, 0o600);
    assert.throws(() => health.record({ ...incident, streamKey: 'never-persist' } as never));
    assert.throws(() => health.record({ ...incident, encoderFailure: 'rtmps://private/key' } as never));
    await fs.writeFile(path.join(directory, 'broadcast-health.json'), JSON.stringify({ ...incident, key: 'untrusted' }));
    assert.equal((await createBroadcastHealth(directory)).latest(), null);
  } finally { await fs.rm(directory, { recursive: true, force: true }); }
});
