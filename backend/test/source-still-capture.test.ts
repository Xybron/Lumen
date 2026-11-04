import test from 'node:test';
import assert from 'node:assert/strict';
import { SourceStillCapture, stillSize } from '../../frontend/src/lib/studio/source-still-capture.js';

class Track extends EventTarget {
  kind = 'video'; readyState = 'live'; enabled = true; muted = false;
  stop() { throw new Error('Borrowed tracks must never stop'); }
  clone() { throw new Error('Borrowed tracks must never be cloned'); }
  applyConstraints() { throw new Error('Borrowed track settings must never change'); }
}

function fixtures(Capture?: new (track: Track) => { grabFrame(): Promise<unknown> }) {
  const descriptors = new Map(['document', 'ImageCapture', 'MediaStream'].map(key => [key, Object.getOwnPropertyDescriptor(globalThis, key)]));
  const streams: Track[][] = [], videos: Video[] = [], canvases: Canvas[] = [];
  class Video extends EventTarget {
    muted = false; volume = 1; playsInline = false; srcObject: unknown = null;
    readyState = 2; videoWidth = 1280; videoHeight = 720; pauses = 0; loads = 0;
    frame: (() => void) | null = null;
    requestVideoFrameCallback(fn: () => void) { this.frame = fn; return 1; }
    cancelVideoFrameCallback() { this.frame = null; }
    play() { queueMicrotask(() => this.frame?.()); return Promise.resolve(); }
    pause() { this.pauses++; }
    removeAttribute() {}
    load() { this.loads++; }
  }
  class Canvas {
    width = 0; height = 0; quality = 0;
    getContext() { return { drawImage() {} }; }
    toBlob(done: (value: Blob) => void, type: string, quality: number) {
      this.quality = quality;
      const blob = new Blob([JSON.stringify([this.width, this.height])], { type });
      queueMicrotask(() => done(blob));
    }
  }
  Object.defineProperty(globalThis, 'ImageCapture', { configurable: true, value: Capture });
  Object.defineProperty(globalThis, 'MediaStream', { configurable: true, value: class { constructor(tracks: Track[]) { streams.push(tracks); } } });
  Object.defineProperty(globalThis, 'document', { configurable: true, value: { createElement(kind: string) {
    if (kind === 'video') { const video = new Video(); videos.push(video); return video; }
    const canvas = new Canvas(); canvases.push(canvas); return canvas;
  } } });
  return { streams, videos, canvases, restore() {
    for (const [key, descriptor] of descriptors) {
      if (descriptor) Object.defineProperty(globalThis, key, descriptor);
      else Reflect.deleteProperty(globalThis, key);
    }
  } };
}
const capture = (adapter: SourceStillCapture, track: Track, signal = new AbortController().signal) => adapter.capture(track as unknown as MediaStreamTrack, signal);
const flush = () => new Promise(resolve => setImmediate(resolve));

test('still dimensions retain aspect ratio, bound pixels, and never upscale', () => {
  assert.deepEqual(stillSize(3840, 2160), { width: 192, height: 108 });
  assert.deepEqual(stillSize(1080, 1920), { width: 61, height: 108 });
  assert.deepEqual(stillSize(100, 50), { width: 100, height: 50 });
  assert.equal(stillSize(0, 100), null);
  assert.equal(stillSize(Infinity, 100), null);
});

test('native stills close the original bitmap and do not create a video or new stream', async () => {
  let closed = 0;
  const f = fixtures(class { async grabFrame() { return { width: 3840, height: 2160, close() { closed++; } }; } });
  const adapter = new SourceStillCapture();
  try {
    const blob = await capture(adapter, new Track());
    assert.equal(blob?.type, 'image/jpeg');
    assert.deepEqual(JSON.parse(await blob!.text()), [192, 108]);
    assert.equal(f.canvases[0].quality, .65);
    assert.equal(closed, 1);
    assert.equal(f.videos.length, 0);
    assert.equal(f.streams.length, 0);
  } finally { adapter.dispose(); f.restore(); }
});

test('aborted native grabs reserve their slot, close late frames, and permit safe reactivation', async () => {
  let finish: (bitmap: unknown) => void = () => {}, calls = 0, closed = 0;
  const f = fixtures(class {
    grabFrame() {
      calls++;
      return calls === 1 ? new Promise(resolve => { finish = resolve; }) : Promise.resolve({ width: 640, height: 360, close() { closed++; } });
    }
  });
  const adapter = new SourceStillCapture(), abort = new AbortController();
  try {
    const pending = capture(adapter, new Track(), abort.signal);
    abort.abort();
    assert.equal(await pending, null);
    adapter.dispose();
    const track = new Track(), blob = await capture(adapter, track);
    assert.ok(blob);
    assert.equal(calls, 1, 'An unresolved native grab must never overlap another native grab');
    assert.deepEqual(f.streams, [[track]], 'Fallback attaches only the borrowed video track');
    assert.equal(f.videos[0].muted, true);
    assert.equal(f.videos[0].srcObject, null);
    assert.ok(f.videos[0].pauses > 0);
    finish({ width: 1920, height: 1080, close() { closed++; } });
    await flush();
    assert.equal(closed, 1, 'Aborted native result is closed instead of displayed');
    assert.ok(await capture(adapter, new Track()));
    assert.equal(calls, 2, 'The native slot becomes usable again after the actual request settles');
  } finally { adapter.dispose(); f.restore(); }
});

test('timed-out native tracks use the brief fallback without repeating hanging native work', async () => {
  let finish: (bitmap: unknown) => void = () => {}, calls = 0, closed = 0;
  const f = fixtures(class { grabFrame() { calls++; return new Promise(resolve => { finish = resolve; }); } });
  const adapter = new SourceStillCapture(), track = new Track();
  try {
    assert.ok(await capture(adapter, track));
    finish({ width: 640, height: 360, close() { closed++; } });
    await flush();
    assert.ok(await capture(adapter, track));
    assert.equal(calls, 1, 'A track that timed out stays on the fallback');
    assert.equal(closed, 1);
    assert.equal(f.videos.length, 1, 'All fallback samples share one detached video');
    assert.equal(f.videos[0].srcObject, null);
  } finally { adapter.dispose(); f.restore(); }
});
