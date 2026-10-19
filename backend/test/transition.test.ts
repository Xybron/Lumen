import assert from 'node:assert/strict';
import test from 'node:test';
import type { SceneLayer, StudioScene } from '../../shared/production';
import { blendScenes, sceneSourceWeights, transitionProgress } from '../../frontend/src/lib/studio/transition';

function scene(id: string, ...sources: string[]): StudioScene {
  return { id, name: id, background: '#000000', layers: sources.map((sourceId, i) => ({
    id: `layer_${i}`, kind: 'source', visible: true, sourceId,
  } as SceneLayer)) };
}

test('transition progress is clamped and completes at the requested duration', () => {
  assert.equal(transitionProgress(100, 300, 50), 0);
  assert.equal(transitionProgress(100, 300, 250), .5);
  assert.equal(transitionProgress(100, 300, 400), 1);
  assert.equal(transitionProgress(100, 300, 999), 1);
});

test('fades retain a live weighted scene mix, including an interruption', () => {
  const a = scene('a'), b = scene('b'), c = scene('c');
  const first = blendScenes([{ scene: a, weight: 1 }], b, .4);
  assert.deepEqual(first, [{ scene: a, weight: .6 }, { scene: b, weight: .4 }]);
  assert.deepEqual(blendScenes(first, c, 0), first, 'a new Fade starts from exactly the current picture');
  assert.deepEqual(blendScenes(first, c, .5), [
    { scene: a, weight: .3 }, { scene: b, weight: .2 }, { scene: c, weight: .5 },
  ]);
  assert.deepEqual(blendScenes(first, c, 1), [{ scene: c, weight: 1 }]);
});

test('a fade can begin at black without inventing an outgoing scene', () => {
  const target = scene('target');
  assert.deepEqual(blendScenes([{ scene: null, weight: 1 }], target, .5), [
    { scene: null, weight: .5 }, { scene: target, weight: .5 },
  ]);
});

test('follow audio crossfades unique sources and keeps shared sources at unity', () => {
  const old = scene('old', 'old_mic', 'shared', 'shared');
  const next = scene('next', 'new_mic', 'shared');
  const weights = sceneSourceWeights(blendScenes([{ scene: old, weight: 1 }], next, .25));
  assert.equal(weights.get('old_mic'), .75);
  assert.equal(weights.get('new_mic'), .25);
  assert.equal(weights.get('shared'), 1, 'duplicate layers and shared sources do not double the audio');
  next.layers[0].visible = false;
  assert.equal(sceneSourceWeights([{ scene: next, weight: 1 }]).has('new_mic'), false);
});
