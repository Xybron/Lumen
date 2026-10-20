import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { ProductionStore } from '../src/production-store.js';
import { AnimationPresetSchema, CommandSchema, initialProduction, ProductionSchema } from '../src/production-schema.js';
import type { LayerAnimation, ProductionState, StudioAnimationPreset } from '../../shared/production.js';

function animation(): LayerAnimation {
  return {
    enabled: false, preset: 'slide-up', durationMs: 1250, delayMs: 180, easing: 'ease-in-out',
    keyframes: [
      { offset: 0, x: -180, y: 140, scale: .7, rotation: -12, opacity: 0 },
      { offset: .6, x: 24, y: -10, scale: 1.05, rotation: 3, opacity: .8 },
      { offset: 1, x: 0, y: 0, scale: 1, rotation: 0, opacity: 1 },
    ],
  };
}

async function fixture(t: { after: (fn: () => Promise<void>) => void }, state?: ProductionState) {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'lumen-animation-presets-test-'));
  t.after(() => fs.rm(dir, { recursive: true, force: true }));
  if (state) await fs.writeFile(path.join(dir, 'production.json'), JSON.stringify(state));
  const store = new ProductionStore(dir);
  await store.init();
  return { dir, store };
}

function committedState(state: ProductionState) {
  const { revision: _revision, updatedAt: _updatedAt, animationPresets: _presets, ...content } = state;
  return content;
}

function savedPreset(index: number): StudioAnimationPreset {
  return {
    id: `preset_${index}`, name: `Animation ${index}`, animation: { ...animation(), enabled: true, preset: 'custom' },
    createdAt: '2026-10-18T07:00:00.000Z', updatedAt: '2026-10-18T07:00:00.000Z',
  };
}

test('legacy station documents load with an empty animation library and persist it on their next save', async t => {
  const legacy = initialProduction();
  delete legacy.animationPresets;
  assert.deepEqual(ProductionSchema.parse(legacy).animationPresets, []);
  const { dir, store } = await fixture(t, legacy);
  assert.deepEqual(store.get().animationPresets, []);
  const saved = await store.save(store.get());
  assert.deepEqual(JSON.parse(await fs.readFile(path.join(dir, 'production.json'), 'utf8')).animationPresets, []);
  const restarted = new ProductionStore(dir);
  await restarted.init();
  assert.deepEqual(restarted.get(), saved);
});

test('saving creates a reusable enabled custom definition with server metadata and independent copies', async t => {
  const { dir, store } = await fixture(t);
  const definition = animation();
  const initial = store.get();
  const saved = await store.command(initial.revision, { type: 'save-animation-preset', name: '  Speaker entrance  ', animation: definition });
  const preset = saved.animationPresets![0];
  assert.match(preset.id, /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
  assert.equal(preset.name, 'Speaker entrance');
  assert.deepEqual(preset.animation, { ...definition, enabled: true, preset: 'custom' });
  assert.equal(preset.createdAt, preset.updatedAt);
  assert.ok(Number.isFinite(Date.parse(preset.createdAt)));
  assert.deepEqual(committedState(saved), committedState(initial));
  definition.keyframes[0].x = 999;
  preset.animation.keyframes[0].opacity = 1;
  assert.equal(store.get().animationPresets![0].animation.keyframes[0].x, -180);
  assert.equal(store.get().animationPresets![0].animation.keyframes[0].opacity, 0);
  const restarted = new ProductionStore(dir);
  await restarted.init();
  assert.deepEqual(restarted.get(), store.get());
});

test('preset library saves, renames and deletions never change draft, live, pinned or animation run snapshots', async t => {
  const { store } = await fixture(t);
  let state = await store.command(0, { type: 'take', sceneId: 'scene_welcome', transition: 'fade', durationMs: 700 });
  state = await store.command(state.revision, { type: 'route', outputId: 'screen_main', sceneId: 'scene_message' });
  const committed = committedState(state);
  state = await store.command(state.revision, { type: 'save-animation-preset', name: 'Gentle reveal', animation: animation() });
  const id = state.animationPresets![0].id;
  assert.deepEqual(committedState(state), committed);
  state = await store.command(state.revision, { type: 'rename-animation-preset', presetId: id, name: 'Gentle arrival' });
  assert.deepEqual(committedState(state), committed);
  state = await store.command(state.revision, { type: 'delete-animation-preset', presetId: id });
  assert.deepEqual(committedState(state), committed);
  assert.deepEqual(state.animationPresets, []);
});

test('renames preserve preset identity, definition and creation time and can change their own name casing', async t => {
  const { dir, store } = await fixture(t);
  let state = await store.command(0, { type: 'save-animation-preset', name: 'Title reveal', animation: animation() });
  const original = structuredClone(state.animationPresets![0]);
  state = await store.command(state.revision, { type: 'rename-animation-preset', presetId: original.id, name: '  TITLE REVEAL  ' });
  const renamed = state.animationPresets![0];
  assert.equal(renamed.id, original.id);
  assert.equal(renamed.name, 'TITLE REVEAL');
  assert.deepEqual(renamed.animation, original.animation);
  assert.equal(renamed.createdAt, original.createdAt);
  assert.ok(Date.parse(renamed.updatedAt) >= Date.parse(original.updatedAt));
  const restarted = new ProductionStore(dir);
  await restarted.init();
  assert.deepEqual(restarted.get(), state);
});

test('duplicate names are rejected regardless of case, compatibility characters or surrounding whitespace', async t => {
  const { store } = await fixture(t);
  let state = await store.command(0, { type: 'save-animation-preset', name: 'Fade', animation: animation() });
  for (const name of ['fade', ' FADE ', 'Ｆａｄｅ']) {
    await assert.rejects(store.command(state.revision, { type: 'save-animation-preset', name, animation: animation() }), { status: 409 });
    assert.deepEqual(store.get(), state);
  }
  state = await store.command(state.revision, { type: 'save-animation-preset', name: 'Slide', animation: animation() });
  await assert.rejects(store.command(state.revision, { type: 'rename-animation-preset', presetId: state.animationPresets![1].id, name: 'ＦＡＤＥ' }), { status: 409 });
  assert.deepEqual(store.get(), state);
});

test('whole-document edits cannot inject, erase or modify the authoritative animation library', async t => {
  const { store } = await fixture(t);
  let state = await store.command(0, { type: 'save-animation-preset', name: 'Original', animation: animation() });
  const library = structuredClone(state.animationPresets);
  for (const replacement of [undefined, [], [savedPreset(99)]]) {
    const edit = structuredClone(state);
    edit.animationPresets = replacement;
    edit.scenes[0].name = `Normal edit ${state.revision}`;
    state = await store.save(ProductionSchema.parse(edit));
    assert.deepEqual(state.animationPresets, library);
    assert.equal(state.scenes[0].name, edit.scenes[0].name);
  }
  const forged = structuredClone(state);
  forged.animationPresets![0].animation.keyframes[0].x = 999;
  state = await store.save(forged);
  assert.deepEqual(state.animationPresets, library);
});

test('deleting a preset leaves copies already applied to layers and committed outputs intact', async t => {
  const { dir, store } = await fixture(t);
  let state = await store.command(0, { type: 'save-animation-preset', name: 'Reusable', animation: animation() });
  const preset = structuredClone(state.animationPresets![0]);
  state.scenes[0].layers[0].animation = structuredClone(preset.animation);
  state.scenes[1].layers[0].animation = structuredClone(preset.animation);
  state = await store.save(state);
  state = await store.command(state.revision, { type: 'take', sceneId: 'scene_welcome' });
  state = await store.command(state.revision, { type: 'route', outputId: 'screen_main', sceneId: 'scene_message' });
  state = await store.command(state.revision, { type: 'delete-animation-preset', presetId: preset.id });
  assert.deepEqual(state.animationPresets, []);
  assert.deepEqual(state.scenes[0].layers[0].animation, preset.animation);
  assert.deepEqual(state.scenes[1].layers[0].animation, preset.animation);
  assert.deepEqual(state.program!.layers[0].animation, preset.animation);
  assert.deepEqual(state.outputs[0].scene!.layers[0].animation, preset.animation);
  const restarted = new ProductionStore(dir);
  await restarted.init();
  assert.deepEqual(restarted.get(), state);
});

test('a full library blocks only new saves and frees capacity after a deletion', async t => {
  const initial = initialProduction();
  initial.animationPresets = Array.from({ length: 100 }, (_, index) => savedPreset(index));
  const { store } = await fixture(t, initial);
  await assert.rejects(store.command(0, { type: 'save-animation-preset', name: 'One too many', animation: animation() }), { status: 409 });
  assert.equal(store.get().revision, 0);
  let state = await store.command(0, { type: 'rename-animation-preset', presetId: 'preset_0', name: 'A renamed preset' });
  state = await store.command(state.revision, { type: 'delete-animation-preset', presetId: 'preset_0' });
  state = await store.command(state.revision, { type: 'save-animation-preset', name: 'New arrival', animation: animation() });
  assert.equal(state.animationPresets!.length, 100);
  assert.equal(state.animationPresets![99].name, 'New arrival');
});

test('missing presets and stale revisions fail without changing the station library', async t => {
  const { store } = await fixture(t);
  await assert.rejects(store.command(0, { type: 'rename-animation-preset', presetId: 'missing', name: 'Renamed' }), { status: 404 });
  await assert.rejects(store.command(0, { type: 'delete-animation-preset', presetId: 'missing' }), { status: 404 });
  const commands = await Promise.allSettled([
    store.command(0, { type: 'save-animation-preset', name: 'Operator A', animation: animation() }),
    store.command(0, { type: 'save-animation-preset', name: 'Operator B', animation: animation() }),
  ]);
  assert.equal(commands[0].status, 'fulfilled');
  assert.equal(commands[1].status, 'rejected');
  assert.equal((commands[1] as PromiseRejectedResult).reason.status, 409);
  assert.equal(store.get().animationPresets!.length, 1);
  assert.equal(store.get().animationPresets![0].name, 'Operator A');
});

test('preset commands enforce bounded names, strict payloads and the existing animation validation', () => {
  const save = { type: 'save-animation-preset', name: 'Motion', animation: animation() };
  assert.equal(CommandSchema.safeParse(save).success, true);
  assert.equal(CommandSchema.parse({ ...save, name: ' Motion ' }).name, 'Motion');
  for (const name of ['', '   ', 'x'.repeat(101), null, 1]) {
    assert.equal(CommandSchema.safeParse({ ...save, name }).success, false);
    assert.equal(CommandSchema.safeParse({ type: 'rename-animation-preset', presetId: 'preset_one', name }).success, false);
  }
  assert.equal(CommandSchema.safeParse({ ...save, id: 'client_chosen' }).success, false);
  assert.equal(CommandSchema.safeParse({ type: 'delete-animation-preset', presetId: 'preset_one', name: 'Unexpected' }).success, false);
  assert.equal(CommandSchema.safeParse({ type: 'rename-animation-preset', presetId: '../file', name: 'Bad ID' }).success, false);
  for (const patch of [
    { durationMs: 99 }, { durationMs: 10001 }, { delayMs: -1 }, { easing: 'bounce' },
    { keyframes: [] }, { keyframes: [{ ...animation().keyframes[0], offset: .2 }, animation().keyframes[2]] },
    { keyframes: [animation().keyframes[0], { ...animation().keyframes[2], x: 1 }] },
    { keyframes: [animation().keyframes[0], { ...animation().keyframes[1], opacity: 2 }, animation().keyframes[2]] },
  ]) assert.equal(CommandSchema.safeParse({ ...save, animation: { ...animation(), ...patch } }).success, false);
});

test('stored libraries reject malformed records, duplicate names and IDs, and excessive capacity', () => {
  const record = savedPreset(0);
  assert.equal(AnimationPresetSchema.safeParse(record).success, true);
  assert.equal(AnimationPresetSchema.safeParse({ ...record, createdAt: 'not-a-date' }).success, false);
  assert.equal(AnimationPresetSchema.safeParse({ ...record, updatedAt: 'tomorrow' }).success, false);
  assert.equal(AnimationPresetSchema.safeParse({ ...record, injected: true }).success, false);
  const initial = initialProduction();
  for (const animationPresets of [
    [record, { ...savedPreset(1), id: record.id }],
    [record, { ...savedPreset(1), name: 'ＡＮＩＭＡＴＩＯＮ ０' }],
    Array.from({ length: 101 }, (_, index) => savedPreset(index)),
  ]) assert.equal(ProductionSchema.safeParse({ ...initial, animationPresets }).success, false);
});
