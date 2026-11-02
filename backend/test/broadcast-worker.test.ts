import test from 'node:test';
import assert from 'node:assert/strict';
import { StudioBroadcastRecorder } from '../../frontend/src/lib/studio/broadcast-recorder.js';

test('Windows retries software before publishing, and never changes codecs after publishing', t => {
  const workers: WorkerStub[] = [];
  let stoppedClones = 0, failures = 0, chunks = 0;
  class WorkerStub {
    onmessage?: (event: { data: unknown }) => void;
    onerror?: () => void;
    sent: unknown[] = [];
    terminated = false;
    constructor() { workers.push(this); }
    postMessage(data: unknown) { this.sent.push(data); }
    terminate() { this.terminated = true; }
  }
  const windowStub = { setTimeout, MediaStreamTrackProcessor: class { readable = {}; } };
  for (const [key, value] of Object.entries({ Worker: WorkerStub, window: windowStub, navigator: { platform: 'Win32' } })) {
    const previous = Object.getOwnPropertyDescriptor(globalThis, key);
    Object.defineProperty(globalThis, key, { configurable: true, value });
    t.after(() => { if (previous) Object.defineProperty(globalThis, key, previous); else Reflect.deleteProperty(globalThis, key); });
  }
  const track = { clone: () => ({ stop() { stoppedClones++; } }), stop: () => assert.fail('Program still owns the original track') };
  const stream = { getVideoTracks: () => [track], getAudioTracks: () => [track] } as unknown as MediaStream;
  const recorder = new StudioBroadcastRecorder(stream, '1080p');
  t.after(() => recorder.stop());
  recorder.ondataavailable = () => { chunks++; };
  recorder.onerror = () => { failures++; recorder.stop(); };
  recorder.start(500);
  assert.deepEqual(workers[0].sent[0], { hardware: true, bitrate: 4500000 });
  workers[0].onmessage?.({ data: 'ready' });
  workers[0].onmessage?.({ data: 'error' });
  assert.ok(workers[0].terminated);
  assert.equal(stoppedClones, 2);
  assert.deepEqual(workers[1].sent[0], { hardware: false, bitrate: 4500000 });
  const chunk = new Blob(['stream'], { type: 'video/x-matroska' });
  workers[0].onmessage?.({ data: chunk });
  assert.equal(chunks, 0, 'discard late output from the failed hardware attempt');
  workers[1].onmessage?.({ data: 'ready' });
  workers[1].onmessage?.({ data: chunk });
  assert.equal(chunks, 1);
  workers[1].onerror?.();
  assert.equal(failures, 1);
  assert.equal(stoppedClones, 4);
  assert.equal(workers.length, 2);
});
