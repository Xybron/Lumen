import test from 'node:test';
import assert from 'node:assert/strict';
import { BroadcastVideoSource, ProgramBroadcastCapture, broadcastCaptureSettings, broadcastRecorderOptions, type BroadcastCaptureRecorder } from '../../frontend/src/lib/studio/broadcast-capture.js';

const tick = () => new Promise(resolve => setTimeout(resolve, 5));
function fixture(overrides: Partial<ConstructorParameters<typeof ProgramBroadcastCapture>[0]> = {}) {
  const recorders: BroadcastCaptureRecorder[] = [], uploads: number[] = [], failures: string[] = [];
  let stopped = 0;
  const capture = new ProgramBroadcastCapture({ createRecorder() { const recorder = { state: 'inactive', ondataavailable: null, onerror: null, start(ms: number) { assert.equal(ms, 500); this.state = 'recording'; }, stop() { this.state = 'inactive'; stopped++; } } satisfies BroadcastCaptureRecorder; recorders.push(recorder); return recorder; },
    async upload(_id, sequence) { uploads.push(sequence); }, onFailure(_id, message) { failures.push(message); }, ...overrides });
  const stream = { getTracks() { throw new Error('Capture must never own or stop Program tracks.'); } } as unknown as MediaStream;
  return { capture, recorders, uploads, failures, stream, stopped: () => stopped, chunk(bytes: number) { recorders.at(-1)?.ondataavailable?.({ data: new Blob([new Uint8Array(bytes)]) }); } };
}
test('broadcast capture serializes chunks and never stops the shared Program tracks or a recording', async () => {
  const f = fixture(); f.capture.start('broadcast_one', f.stream); f.capture.start('broadcast_one', f.stream);
  assert.equal(f.recorders.length, 1); f.chunk(12); f.chunk(13); await tick();
  assert.deepEqual(f.uploads, [0, 1]); assert.equal(f.capture.queuedBytes, 0);
  f.capture.stop('unrelated'); assert.equal(f.stopped(), 0); f.capture.stop();
  assert.equal(f.stopped(), 1); assert.equal(f.capture.activeId, null); assert.deepEqual(f.failures, []);
});
test('a failed chunk retries the same sequence instead of corrupting the continuous WebM stream', async () => {
  const sequences: number[] = [], f = fixture({ retryDelayMs: 1, async upload(_id, sequence) { sequences.push(sequence); if (sequences.length === 1) throw new Error('temporary failure'); } });
  f.capture.start('broadcast_retry', f.stream); f.chunk(8); f.chunk(8); await new Promise(resolve => setTimeout(resolve, 20));
  assert.deepEqual(sequences, [0, 0, 1]); assert.deepEqual(f.failures, []); f.capture.stop();
});
test('a bounded transport overflow stops only streaming and reports one clear failure', async () => {
  const f = fixture({ maxQueuedBytes: 12, async upload() { await new Promise(() => {}); } });
  f.capture.start('broadcast_bound', f.stream); f.chunk(8); f.chunk(8); f.chunk(8); await tick();
  assert.deepEqual(f.failures, ['The streaming connection is too slow. Streaming stopped to protect Program and local recording.']); assert.equal(f.capture.activeId, null); assert.equal(f.stopped(), 1);
});
test('encoder failures use streaming language and preserve independent recording', async () => {
  const f = fixture(); f.capture.start('broadcast_encoder_error', f.stream);
  f.recorders[0].onerror?.(); await tick();
  assert.deepEqual(f.failures, ['The streaming encoder stopped. Local recording is independent.']);
  assert.equal(f.capture.activeId, null); assert.equal(f.stopped(), 1);
});
test('stalled uploads time out and stop streaming rather than growing an unbounded queue', async () => {
  const f = fixture({ requestTimeoutMs: 8, retryDelayMs: 1, async upload() { return new Promise(() => {}); } });
  f.capture.start('broadcast_stall', f.stream); f.chunk(8); await new Promise(resolve => setTimeout(resolve, 50));
  assert.equal(f.failures.length, 1); assert.equal(f.capture.activeId, null); assert.equal(f.stopped(), 1);
});
test('a new broadcast discards old-session queued chunks without reporting a new-session failure', async () => {
  const f = fixture({ async upload() { return new Promise(() => {}); } });
  f.capture.start('broadcast_old', f.stream); f.chunk(8); await tick(); f.capture.start('broadcast_new', f.stream); await tick();
  assert.equal(f.capture.activeId, 'broadcast_new'); assert.deepEqual(f.failures, []); assert.equal(f.stopped(), 1); f.capture.stop();
});

test('broadcast profiles cap native capture at 30fps and avoid unnecessary 1080p encode for 720p', () => {
  assert.deepEqual(broadcastCaptureSettings('720p'), { profile: '720p', width: 1280, height: 720, frameRate: 30, videoBitsPerSecond: 3_000_000, audioBitsPerSecond: 192_000 });
  assert.deepEqual(broadcastCaptureSettings('1080p'), { profile: '1080p', width: 1920, height: 1080, frameRate: 30, videoBitsPerSecond: 6_000_000, audioBitsPerSecond: 192_000 });
  const small = broadcastCaptureSettings('720p'), full = broadcastCaptureSettings('1080p');
  assert.ok(small.width * small.height < full.width * full.height * .45);
  assert.equal(small.audioBitsPerSecond, full.audioBitsPerSecond);
});

test('native transport explicitly chooses VP8 and never silently falls back to VP9', () => {
  const checked: string[] = [];
  const options = broadcastRecorderOptions('720p', mime => { checked.push(mime); return mime === 'video/webm;codecs=vp8'; });
  assert.deepEqual(options, { mimeType: 'video/webm;codecs=vp8', videoBitsPerSecond: 3_000_000, audioBitsPerSecond: 192_000 });
  assert.ok(checked.every(mime => !mime.includes('vp9')));
  assert.throws(() => broadcastRecorderOptions('1080p', () => false), /VP8/);
});

function videoSurfaceFixture() {
  let stopped = 0, fps = 0, draws = 0;
  const audio = { kind: 'audio', stop() { throw new Error('The mixed audio track is never owned by streaming.'); } } as unknown as MediaStreamTrack;
  const originalVideo = { kind: 'video', stop() { throw new Error('Program and recording video must stay live.'); } } as unknown as MediaStreamTrack;
  const ownedVideo = { kind: 'video', stop() { stopped++; } } as unknown as MediaStreamTrack;
  const attached: MediaStreamTrack[] = [ownedVideo];
  const program = { getAudioTracks: () => [audio], getVideoTracks: () => [originalVideo], getTracks: () => [originalVideo, audio] } as unknown as MediaStream;
  const captured = { getAudioTracks: () => attached.filter(track => track.kind === 'audio'), getVideoTracks: () => [ownedVideo], addTrack(track: MediaStreamTrack) { attached.push(track); } } as unknown as MediaStream;
  const source = { width: 1920, height: 1080 } as HTMLCanvasElement;
  const context = { drawImage(actual: HTMLCanvasElement, x: number, y: number, width: number, height: number) { assert.equal(actual, source); assert.deepEqual([x, y, width, height], [0, 0, 1280, 720]); draws++; } };
  const canvas = { width: 0, height: 0, getContext: () => context, captureStream(rate: number) { fps = rate; return captured; } } as unknown as HTMLCanvasElement;
  return { source, program, canvas, captured, audio, stopped: () => stopped, fps: () => fps, draws: () => draws };
}

test('720p uses one owned surface and shares exact Main audio without changing the recording surface', () => {
  const f = videoSurfaceFixture(), surface = new BroadcastVideoSource(f.source, f.program, '720p', () => f.canvas);
  assert.equal(surface.stream, f.captured); assert.equal(f.fps(), 30);
  assert.deepEqual([f.canvas.width, f.canvas.height], [1280, 720]);
  assert.deepEqual(surface.stream.getAudioTracks(), [f.audio]);
  assert.equal(f.draws(), 1); surface.draw(); assert.equal(f.draws(), 2);
  surface.close(); surface.close(); surface.draw();
  assert.equal(f.stopped(), 1); assert.equal(f.draws(), 2);
  assert.deepEqual([f.canvas.width, f.canvas.height], [0, 0]);
  assert.deepEqual([f.source.width, f.source.height], [1920, 1080]);
});

test('1080p directly reuses Program, allocates no extra surface and stops no shared tracks', () => {
  const f = videoSurfaceFixture(), surface = new BroadcastVideoSource(f.source, f.program, '1080p', () => { throw new Error('No redundant 1080p canvas.'); });
  assert.equal(surface.stream, f.program); surface.draw(); surface.close(); surface.close();
  assert.equal(f.stopped(), 0); assert.equal(f.draws(), 0);
  assert.deepEqual([f.source.width, f.source.height], [1920, 1080]);
});

test('surface initialization failures release only the owned video track', () => {
  const f = videoSurfaceFixture(); f.captured.addTrack = () => { throw new Error('Cannot attach audio.'); };
  assert.throws(() => new BroadcastVideoSource(f.source, f.program, '720p', () => f.canvas), /Cannot attach/);
  assert.equal(f.stopped(), 1);
  assert.deepEqual([f.source.width, f.source.height], [1920, 1080]);
});

test('a broadcast lazily acquires its profile surface once and releases it on stop or replacement', () => {
  const f = fixture(); let acquired = 0, released = 0;
  const source = () => { acquired++; return { stream: f.stream, release() { released++; } }; };
  f.capture.start('first', source, '720p'); f.capture.start('first', source, '720p');
  assert.equal(acquired, 1); assert.equal(f.capture.settings?.width, 1280);
  f.capture.start('second', source, '1080p'); assert.equal(released, 1); assert.equal(acquired, 2);
  assert.equal(f.capture.settings?.width, 1920);
  f.capture.stop('unrelated'); assert.equal(released, 1);
  f.capture.stop(); f.capture.stop(); assert.equal(released, 2); assert.equal(f.capture.settings, null);
});

test('encoder creation and start failures free an owned surface without stopping Program', async () => {
  for (const failsOnStart of [false, true]) {
    let released = 0;
    const f = fixture({ createRecorder() {
      if (!failsOnStart) throw new Error('No encoder.');
      return { state: 'inactive', ondataavailable: null, onerror: null, start() { throw new Error('Cannot start.'); }, stop() {} };
    } });
    f.capture.start('failure', () => ({ stream: f.stream, release() { released++; } }), '720p');
    await tick(); assert.equal(released, 1); assert.equal(f.failures.length, 1); assert.equal(f.capture.activeId, null);
  }
});

test('source creation or synchronous failure reporting cannot escape into the production draw loop', async () => {
  const f = fixture({ onFailure() { throw new Error('Failed reporting is isolated.'); } });
  assert.doesNotThrow(() => f.capture.start('failure', () => { throw new Error('No capture surface.'); }, '720p'));
  await tick(); assert.equal(f.capture.activeId, null);
});
