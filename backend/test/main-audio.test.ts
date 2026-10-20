import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { ProductionStore } from '../src/production-store.js';
import { CommandSchema, ProductionSchema, initialProduction } from '../src/production-schema.js';
import { sourceAudioWeight, outputAudioEnabled } from '../../frontend/src/lib/studio/audio-routing.js';
import type { StudioSource } from '../../shared/production.js';

function source(id: string, muted = true, kind: StudioSource['kind'] = 'microphone'): StudioSource {
  return { id, name: id, kind, loop: false, ...(kind === 'image' ? { url: 'media/backgrounds/logo.png' } : {}),
    audio: { volume: .6, muted, mode: 'follow', delayMs: 80 } };
}
async function fixture() {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'lumen-main-audio-'));
  const store = new ProductionStore(dir); await store.init();
  const state = store.get();
  state.sources = [source('mixer'), source('backup'), source('extra', false), source('logo', true, 'image')];
  state.masterMuted = true; state.masterVolume = .7;
  await store.save(state);
  return { store, dir };
}

test('main audio selection persists across scenes, independent output routes, mute and restart', async () => {
  const { store, dir } = await fixture();
  let state = await store.command(store.get().revision, { type: 'set-main-audio', sourceId: 'mixer' });
  assert.equal(state.mainAudioSourceId, 'mixer');
  assert.deepEqual(state.sources[0].audio, { volume: .6, muted: false, mode: 'follow', delayMs: 80 });
  assert.equal(state.masterMuted, true); assert.equal(state.masterVolume, .7);
  state = await store.command(state.revision, { type: 'take', sceneId: 'scene_message' });
  state = await store.command(state.revision, { type: 'take', sceneId: 'scene_close', transition: 'fade', durationMs: 700 });
  state = await store.command(state.revision, { type: 'route', outputId: 'screen_main', sceneId: 'scene_welcome' });
  state = await store.command(state.revision, { type: 'blank', outputId: 'screen_broadcast', blanked: true });
  assert.equal(state.mainAudioSourceId, 'mixer');
  assert.equal(state.sources[0].audio.muted, false);
  assert.equal(state.outputs[0].audioEnabled, false);
  assert.equal(state.outputs[1].audioEnabled, true);
  const restarted = new ProductionStore(dir); await restarted.init();
  assert.deepEqual(restarted.get(), state);
});

test('replacing or clearing main audio mutes only the previous main, preserving explicit extras and final mute', async () => {
  const { store } = await fixture();
  let state = await store.command(store.get().revision, { type: 'set-main-audio', sourceId: 'mixer' });
  const before = structuredClone(state);
  state = await store.command(state.revision, { type: 'set-main-audio', sourceId: 'backup' });
  assert.equal(state.mainAudioSourceId, 'backup');
  assert.equal(state.sources[0].audio.muted, true);
  assert.equal(state.sources[1].audio.muted, false);
  assert.deepEqual(state.sources[2], before.sources[2]);
  assert.equal(state.masterMuted, true); assert.equal(state.masterVolume, .7);
  assert.deepEqual(state.scenes, before.scenes); assert.deepEqual(state.outputs, before.outputs);
  state = await store.command(state.revision, { type: 'set-main-audio', sourceId: null });
  assert.equal(state.mainAudioSourceId, null);
  assert.equal(state.sources[1].audio.muted, true);
  assert.equal(state.sources[2].audio.muted, false);
});

test('legacy and forged whole-document saves cannot replace main audio; deletion requires explicit replacement', async () => {
  const { store } = await fixture();
  let state = await store.command(store.get().revision, { type: 'set-main-audio', sourceId: 'mixer' });
  delete state.mainAudioSourceId;
  state = await store.save(state);
  assert.equal(state.mainAudioSourceId, 'mixer');
  state.mainAudioSourceId = 'backup';
  state = await store.save(state);
  assert.equal(state.mainAudioSourceId, 'mixer');
  const revision = state.revision;
  state.sources = state.sources.filter(source => source.id !== 'mixer');
  await assert.rejects(store.save(state), { status: 422 });
  assert.equal(store.get().revision, revision);
  await assert.rejects(store.command(revision, { type: 'set-main-audio', sourceId: 'missing' }), { status: 404 });
  await assert.rejects(store.command(revision, { type: 'set-main-audio', sourceId: 'logo' }), { status: 422 });
  await assert.rejects(store.command(revision - 1, { type: 'set-main-audio', sourceId: 'backup' }), { status: 409 });
  assert.equal(store.get().mainAudioSourceId, 'mixer');
  await store.command(revision, { type: 'set-main-audio', sourceId: null });
  const cleared = store.get(); cleared.sources = cleared.sources.filter(source => source.id !== 'mixer');
  assert.ok(await store.save(cleared));
});

test('old stations keep their deliberate mixes and main audio commands reject malformed input', () => {
  const old = initialProduction(); delete old.mainAudioSourceId;
  old.sources.push(source('legacy', false));
  const parsed = ProductionSchema.parse(old);
  assert.equal(parsed.mainAudioSourceId, null);
  assert.equal(parsed.sources[0].audio.muted, false);
  for (const command of [
    { type: 'set-main-audio' }, { type: 'set-main-audio', sourceId: '' },
    { type: 'set-main-audio', sourceId: 'mixer', muted: false }, { type: 'set-main-audio', sourceId: 1 },
  ]) assert.equal(CommandSchema.safeParse(command).success, false);
  assert.equal(CommandSchema.safeParse({ type: 'set-main-audio', sourceId: null }).success, true);
});

test('main audio is exactly one route in every scene and fade, while extra audio retains its routing', () => {
  const main = source('mixer');
  for (const followsProgram of [true, false]) {
    for (const sceneWeight of [0, .2, .8, 1]) {
      assert.equal(sourceAudioWeight(main, 'mixer', true, followsProgram, .3, sceneWeight), 1);
    }
  }
  assert.equal(sourceAudioWeight(main, null, true, true, .3, .2), .2);
  assert.equal(sourceAudioWeight(main, 'other', true, false, 0, 0), 0);
  main.audio.mode = 'always';
  assert.equal(sourceAudioWeight(main, 'other', true, false, .3, 0), 1);
  assert.equal(sourceAudioWeight(main, 'other', false, true, .3, 1), .3);
  assert.equal(sourceAudioWeight(main, 'other', false, false, .3, 1), 0);
});

test('main audio never enables a silent projector or Preview output', () => {
  assert.equal(outputAudioEnabled('preview', true), false);
  assert.equal(outputAudioEnabled('program'), true);
  assert.equal(outputAudioEnabled('auditorium', false), false);
  assert.equal(outputAudioEnabled('auditorium'), false);
  assert.equal(outputAudioEnabled('broadcast', true), true);
});
