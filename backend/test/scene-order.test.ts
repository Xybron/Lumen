import test from 'node:test';
import assert from 'node:assert/strict';
import { reorderScenes } from '../../frontend/src/lib/studio/scene-order.js';

const scene = (id: string) => ({ id, name: id, background: '#000000', layers: [] });

test('moving scenes preserves scene objects and unrelated order, including hidden search results', () => {
  const scenes = ['opening', 'hidden-one', 'scripture', 'hidden-two', 'closing'].map(scene);
  const reordered = reorderScenes(scenes, 'closing', 'scripture', 'before');
  assert.deepEqual(reordered.map(s => s.id), ['opening', 'hidden-one', 'closing', 'scripture', 'hidden-two']);
  assert.deepEqual(reordered.filter(s => s.id !== 'closing'), scenes.filter(s => s.id !== 'closing'));
  assert.strictEqual(reordered[2], scenes[4]);
  assert.deepEqual(scenes.map(s => s.id), ['opening', 'hidden-one', 'scripture', 'hidden-two', 'closing']);
  assert.deepEqual(reorderScenes(reordered, 'opening', 'hidden-two', 'after').map(s => s.id), ['hidden-one', 'closing', 'scripture', 'hidden-two', 'opening']);
});

test('missing or already placed scene targets leave the order unchanged', () => {
  const scenes = ['first', 'second', 'last'].map(scene);
  assert.strictEqual(reorderScenes(scenes, 'first', 'first', 'before'), scenes);
  assert.strictEqual(reorderScenes(scenes, 'missing', 'second', 'after'), scenes);
  assert.strictEqual(reorderScenes(scenes, 'first', 'missing', 'before'), scenes);
  assert.strictEqual(reorderScenes(scenes, 'first', 'second', 'before'), scenes);
  assert.strictEqual(reorderScenes(scenes, 'last', 'second', 'after'), scenes);
});
