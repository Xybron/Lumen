import test from 'node:test';
import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';
import { resolveTextPadding, textPaddingForLayer } from '../../frontend/src/lib/studio/text-padding.js';
import { layoutChannelOverlay } from '../../frontend/src/lib/studio/channel-overlay.js';
import { createChannelPosterLayoutCache } from '../../frontend/src/lib/studio/channel-poster-layout.js';
import { initialProduction } from '../src/production-schema.js';
import type { Item } from '../../frontend/src/types.js';

const measure = (text: string, size: number) => text.length * size * .5;
const cue: Item = { id: 'cue_padding', type: 'scripture', body: 'Room for every word', reference: 'John 3:16', subtitle: 'King James Version', durationMs: 0 };
const close = (actual: number, expected: number) => assert.ok(Math.abs(actual - expected) < .0001, `${actual} ≈ ${expected}`);

test('padding preserves implicit margins, honors explicit zero and clamps resized layers proportionally', () => {
  assert.deepEqual(resolveTextPadding(1920, 1080, undefined), { top: 0, right: 8, bottom: 0, left: 8 });
  for (const [width, height] of [[1920, 1080], [1920, 200], [50, 30]]) {
    const inset = Math.max(2, Math.min(30, width * .025, height * .1));
    assert.deepEqual(resolveTextPadding(width, height, undefined, 'overlay'), { top: inset, right: inset, bottom: inset, left: inset });
  }
  assert.deepEqual(resolveTextPadding(1920, 1080, { top: 0, right: 0, bottom: 0, left: 0 }, 'overlay'), { top: 0, right: 0, bottom: 0, left: 0 });
  const padding = { top: 3000, right: 2000, bottom: 1000, left: 1000, linked: false };
  const before = structuredClone(padding), inset = resolveTextPadding(240, 120, padding);
  close(inset.top / inset.bottom, 3); close(inset.right / inset.left, 2);
  close(240 - inset.left - inset.right, 1); close(120 - inset.top - inset.bottom, 1);
  assert.deepEqual(padding, before, 'Rendering never rewrites saved values after a resize');
  const layer = { ...initialProduction().scenes[0].layers[0], width: 50, height: 20, textPadding: { top: 12, right: 24, bottom: 36, left: 48 } };
  assert.deepEqual(textPaddingForLayer(layer), layer.textPadding);
  assert.deepEqual(resolveTextPadding(1, 1, padding), { top: 0, right: 0, bottom: 0, left: 0 });
});

test('channel layout fits all metadata inside asymmetric insets and cached link changes do not remeasure', () => {
  const padding = { top: 40, right: 70, bottom: 100, left: 230, linked: false };
  const style = { textPadding: padding, verticalAlign: 'top' as const };
  const top = layoutChannelOverlay(cue, 1000, 400, 54, 500, measure, style);
  assert.deepEqual(top.insets, { top: 40, right: 70, bottom: 100, left: 230 });
  assert.equal(top.contentWidth, 700); assert.equal(top.contentHeight, 260);
  assert.equal(top.blocks[0].top, 40);
  const bottom = layoutChannelOverlay(cue, 1000, 400, 54, 500, measure, { ...style, verticalAlign: 'bottom' });
  const last = bottom.blocks.at(-1)!;
  close(last.top + last.lines.length * last.lineHeight, 300);
  const centered = layoutChannelOverlay(cue, 1000, 400, 54, 500, measure, { ...style, verticalAlign: 'middle' });
  close(centered.blocks[0].top, (top.blocks[0].top + bottom.blocks[0].top) / 2);
  for (const block of bottom.blocks) {
    assert.ok(block.top >= 40);
    assert.ok(block.top + block.lines.length * block.lineHeight <= 300.001);
    assert.ok(block.lines.every(line => measure(line, block.fontSize) <= 700));
  }
  const legacy = layoutChannelOverlay(cue, 1000, 400, 54, 500, measure);
  assert.deepEqual(layoutChannelOverlay(cue, 1000, 400, 54, 500, measure, { textPadding: { top: 25, right: 25, bottom: 25, left: 25 } }), legacy,
    'Setting explicit insets equal to the implicit margins preserves the layout');
  let measurements = 0;
  const cached = createChannelPosterLayoutCache((text, size) => { measurements++; return measure(text, size); });
  const first = cached(cue, 1000, 400, 54, 500, style), count = measurements;
  padding.linked = true;
  assert.strictEqual(cached(cue, 1000, 400, 54, 500, style), first);
  assert.equal(measurements, count, 'Changing link mode is not a visual change');
  padding.left = 400;
  assert.notStrictEqual(cached(cue, 1000, 400, 54, 500, style), first);
  assert.ok(measurements > count, 'Changing a side updates wrapping');
});

async function loadRenderer() {
  const { default: esbuild } = await import('../../frontend/node_modules/esbuild/lib/main.js');
  const frontend = fileURLToPath(new URL('../../frontend/', import.meta.url));
  const bundle = await esbuild.build({ absWorkingDir: frontend,
    stdin: { contents: 'export { paintScene } from "./src/lib/studio/compositor.ts";', resolveDir: frontend },
    tsconfig: 'tsconfig.json', bundle: true, write: false, format: 'esm', platform: 'browser', define: { 'process.env.NODE_ENV': '"production"' } });
  return import(`data:text/javascript;base64,${Buffer.from(bundle.outputFiles[0].text).toString('base64')}`);
}

test('renderer offsets and clips only text, keeps backgrounds fixed and reuses prepared layouts and effects', async t => {
  const { paintScene } = await loadRenderer();
  const filled: { color: string; rect: number[] }[] = [], media: number[][] = [], clipped: number[][] = [];
  const painted: { text: string; x: number; y: number; align: string; baseline: string }[] = [];
  let measures = 0, allocations = 0;
  const picture = { naturalWidth: 1920, naturalHeight: 1080 };
  class Context {
    font = ''; fillStyle = ''; globalAlpha = 1; textAlign = 'left'; textBaseline = 'top';
    save() {} restore() {} setTransform() {} translate() {} rotate() {} scale() {} beginPath() {} roundRect() {} clip() {}
    rect(...coords: number[]) { clipped.push(coords); }
    fillRect(...rect: number[]) { filled.push({ color: this.fillStyle, rect }); }
    measureText(value: string) { measures++; return { width: measure(value, Number(/([\d.]+)px/.exec(this.font)?.[1])) }; }
    fillText(text: string, x: number, y: number) { painted.push({ text, x, y, align: this.textAlign, baseline: this.textBaseline }); }
    strokeText() {}
    drawImage(image: unknown, ...coords: number[]) { if (image === picture) media.push(coords); }
  }
  const oldDocument = Object.getOwnPropertyDescriptor(globalThis, 'document');
  const oldVideo = Object.getOwnPropertyDescriptor(globalThis, 'HTMLVideoElement');
  Object.defineProperty(globalThis, 'document', { configurable: true, value: { createElement() {
    allocations++; const ctx = new Context(); return { width: 0, height: 0, getContext: () => ctx };
  } } });
  Object.defineProperty(globalThis, 'HTMLVideoElement', { configurable: true, value: class {} });
  t.after(() => {
    if (oldDocument) Object.defineProperty(globalThis, 'document', oldDocument); else Reflect.deleteProperty(globalThis, 'document');
    if (oldVideo) Object.defineProperty(globalThis, 'HTMLVideoElement', oldVideo); else Reflect.deleteProperty(globalThis, 'HTMLVideoElement');
  });
  const ctx = new Context(), canvas = { width: 1920, height: 1080, getContext: () => ctx };
  const scene = initialProduction().scenes[0], base = scene.layers[0];
  scene.layers = [{ ...base, kind: 'text', text: 'Padding', x: 0, y: 0, width: 100, height: 100,
    background: '#102030', fontSize: 40, fontWeight: 500, align: 'left', verticalAlign: 'top',
    mediaBackground: { kind: 'image', url: 'media/backgrounds/test.png', fit: 'cover', dim: .2, loop: false } }];
  const layer = scene.layers[0];
  const bank = { inputs: new Map([['channel', { source: { kind: 'channel' }, element: null }]]),
    layerBackground: () => picture, image: () => picture, channelItem: () => cue, isTextChannel: () => true };
  paintScene(canvas, scene, bank);
  assert.equal(painted[0].x, 8); close(painted[0].y, 40 * 1.24 / 2);
  const originalBackgrounds = structuredClone(filled), originalMedia = structuredClone(media);
  filled.length = media.length = painted.length = 0;
  layer.textPadding = { top: 80, right: 60, bottom: 120, left: 200, linked: false };
  layer.align = 'center'; layer.verticalAlign = 'bottom';
  paintScene(canvas, scene, bank);
  assert.deepEqual(filled, originalBackgrounds); assert.deepEqual(media, originalMedia, 'Media fit/crop never follows text insets');
  close(painted[0].x, 200 + (1920 - 200 - 60) / 2);
  close(painted[0].y, 1080 - 120 - 40 * 1.24 / 2);
  assert.deepEqual(clipped.at(-1), [200, 80, 1660, 880]);
  const initialMeasures = measures;
  for (let frame = 0; frame < 30; frame++) paintScene(canvas, scene, bank);
  assert.equal(measures, initialMeasures, 'Stable frames never remeasure plain text');
  layer.textPadding.linked = true; paintScene(canvas, scene, bank);
  assert.equal(measures, initialMeasures);
  layer.textPadding.left = 400; paintScene(canvas, scene, bank);
  assert.ok(measures > initialMeasures, 'Plain text recalculates when a side changes');

  layer.kind = 'source'; layer.sourceId = 'channel'; layer.channelStyle = 'overlay';
  layer.align = 'right'; layer.verticalAlign = 'top';
  painted.length = 0; paintScene(canvas, scene, bank);
  assert.ok(painted.every(line => line.x === 1860)); assert.equal(painted[0].y, 80);
  assert.deepEqual(clipped.at(-1), [400, 80, 1460, 880]);
  layer.textShadow = { color: '#00000088', blur: 10, offsetX: 3, offsetY: 4 };
  paintScene(canvas, scene, bank);
  const styled = { measures, paints: painted.length, allocations };
  for (let frame = 0; frame < 30; frame++) paintScene(canvas, scene, bank);
  layer.textPadding.linked = false; paintScene(canvas, scene, bank);
  assert.deepEqual({ measures, paints: painted.length, allocations }, styled, 'Padding keeps the existing cached text-effect path');

  // Full-slide presentation content continues to use its own theme/layout.
  bank.isTextChannel = () => false; layer.channelStyle = 'slide'; delete layer.textShadow;
  delete layer.textPadding; painted.length = 0; paintScene(canvas, scene, bank);
  const fullSlide = structuredClone(painted);
  layer.textPadding = { top: 1000, right: 1000, bottom: 1000, left: 1000 };
  painted.length = 0; paintScene(canvas, scene, bank);
  assert.deepEqual(painted, fullSlide, 'Scene padding does not reinterpret full presentation slides');
});
