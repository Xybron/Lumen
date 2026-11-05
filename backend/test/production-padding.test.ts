import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { ProductionStore } from '../src/production-store.js';
import { LayerSchema, initialProduction } from '../src/production-schema.js';
import type { LayerTextPadding } from '../../shared/production.js';

const padding = { top: 24, right: 48, bottom: 36, left: 64, linked: false } satisfies LayerTextPadding;

test('text padding preserves legacy margins and accepts explicit sides without injected defaults', () => {
  const legacy = initialProduction().scenes[0].layers[0];
  assert.deepEqual(LayerSchema.parse(legacy), legacy);
  assert.equal(Object.hasOwn(LayerSchema.parse(legacy), 'textPadding'), false);
  assert.deepEqual(LayerSchema.parse({ ...legacy, textPadding: padding }).textPadding, padding);
  const withoutPreference = { top: 0, right: 3840, bottom: 12.5, left: 1 };
  assert.deepEqual(LayerSchema.parse({ ...legacy, textPadding: withoutPreference }).textPadding, withoutPreference);
  // The preference never rewrites independently saved values.
  assert.deepEqual(LayerSchema.parse({ ...legacy, textPadding: { ...padding, linked: true } }).textPadding, { ...padding, linked: true });
});

test('text padding rejects invalid, incomplete, and unknown side settings', () => {
  const legacy = initialProduction().scenes[0].layers[0];
  const invalid: unknown[] = [null, {}, { ...padding, linked: 1 }, { ...padding, extra: true }];
  for (const side of ['top', 'right', 'bottom', 'left'] as const) {
    for (const value of [-.01, 3840.01, Infinity, -Infinity, NaN, '24', undefined]) {
      invalid.push({ ...padding, [side]: value });
    }
  }
  for (const textPadding of invalid) {
    assert.equal(LayerSchema.safeParse({ ...legacy, textPadding }).success, false, JSON.stringify(textPadding));
  }
});

test('text padding saves across restart and keeps Program and pinned outputs independent', async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'lumen-padding-'));
  try {
    const store = new ProductionStore(dir); await store.init();
    let state = store.get();
    state.scenes[0].layers[0].textPadding = structuredClone(padding);
    state = await store.save(state);
    const sceneId = state.scenes[0].id;
    state = await store.command(state.revision, { type: 'take', sceneId });
    state = await store.command(state.revision, { type: 'route', outputId: 'screen_main', sceneId });
    const changed = { top: 96, right: 96, bottom: 96, left: 96, linked: true };
    Object.assign(state.scenes[0].layers[0].textPadding!, changed);
    state = await store.save(state);
    assert.deepEqual(state.scenes[0].layers[0].textPadding, changed);
    assert.deepEqual(state.program!.layers[0].textPadding, padding);
    assert.deepEqual(state.outputs[0].scene!.layers[0].textPadding, padding);

    const reopened = new ProductionStore(dir); await reopened.init();
    assert.deepEqual(reopened.get(), state, 'Draft and committed padding persist independently');
    state = await reopened.command(state.revision, { type: 'take', sceneId });
    assert.deepEqual(state.program!.layers[0].textPadding, changed);
    assert.deepEqual(state.outputs[0].scene!.layers[0].textPadding, padding, 'A pinned output keeps the earlier sides');

    state.scenes[0].layers[0].textPadding = undefined;
    state = await reopened.save(JSON.parse(JSON.stringify(state)));
    assert.equal(Object.hasOwn(state.scenes[0].layers[0], 'textPadding'), false);
    assert.deepEqual(state.program!.layers[0].textPadding, changed);
    assert.deepEqual(state.outputs[0].scene!.layers[0].textPadding, padding);
    const cleared = new ProductionStore(dir); await cleared.init();
    assert.deepEqual(cleared.get(), state, 'Clearing padding restores the omitted value after restart');
  } finally { await fs.rm(dir, { recursive: true, force: true }); }
});
