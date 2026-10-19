import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { ProductionStore } from '../src/production-store.js';
import { ProductionSchema } from '../src/production-schema.js';
import type { ProductionState, SceneLayer, StudioSource } from '../../shared/production.js';

async function fixture() {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'lumen-scene-gates-'));
  const snapshots: string[][] = [];
  const store = new ProductionStore(dir, () => {}, async ids => {
    snapshots.push(ids);
    return ids.filter(id => ['bible', 'song'].includes(id)).map(channelId => ({ channelId, revision: channelId === 'bible' ? 12 : 7 }));
  });
  await store.init(); const state = store.get();
  const source = (id: string): StudioSource => ({ id, name: id, kind: 'channel', channelId: id, loop: false, audio: { volume: .8, muted: true, mode: 'follow', delayMs: 0 } });
  state.sources = ['bible', 'song', 'slides', 'hidden', 'offcanvas', 'transparent'].map(source);
  const base = state.scenes[0].layers[0];
  const layer = (id: string, patch: Partial<SceneLayer> = {}): SceneLayer => ({ ...base, id, sourceId: id, kind: 'source', visible: true, opacity: 1, x: 0, y: 0, width: 100, height: 100, ...patch });
  state.scenes[0].layers = [layer('bible'), layer('song'), layer('slides'), layer('hidden', { visible: false }), layer('offcanvas', { x: 100 }), layer('transparent', { opacity: 0 }), layer('bible', { id: 'bible_second' })];
  await store.save(state); return { store, dir, snapshots };
}

test('Take snapshots all unique visible text-channel revisions and leaves content-only publication independent', async () => {
  const { store, snapshots } = await fixture();
  const state = await store.command(store.get().revision, { type: 'take', sceneId: 'scene_welcome', transition: 'fade', durationMs: 600 });
  assert.deepEqual(snapshots, [['bible', 'song', 'slides']]);
  assert.deepEqual(state.programCueGates, [{ channelId: 'bible', revision: 12 }, { channelId: 'song', revision: 7 }]);
  assert.equal(state.programTransition?.durationMs, 600);
  const copy = structuredClone(state); copy.programCueGates = [{ channelId: 'bible', revision: 999 }];
  let saved = await store.save(copy);
  assert.deepEqual(saved.programCueGates, state.programCueGates, 'PUT cannot forge minimum cue revisions');
  delete saved.programCueGates; saved = await store.save(saved);
  assert.deepEqual(saved.programCueGates, state.programCueGates, 'Older controllers cannot erase the wait');
  const cleared = await store.command(saved.revision, { type: 'take', sceneId: 'scene_close' });
  assert.equal(cleared.programCueGates, undefined, 'A scene without text does not wait for an unrelated channel');
});

test('gates persist across restart and rejected/stale Takes never change Program', async () => {
  const { store, dir, snapshots } = await fixture();
  const state = await store.command(store.get().revision, { type: 'take', sceneId: 'scene_welcome' });
  const restarted = new ProductionStore(dir); await restarted.init(); assert.deepEqual(restarted.get(), state);
  await assert.rejects(store.command(state.revision - 1, { type: 'take', sceneId: 'scene_welcome' }), { status: 409 });
  assert.equal(snapshots.length, 1); assert.deepEqual(store.get(), state);
  const failing = new ProductionStore(dir, () => {}, async () => { throw new Error('Channel snapshot unavailable'); });
  await failing.init();
  await assert.rejects(failing.command(state.revision, { type: 'take', sceneId: 'scene_welcome' }), /snapshot unavailable/);
  assert.deepEqual(failing.get(), state);
});

test('gate schema rejects duplicate channels, unsafe revisions and oversized lists', async () => {
  const { store } = await fixture();
  const state: ProductionState = store.get();
  const gate = { channelId: 'bible', revision: 12 };
  for (const gates of [[gate, gate], [{ ...gate, revision: -1 }], [{ ...gate, revision: 1.5 }], [{ ...gate, revision: Number.MAX_SAFE_INTEGER + 1 }], Array.from({ length: 41 }, (_, i) => ({ channelId: `channel_${i}`, revision: 1 }))]) {
    assert.equal(ProductionSchema.safeParse({ ...state, programCueGates: gates }).success, false);
  }
});
