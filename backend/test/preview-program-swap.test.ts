import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { ProductionStore } from '../src/production-store.js';
import { CommandSchema } from '../src/production-schema.js';
import type { ProductionState, StudioSource } from '../../shared/production.js';

async function fixture() {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'lumen-preview-swap-'));
  const store = new ProductionStore(dir);
  await store.init();
  return { dir, store };
}

test('operator Cut and Fade atomically exchange Preview and Program on every take', async () => {
  const { dir, store } = await fixture();
  let state = await store.command(0, { type: 'take', sceneId: 'scene_welcome' });
  state.previewSceneId = 'scene_message';
  state = await store.save(state);
  const drafts = structuredClone(state.scenes);
  const beforeRevision = state.revision;

  state = await store.command(state.revision, { type: 'take', sceneId: state.previewSceneId!, transition: 'cut', swapPreview: true });
  assert.equal(state.program?.id, 'scene_message');
  assert.equal(state.previewSceneId, 'scene_welcome');
  assert.equal(state.revision, beforeRevision + 1, 'The exchange is one committed mutation');
  assert.equal(state.programTransition?.kind, 'cut');
  const cutToken = state.programTransition?.id;

  state = await store.command(state.revision, { type: 'take', sceneId: state.previewSceneId!, transition: 'fade', durationMs: 650, swapPreview: true });
  assert.equal(state.program?.id, 'scene_welcome');
  assert.equal(state.previewSceneId, 'scene_message');
  assert.equal(state.programTransition?.kind, 'fade');
  assert.equal(state.programTransition?.durationMs, 650);
  assert.notEqual(state.programTransition?.id, cutToken);

  state = await store.command(state.revision, { type: 'take', sceneId: state.previewSceneId!, transition: 'cut', swapPreview: true });
  assert.equal(state.program?.id, 'scene_message');
  assert.equal(state.previewSceneId, 'scene_welcome');
  assert.deepEqual(state.scenes, drafts, 'Swapping does not duplicate or overwrite scene drafts');
  const restarted = new ProductionStore(dir);
  await restarted.init();
  assert.deepEqual(restarted.get(), state, 'Both sides of the exchange survive a backend restart');
});

test('first, same-scene and deleted-outgoing takes keep a valid incoming Preview', async () => {
  const { store } = await fixture();
  let state = store.get();
  state.previewSceneId = 'scene_close';
  state = await store.save(state);
  state = await store.command(state.revision, { type: 'take', sceneId: 'scene_welcome', swapPreview: true });
  assert.equal(state.program?.id, 'scene_welcome');
  assert.equal(state.previewSceneId, 'scene_welcome', 'No prior Program exists on the first take');

  state = await store.command(state.revision, { type: 'take', sceneId: 'scene_welcome', swapPreview: true });
  assert.equal(state.previewSceneId, 'scene_welcome', 'Retaking a scene never clears Preview');
  const outgoing = structuredClone(state.program);
  state.scenes = state.scenes.filter(scene => scene.id !== 'scene_welcome');
  state.previewSceneId = 'scene_message';
  state = await store.save(state);
  assert.deepEqual(state.program, outgoing, 'Deleting the draft does not blank its committed Program picture');
  state = await store.command(state.revision, { type: 'take', sceneId: 'scene_message', swapPreview: true });
  assert.equal(state.program?.id, 'scene_message');
  assert.equal(state.previewSceneId, 'scene_message');
  assert.equal(state.scenes.some(scene => scene.id === 'scene_welcome'), false, 'A deleted outgoing draft is not recreated');
});

test('returning the old scene to Preview preserves unpublished draft edits', async () => {
  const { store } = await fixture();
  let state = await store.command(0, { type: 'take', sceneId: 'scene_welcome' });
  const committedWelcome = structuredClone(state.program);
  const welcome = state.scenes.find(scene => scene.id === 'scene_welcome')!;
  welcome.name = 'Welcome, revised';
  welcome.layers[1].text = 'Keep this unpublished draft';
  state.previewSceneId = 'scene_message';
  state = await store.save(state);
  assert.deepEqual(state.program, committedWelcome);
  const drafts = structuredClone(state.scenes);

  state = await store.command(state.revision, { type: 'take', sceneId: 'scene_message', swapPreview: true });
  assert.equal(state.previewSceneId, 'scene_welcome');
  assert.deepEqual(state.scenes, drafts);
  assert.equal(state.scenes.find(scene => scene.id === state.previewSceneId)?.layers[1].text, 'Keep this unpublished draft');
  const committedMessage = structuredClone(state.program);
  state = await store.command(state.revision, { type: 'take', sceneId: state.previewSceneId!, swapPreview: true });
  assert.deepEqual(state.program, drafts.find(scene => scene.id === 'scene_welcome'), 'Returning live commits the saved draft, not an obsolete snapshot');
  assert.equal(state.previewSceneId, committedMessage?.id);
  assert.deepEqual(state.scenes, drafts);
});

test('swapping preserves pinned outputs, persistent main audio and explicit input mix settings', async () => {
  const { store } = await fixture();
  let state = store.get();
  const microphone: StudioSource = { id: 'service_mic', name: 'Service mic', kind: 'microphone', loop: false,
    audio: { volume: 0.7, muted: true, mode: 'follow', delayMs: 125 } };
  const music: StudioSource = { id: 'service_music', name: 'Service music', kind: 'audio', url: '/media/music/music.mp3', loop: true,
    audio: { volume: 0.25, muted: true, mode: 'always', delayMs: 0 } };
  state.sources.push(microphone, music);
  state.masterVolume = 0.6;
  state.masterMuted = true;
  state = await store.save(state);
  state = await store.command(state.revision, { type: 'set-main-audio', sourceId: microphone.id });
  state = await store.command(state.revision, { type: 'take', sceneId: 'scene_welcome' });
  state = await store.command(state.revision, { type: 'route', outputId: 'screen_main', sceneId: 'scene_close' });
  state = await store.command(state.revision, { type: 'blank', outputId: 'screen_broadcast', blanked: true });
  const before = structuredClone(state);

  state = await store.command(state.revision, { type: 'take', sceneId: 'scene_message', transition: 'fade', durationMs: 700, swapPreview: true });
  assert.equal(state.program?.id, 'scene_message');
  assert.equal(state.previewSceneId, 'scene_welcome');
  for (const key of ['sources', 'scenes', 'outputs', 'masterVolume', 'masterMuted', 'mainAudioSourceId'] as const) {
    assert.deepEqual(state[key], before[key], `Swapping preserves ${key}`);
  }
});

test('legacy and direct API takes without the swap flag leave an unrelated Preview selection untouched', async () => {
  const { store } = await fixture();
  let state = await store.command(0, { type: 'take', sceneId: 'scene_welcome' });
  state.previewSceneId = 'scene_close';
  state = await store.save(state);
  state = await store.command(state.revision, { type: 'take', sceneId: 'scene_message', transition: 'fade', durationMs: 400 });
  assert.equal(state.program?.id, 'scene_message');
  assert.equal(state.previewSceneId, 'scene_close', 'Omitting swapPreview preserves the direct-Take API contract');
  state = await store.command(state.revision, { type: 'take', sceneId: 'scene_welcome', swapPreview: false });
  assert.equal(state.previewSceneId, 'scene_close');
});

test('stale, missing-scene and failed cue snapshots cannot partially exchange Preview and Program', async () => {
  const { dir, store } = await fixture();
  let state = await store.command(0, { type: 'take', sceneId: 'scene_welcome' });
  state.previewSceneId = 'scene_message';
  state = await store.save(state);
  await assert.rejects(store.command(state.revision - 1, { type: 'take', sceneId: 'scene_message', swapPreview: true }), { status: 409 });
  assert.deepEqual(store.get(), state);
  await assert.rejects(store.command(state.revision, { type: 'take', sceneId: 'missing_scene', swapPreview: true }), { status: 404 });
  assert.deepEqual(store.get(), state);

  const failing = new ProductionStore(dir, () => {}, async () => { throw new Error('Cue snapshot unavailable'); });
  await failing.init();
  await assert.rejects(failing.command(state.revision, { type: 'take', sceneId: 'scene_message', swapPreview: true }), /Cue snapshot unavailable/);
  assert.deepEqual(failing.get(), state);
  assert.deepEqual(JSON.parse(await fs.readFile(path.join(dir, 'production.json'), 'utf8')), state);
});

test('a delayed cue snapshot publishes the new Program and outgoing Preview together', async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'lumen-preview-swap-gates-'));
  const events: ProductionState[] = [];
  let hold = false;
  let release!: (gates: NonNullable<ProductionState['programCueGates']>) => void;
  let entered!: () => void;
  const enteredSnapshot = new Promise<void>(resolve => { entered = resolve; });
  const deferredGates = new Promise<NonNullable<ProductionState['programCueGates']>>(resolve => { release = resolve; });
  const store = new ProductionStore(dir, state => events.push(state), async ids => {
    if (!hold) return [];
    assert.deepEqual(ids, ['scripture_channel']);
    entered();
    return deferredGates;
  });
  await store.init();
  let state = store.get();
  state.sources.push({ id: 'scripture_source', name: 'Scripture', kind: 'channel', channelId: 'scripture_channel', loop: false,
    audio: { volume: 1, muted: true, mode: 'follow', delayMs: 0 } });
  state.scenes.find(scene => scene.id === 'scene_message')!.layers.push({ ...state.scenes[0].layers[0],
    id: 'scripture_layer', kind: 'source', sourceId: 'scripture_source' });
  state = await store.save(state);
  state = await store.command(state.revision, { type: 'take', sceneId: 'scene_welcome' });
  state.previewSceneId = 'scene_message';
  state = await store.save(state);
  events.length = 0;
  hold = true;
  const taking = store.command(state.revision, { type: 'take', sceneId: 'scene_message', transition: 'fade', durationMs: 500, swapPreview: true });
  await enteredSnapshot;
  assert.deepEqual(store.get(), state, 'Readers still see the complete old state while cue readiness is captured');
  assert.deepEqual(JSON.parse(await fs.readFile(path.join(dir, 'production.json'), 'utf8')), state);
  assert.equal(events.length, 0, 'No half-swapped state is broadcast');
  release([{ channelId: 'scripture_channel', revision: 27 }]);
  const swapped = await taking;
  assert.equal(swapped.program?.id, 'scene_message');
  assert.equal(swapped.previewSceneId, 'scene_welcome');
  assert.equal(swapped.revision, state.revision + 1);
  assert.deepEqual(swapped.programCueGates, [{ channelId: 'scripture_channel', revision: 27 }]);
  assert.deepEqual(events, [swapped]);
});

test('Take schema accepts only an explicit boolean swapPreview option', () => {
  const base = { type: 'take', sceneId: 'scene_welcome' };
  assert.deepEqual(CommandSchema.parse(base), base);
  for (const swapPreview of [true, false]) assert.deepEqual(CommandSchema.parse({ ...base, swapPreview }), { ...base, swapPreview });
  for (const swapPreview of ['true', 1, null, {}]) assert.equal(CommandSchema.safeParse({ ...base, swapPreview }).success, false);
});
