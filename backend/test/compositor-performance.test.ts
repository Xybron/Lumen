import test from 'node:test';
import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';
import type { Item } from '../../frontend/src/types.js';
import { initialProduction } from '../src/production-schema.js';

async function loadRenderer() {
  const { default: esbuild } = await import('../../frontend/node_modules/esbuild/lib/main.js');
  const frontend = fileURLToPath(new URL('../../frontend/', import.meta.url));
  const bundle = await esbuild.build({ absWorkingDir: frontend,
    stdin: { contents: 'export { paintScene } from "./src/lib/studio/compositor.ts"; export { SourceBank } from "./src/lib/studio/sources.ts";', resolveDir: frontend },
    tsconfig: 'tsconfig.json', bundle: true, write: false, format: 'esm', platform: 'browser', define: { 'process.env.NODE_ENV': '"production"' } });
  return import(`data:text/javascript;base64,${Buffer.from(bundle.outputFiles[0].text).toString('base64')}`);
}
const renderer = loadRenderer();

test('unchanged slide and lower-third text are measured once while each new camera frame still paints', async t => {
  const { paintScene } = await renderer;
  class Video { videoWidth = 1920; videoHeight = 1080; }
  const originals = ['HTMLAudioElement', 'HTMLVideoElement'].map(key => [key, Object.getOwnPropertyDescriptor(globalThis, key)] as const);
  Object.defineProperty(globalThis, 'HTMLVideoElement', { configurable: true, value: Video });
  Object.defineProperty(globalThis, 'HTMLAudioElement', { configurable: true, value: class {} });
  t.after(() => { for (const [key, value] of originals) if (value) Object.defineProperty(globalThis, key, value); else Reflect.deleteProperty(globalThis, key); });
  const screen = initialProduction().scenes[0], base = screen.layers[0], camera = new Video();
  const title = { ...base, kind: 'text' as const, text: 'A service announcement', fontSize: 44 };
  screen.layers = [
    { ...base, kind: 'source', sourceId: 'cam' },
    { ...base, kind: 'source', sourceId: 'deck', channelStyle: 'slide' }, title,
  ];
  let slide: Item = { id: 'cue_slide', type: 'text', durationMs: 0, body: 'A line from the service announcement. '.repeat(25),
    reference: 'Service notes', subtitle: 'Presentation credit', typography: { size: '2xl', weight: 600 } };
  const bank = { inputs: new Map([['cam', { source: { kind: 'camera' }, element: camera }], ['deck', { source: { kind: 'channel' }, element: null }]]),
    channelItem: () => slide, isTextChannel: () => false };
  const text: string[] = [];
  let measured = 0, cameraDraws = 0;
  const ctx = { font: '', globalAlpha: 1, save() {}, restore() {}, setTransform() {}, translate() {}, rotate() {}, scale() {}, fillRect() {}, clip() {}, beginPath() {}, roundRect() {},
    measureText(value: string) { measured++; return { width: value.length * Number(/([\d.]+)px/.exec(this.font)?.[1]) * .5 }; },
    fillText(value: string) { text.push(value); },
    drawImage(image: unknown) { assert.equal(image, camera); cameraDraws++; } };
  const paint = () => paintScene({ width: 1920, height: 1080, getContext: () => ctx }, screen, bank);
  paint();
  const firstCost = measured, firstFrame = [...text];
  assert.ok(firstFrame.includes('Service notes') && firstFrame.includes('Presentation credit'));
  for (let i = 0; i < 29; i++) { text.length = 0; paint(); assert.deepEqual(text, firstFrame); }
  assert.equal(cameraDraws, 30);
  assert.equal(measured, firstCost, `30 frames used ${measured} measurements, first frame ${firstCost}`);
  slide = { ...slide, body: 'Next slide' };
  screen.layers[2] = { ...title, text: 'Next announcement', width: 90 };
  text.length = 0; paint();
  assert.ok(text.includes('Next slide') && text.includes('Next announcement'));
  assert.ok(measured > firstCost, 'Fresh scene or cue is measured before drawing');
});

test('standby artwork is bounded without reloading source-owned or recently drawn images', async t => {
  const { SourceBank } = await renderer;
  class TestImage { src = ''; naturalWidth = 3840; naturalHeight = 2160; }
  const original = Object.getOwnPropertyDescriptor(globalThis, 'Image');
  Object.defineProperty(globalThis, 'Image', { configurable: true, value: TestImage });
  t.after(() => { if (original) Object.defineProperty(globalThis, 'Image', original); else Reflect.deleteProperty(globalThis, 'Image'); });
  let now = 0;
  t.mock.method(performance, 'now', () => ++now);
  const bank = Object.create(SourceBank.prototype);
  bank.images = new Map(); bank.inputs = new Map(); bank.imageSweepAt = 0;
  const logo = bank.image('logo'); bank.inputs.set('logo', { element: logo });
  const slides = Array.from({ length: 18 }, (_, i) => bank.image('slide-' + i));
  // Seventeen concurrently visible layers exceed both standby limits.
  const visible = Array.from({ length: 17 }, (_, i) => bank.image('visible-' + i));
  visible[2].naturalWidth = 0; visible[2].naturalHeight = 0; // A currently loading image.
  assert.equal(bank.image('slide-0'), slides[0]); // A previously visited slide becomes most recent.
  now = 20_000;
  visible.forEach((image, i) => assert.equal(image, bank.image('visible-' + i)));
  bank.trimArtwork();
  assert.equal(bank.images.size, 1 + visible.length + 2, 'Only the two most recently used 4K standby slides fit the pixel budget');
  assert.equal(bank.image('logo'), logo);
  assert.equal(bank.image('slide-0'), slides[0]); assert.equal(bank.image('slide-17'), slides[17]);
  visible.forEach((image, i) => assert.equal(image, bank.image('visible-' + i)));
  assert.notEqual(bank.image('slide-1'), slides[1], 'Returning to an evicted slide starts a fresh load');
  assert.equal(slides[1].src, '/slide-1', 'Cache eviction does not cancel or mutate a caller’s image');

  for (let i = 0; i < 30; i++) {
    const pending = bank.image('pending-' + i); pending.naturalWidth = pending.naturalHeight = 0;
  }
  now = 40_000;
  bank.trimArtwork();
  assert.equal(bank.images.size, 13, 'One owned input plus at most twelve standby entries even when dimensions are unknown');
  assert.equal(bank.image('logo'), logo);
});
