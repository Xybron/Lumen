import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import type { LayerAnimation, ProductionState } from '../../shared/production';
import { AnimationRunTracker, ANIMATION_PRESETS, animationTotalMs, createAnimation, sampleAnimation } from '../../frontend/src/lib/studio/animation';
import { blendScenes, weightedScene } from '../../frontend/src/lib/studio/transition';
import { initialProduction, LayerAnimationSchema, ProductionSchema } from '../src/production-schema.js';
import { ProductionStore } from '../src/production-store.js';

const identity = { x: 0, y: 0, scale: 1, opacity: 1, rotation: 0 };
const scene = () => initialProduction().scenes[0];

test('every preset is a valid independent entrance that finishes at the saved design pose', () => {
  for (const { value } of ANIMATION_PRESETS) {
    const animation = createAnimation(value);
    assert.equal(LayerAnimationSchema.safeParse(animation).success, true, value);
    assert.equal(animation.preset, value);
    assert.deepEqual(sampleAnimation(animation, 600), identity);
    assert.deepEqual(sampleAnimation(animation, 100000), identity);
    assert.equal(sampleAnimation(animation, 0).opacity, 0);
    assert.deepEqual(sampleAnimation(animation, null), identity);
    animation.keyframes[0].x = 500;
    assert.notEqual(createAnimation(value).keyframes[0].x, 500, 'presets never share mutable keyframes');
  }
  assert.equal(sampleAnimation(createAnimation('slide-up'), 0).y, 64);
  assert.equal(sampleAnimation(createAnimation('slide-down'), 0).y, -64);
  assert.equal(sampleAnimation(createAnimation('slide-left'), 0).x, 96);
  assert.equal(sampleAnimation(createAnimation('slide-right'), 0).x, -96);
  assert.equal(sampleAnimation(createAnimation('scale'), 0).scale, .85);
});

test('sampling interpolates custom keyframes with a delay, easing, opacity and centred transforms', () => {
  const animation: LayerAnimation = {
    enabled: true, preset: 'custom', durationMs: 1000, delayMs: 200, easing: 'linear',
    keyframes: [
      { offset: 0, x: -400, y: 100, scale: .5, opacity: 0, rotation: -90 },
      { offset: .5, x: -100, y: 20, scale: .8, opacity: .6, rotation: -30 },
      { offset: 1, ...identity },
    ],
  };
  const copy = structuredClone(animation);
  assert.deepEqual(sampleAnimation(animation, -100), { x: -400, y: 100, scale: .5, opacity: 0, rotation: -90 });
  assert.deepEqual(sampleAnimation(animation, 200), sampleAnimation(animation, 0), 'delay holds the first keyframe');
  assert.deepEqual(sampleAnimation(animation, 450), { x: -250, y: 60, scale: .65, opacity: .3, rotation: -60 });
  assert.deepEqual(sampleAnimation(animation, 700), { x: -100, y: 20, scale: .8, opacity: .6, rotation: -30 });
  assert.deepEqual(sampleAnimation(animation, 950), { x: -50, y: 10, scale: .9, opacity: .8, rotation: -15 });
  assert.deepEqual(sampleAnimation(animation, 1200), identity);
  assert.deepEqual(sampleAnimation({ ...animation, easing: 'ease-out' }, 700), sampleAnimation(animation, 700), 'keyframe timeline timestamps remain exact with easing');
  assert.deepEqual(animation, copy, 'sampling must not modify saved snapshots');

  const fade = { ...createAnimation('fade'), durationMs: 1000 };
  assert.equal(sampleAnimation({ ...fade, easing: 'linear' }, 500).opacity, .5);
  assert.equal(sampleAnimation({ ...fade, easing: 'ease-in' }, 500).opacity, .125);
  assert.equal(sampleAnimation({ ...fade, easing: 'ease-out' }, 500).opacity, .875);
  assert.equal(sampleAnimation({ ...fade, easing: 'ease-in-out' }, 250).opacity, .0625);
  assert.equal(sampleAnimation({ ...fade, easing: 'ease-in-out' }, 750).opacity, .9375);
});

test('disabled, absent and clockless animations render the final pose; duration ignores hidden layers', () => {
  const animation = createAnimation('slide-up');
  assert.deepEqual(sampleAnimation(undefined, 0), identity);
  assert.deepEqual(sampleAnimation({ ...animation, enabled: false }, 0), identity);
  assert.deepEqual(sampleAnimation(animation, null), identity);
  assert.deepEqual(sampleAnimation(animation, NaN), identity);
  const target = scene();
  assert.equal(animationTotalMs(null), 0);
  assert.equal(animationTotalMs(target), 0);
  target.layers[0].animation = { ...animation, durationMs: 1000, delayMs: 200 };
  target.layers[1].animation = { ...animation, enabled: false, durationMs: 3000 };
  target.layers[2].animation = { ...animation, durationMs: 5000 };
  target.layers[2].visible = false;
  assert.equal(animationTotalMs(target), 1200);
});

test('animation validation rejects invalid ranges, malformed timing, unordered frames and moving final poses', () => {
  const good = createAnimation('custom');
  const invalid: unknown[] = [
    { ...good, durationMs: 99 }, { ...good, durationMs: 10001 }, { ...good, durationMs: 100.5 },
    { ...good, delayMs: -1 }, { ...good, delayMs: 10001 }, { ...good, delayMs: 1.5 },
    { ...good, preset: 'spin-forever' }, { ...good, easing: 'spring' }, { ...good, repeat: true },
    { ...good, keyframes: [] }, { ...good, keyframes: [good.keyframes[0]] },
    { ...good, keyframes: Array.from({ length: 13 }, (_, index) => ({ offset: index / 12, ...identity })) },
    { ...good, keyframes: [{ ...good.keyframes[0], offset: .1 }, good.keyframes[1]] },
    { ...good, keyframes: [good.keyframes[0], { ...good.keyframes[1], offset: .9 }] },
    { ...good, keyframes: [good.keyframes[0], { offset: 0, ...identity }, good.keyframes[1]] },
    { ...good, keyframes: [good.keyframes[0], { offset: .7, ...identity }, { offset: .3, ...identity }, good.keyframes[1]] },
    { ...good, keyframes: [good.keyframes[0], { ...good.keyframes[1], x: 1 }] },
    { ...good, keyframes: [good.keyframes[0], { ...good.keyframes[1], opacity: .9 }] },
    { ...good, keyframes: [good.keyframes[0], { ...good.keyframes[1], rotation: 1 }] },
    { ...good, keyframes: [good.keyframes[0], { ...good.keyframes[1], scale: .9 }] },
  ];
  for (const [key, values] of Object.entries({ x: [-3841, 3841, NaN, Infinity], y: [-2161, 2161], scale: [0, .049, 4.01], opacity: [-.1, 1.01], rotation: [-361, 361] })) {
    for (const value of values) invalid.push({ ...good, keyframes: [{ ...good.keyframes[0], [key]: value }, good.keyframes[1]] });
  }
  for (const animation of invalid) assert.equal(LayerAnimationSchema.safeParse(animation).success, false, JSON.stringify(animation));
  assert.equal(LayerAnimationSchema.safeParse(good).success, true);
  assert.equal(ProductionSchema.safeParse(initialProduction()).success, true, 'old files do not need migration');
});

test('animation clocks only start on deliberate commits and remain independent for pinned outputs', () => {
  const state = initialProduction();
  state.programTransition = { id: 'stored_take', kind: 'cut', durationMs: 0 };
  state.outputs[0] = { ...state.outputs[0], mode: 'scene', scene: state.scenes[0], sceneRunId: 'stored_pin' };
  const tracker = new AnimationRunTracker(state);
  assert.equal(tracker.program, null, 'engine startup never replays a stored Take');
  assert.equal(tracker.output('screen_main'), null, 'engine startup never replays a stored pin');
  assert.equal(tracker.update(structuredClone(state), 500), false);

  state.programTransition.id = 'new_take';
  assert.equal(tracker.update(state, 1000), true);
  assert.deepEqual(tracker.program, { id: 'new_take', startedAt: 1000 });
  assert.equal(tracker.output('screen_main'), null);
  state.revision++; state.scenes[0].name = 'Draft change';
  state.outputs[0].blanked = true;
  assert.equal(tracker.update(state, 1100), false);
  state.outputs[0].blanked = false;
  assert.equal(tracker.update(state, 1200), false);
  assert.equal(tracker.program?.startedAt, 1000, 'draft edits and unblanking do not restart Program');
  assert.equal(tracker.output('screen_main'), null, 'unblanking does not restart a pin');

  state.outputs[0].sceneRunId = 'new_pin';
  tracker.update(state, 1300);
  assert.deepEqual(tracker.output('screen_main'), { id: 'new_pin', startedAt: 1300 });
  assert.equal(tracker.program?.startedAt, 1000);
  assert.equal(tracker.update(structuredClone(state), 1400), false);
  assert.equal(tracker.output('screen_main')?.startedAt, 1300);
  state.programTransition.id = 'retake_same_scene';
  tracker.update(state, 2000);
  assert.equal(tracker.program?.startedAt, 2000, 'the same scene can be deliberately replayed');
  assert.equal(tracker.output('screen_main')?.startedAt, 1300, 'Program never restarts a pinned output');
  state.outputs[0].mode = 'program'; state.outputs[0].scene = null; delete state.outputs[0].sceneRunId;
  tracker.update(state, 2100);
  assert.equal(tracker.output('screen_main'), null);
});

test('interrupted crossfades preserve outgoing element animation clocks, including repeated scene takes', () => {
  const a = scene(), b = { ...scene(), id: 'next_scene' };
  const first = blendScenes([weightedScene(a, 1, { id: 'run_a', startedAt: 0 })], a, .4, { id: 'run_b', startedAt: 100 });
  assert.deepEqual(first, [
    { scene: a, weight: .6, runId: 'run_a', animationStartedAt: 0 },
    { scene: a, weight: .4, runId: 'run_b', animationStartedAt: 100 },
  ], 'different entrances of the same scene must not be merged');
  const interrupted = blendScenes(first, b, .5, { id: 'run_c', startedAt: 200 });
  assert.deepEqual(interrupted.map(({ weight, runId, animationStartedAt }) => ({ weight, runId, animationStartedAt })), [
    { weight: .3, runId: 'run_a', animationStartedAt: 0 },
    { weight: .2, runId: 'run_b', animationStartedAt: 100 },
    { weight: .5, runId: 'run_c', animationStartedAt: 200 },
  ]);
});

test('animation snapshots and run IDs persist safely without draft saves changing live playback', async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'lumen-animation-test-'));
  try {
    const store = new ProductionStore(dir); await store.init();
    let state = store.get();
    state.scenes[0].layers[0].animation = createAnimation('slide-up');
    state = await store.save(state);
    assert.equal(state.program, null);
    state = await store.command(state.revision, { type: 'take', sceneId: 'scene_welcome' });
    state = await store.command(state.revision, { type: 'route', outputId: 'screen_main', sceneId: 'scene_welcome' });
    const committed = structuredClone(state.program), pinned = structuredClone(state.outputs[0]);
    const transition = structuredClone(state.programTransition);
    assert.ok(pinned.sceneRunId);
    state.scenes[0].layers[0].animation = createAnimation('scale');
    state.program!.layers[0].animation!.durationMs = 9999;
    state.outputs[0].scene!.layers[0].animation!.durationMs = 9999;
    state.outputs[0].sceneRunId = 'forged_pin';
    state = await store.save(state);
    assert.deepEqual(state.program, committed);
    assert.deepEqual(state.outputs[0], pinned);
    assert.deepEqual(state.programTransition, transition);
    state = await store.command(state.revision, { type: 'blank', outputId: 'screen_main', blanked: true });
    state = await store.command(state.revision, { type: 'blank', outputId: 'screen_main', blanked: false });
    assert.equal(state.outputs[0].sceneRunId, pinned.sceneRunId);
    state = await store.command(state.revision, { type: 'route', outputId: 'screen_main', sceneId: 'scene_welcome' });
    assert.notEqual(state.outputs[0].sceneRunId, pinned.sceneRunId, 'explicit re-routing replays the new committed entrance');
    assert.equal(state.outputs[0].scene!.layers[0].animation!.preset, 'scale');
    const restarted = new ProductionStore(dir); await restarted.init();
    assert.deepEqual(restarted.get(), state);
    const tracker = new AnimationRunTracker(restarted.get());
    assert.equal(tracker.program, null); assert.equal(tracker.output('screen_main'), null);
    state = await store.command(state.revision, { type: 'route', outputId: 'screen_main', sceneId: null });
    assert.equal(state.outputs[0].sceneRunId, undefined);
    assert.equal(state.outputs[0].mode, 'program');
  } finally { await fs.rm(dir, { recursive: true, force: true }); }
});

test('new output inputs cannot forge a pinned animation run', async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'lumen-animation-output-test-'));
  try {
    const store = new ProductionStore(dir); await store.init();
    const input: ProductionState = store.get();
    input.outputs.push({ ...input.outputs[0], id: 'new_output', mode: 'scene', scene: input.scenes[0], sceneRunId: 'forged_run' });
    const state = await store.save(input), output = state.outputs.find(value => value.id === 'new_output')!;
    assert.equal(output.mode, 'program'); assert.equal(output.scene, null); assert.equal(output.sceneRunId, undefined);
  } finally { await fs.rm(dir, { recursive: true, force: true }); }
});
