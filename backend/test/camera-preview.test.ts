import test, { type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { CameraPreviewCapture } from '../../frontend/src/lib/studio/camera-preview.js';

class Track {
  readyState = 'live'; muted = false; stops = 0;
  applications: MediaTrackConstraints[] = []; clones: Track[] = [];
  onApply?: (constraints: MediaTrackConstraints) => Promise<void>;
  constructor(readonly kind: 'video' | 'audio', readonly deviceId: string, private constraints: MediaTrackConstraints = {}) {}
  getSettings() { return { deviceId: this.deviceId }; }
  getConstraints() { return structuredClone(this.constraints); }
  async applyConstraints(constraints: MediaTrackConstraints) {
    this.applications.push(structuredClone(constraints));
    await this.onApply?.(constraints);
    this.constraints = structuredClone(constraints);
  }
  stop() { this.stops++; this.readyState = 'ended'; }
  clone() {
    const clone = new Track(this.kind, this.deviceId, this.getConstraints());
    clone.onApply = this.onApply; this.clones.push(clone);
    return clone;
  }
}
class Stream {
  constructor(readonly tracks: Track[] = []) {}
  getTracks() { return this.tracks; }
  getVideoTracks() { return this.tracks.filter(track => track.kind === 'video'); }
  getAudioTracks() { return this.tracks.filter(track => track.kind === 'audio'); }
  addTrack(track: Track) { this.tracks.push(track); }
  clone() { return new Stream(this.tracks.map(track => track.clone())); }
}
const cast = (stream: Stream) => stream as unknown as MediaStream;
const camera = (id: string) => new Stream([new Track('video', id)]);
function deferred<T>() { let resolve!: (value: T) => void; const promise = new Promise<T>(done => { resolve = done; }); return { promise, resolve }; }
function harness(t: TestContext, capture: (value: MediaStreamConstraints) => Promise<MediaStream>) {
  const keys = ['navigator', 'MediaStream'], originals = keys.map(key => [key, Object.getOwnPropertyDescriptor(globalThis, key)] as const);
  Object.defineProperty(globalThis, 'navigator', { configurable: true, value: { mediaDevices: { getUserMedia: capture } } });
  Object.defineProperty(globalThis, 'MediaStream', { configurable: true, value: Stream });
  t.after(() => { for (const [key, descriptor] of originals) {
    if (descriptor) Object.defineProperty(globalThis, key, descriptor); else delete (globalThis as any)[key];
  } });
}

test('switching cameras discards a late permission result without replacing the newer picture', async t => {
  const first = deferred<MediaStream>(), second = deferred<MediaStream>(), a = camera('a'), b = camera('b');
  harness(t, async constraints => (constraints.video as MediaTrackConstraints).deviceId && ((constraints.video as MediaTrackConstraints).deviceId as ConstrainDOMStringParameters).exact === 'a' ? first.promise : second.promise);
  const preview = new CameraPreviewCapture(), old = preview.start({ videoDeviceId: 'a' }), next = preview.start({ videoDeviceId: 'b' });
  second.resolve(cast(b)); assert.equal(await next, b);
  first.resolve(cast(a)); assert.equal(await old, null);
  assert.equal(a.tracks[0].readyState, 'ended'); assert.equal(b.tracks[0].readyState, 'live');
  preview.stop(); assert.equal(b.tracks[0].readyState, 'ended');
});

test('closing setup releases a camera whose permission prompt finishes after close', async t => {
  const pending = deferred<MediaStream>(), feed = camera('card'); harness(t, () => pending.promise);
  const preview = new CameraPreviewCapture(), request = preview.start({ videoDeviceId: 'card' });
  preview.stop(); pending.resolve(cast(feed));
  assert.equal(await request, null); assert.equal(feed.tracks[0].readyState, 'ended'); assert.equal(preview.copy(), null);
});

test('previewing an active card and closing setup never stops its published tracks', async t => {
  harness(t, async () => assert.fail('An active card must not be opened twice'));
  const live = camera('card'), preview = new CameraPreviewCapture();
  const shown = await preview.start({ videoDeviceId: 'card' }, [cast(live)]);
  assert.notEqual(shown?.getVideoTracks()[0], live.tracks[0]);
  const published = preview.copy()!;
  preview.stop();
  assert.equal(shown?.getVideoTracks()[0].readyState, 'ended');
  assert.equal(live.tracks[0].readyState, 'live'); assert.equal(published.getVideoTracks()[0].readyState, 'live');
  published.getTracks().forEach(track => track.stop()); assert.equal(live.tracks[0].stops, 0);
});

test('turning audio on preserves the same camera and acquires only the selected sound input', async t => {
  const sound = new Stream([new Track('audio', 'hdmi-audio')]), calls: MediaStreamConstraints[] = [];
  harness(t, async value => { calls.push(value); return cast(sound); });
  const live = camera('card'), preview = new CameraPreviewCapture();
  const first = await preview.start({ videoDeviceId: 'card' }, [cast(live)]);
  const next = await preview.start({ videoDeviceId: 'card', audioDeviceId: 'hdmi-audio', includeAudio: true });
  assert.equal(calls.length, 1); assert.equal(calls[0].video, false);
  assert.deepEqual((calls[0].audio as MediaTrackConstraints).deviceId, { exact: 'hdmi-audio' });
  assert.equal(first?.getVideoTracks()[0].readyState, 'ended'); assert.equal(next?.getVideoTracks()[0].readyState, 'live');
  preview.stop(); assert.equal(sound.tracks[0].readyState, 'ended'); assert.equal(live.tracks[0].readyState, 'live');
});

test('audio arriving after cancel is released while the existing Studio camera remains live', async t => {
  const pending = deferred<MediaStream>(), started = deferred<void>(), sound = new Stream([new Track('audio', 'audio')]);
  harness(t, () => { started.resolve(); return pending.promise; });
  const live = camera('card'), preview = new CameraPreviewCapture();
  const request = preview.start({ videoDeviceId: 'card', includeAudio: true }, [cast(live)]);
  await started.promise;
  preview.stop(); pending.resolve(cast(sound));
  assert.equal(await request, null); assert.equal(sound.tracks[0].readyState, 'ended'); assert.equal(live.tracks[0].readyState, 'live');
});

test('format changes apply to the owned preview clone and cancel preserves published track constraints', async t => {
  harness(t, async () => assert.fail('An active card must not be opened twice'));
  const originalConstraints = { deviceId: { exact: 'card' }, width: { exact: 1920 }, height: { exact: 1080 }, frameRate: { exact: 30 } };
  const original = new Track('video', 'card', originalConstraints), live = new Stream([original]);
  const preview = new CameraPreviewCapture();
  const shown = await preview.start({ videoDeviceId: 'card', width: 1280, height: 720, frameRate: 25 }, [cast(live)]);
  assert.deepEqual(shown!.getVideoTracks()[0].getConstraints(), {
    deviceId: { exact: 'card' }, width: { exact: 1280 }, height: { exact: 720 }, frameRate: { exact: 25 },
  });
  assert.equal(original.applications.length, 0);
  assert.deepEqual(original.getConstraints(), originalConstraints);
  preview.stop();
  assert.equal(shown!.getVideoTracks()[0].readyState, 'ended');
  assert.equal(original.readyState, 'live'); assert.deepEqual(original.getConstraints(), originalConstraints);
});

test('returning to Auto replaces inherited exact preview constraints with automatic preferences', async t => {
  harness(t, async () => assert.fail('Format changes must reuse the active card'));
  const live = camera('card'), preview = new CameraPreviewCapture();
  const selected = await preview.start({ videoDeviceId: 'card', width: 1280, height: 720, frameRate: 25 }, [cast(live)]);
  const automatic = await preview.start({ videoDeviceId: 'card' });
  assert.deepEqual(automatic!.getVideoTracks()[0].getConstraints(), {
    deviceId: { exact: 'card' }, width: { ideal: 1920 }, height: { ideal: 1080 }, frameRate: { ideal: 30 },
  });
  assert.equal(selected!.getVideoTracks()[0].readyState, 'ended');
  assert.equal(automatic!.getVideoTracks()[0].readyState, 'live');
  preview.stop(); assert.equal(live.tracks[0].stops, 0);
});

test('a rejected clone format reports the unsupported setting and releases only preview tracks', async t => {
  harness(t, async () => assert.fail('Unsupported formats must not retry a default input'));
  const live = camera('card'), preview = new CameraPreviewCapture();
  live.tracks[0].onApply = async () => { throw { name: 'OverconstrainedError', constraint: 'frameRate' }; };
  await assert.rejects(preview.start({ videoDeviceId: 'card', frameRate: 120 }, [cast(live)]), /selected frame rate.*Auto/);
  assert.equal(live.tracks[0].clones[0].readyState, 'ended');
  assert.equal(live.tracks[0].readyState, 'live'); assert.equal(preview.copy(), null);
});

test('a late format result cannot replace the newer preview or start cancelled audio capture', async t => {
  harness(t, async () => assert.fail('A superseded format must not request audio'));
  const pending = deferred<void>(), live = camera('card'), preview = new CameraPreviewCapture();
  live.tracks[0].onApply = async constraints => {
    if ((constraints.width as ConstrainULongRange).exact === 1920) await pending.promise;
  };
  const old = preview.start({ videoDeviceId: 'card', width: 1920, height: 1080, includeAudio: true }, [cast(live)]);
  const next = await preview.start({ videoDeviceId: 'card', width: 1280, height: 720 });
  pending.resolve(); assert.equal(await old, null);
  assert.equal(live.tracks[0].clones[0].readyState, 'ended');
  assert.equal(next!.getVideoTracks()[0].readyState, 'live');
  const transferred = preview.copy()!;
  assert.deepEqual(transferred.getVideoTracks()[0].getConstraints().width, { exact: 1280 });
  preview.stop(); transferred.getTracks().forEach(track => track.stop());
  assert.equal(live.tracks[0].stops, 0);
});
