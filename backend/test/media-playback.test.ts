import test from 'node:test';
import assert from 'node:assert/strict';
import { MediaPlayback, playbackError } from '../../frontend/src/lib/studio/media-playback.js';

function pending() {
  let resolve!: () => void, reject!: (reason: unknown) => void;
  const promise = new Promise<void>((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}
const flush = () => new Promise<void>(resolve => queueMicrotask(resolve));

test('replacing or disconnecting an input ignores its stale play rejection', async () => {
  const playback = new MediaPlayback(), errors: unknown[] = [];
  const old = pending(), next = pending();
  playback.bind({ play: () => old.promise, pause() {} }); playback.play(error => errors.push(error));
  playback.bind({ play: () => next.promise, pause() {} }); playback.play(error => errors.push(error));
  old.reject(new DOMException('Interrupted by pause() https://invalid.example', 'AbortError'));
  await flush(); assert.deepEqual(errors, []);
  playback.bind(null); next.reject(new DOMException('Source disconnected', 'AbortError'));
  await flush(); assert.deepEqual(errors, []);
});

test('an intentional pause cancels pending playback errors, but an active AbortError remains actionable', async () => {
  const playback = new MediaPlayback(), errors: unknown[] = [], request = pending(); let pauses = 0;
  playback.bind({ play: () => request.promise, pause() { pauses++; } });
  playback.play(error => errors.push(error)); playback.pause();
  request.reject(new DOMException('Paused by operator', 'AbortError')); await flush();
  assert.equal(pauses, 1); assert.deepEqual(errors, []);
  const activeError = new DOMException('Unexpected interruption', 'AbortError');
  playback.bind({ play: () => Promise.reject(activeError), pause() {} }); playback.play(error => errors.push(error));
  await flush(); assert.deepEqual(errors, [activeError]);
});

test('repeated play uses only the newest request and binding the same element is idempotent', async () => {
  const playback = new MediaPlayback(), errors: unknown[] = [], first = pending(), second = pending(); let calls = 0;
  const element = { play: () => ++calls === 1 ? first.promise : second.promise, pause() {} };
  playback.bind(element); playback.play(error => errors.push(error)); playback.play(error => errors.push(error));
  first.reject(new Error('obsolete')); await flush(); assert.deepEqual(errors, []);
  playback.bind(element); const currentError = new Error('current'); second.reject(currentError);
  await flush(); assert.deepEqual(errors, [currentError]);
  assert.equal(playback.isCurrent(element), true); playback.bind(null); assert.equal(playback.isCurrent(element), false);
});

test('synchronous playback failures are retained and messages never expose raw browser diagnostics or URLs', () => {
  const playback = new MediaPlayback(), errors: unknown[] = [], failure = new Error('raw browser url https://example.invalid');
  playback.bind({ play() { throw failure; }, pause() {} }); playback.play(error => errors.push(error));
  assert.deepEqual(errors, [failure]);
  for (const live of [true, false]) for (const name of ['AbortError', 'NotAllowedError', 'NotSupportedError', 'UnknownError']) {
    const message = playbackError({ name, message: 'The play() request was interrupted https://example.invalid' }, live);
    assert.ok(message.length < 130); assert.doesNotMatch(message, /https?:|play\(\)|example\.invalid/);
    assert.match(message, /Reconnect|Resume|Try|choose/);
  }
});
