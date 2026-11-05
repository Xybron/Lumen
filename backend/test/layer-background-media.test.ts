import test from 'node:test';
import assert from 'node:assert/strict';
import { LayerBackgroundMedia } from '../../frontend/src/lib/studio/layer-background-media.js';
import type { SceneLayer } from '../../shared/production';

type BackgroundLayer = Pick<SceneLayer, 'id' | 'mediaBackground'>;
const layer = (url = 'media/backgrounds/worship.mp4'): BackgroundLayer => ({ id: 'lyrics-layer',
  mediaBackground: { kind: 'video', url, fit: 'cover', dim: .4, loop: true } });
const flush = () => new Promise(resolve => setImmediate(resolve));

function fixtures(playError?: unknown) {
  class Video {
    muted = false; defaultMuted = false; volume = 1; playsInline = false;
    loop = false; preload = ''; src = ''; readyState = 0; currentTime = 0;
    plays = 0; pauses = 0; loads = 0;
    onerror: (() => void) | null = null; onplaying: (() => void) | null = null;
    play() { this.plays++; return playError ? Promise.reject(playError) : Promise.resolve(); }
    pause() { this.pauses++; }
    load() { this.loads++; }
    removeAttribute(name: string) { assert.equal(name, 'src'); this.src = ''; }
  }
  const descriptor = Object.getOwnPropertyDescriptor(globalThis, 'document'), videos: Video[] = [];
  Object.defineProperty(globalThis, 'document', { configurable: true, value: { createElement(kind: string) {
    assert.equal(kind, 'video'); const video = new Video(); videos.push(video); return video;
  } } });
  return { videos, restore() {
    if (descriptor) Object.defineProperty(globalThis, 'document', descriptor); else Reflect.deleteProperty(globalThis, 'document');
  } };
}

test('background videos stay muted and uninterrupted across cue/layout changes, then release on inactivity', () => {
  const f = fixtures(), cache = new LayerBackgroundMedia(async () => { throw new Error('MP4 needs no preparation'); });
  try {
    const current = layer('media/backgrounds/Grace #1 100%.mp4');
    cache.sync([current]);
    const video = f.videos[0]; video.currentTime = 42;
    assert.equal(video.src, '/media/backgrounds/Grace%20%231%20100%25.mp4');
    assert.equal(video.muted, true); assert.equal(video.defaultMuted, true); assert.equal(video.volume, 0);
    assert.equal(video.playsInline, true); assert.equal(video.loop, true);
    for (let i = 0; i < 120; i++) cache.sync([{ ...current, mediaBackground: { ...current.mediaBackground!, dim: i / 120, fit: 'contain' } }]);
    assert.equal(cache.video(current), video);
    assert.equal(video.plays, 1); assert.equal(video.currentTime, 42); assert.equal(f.videos.length, 1);
    cache.sync([]);
    assert.equal(cache.video(current), undefined); assert.equal(video.pauses, 1); assert.equal(video.src, ''); assert.equal(video.loads, 1);
    cache.sync([current]); assert.equal(f.videos.length, 2, 'Returning to a released background makes one fresh player');
    cache.sync([{ ...current, mediaBackground: { ...current.mediaBackground!, kind: 'image' } }]);
    assert.equal(f.videos[1].pauses, 1); assert.equal(f.videos.length, 2, 'Images never allocate video players');
  } finally { cache.close(); f.restore(); }
});

test('draft and Program snapshots with the same layer id retain separate media and loop settings', () => {
  const f = fixtures(), cache = new LayerBackgroundMedia(async () => ({ status: 'missing' }));
  try {
    const program = layer(), draft = layer('media/backgrounds/new.mp4');
    cache.sync([program, draft]);
    const playing = cache.video(program), preview = cache.video(draft);
    assert.notEqual(playing, preview); assert.equal(f.videos.length, 2);
    const once = { ...draft, mediaBackground: { ...draft.mediaBackground!, loop: false } };
    cache.sync([program, draft, once]);
    assert.equal(cache.video(program), playing); assert.equal(cache.video(draft), preview);
    assert.notEqual(cache.video(once), preview); assert.equal(cache.video(once)?.loop, false);
    cache.sync([draft]);
    assert.equal(f.videos[0].pauses, 1); assert.equal(f.videos[2].pauses, 1); assert.equal(f.videos[1].pauses, 0);
    assert.equal(cache.video(draft), preview, 'A Take retains the preview player instead of restarting it');
  } finally { cache.close(); f.restore(); }
});

test('MOV preparation uses the compatible file only when original playback is unavailable', async () => {
  const f = fixtures();
  let resolve!: (value: { status: 'ready'; path: string }) => void;
  const cache = new LayerBackgroundMedia(() => new Promise(done => { resolve = done; }));
  try {
    const current = layer('media/backgrounds/worship.mov'); cache.sync([current]);
    resolve({ status: 'ready', path: 'media/backgrounds/prepared.mp4' }); await flush();
    assert.equal(f.videos[0].src, '/media/backgrounds/prepared.mp4'); assert.equal(f.videos[0].plays, 2);
    cache.sync([]); cache.sync([current]); f.videos[1].readyState = 2; f.videos[1].currentTime = 12;
    resolve({ status: 'ready', path: 'media/backgrounds/prepared.mp4' }); await flush();
    assert.equal(f.videos[1].src, '/media/backgrounds/worship.mov'); assert.equal(f.videos[1].plays, 1);
    assert.equal(f.videos[1].currentTime, 12);
  } finally { cache.close(); f.restore(); }
});

test('a late preparation response cannot revive a removed background', async () => {
  const f = fixtures(); let resolve!: (value: { status: 'ready'; path: string }) => void;
  const cache = new LayerBackgroundMedia(() => new Promise(done => { resolve = done; }));
  try {
    cache.sync([layer('media/backgrounds/worship.mov')]); cache.close();
    resolve({ status: 'ready', path: 'media/backgrounds/prepared.mp4' }); await flush();
    assert.equal(f.videos[0].src, ''); assert.equal(f.videos[0].plays, 1); assert.equal(f.videos[0].loads, 1);
  } finally { cache.close(); f.restore(); }
});

test('background playback and preparation failures provide concise recovery messages', async () => {
  const f = fixtures({ name: 'NotAllowedError', message: 'raw browser data https://example.invalid/private.mov' });
  const cache = new LayerBackgroundMedia(async () => ({ status: 'missing' }));
  try {
    const current = layer(); cache.sync([current]); await flush();
    assert.match(cache.error(current) ?? '', /blocked.*Choose another video/);
    assert.doesNotMatch(cache.error(current) ?? '', /https:|private\.mov/);
    f.videos[0].onerror?.(); assert.match(cache.error(current) ?? '', /MP4 \(H.264\)/);
    f.videos[0].onplaying?.(); assert.equal(cache.error(current), undefined);
    const missing = layer('media/backgrounds/missing.mov'); cache.sync([missing]); await flush();
    assert.match(cache.error(missing) ?? '', /missing from this station.*Choose another video/);
    cache.close(); assert.equal(f.videos[1].onerror, null); assert.equal(f.videos[1].onplaying, null);
  } finally { cache.close(); f.restore(); }
});
