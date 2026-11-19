import test from 'node:test';
import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';
import { createCanvas } from '@napi-rs/canvas';
import { notesLayerPlacement, notesLayerPreset } from '../../frontend/src/lib/studio/notes-layout.js';
import { layoutChannelOverlay } from '../../frontend/src/lib/studio/channel-overlay.js';
import { createChannelPosterLayoutCache } from '../../frontend/src/lib/studio/channel-poster-layout.js';
import { initialProduction } from '../src/production-schema.js';
import type { Item } from '../../frontend/src/types.js';

const note: Item = { id: 'note', type: 'notes', title: 'Walk in wisdom', body: 'Ask God for wisdom.\nPut what you hear into practice.', reference: 'James 1:5, 22',
  durationMs: 30000, layout: 'key-points', background: { kind: 'color', color: '#123456' }, typography: { size: 'lg', align: 'left' } };
const measure = (text: string, size: number) => text.length * size * .52;

test('Notes compact layouts retain the heading, points and reference, fit bounds, and refresh when edited', () => {
  const item = structuredClone(note), original = structuredClone(item);
  const layout = createChannelPosterLayoutCache(measure);
  const first = layout(item, 1728, 280.8, 54, 500);
  assert.equal(first.blocks.length, 3);
  assert.equal(first.blocks[0].lines.join(' '), note.title);
  assert.deepEqual(first.blocks[1].lines, ['• Ask God for wisdom.', '• Put what you hear into practice.']);
  assert.equal(first.blocks[2].lines.join(' '), note.reference);
  assert.strictEqual(layout(item, 1728, 280.8, 54, 500), first);
  item.title = 'A new heading';
  assert.equal(layout(item, 1728, 280.8, 54, 500).blocks[0].lines.join(' '), item.title);
  item.layout = 'quote';
  assert.ok(layout(item, 1728, 280.8, 54, 500).blocks[1].lines.join(' ').startsWith('“'));
  for (const [width, height] of [[1728, 280.8], [960, 180], [250, 100]]) {
    const fitted = layoutChannelOverlay({ ...note, body: Array.from({ length: 8 }, (_, i) => `Point ${i + 1}: keep putting your faith into practice.`).join('\n') }, width, height, 72, 600, measure);
    for (const block of fitted.blocks) {
      assert.ok(block.top >= fitted.insets.top);
      assert.ok(block.top + block.lines.length * block.lineHeight <= height - fitted.insets.bottom + .01);
      assert.ok(block.lines.every(line => measure(line, block.fontSize) <= fitted.contentWidth + .01));
    }
  }
  assert.deepEqual(note, original, 'Rendering does not rewrite the saved note');
});

test('Notes placements switch render modes while retaining independent scene styling', () => {
  const layer = { ...initialProduction().scenes[0].layers[0], kind: 'source' as const, background: '#102030cc', fontSize: 61, color: '#ffeecc',
    textPadding: { top: 12, right: 30, bottom: 15, left: 20 }, mediaBackground: { kind: 'image' as const, url: '/note.png', fit: 'cover' as const, dim: .2, loop: false } };
  const before = structuredClone(layer);
  Object.assign(layer, notesLayerPreset(layer, 'lower-third'));
  assert.equal(notesLayerPlacement(layer), 'bottom'); assert.equal(layer.channelStyle, 'overlay');
  const bottom = [layer.x, layer.y, layer.width, layer.height];
  Object.assign(layer, notesLayerPreset(layer, 'upper-third'));
  assert.equal(notesLayerPlacement(layer), 'top'); assert.equal(layer.channelStyle, 'overlay');
  assert.deepEqual([layer.x, layer.width, layer.height], [bottom[0], bottom[2], bottom[3]]);
  Object.assign(layer, notesLayerPreset(layer, 'full'));
  assert.equal(notesLayerPlacement(layer), 'full'); assert.equal(layer.channelStyle, 'slide');
  for (const key of ['background', 'fontSize', 'color', 'textPadding', 'mediaBackground'] as const) assert.deepEqual(layer[key], before[key]);
});

async function renderer() {
  const { default: esbuild } = await import('../../frontend/node_modules/esbuild/lib/main.js');
  const frontend = fileURLToPath(new URL('../../frontend/', import.meta.url));
  const built = await esbuild.build({ absWorkingDir: frontend,
    stdin: { contents: 'export { paintScene, drawPresentationItem } from "./src/lib/studio/compositor.ts"; export { SourceBank } from "./src/lib/studio/sources.ts";', resolveDir: frontend },
    tsconfig: 'tsconfig.json', bundle: true, write: false, format: 'esm', platform: 'browser', define: { 'process.env.NODE_ENV': '"production"' } });
  return import(`data:text/javascript;base64,${Buffer.from(built.outputFiles[0].text).toString('base64')}`);
}

test('Program paints the original full Notes slide and compact overlays only in their chosen region', async t => {
  const { paintScene, drawPresentationItem, SourceBank } = await renderer();
  const globals = ['document', 'HTMLVideoElement', 'HTMLAudioElement'].map(key => [key, Object.getOwnPropertyDescriptor(globalThis, key)] as const);
  Object.defineProperty(globalThis, 'document', { configurable: true, value: { createElement: () => createCanvas(1920, 1080) } });
  Object.defineProperty(globalThis, 'HTMLVideoElement', { configurable: true, value: class {} });
  Object.defineProperty(globalThis, 'HTMLAudioElement', { configurable: true, value: class {} });
  t.after(() => { for (const [key, descriptor] of globals) if (descriptor) Object.defineProperty(globalThis, key, descriptor); else Reflect.deleteProperty(globalThis, key); });
  const state = initialProduction(), scene = state.scenes[0]; scene.background = '#456789';
  const layer = { ...scene.layers[0], kind: 'source' as const, sourceId: 'notes', background: '#102030', radius: 0, opacity: 1 };
  scene.layers = [layer];
  let item: Item | undefined = structuredClone(note);
  const bank = { inputs: new Map([['notes', { source: { kind: 'channel', channelId: 'notes' }, element: null }]]),
    channelItem: () => item, isTextChannel: () => false, isNotesChannel: () => true };
  const canvas = createCanvas(1920, 1080), ctx = canvas.getContext('2d');
  const pixel = (x: number, y: number) => [...ctx.getImageData(x, y, 1, 1).data];
  Object.assign(layer, notesLayerPreset(layer, 'full')); paintScene(canvas, scene, bank);
  const expected = createCanvas(1920, 1080); drawPresentationItem(expected.getContext('2d'), item, bank, null, 1920, 1080);
  assert.deepEqual(canvas.toBuffer('image/png'), expected.toBuffer('image/png'), 'Full screen uses the exact saved slide design');
  Object.assign(layer, notesLayerPreset(layer, 'lower-third')); paintScene(canvas, scene, bank);
  assert.deepEqual(pixel(100, 740), [16, 32, 48, 255]);
  assert.deepEqual(pixel(100, 80), [69, 103, 137, 255]);
  const bottomPixels = canvas.toBuffer('image/png');
  item!.title = 'Changed while preaching'; paintScene(canvas, scene, bank);
  assert.notDeepEqual(canvas.toBuffer('image/png'), bottomPixels, 'A same-object heading edit invalidates the live renderer cache');
  Object.assign(layer, notesLayerPreset(layer, 'upper-third')); paintScene(canvas, scene, bank);
  assert.deepEqual(pixel(100, 80), [16, 32, 48, 255]);
  assert.deepEqual(pixel(100, 740), [69, 103, 137, 255]);
  for (const preset of ['full', 'lower-third', 'upper-third'] as const) {
    item = undefined; Object.assign(layer, notesLayerPreset(layer, preset)); paintScene(canvas, scene, bank);
    assert.deepEqual(pixel(100, 80), [69, 103, 137, 255]); assert.deepEqual(pixel(100, 740), [69, 103, 137, 255]);
  }
  const sourceBank = Object.create(SourceBank.prototype);
  sourceBank.content = { channels: [{ id: 'notes', kind: 'notes', playlistId: 'notes-deck' }], playlists: [{ id: 'notes-deck', items: [note] }] };
  sourceBank.channelStates = new Map();
  const input = bank.inputs.get('notes');
  assert.equal(sourceBank.isTextChannel(input), false, 'Notes follows its playlist rather than a worship cue');
  assert.equal(sourceBank.isNotesChannel(input), true);
  assert.equal(sourceBank.channelItem(input, false), note);
  assert.equal(sourceBank.channelGraphics(input), undefined, 'Notes must not inherit presentation countdown/flame graphics');
});
