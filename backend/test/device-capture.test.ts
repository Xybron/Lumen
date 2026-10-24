import test, { type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { inputCaptureError, liveInputStatus, openDeviceCapture } from '../../frontend/src/lib/studio/device-capture.js';

function devices(t: TestContext, capture: (constraints: MediaStreamConstraints) => Promise<MediaStream>) {
  const original = Object.getOwnPropertyDescriptor(globalThis, 'navigator');
  Object.defineProperty(globalThis, 'navigator', { configurable: true, value: { mediaDevices: { getUserMedia: capture } } });
  t.after(() => { if (original) Object.defineProperty(globalThis, 'navigator', original); else delete (globalThis as any).navigator; });
}
function track(kind: 'video' | 'audio', live = true) {
  return { kind, readyState: live ? 'live' : 'ended', muted: false, stops: 0,
    stop() { this.stops++; this.readyState = 'ended'; }, getSettings: () => ({ width: 1280, height: 720, frameRate: 25 }) };
}
function stream(...tracks: ReturnType<typeof track>[]) {
  return { getTracks: () => tracks, getVideoTracks: () => tracks.filter(t => t.kind === 'video'), getAudioTracks: () => tracks.filter(t => t.kind === 'audio') } as unknown as MediaStream;
}

test('an HDMI card can negotiate a fixed 720p25 mode while retaining exact video and HDMI audio selections', async t => {
  const video = track('video'), audio = track('audio'), feed = stream(video, audio), calls: MediaStreamConstraints[] = [];
  devices(t, async constraints => { calls.push(constraints); return feed; });
  assert.equal(await openDeviceCapture('camera', { videoDeviceId: 'hdmi-video', audioDeviceId: 'hdmi-audio', includeAudio: true }), feed);
  const constraints = calls[0].video as MediaTrackConstraints, sound = calls[0].audio as MediaTrackConstraints;
  assert.deepEqual(constraints.deviceId, { exact: 'hdmi-video' });
  assert.deepEqual(sound.deviceId, { exact: 'hdmi-audio' });
  for (const setting of [constraints.width, constraints.height, constraints.frameRate] as any[]) {
    assert.equal(setting.exact, undefined); assert.equal(setting.min, undefined, 'No required HD mode excludes inexpensive capture cards');
  }
  assert.equal(sound.echoCancellation, false); assert.equal(sound.noiseSuppression, false); assert.equal(sound.autoGainControl, false);
  assert.equal(video.stops + audio.stops, 0);
});

test('video-only capture does not require microphone access or invent a sound track', async t => {
  const video = track('video'), feed = stream(video);
  devices(t, async constraints => { assert.equal(constraints.audio, false); return feed; });
  assert.equal(await openDeviceCapture('camera', { videoDeviceId: 'usb-hdmi' }), feed);
  assert.equal(video.stops, 0);
});

test('an explicit camera format requests exact dimensions and fractional frame rate', async t => {
  const feed = stream(track('video')), calls: MediaStreamConstraints[] = [];
  devices(t, async constraints => { calls.push(constraints); return feed; });
  await openDeviceCapture('camera', { videoDeviceId: 'card', width: 1280, height: 720, frameRate: 29.97 });
  assert.deepEqual(calls[0].video, {
    deviceId: { exact: 'card' }, width: { exact: 1280 }, height: { exact: 720 }, frameRate: { exact: 29.97 },
  });
  await openDeviceCapture('camera', { videoDeviceId: 'card', frameRate: 60 });
  assert.deepEqual(calls[1].video, {
    deviceId: { exact: 'card' }, width: { ideal: 1920 }, height: { ideal: 1080 }, frameRate: { exact: 60 },
  });
});

test('unsupported format constraints report a format choice error and never retry a different mode', async t => {
  const calls: MediaStreamConstraints[] = []; let constraint = 'width';
  devices(t, async constraints => { calls.push(constraints); throw { name: 'OverconstrainedError', constraint }; });
  for (constraint of ['width', 'height', 'frameRate']) {
    await assert.rejects(openDeviceCapture('camera', { videoDeviceId: 'card', width: 3840, height: 2160, frameRate: 60 }),
      constraint === 'frameRate' ? /selected frame rate.*Choose another.*Auto/ : /selected resolution.*Choose another.*Auto/);
  }
  assert.equal(calls.length, 3, 'Each request fails once without relaxing its exact constraints');
  assert.match(inputCaptureError({ name: 'OverconstrainedError', constraint: 'deviceId' }), /selected input is unavailable/);
});

test('missing or busy selected hardware fails without retrying the default webcam', async t => {
  const calls: MediaStreamConstraints[] = [];
  devices(t, async constraints => { calls.push(constraints); throw new DOMException('Driver detail', 'OverconstrainedError'); });
  await assert.rejects(openDeviceCapture('camera', { videoDeviceId: 'removed-card' }), /selected input is unavailable/);
  assert.equal(calls.length, 1); assert.deepEqual((calls[0].video as MediaTrackConstraints).deviceId, { exact: 'removed-card' });
  assert.match(inputCaptureError({ name: 'NotReadableError' }), /Close other apps/);
  assert.match(inputCaptureError({ name: 'NotAllowedError' }), /system privacy settings/);
});

test('partial camera captures release every track and report the missing video or requested audio', async t => {
  const video = track('video'), audio = track('audio'); let feed = stream(audio);
  devices(t, async () => feed);
  await assert.rejects(openDeviceCapture('camera'), /no live video track/); assert.equal(audio.stops, 1);
  feed = stream(video);
  await assert.rejects(openDeviceCapture('camera', { includeAudio: true }), /no live audio track/); assert.equal(video.stops, 1);
});

test('camera readiness requires a live unmuted video track and decoded pixels, independently of audio', () => {
  const video = track('video'), audio = track('audio'), feed = stream(video, audio);
  const picture = { readyState: 2, videoWidth: 1280, videoHeight: 720 };
  assert.equal(liveInputStatus('camera', feed, null), 'loading');
  assert.equal(liveInputStatus('camera', feed, { ...picture, readyState: 1 }), 'loading');
  assert.equal(liveInputStatus('camera', feed, { ...picture, videoWidth: 0 }), 'loading');
  assert.equal(liveInputStatus('camera', feed, picture), 'ready');
  video.muted = true; assert.equal(liveInputStatus('camera', feed, picture), 'loading');
  video.stop(); assert.equal(liveInputStatus('camera', feed, picture), 'missing', 'Live HDMI audio cannot mask a lost camera track');
  assert.equal(liveInputStatus('microphone', feed), 'ready');
  assert.equal(liveInputStatus('screen', stream(audio), picture), 'missing');
  assert.equal(liveInputStatus('camera', null, picture), 'missing');
});
