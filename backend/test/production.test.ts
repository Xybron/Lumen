import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { ProductionStore } from '../src/production-store.js';
import { CommandSchema, ProductionSchema } from '../src/production-schema.js';
import { RecordingStore } from '../src/production-recordings.js';

async function fixture() {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'lumen-production-test-'));
  const store = new ProductionStore(dir); await store.init(); return { dir, store };
}

test('fresh stations name the Program output clearly without renaming saved output settings', async () => {
  const { dir, store } = await fixture();
  try {
    const initial = store.get(), output = initial.outputs.find(item => item.id === 'screen_broadcast')!;
    assert.equal(output.name, 'Program'); assert.equal(output.audioEnabled, true); assert.equal(output.mode, 'program');
    output.name = 'Broadcast'; await store.save(initial);
    const persisted = await fs.readFile(path.join(dir, 'production.json'));
    const reopened = new ProductionStore(dir); await reopened.init();
    assert.equal(reopened.get().outputs.find(item => item.id === 'screen_broadcast')?.name, 'Broadcast');
    assert.deepEqual(await fs.readFile(path.join(dir, 'production.json')), persisted);
  } finally { await fs.rm(dir, { recursive: true, force: true }); }
});

test('draft changes cannot change Program or a pinned output until explicitly committed', async () => {
  const { dir, store } = await fixture();
  let state = await store.command(0, { type: 'take', sceneId: 'scene_welcome' });
  state = await store.command(state.revision, { type: 'route', outputId: 'screen_main', sceneId: 'scene_welcome' });
  const committed = structuredClone(state.program);
  state.scenes[0].layers[1].text = 'An unpublished edit';
  state.program!.layers[1].text = 'Attempted live edit';
  state.outputs[0].scene!.layers[1].text = 'Attempted pinned edit';
  state = await store.save(state);
  assert.deepEqual(state.program, committed);
  assert.deepEqual(state.outputs[0].scene, committed);
  state = await store.command(state.revision, { type: 'take', sceneId: 'scene_welcome' });
  assert.equal(state.program!.layers[1].text, 'An unpublished edit');
  assert.deepEqual(state.outputs[0].scene, committed);
  const restarted = new ProductionStore(dir); await restarted.init();
  assert.deepEqual(restarted.get(), state);
});

test('independent blanking and routing preserve every other output and master audio', async () => {
  const { store } = await fixture();
  let state = await store.command(0, { type: 'route', outputId: 'screen_main', sceneId: 'scene_message' });
  state = await store.command(state.revision, { type: 'take', sceneId: 'scene_close' });
  assert.equal(state.outputs[0].scene?.id, 'scene_message');
  assert.equal(state.program?.id, 'scene_close');
  state = await store.command(state.revision, { type: 'blank', outputId: 'screen_broadcast', blanked: true });
  assert.equal(state.outputs[0].blanked, false);
  assert.equal(state.outputs[1].blanked, true);
  assert.equal(state.outputs[1].audioEnabled, true);
  assert.equal(state.masterMuted, false);
});

test('legacy takes cut immediately and legacy production documents still load', async () => {
  const { dir, store } = await fixture();
  const legacy = store.get();
  assert.equal(legacy.programTransition, undefined);
  assert.equal(ProductionSchema.safeParse(legacy).success, true);
  const restarted = new ProductionStore(dir); await restarted.init();
  assert.deepEqual(restarted.get(), legacy);
  assert.deepEqual(CommandSchema.parse({ type: 'take', sceneId: 'scene_welcome' }), { type: 'take', sceneId: 'scene_welcome' });

  let state = await store.command(0, { type: 'take', sceneId: 'scene_welcome' });
  assert.equal(state.programTransition?.kind, 'cut');
  assert.equal(state.programTransition?.durationMs, 0);
  const token = state.programTransition?.id;
  assert.ok(token);
  state = await store.command(state.revision, { type: 'take', sceneId: 'scene_welcome', transition: 'cut', durationMs: 500 });
  assert.equal(state.programTransition?.durationMs, 0);
  assert.notEqual(state.programTransition?.id, token);
});

test('fade commits a new Program snapshot without changing pinned outputs or replaying on a draft save', async () => {
  const { dir, store } = await fixture();
  let state = await store.command(0, { type: 'take', sceneId: 'scene_welcome' });
  state = await store.command(state.revision, { type: 'route', outputId: 'screen_main', sceneId: 'scene_welcome' });
  const pinned = structuredClone(state.outputs[0]);
  const previousToken = state.programTransition?.id;
  state = await store.command(state.revision, { type: 'take', sceneId: 'scene_message', transition: 'fade', durationMs: 700 });
  assert.deepEqual(state.program, state.scenes[1]);
  assert.deepEqual(state.outputs[0], pinned);
  assert.equal(state.outputs[1].mode, 'program');
  assert.equal(state.programTransition?.kind, 'fade');
  assert.equal(state.programTransition?.durationMs, 700);
  assert.notEqual(state.programTransition?.id, previousToken);
  const transition = structuredClone(state.programTransition);
  const committed = structuredClone(state.program);

  state.scenes[1].layers[1].text = 'An unpublished fade edit';
  state.programTransition = { id: 'forged_transition', kind: 'fade', durationMs: 3000 };
  state = await store.save(state);
  assert.deepEqual(state.program, committed);
  assert.deepEqual(state.programTransition, transition);
  assert.deepEqual(state.outputs[0], pinned);
  state = await store.command(state.revision, { type: 'blank', outputId: 'screen_broadcast', blanked: true });
  assert.deepEqual(state.programTransition, transition);
  const restarted = new ProductionStore(dir); await restarted.init();
  assert.deepEqual(restarted.get(), state);

  state = await store.command(state.revision, { type: 'take', sceneId: 'scene_close', transition: 'fade' });
  assert.equal(state.programTransition?.durationMs, 300);
  assert.notEqual(state.programTransition?.id, transition?.id);
});

test('transition commands and persisted metadata reject invalid durations and unknown options', async () => {
  const take = { type: 'take', sceneId: 'scene_welcome', transition: 'fade' };
  for (const durationMs of [0, 99, 3001, 100.5, -100, NaN, Infinity, '300', null]) {
    assert.equal(CommandSchema.safeParse({ ...take, durationMs }).success, false, `Duration ${String(durationMs)} must be rejected`);
  }
  for (const durationMs of [100, 300, 3000]) assert.equal(CommandSchema.safeParse({ ...take, durationMs }).success, true);
  assert.equal(CommandSchema.safeParse({ ...take, transition: 'wipe' }).success, false);
  assert.equal(CommandSchema.safeParse({ ...take, id: 'forged_transition' }).success, false);
  const { store } = await fixture();
  for (const transition of [
    { id: 'transition_one', kind: 'cut', durationMs: 300 },
    { id: 'transition_one', kind: 'fade', durationMs: 0 },
    { id: 'transition_one', kind: 'fade', durationMs: 3001 },
    { id: 'transition_one', kind: 'wipe', durationMs: 300 },
  ]) assert.equal(ProductionSchema.safeParse({ ...store.get(), programTransition: transition }).success, false);
});

test('concurrent edits reject stale revisions instead of overwriting another operator', async () => {
  const { store } = await fixture();
  const a = store.get(), b = store.get(); a.scenes[0].name = 'Operator A'; b.scenes[0].name = 'Operator B';
  const results = await Promise.allSettled([store.save(a), store.save(b)]);
  assert.equal(results[0].status, 'fulfilled'); assert.equal(results[1].status, 'rejected');
  assert.equal((results[1] as PromiseRejectedResult).reason.status, 409);
  assert.equal(store.get().scenes[0].name, 'Operator A');
});

test('invalid source references, duplicate IDs and arbitrary media paths are rejected', async () => {
  const { store } = await fixture();
  const state = store.get(); state.scenes[0].layers[0].kind = 'source'; state.scenes[0].layers[0].sourceId = 'missing';
  assert.equal(ProductionSchema.safeParse(state).success, false);
  const duplicate = store.get(); duplicate.scenes.push(duplicate.scenes[0]);
  assert.equal(ProductionSchema.safeParse(duplicate).success, false);
  const source = { id: 'input_one', name: 'Invalid', kind: 'video' as const, url: 'http://example.com/private', loop: true, audio: { volume: 1, muted: false, mode: 'follow' as const, delayMs: 0 } };
  const bad = store.get(); bad.sources.push(source);
  assert.equal(ProductionSchema.safeParse(bad).success, false);
  await assert.rejects(store.command(0, { type: 'take', sceneId: 'missing' }), { status: 404 });
  assert.equal(store.get().revision, 0);
});

test('recording chunks are ordered, retry-idempotent, and marked recoverable after restart', async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'lumen-recording-test-'));
  const records = new RecordingStore(dir, () => {}); await records.init();
  const recording = await records.create('Sunday service');
  await assert.rejects(records.create('Second writer'), { status: 409 });
  await records.chunk(recording.id, 0, Buffer.from('first'));
  await records.chunk(recording.id, 0, Buffer.from('first'));
  await assert.rejects(records.chunk(recording.id, 2, Buffer.from('out of order')), { status: 409 });
  await records.chunk(recording.id, 1, Buffer.from('second'));
  assert.equal(records.active()!.bytes, 11);
  const restarted = new RecordingStore(dir, () => {}); await restarted.init();
  assert.equal(restarted.active(), null);
  assert.equal(restarted.list()[0].status, 'interrupted');
  assert.equal(restarted.list()[0].bytes, 11);
  await assert.rejects(restarted.chunk(recording.id, 2, Buffer.from('late')), { status: 409 });
});
