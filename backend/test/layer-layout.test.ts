import test from 'node:test';
import assert from 'node:assert/strict';
import { arrangeLayers, layerAlignment, layerGeometryInput, layerGeometryValue, layerPreset, nudgeLayerGeometry, reorderLayers } from '../../frontend/src/lib/studio/layer-layout.js';
import { initialProduction, ProductionSchema } from '../src/production-schema.js';

const rectangle = { x: 12, y: 20, width: 30, height: 10 };

test('canvas alignment places all six bounds precisely and retains oversized elements', () => {
  assert.deepEqual(layerAlignment(rectangle, 'left'), { x: 0 });
  assert.deepEqual(layerAlignment(rectangle, 'center'), { x: 35 });
  assert.deepEqual(layerAlignment(rectangle, 'right'), { x: 70 });
  assert.deepEqual(layerAlignment(rectangle, 'top'), { y: 0 });
  assert.deepEqual(layerAlignment(rectangle, 'middle'), { y: 45 });
  assert.deepEqual(layerAlignment(rectangle, 'bottom'), { y: 90 });
  assert.deepEqual(layerAlignment({ ...rectangle, width: 150 }, 'right'), { x: -50 });
  assert.deepEqual(rectangle, { x: 12, y: 20, width: 30, height: 10 });
});

test('placement presets have deliberate center, full-frame and upper/lower-third geometry', () => {
  assert.deepEqual(layerPreset(rectangle, 'center'), { x: 35, y: 45, width: 30, height: 10 });
  assert.deepEqual(layerPreset(rectangle, 'full'), { x: 0, y: 0, width: 100, height: 100 });
  assert.deepEqual(layerPreset(rectangle, 'lower-third'), { x: 5, y: 78, width: 90, height: 16 });
  assert.deepEqual(layerPreset(rectangle, 'upper-third'), { x: 5, y: 6, width: 90, height: 16 });
});

test('visual top-down drag order converts correctly to the compositor back-to-front order', () => {
  const layers = initialProduction().scenes[0].layers.slice(0, 3);
  assert.deepEqual(layers.map(layer => layer.id), ['eyebrow', 'title', 'subtitle']);
  assert.deepEqual(reorderLayers(layers, 'eyebrow', 'subtitle', 'before').map(layer => layer.id), ['title', 'subtitle', 'eyebrow']);
  assert.deepEqual(reorderLayers(layers, 'eyebrow', 'subtitle', 'after').map(layer => layer.id), ['title', 'eyebrow', 'subtitle']);
  assert.deepEqual(reorderLayers(layers, 'subtitle', 'eyebrow', 'after').map(layer => layer.id), ['subtitle', 'eyebrow', 'title']);
  assert.deepEqual(reorderLayers(layers, 'title', 'eyebrow', 'before').map(layer => layer.id), ['eyebrow', 'title', 'subtitle']);
  assert.equal(reorderLayers(layers, 'title', 'title', 'before'), layers);
  assert.equal(reorderLayers(layers, 'missing', 'title', 'before'), layers);
  assert.equal(reorderLayers(layers, 'title', 'missing', 'before'), layers);
  assert.deepEqual(layers.map(layer => layer.id), ['eyebrow', 'title', 'subtitle']);
});

test('layer arrangement moves one level or to an edge without mutating drafts or moving locks', () => {
  const layers = initialProduction().scenes[0].layers.slice(0, 3);
  assert.deepEqual(arrangeLayers(layers, 'eyebrow', 'forward').map(layer => layer.id), ['title', 'eyebrow', 'subtitle']);
  assert.deepEqual(arrangeLayers(layers, 'subtitle', 'backward').map(layer => layer.id), ['eyebrow', 'subtitle', 'title']);
  assert.deepEqual(arrangeLayers(layers, 'eyebrow', 'front').map(layer => layer.id), ['title', 'subtitle', 'eyebrow']);
  assert.deepEqual(arrangeLayers(layers, 'subtitle', 'back').map(layer => layer.id), ['subtitle', 'eyebrow', 'title']);
  assert.equal(arrangeLayers(layers, 'subtitle', 'forward'), layers);
  assert.equal(arrangeLayers(layers, 'eyebrow', 'back'), layers);
  layers[1] = { ...layers[1], locked: true };
  assert.equal(arrangeLayers(layers, 'title', 'front'), layers);
  assert.equal(reorderLayers(layers, 'title', 'subtitle', 'before'), layers);
});

test('pixel inputs convert using the design resolution, clamp legal geometry and reject invalid numbers', () => {
  assert.equal(layerGeometryInput(960, 'x', 'px'), 50);
  assert.equal(layerGeometryInput(540, 'y', 'px'), 50);
  assert.equal(layerGeometryInput(480, 'width', 'px'), 25);
  assert.equal(layerGeometryInput(270, 'height', 'px'), 25);
  assert.equal(layerGeometryValue(50, 'width', 'px'), 960);
  assert.equal(layerGeometryValue(50, 'height', 'px'), 540);
  assert.equal(layerGeometryValue(12, 'x', '%'), 12);
  assert.equal(layerGeometryInput(-8000, 'x', 'px'), -100);
  assert.equal(layerGeometryInput(8000, 'y', 'px'), 100);
  assert.equal(layerGeometryInput(0, 'width', 'px'), 1);
  assert.equal(layerGeometryInput(500, 'height', '%'), 200);
  assert.equal(layerGeometryInput(NaN, 'width', 'px'), null);
  assert.equal(layerGeometryInput(Infinity, 'x', '%'), null);
});

test('keyboard nudges are pixel based and keep resulting geometry valid for the production schema', () => {
  const moved = nudgeLayerGeometry(rectangle, 1, -10);
  assert.ok(Math.abs((moved.x! - rectangle.x) * 19.2 - 1) < .0001);
  assert.ok(Math.abs((moved.y! - rectangle.y) * 10.8 + 10) < .0001);
  assert.deepEqual(nudgeLayerGeometry({ ...rectangle, x: 100, y: -100 }, 10, -10), { x: 100, y: -100 });
  const state = initialProduction();
  for (const preset of ['center', 'full', 'lower-third'] as const) {
    Object.assign(state.scenes[0].layers[0], layerPreset(rectangle, preset));
    assert.equal(ProductionSchema.safeParse(state).success, true);
  }
});
