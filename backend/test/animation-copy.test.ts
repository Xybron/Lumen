import assert from 'node:assert/strict';
import test from 'node:test';
import type { StudioAnimationPreset } from '../../shared/production';
import { animationFromPreset, cloneAnimation, createAnimation } from '../../frontend/src/lib/studio/animation';

test('animation copies preserve all motion settings without sharing mutable frames', () => {
  const original = { ...createAnimation('slide-up'), durationMs: 1240, delayMs: 430, enabled: false };
  original.keyframes.splice(1, 0, { offset: .4, x: 81, y: -34, scale: 1.3, opacity: .7, rotation: -18 });
  const copy = cloneAnimation(new Proxy(original, {}));
  assert.deepEqual(copy, original);
  assert.notEqual(copy, original);
  assert.notEqual(copy.keyframes, original.keyframes);
  assert.notEqual(copy.keyframes[1], original.keyframes[1]);
  copy.keyframes[1].x = 999;
  copy.durationMs = 600;
  assert.equal(original.keyframes[1].x, 81);
  assert.equal(original.durationMs, 1240);
});

test('applying a saved preset makes independent enabled custom animations, not layer references', () => {
  const preset: StudioAnimationPreset = { id: 'preset_test', name: 'Gentle entrance',
    animation: { ...createAnimation('scale'), enabled: false, delayMs: 100, durationMs: 1500 },
    createdAt: '2026-10-18T08:00:00.000Z', updatedAt: '2026-10-18T08:00:00.000Z' };
  const first = animationFromPreset(preset), second = animationFromPreset(preset);
  assert.equal(first.enabled, true);
  assert.equal(first.preset, 'custom');
  assert.equal(first.delayMs, 100);
  assert.equal(first.durationMs, 1500);
  assert.deepEqual(first.keyframes, preset.animation.keyframes);
  assert.notEqual(first.keyframes[0], second.keyframes[0]);
  first.keyframes[0].rotation = 70;
  first.delayMs = 700;
  assert.equal(second.keyframes[0].rotation, 0);
  assert.equal(preset.animation.keyframes[0].rotation, 0);
  assert.equal(preset.animation.delayMs, 100);
  assert.equal(preset.animation.enabled, false);
  assert.equal(preset.animation.preset, 'scale');
  assert.equal('id' in first, false);
  assert.equal('name' in first, false);
});
