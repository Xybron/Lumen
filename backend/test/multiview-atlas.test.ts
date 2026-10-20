import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { multiviewCanvasSize, multiviewSlots, MULTIVIEW_OUTPUT_ID } from '../../shared/multiview-layout.js';
import { initialProduction, ProductionSchema } from '../src/production-schema.js';

test('Multiview pads odd scene counts to even pairs without altering saved scenes', () => {
  assert.deepEqual(multiviewSlots([]), [null, null]);
  assert.deepEqual(multiviewSlots(['a']), ['a', null]);
  const scenes = Object.freeze(['a', 'b', 'c']);
  assert.deepEqual(multiviewSlots(scenes), ['a', 'b', 'c', null]);
  assert.deepEqual(scenes, ['a', 'b', 'c']);
  assert.deepEqual(multiviewSlots(['a', 'b']), ['a', 'b']);
  for (const count of [0, 1, 2, 3, 4, 59, 60]) {
    const slots = multiviewSlots(Array.from({ length: count }, (_, i) => i));
    assert.equal(slots.length % 2, 0);
    assert.deepEqual(multiviewCanvasSize(count), { width: 640, height: slots.length / 2 * 180 });
  }
  assert.deepEqual(multiviewCanvasSize(Number.NaN), { width: 640, height: 180 });
});

test('the private Multiview stream cannot be saved as a public editable output', () => {
  const state = initialProduction();
  state.outputs[0].id = MULTIVIEW_OUTPUT_ID;
  const parsed = ProductionSchema.safeParse(state);
  assert.equal(parsed.success, false);
  if (!parsed.success) assert.ok(parsed.error.issues.some(issue => issue.message === 'Reserved output ID.'));
});

test('the atlas paints final-pose drafts into one lazy video-only capture and releases it', async t => {
  // Bundle the production painter with the same frontend path resolution. The
  // harness supplies only Canvas/stream primitives: no real device, station,
  // websocket, AudioContext, renderer, or filesystem output is created.
  const { default: esbuild } = await import('../../frontend/node_modules/esbuild/lib/main.js');
  const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
  const result = await esbuild.build({ entryPoints: [path.join(root, 'frontend/src/lib/studio/compositor.ts')],
    absWorkingDir: path.join(root, 'frontend'), tsconfig: path.join(root, 'frontend/tsconfig.json'),
    bundle: true, write: false, platform: 'browser', format: 'esm', define: { 'process.env.NODE_ENV': '"production"' } });
  const { StudioCompositor, paintMultiview } = await import(`data:text/javascript;base64,${Buffer.from(result.outputFiles[0].text).toString('base64')}`);
  const originalDocument = globalThis.document, originalAudioElement = globalThis.HTMLAudioElement;
  t.after(() => {
    if (originalDocument === undefined) delete (globalThis as any).document; else globalThis.document = originalDocument;
    if (originalAudioElement === undefined) delete (globalThis as any).HTMLAudioElement; else globalThis.HTMLAudioElement = originalAudioElement;
  });
  (globalThis as any).HTMLAudioElement = class {};
  const canvases: any[] = [], fills: any[] = [], pictures: any[] = [];
  (globalThis as any).document = { createElement: (kind: string) => {
    assert.equal(kind, 'canvas');
    const ctx = { globalAlpha: 1, fillStyle: '', globalCompositeOperation: '',
      setTransform() {}, save() {}, restore() {}, beginPath() {}, rect() {}, clip() {}, translate() {}, scale() {}, rotate() {}, roundRect() {},
      fillRect(x: number, y: number, w: number, h: number) { fills.push({ x, y, w, h, fill: this.fillStyle, alpha: this.globalAlpha }); },
      drawImage(media: unknown) { pictures.push(media); } };
    const track = { kind: 'video', stopped: false, stop() { this.stopped = true; } };
    const stream = { getTracks: () => [track], getVideoTracks: () => [track], getAudioTracks: () => [] };
    const canvas = { width: 0, height: 0, getContext: () => ctx, captureStream(fps: number) { canvas.captures++; assert.equal(fps, 7.5); return stream; }, captures: 0 };
    canvases.push(canvas); return canvas;
  } };
  const state = initialProduction();
  const layer = { ...state.scenes[0].layers[0], kind: 'shape', background: '#ff0000', animation: {
    enabled: true, preset: 'fade', durationMs: 600, delayMs: 0, easing: 'linear', keyframes: [
      { offset: 0, x: 0, y: 0, scale: 1, opacity: 0, rotation: 0 },
      { offset: 1, x: 0, y: 0, scale: 1, opacity: 1, rotation: 0 },
    ] } };
  state.scenes = state.scenes.map((scene, index) => ({ ...scene, layers: index === 0 ? [layer] : [] })) as typeof state.scenes;
  state.scenes[1].layers = [{ ...state.scenes[0].layers[0], kind: 'source', sourceId: 'live_camera', background: '#00000000' }];
  const liveCamera = { videoWidth: 1280, videoHeight: 720 };
  const compositor = Object.create(StudioCompositor.prototype);
  compositor.state = state; compositor.bank = {
    inputs: new Map([['live_camera', { source: { kind: 'camera' }, element: liveCamera }]]),
    multiviewView() { return this; }, releaseMultiview() {},
  }; compositor.multiview = null;
  assert.equal(canvases.length, 0, 'No atlas canvas exists before the first subscription');
  const first = compositor.stream(MULTIVIEW_OUTPUT_ID);
  assert.equal(canvases.length, 1);
  assert.equal(first.getAudioTracks().length, 0);
  assert.equal(first.getVideoTracks().length, 1);
  assert.equal(compositor.stream(MULTIVIEW_OUTPUT_ID), first, 'Subscribers share one capture, not per-scene streams');
  assert.equal(canvases[0].captures, 1);
  assert.ok(fills.some(fill => fill.fill === '#ff0000' && fill.alpha === 1), 'Entrances are shown in their saved final pose');
  assert.ok(pictures.includes(liveCamera), 'Scene tiles paint the actual source-bank media element, not a placeholder');
  assert.equal(canvases[0].width, 640); assert.equal(canvases[0].height, 360);
  state.scenes = state.scenes.slice(0, 2);
  paintMultiview(canvases[0], state.scenes, compositor.bank);
  assert.equal(canvases[0].height, 180);
  assert.equal(compositor.stream(MULTIVIEW_OUTPUT_ID), first, 'Scene-count resize retains the WebRTC video track');
  compositor.releaseMultiview();
  assert.equal(first.getVideoTracks()[0].stopped, true);
  assert.equal(canvases[0].width, 0); assert.equal(canvases[0].height, 0);
  compositor.releaseMultiview();
  assert.notEqual(compositor.stream(MULTIVIEW_OUTPUT_ID), first, 'Reopening creates a fresh live capture');
  compositor.releaseMultiview();
});

test('Multiview inspects channel video/images without activating always-audio or replacing held production media', async t => {
  const { default: esbuild } = await import('../../frontend/node_modules/esbuild/lib/main.js');
  const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
  const result = await esbuild.build({ stdin: {
    contents: 'export { SourceBank } from "./src/lib/studio/sources.ts"; export { paintMultiview } from "./src/lib/studio/compositor.ts";',
    resolveDir: path.join(root, 'frontend'), loader: 'ts',
  }, absWorkingDir: path.join(root, 'frontend'), tsconfig: path.join(root, 'frontend/tsconfig.json'),
    bundle: true, write: false, platform: 'browser', format: 'esm', define: { 'process.env.NODE_ENV': '"production"' } });
  const { SourceBank, paintMultiview } = await import(`data:text/javascript;base64,${Buffer.from(result.outputFiles[0].text).toString('base64')}`);
  const globals = ['document', 'HTMLMediaElement', 'HTMLVideoElement', 'HTMLAudioElement', 'Image'] as const;
  const originals = globals.map(key => [key, (globalThis as any)[key]]);
  t.after(() => { for (const [key, value] of originals) { if (value === undefined) delete (globalThis as any)[key]; else (globalThis as any)[key] = value; } });
  class Media {
    src = ''; paused = true; plays = 0; pauses = 0; loads = 0;
    loop = false; muted = false; defaultMuted = false; playsInline = false; preload = '';
    videoWidth = 1280; videoHeight = 720;
    play() { this.plays++; this.paused = false; return Promise.resolve(); }
    pause() { this.pauses++; this.paused = true; }
    removeAttribute(name: string) { assert.equal(name, 'src'); this.src = ''; }
    load() { this.loads++; }
  }
  class Video extends Media {}
  class Audio extends Media {}
  class Image { src = ''; naturalWidth = 800; naturalHeight = 450; }
  (globalThis as any).HTMLMediaElement = Media;
  (globalThis as any).HTMLVideoElement = Video;
  (globalThis as any).HTMLAudioElement = Audio;
  (globalThis as any).Image = Image;
  const created: Video[] = [], pictures: unknown[] = [];
  const ctx = { globalAlpha: 1, fillStyle: '', globalCompositeOperation: '',
    setTransform() {}, save() {}, restore() {}, beginPath() {}, rect() {}, clip() {}, translate() {}, scale() {}, rotate() {}, roundRect() {}, fillRect() {},
    drawImage(media: unknown) { pictures.push(media); } };
  const canvas = { width: 0, height: 0, getContext: () => ctx };
  (globalThis as any).document = { createElement(kind: string) { assert.equal(kind, 'video'); const video = new Video(); created.push(video); return video; } };
  let audioNodes = 0;
  const bank = Object.create(SourceBank.prototype);
  bank.audio = { createMediaElementSource() { audioNodes++; throw new Error('Multiview must not create audio nodes'); } };
  bank.inputs = new Map(); bank.images = new Map(); bank.channelStates = new Map();
  bank.multiviewVideos = new Map(); bank.multiviewInputs = new Map(); bank.multiviewBank = null;
  bank.content = {
    channels: [{ id: 'slides', kind: 'slides', playlistId: 'service' }],
    playlists: [{ id: 'service', items: [
      { id: 'film', type: 'video', background: { kind: 'video', src: 'media/backgrounds/current.mp4' } },
      { id: 'art', type: 'image', background: { kind: 'image', src: 'media/backgrounds/current.png' } },
    ] }],
  };
  bank.channelStates.set('slides', { playlistId: 'service', index: 0 });
  const source = { id: 'slides_source', channelId: 'slides', kind: 'channel', loop: true,
    audio: { muted: false, volume: 1, mode: 'always', delayMs: 0 } };
  const input = { source, element: null, node: null, channelItemKey: undefined, error: 'Original diagnostic', playback: {
    bind() { throw new Error('Multiview must not rebind production playback'); },
    pause() { throw new Error('Multiview must not pause production playback'); },
  } };
  bank.inputs.set(source.id, input);
  const state = initialProduction(), scene = { ...state.scenes[0], layers: [{
    ...state.scenes[0].layers[0], kind: 'source', sourceId: source.id, channelStyle: 'slide', background: '#00000000', opacity: 1,
  }] };
  const ids = new Set([source.id]);
  let view = bank.multiviewView(ids);
  paintMultiview(canvas, [scene], view);
  assert.equal(audioNodes, 0);
  assert.equal(input.node, null); assert.equal(input.element, null); assert.equal(input.channelItemKey, undefined);
  assert.equal(input.error, 'Original diagnostic');
  assert.equal(created.length, 1); assert.equal(created[0].muted, true); assert.equal(created[0].defaultMuted, true);
  assert.equal(created[0].plays, 1); assert.ok(pictures.includes(created[0]), 'Current channel video actually paints in the atlas');
  assert.equal(bank.multiviewView(ids), view, 'One stable visual bank/cache is reused across frames');
  assert.equal(created.length, 1); assert.equal(created[0].plays, 1, 'Repeated inspection does not restart the preview video');

  // Program can be holding the prior cue while authoritative content has
  // advanced. The atlas shows that newer content using only its own player.
  const held = new Video(); held.src = '/media/backgrounds/held.mp4'; held.paused = false;
  (input as any).element = held; (input as any).channelItemKey = 'media/backgrounds/held.mp4';
  view = bank.multiviewView(ids); paintMultiview(canvas, [scene], view);
  assert.equal(input.element, held); assert.equal(input.channelItemKey, 'media/backgrounds/held.mp4');
  assert.equal(held.pauses, 0); assert.equal(held.plays, 0); assert.equal(held.src, '/media/backgrounds/held.mp4');
  bank.channelStates.set('slides', { playlistId: 'service', index: 0, blanked: true });
  bank.pruneMultiviewVideos();
  assert.equal(created[0].pauses, 1); assert.equal(created[0].src, '', 'Blanking releases only atlas-owned media');
  view = bank.multiviewView(ids); paintMultiview(canvas, [scene], view);
  assert.equal(held.pauses, 0); assert.equal(input.element, held); assert.equal(input.channelItemKey, 'media/backgrounds/held.mp4');

  bank.channelStates.set('slides', { playlistId: 'service', index: 1 });
  view = bank.multiviewView(ids); paintMultiview(canvas, [scene], view);
  const image = bank.images.get('media/backgrounds/current.png');
  assert.ok(image instanceof Image && pictures.includes(image), 'The actual current image is also painted');
  assert.equal(held.pauses, 0); assert.equal(audioNodes, 0);

  bank.channelStates.set('slides', { playlistId: 'service', index: 0 });
  view = bank.multiviewView(ids); assert.equal(created.length, 2);
  bank.inputs.delete(source.id); bank.pruneMultiviewVideos();
  assert.equal(created[1].pauses, 1); assert.equal(created[1].src, '', 'Removing a source releases atlas-only media');
  bank.inputs.set(source.id, input);
  bank.multiviewView(ids); assert.equal(created.length, 3);
  bank.releaseMultiview(); bank.releaseMultiview();
  assert.equal(created[2].pauses, 1); assert.equal(created[2].src, '', 'Closing the final atlas viewer releases previews exactly once');
  assert.equal(bank.multiviewVideos.size, 0); assert.equal(held.pauses, 0);
  // Once Program independently activates the matching URL, observe its exact
  // media element/time. Closing Multiview must not pause that owned player.
  (input as any).channelItemKey = 'media/backgrounds/current.mp4'; held.src = '/media/backgrounds/current.mp4';
  view = bank.multiviewView(ids);
  assert.equal(view.inputs.get(source.id).element, held);
  assert.equal(created.length, 3);
  bank.releaseMultiview();
  assert.equal(held.pauses, 0); assert.equal(held.plays, 0); assert.equal(audioNodes, 0);
});
