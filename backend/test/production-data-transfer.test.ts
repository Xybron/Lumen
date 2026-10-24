import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { ProductionStore } from '../src/production-store.js';
import { RecordingStore } from '../src/production-recordings.js';
import { createClips } from '../src/clips.js';
import { ProductionDataTransfer, PortableStudioSchema, portableClipFiles, type PortableClips } from '../src/production-data-transfer.js';

const stamp = '2026-10-24T00:00:00.000Z';
async function fixture() {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'lumen-production-transfer-'));
  let published = 0, live = false;
  const store = new ProductionStore(dir, () => { published++; }); await store.init();
  const recordings = new RecordingStore(path.join(dir, 'recordings'), () => { published++; }); await recordings.init();
  const clips = await createClips({ dir: path.join(dir, 'clips'), recordings, isLive: () => true });
  const adapter = new ProductionDataTransfer(store, recordings, clips.transfer, () => live);
  return { dir, store, recordings, clips, adapter, published: () => published, setLive: (value: boolean) => { live = value; },
    cleanup: async () => { await clips.close(); await fs.rm(dir, { recursive: true, force: true }); } };
}
async function commit(f: Awaited<ReturnType<typeof fixture>>, fn: Parameters<ProductionDataTransfer['transaction']>[1]) {
  return f.adapter.transaction(path.join(f.dir, 'backups', crypto.randomUUID()), async tx => { const result = await fn(tx); await tx.prepare(); tx.commitSync(); tx.publish(); return result; });
}
function sceneBundle(f: Awaited<ReturnType<typeof fixture>>) {
  const layer = f.store.get().scenes[0].layers[0];
  return PortableStudioSchema.parse({ scenes: [{ id: 'portable_scene', name: 'Synthetic portable scene', background: '#000000', layers: [
    { ...layer, id: 'portable_layer', kind: 'source', sourceId: 'portable_video' },
    { ...layer, id: 'camera_layer', kind: 'source', sourceId: 'portable_camera' },
  ] }], sources: [
    { id: 'portable_video', name: 'Synthetic video', kind: 'video', url: '/media/backgrounds/source.webm', loop: true, audio: { volume: .5, muted: false, mode: 'always', delayMs: 0 }, playback: { paused: false, restart: 2 } },
    { id: 'portable_camera', name: 'Synthetic camera', kind: 'camera', loop: false, audio: { volume: 1, muted: false, mode: 'follow', delayMs: 0 } },
  ], animationPresets: [] });
}

test('Studio import remaps inputs and layers, pauses and mutes imports, and preserves every live bus', async () => {
  const f = await fixture();
  try {
    let current = await f.store.command(0, { type: 'take', sceneId: 'scene_welcome' });
    current = await f.store.command(current.revision, { type: 'route', outputId: 'screen_main', sceneId: 'scene_welcome' });
    f.setLive(true);
    const original = f.store.get(), beforePublish = f.published(), bundle = sceneBundle(f);
    await f.adapter.transaction(path.join(f.dir, 'backup'), async tx => {
      assert.equal(await tx.importScenes(bundle, { media: { 'media/backgrounds/source.webm': '/media/backgrounds/fresh.webm' }, channels: {} }), 1);
      await tx.prepare(); assert.deepEqual(f.store.get(), original);
      tx.commitSync(); assert.equal(f.published(), beforePublish); tx.publish();
    });
    const currentState = f.store.get();
    for (const key of ['program', 'programTransition', 'previewSceneId', 'outputs', 'mainAudioSourceId', 'masterVolume', 'masterMuted'] as const) assert.deepEqual(currentState[key], original[key]);
    const added = currentState.scenes.at(-1)!;
    assert.notEqual(added.id, bundle.scenes[0].id);
    assert.ok(added.layers.every(layer => !bundle.scenes[0].layers.some(old => old.id === layer.id)));
    assert.ok(currentState.sources.every(source => source.audio.muted && source.playback?.paused));
    assert.equal(currentState.sources[0].url, '/media/backgrounds/fresh.webm');
    const restarted = new ProductionStore(f.dir); await restarted.init(); assert.deepEqual(restarted.get(), currentState);
  } finally { await f.cleanup(); }
});

test('post-commit failure restores files and caches without publication; queued edits see restored revision', async () => {
  const f = await fixture();
  try {
    const before = f.store.get(), originalBytes = await fs.readFile(path.join(f.dir, 'production.json')), beforePublish = f.published();
    await assert.rejects(f.adapter.transaction(path.join(f.dir, 'backup'), async tx => {
      await tx.importScenes(sceneBundle(f), { media: { 'media/backgrounds/source.webm': '/media/backgrounds/fresh.webm' }, channels: {} });
      await tx.prepare(); tx.commitSync(); throw new Error('Synthetic SQLite constraint');
    }), /Synthetic SQLite/);
    assert.deepEqual(f.store.get(), before); assert.deepEqual(await fs.readFile(path.join(f.dir, 'production.json')), originalBytes);
    assert.equal(f.published(), beforePublish);
    const next = await f.store.command(before.revision, { type: 'take', sceneId: 'scene_message' }); assert.equal(next.program?.id, 'scene_message');
  } finally { await f.cleanup(); }
});

test('clear blocks live Program and recording clip dependencies, but allows offline Program/Preview cleanup', async () => {
  const f = await fixture();
  try {
    let state = await f.store.command(0, { type: 'take', sceneId: 'scene_welcome' });
    await f.store.command(state.revision, { type: 'route', outputId: 'screen_main', sceneId: 'scene_welcome' });
    f.setLive(true);
    assert.match((await f.adapter.clearPlan({ scenes: ['scene_welcome'], recordings: [], clips: [] })).blockers.join(' '), /Stop Studio/);
    await assert.rejects(commit(f, tx => tx.clearScenes(['scene_welcome'])), /Stop Studio/);
    f.setLive(false); await commit(f, tx => tx.clearScenes(['scene_welcome']));
    state = f.store.get(); assert.equal(state.program, null); assert.equal(state.outputs[0].scene, null);
    assert.notEqual(state.previewSceneId, 'scene_welcome'); assert.ok(state.scenes.some(scene => scene.id === state.previewSceneId));
    const active = await f.recordings.create('Synthetic active recording');
    await assert.rejects(commit(f, tx => tx.clearRecordings([active.id])), /active recordings/);
  } finally { await f.cleanup(); }
});

test('recordings and Clips round-trip with fresh IDs, private asset bytes, owner remapping and reversible clear', async () => {
  const f = await fixture();
  try {
    const recordingFile = path.join(f.dir, 'synthetic-recording.webm'); await fs.writeFile(recordingFile, 'synthetic recording bytes');
    const assetFile = path.join(f.dir, 'synthetic.png'); await fs.writeFile(assetFile, 'synthetic private image bytes');
    const exportFile = path.join(f.dir, 'synthetic-export.mp4'); await fs.writeFile(exportFile, 'synthetic exported bytes');
    const recording = { id: 'rec_original', name: 'Synthetic saved recording', createdAt: stamp, durationMs: 10000, bytes: (await fs.stat(recordingFile)).size };
    const settings = { inMs: 0, outMs: 1000, format: '16:9' as const, fit: 'contain' as const, positionX: .5, positionY: .5,
      timeline: { version: 1 as const, background: '#000000', tracks: [{ id: 'track_original', name: 'Synthetic images', kind: 'video' as const, muted: false, hidden: false, locked: false, items: [{ id: 'item_original', name: 'Synthetic asset', kind: 'image' as const, source: { kind: 'asset' as const, id: 'asset_original' }, startMs: 0, inMs: 0, durationMs: 1000, x: 0, y: 0, width: 1, height: 1, fit: 'contain' as const, positionX: .5, positionY: .5, opacity: 1, volume: 1, muted: false, text: '', fontSize: 24, fontWeight: 400, color: '#ffffff', background: '#00000000', align: 'center' as const }] }] } };
    const bundle: PortableClips = {
      drafts: [{ id: 'draft_original', name: 'Synthetic clip project', recordingId: recording.id, revision: 2, ownerId: 'old_owner', ownerName: 'Old owner', createdAt: stamp, updatedAt: stamp, ...settings }],
      exports: [{ id: 'export_original', draftId: 'draft_original', draftRevision: 2, recordingId: recording.id, name: 'Synthetic export', ownerId: 'old_owner', status: 'complete', progress: 1, createdAt: stamp, bytes: (await fs.stat(exportFile)).size, settings }],
      assets: [{ id: 'asset_original', name: 'Synthetic image', kind: 'image', mime: 'image/png', bytes: (await fs.stat(assetFile)).size, durationMs: 0, width: 100, height: 100, ownerId: 'old_owner', ownerName: 'Old owner', createdAt: stamp, extension: 'png' }],
    };
    const descriptors = portableClipFiles(bundle), files = { [descriptors[0].id]: assetFile, [descriptors[1].id]: exportFile };
    const mapping = await commit(f, async tx => {
      const mapping = await tx.importRecordings([{ recording, path: recordingFile }]);
      assert.equal(await tx.importClips(bundle, { recordings: mapping, files, owner: { id: 'new_owner', name: 'New owner' } }), 1);
      return mapping;
    }) as Record<string, string>;
    assert.notEqual(mapping[recording.id], recording.id); assert.equal(f.recordings.list()[0].status, 'complete');
    assert.equal(await fs.readFile(f.recordings.download(mapping[recording.id]).path, 'utf8'), 'synthetic recording bytes');
    const snapshot = f.clips.transfer.snapshot(), draft = snapshot.data.drafts[0], asset = snapshot.assets[0];
    assert.notEqual(draft.id, 'draft_original'); assert.equal(draft.ownerId, 'new_owner'); assert.equal(asset.ownerId, 'new_owner');
    assert.equal(draft.recordingId, mapping[recording.id]); assert.equal(draft.timeline!.tracks[0].items[0].source!.id, asset.id);
    assert.notEqual(draft.timeline!.tracks[0].id, 'track_original'); assert.equal(snapshot.data.exports[0].draftId, draft.id);
    const exported = await f.adapter.exportClips([draft.id]); assert.equal(exported.files.length, 2); assert.deepEqual(exported.recordingIds, [mapping[recording.id]]);
    await assert.rejects(commit(f, tx => tx.clearRecordings([mapping[recording.id]])), /retained clip/);
    const before = f.clips.transfer.snapshot();
    await assert.rejects(f.adapter.transaction(path.join(f.dir, 'rollback-clear'), async tx => {
      await tx.clearClips([draft.id]); await tx.clearRecordings([mapping[recording.id]]); await tx.prepare(); tx.commitSync(); throw new Error('synthetic clear failure');
    }), /synthetic clear failure/);
    assert.deepEqual(f.clips.transfer.snapshot(), before); assert.equal(f.recordings.list().length, 1);
    await commit(f, async tx => { await tx.clearClips([draft.id]); await tx.clearRecordings([mapping[recording.id]]); });
    assert.equal(f.clips.transfer.snapshot().data.drafts.length, 0); assert.equal(f.recordings.list().length, 0);
    assert.equal(f.clips.transfer.snapshot().assets.length, 0);
    await assert.rejects(fs.stat(path.join(f.dir, 'clips/assets', `${asset.id}.${asset.extension}`)), { code: 'ENOENT' });
  } finally { await f.cleanup(); }
});

test('missing files, malformed bundles and Studio capacity violations fail before publishing', async () => {
  const f = await fixture();
  try {
    const before = f.store.get(), bundle = sceneBundle(f);
    assert.equal(PortableStudioSchema.safeParse({ ...bundle, sources: [] }).success, false);
    assert.equal(PortableStudioSchema.safeParse({ ...bundle, scenes: [bundle.scenes[0], bundle.scenes[0]] }).success, false);
    await assert.rejects(commit(f, async tx => {
      for (let i = 0; i < 21; i++) await tx.importScenes(bundle, { media: { 'media/backgrounds/source.webm': '/media/backgrounds/fresh.webm' }, channels: {} });
    }));
    assert.deepEqual(f.store.get(), before);
    await assert.rejects(commit(f, tx => tx.importRecordings([{ recording: { id: 'rec_missing', name: 'Missing', createdAt: stamp, durationMs: 10, bytes: 10 }, path: path.join(f.dir, 'absent') }])));
    assert.equal(f.recordings.list().length, 0);
  } finally { await f.cleanup(); }
});

test('offline fresh-start clearing releases selected Main Audio; engine startup during staging aborts live scene removal', async () => {
  const f = await fixture();
  try {
    await commit(f, tx => tx.importScenes(sceneBundle(f), { media: { 'media/backgrounds/source.webm': '/media/backgrounds/fresh.webm' }, channels: {} }));
    let state = f.store.get();
    state = await f.store.command(state.revision, { type: 'set-main-audio', sourceId: state.sources[0].id });
    state = await f.store.command(state.revision, { type: 'take', sceneId: state.scenes.at(-1)!.id });
    const sceneIds = state.scenes.map(scene => scene.id);
    await assert.rejects(f.adapter.transaction(path.join(f.dir, 'start-race'), async tx => {
      await tx.clearScenes(sceneIds); await tx.prepare(); f.setLive(true); tx.commitSync(); tx.publish();
    }), /Stop Studio/);
    assert.deepEqual(f.store.get(), state);
    f.setLive(false);
    await commit(f, async tx => { await tx.clearScenes(sceneIds); await tx.removeMedia(['media/backgrounds/fresh.webm']); });
    const cleared = f.store.get();
    assert.equal(cleared.scenes.length, 0); assert.equal(cleared.sources.length, 0); assert.equal(cleared.previewSceneId, null);
    assert.equal(cleared.program, null); assert.equal(cleared.mainAudioSourceId, null);
  } finally { await f.cleanup(); }
});

test('transfer refuses a symlinked storage directory before copying any imported recording', async () => {
  const f = await fixture();
  try {
    const outside = path.join(f.dir, 'other-storage'); await fs.mkdir(outside);
    await fs.rmdir(path.join(f.dir, 'recordings')); await fs.symlink(outside, path.join(f.dir, 'recordings'));
    const source = path.join(f.dir, 'synthetic.webm'); await fs.writeFile(source, 'synthetic');
    await assert.rejects(commit(f, tx => tx.importRecordings([{ recording: { id: 'rec_source', name: 'Synthetic', createdAt: stamp, durationMs: 1000, bytes: 9 }, path: source }])), /symbolic links/);
    assert.deepEqual(await fs.readdir(outside), []); assert.equal(f.recordings.list().length, 0);
  } finally { await f.cleanup(); }
});
