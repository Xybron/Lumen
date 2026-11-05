import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { ProductionStore } from '../src/production-store.js';
import { RecordingStore } from '../src/production-recordings.js';
import { LayerSchema, initialProduction } from '../src/production-schema.js';
import { ProductionDataTransfer, portableStudioDependencies } from '../src/production-data-transfer.js';
import type { LayerMediaBackground } from '../../shared/production.js';

const background: LayerMediaBackground = { kind: 'video', url: '/media/backgrounds/worship.webm', fit: 'cover', dim: .4, loop: true };
async function fixture() {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'lumen-layer-background-'));
  const store = new ProductionStore(dir); await store.init();
  const recordings = new RecordingStore(path.join(dir, 'recordings'), () => {}); await recordings.init();
  const transfer = new ProductionDataTransfer(store, recordings, undefined);
  return { dir, store, transfer, close: () => fs.rm(dir, { recursive: true, force: true }) };
}

test('layer media accepts legacy and cleared settings but rejects unsafe paths and invalid display settings', () => {
  const layer = initialProduction().scenes[0].layers[0];
  for (const mediaBackground of [undefined, null, background, { ...background, kind: 'image', loop: false }]) {
    assert.equal(LayerSchema.safeParse({ ...layer, mediaBackground }).success, true);
  }
  for (const url of ['https://example.com/image.png', 'file:///private/image.png', 'data:image/png;base64,AA', '/media/backgrounds/../secret', '/media/backgrounds/nested/video.mp4']) {
    assert.equal(LayerSchema.safeParse({ ...layer, mediaBackground: { ...background, url } }).success, false, url);
  }
  for (const patch of [{ dim: -1 }, { dim: 1.1 }, { dim: NaN }, { fit: 'stretch' }, { kind: 'audio' }, { muted: false }]) {
    assert.equal(LayerSchema.safeParse({ ...layer, mediaBackground: { ...background, ...patch } }).success, false);
  }
});

test('background edits and removal remain in draft while Program and pinned output survive restart', async () => {
  const f = await fixture();
  try {
    let state = f.store.get();
    state.scenes[0].layers[0].mediaBackground = structuredClone(background);
    state = await f.store.save(state);
    state = await f.store.command(state.revision, { type: 'take', sceneId: state.scenes[0].id });
    state = await f.store.command(state.revision, { type: 'route', outputId: 'screen_main', sceneId: state.scenes[0].id });
    state.scenes[0].layers[0].mediaBackground = null;
    state = await f.store.save(state);
    assert.equal(state.scenes[0].layers[0].mediaBackground, null);
    assert.deepEqual(state.program?.layers[0].mediaBackground, background);
    assert.deepEqual(state.outputs[0].scene?.layers[0].mediaBackground, background);
    const restarted = new ProductionStore(f.dir); await restarted.init();
    assert.deepEqual(restarted.get(), state);
    state = await restarted.command(state.revision, { type: 'take', sceneId: state.scenes[0].id });
    assert.equal(state.program?.layers[0].mediaBackground, null);
    assert.deepEqual(state.outputs[0].scene?.layers[0].mediaBackground, background);
  } finally { await f.close(); }
});

test('portable scenes include background dependencies and import with remapped paths', async () => {
  const f = await fixture();
  try {
    const state = f.store.get();
    state.scenes[0].layers[0].mediaBackground = structuredClone(background);
    await f.store.save(state);
    const bundle = await f.transfer.exportScenes([state.scenes[0].id]);
    assert.deepEqual(portableStudioDependencies(bundle).mediaIds, ['media/backgrounds/worship.webm']);
    const before = f.store.get();
    await assert.rejects(f.transfer.transaction(path.join(f.dir, 'missing-backup'), tx => tx.importScenes(bundle, { media: {}, channels: {} })), /background is missing its media/);
    assert.deepEqual(f.store.get(), before);
    await f.transfer.transaction(path.join(f.dir, 'import-backup'), async tx => {
      await tx.importScenes(bundle, { media: { 'media/backgrounds/worship.webm': '/media/backgrounds/imported.webm' }, channels: {} });
      await tx.prepare(); tx.commitSync(); tx.publish();
    });
    const imported = f.store.get().scenes.at(-1)!;
    assert.notEqual(imported.id, state.scenes[0].id);
    assert.deepEqual(imported.layers[0].mediaBackground, { ...background, url: '/media/backgrounds/imported.webm' });
    assert.equal(bundle.scenes[0].layers[0].mediaBackground?.url, background.url);
    const restarted = new ProductionStore(f.dir); await restarted.init();
    assert.deepEqual(restarted.get(), f.store.get());
  } finally { await f.close(); }
});

test('media deletion waits for removal from draft, Program and pinned outputs', async () => {
  const f = await fixture();
  try {
    let state = f.store.get();
    state.scenes[0].layers[0].mediaBackground = structuredClone(background);
    state = await f.store.save(state);
    const ids = ['media/backgrounds/worship.webm'];
    let removed = false;
    const remove = () => f.transfer.withUnusedMedia(ids, async () => { removed = true; });
    await assert.rejects(remove(), /scene background/);
    assert.equal(removed, false);
    state = await f.store.command(state.revision, { type: 'take', sceneId: state.scenes[0].id });
    state = await f.store.command(state.revision, { type: 'route', outputId: 'screen_main', sceneId: state.scenes[0].id });
    state.scenes[0].layers[0].mediaBackground = null;
    state = await f.store.save(state);
    await assert.rejects(remove(), /scene background/);
    assert.match((await f.transfer.clearPlan({ scenes: [], clips: [], recordings: [], media: ids })).blockers.join(' '), /scene background/);
    await assert.rejects(f.transfer.transaction(path.join(f.dir, 'blocked-clear'), tx => tx.removeMedia(ids)), /scene background/);
    state = await f.store.command(state.revision, { type: 'clear-program' });
    await assert.rejects(remove(), /scene background/);
    await f.store.command(state.revision, { type: 'route', outputId: 'screen_main', sceneId: null });
    await remove();
    assert.equal(removed, true);
    assert.deepEqual((await f.transfer.clearPlan({ scenes: [], clips: [], recordings: [], media: ids })).blockers, []);
  } finally { await f.close(); }
});
