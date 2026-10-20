import test from 'node:test';
import assert from 'node:assert/strict';
import { describeMainAudioStatus } from '../../frontend/src/lib/studio/main-audio-status.js';

const input = { audio: { volume: .8, muted: false, mode: 'follow' as const, delayMs: 0 } };
test('Main input badge follows mute, zero gain and recovered readiness, not meter silence', () => {
  assert.equal(describeMainAudioStatus(input, 'running', 'ready').label, 'Main');
  assert.equal(describeMainAudioStatus({ audio: { ...input.audio, muted: true } }, 'running', 'ready').label, 'Main · Muted');
  const zero = describeMainAudioStatus({ audio: { ...input.audio, volume: 0 } }, 'running', 'ready');
  assert.equal(zero.state, 'muted'); assert.match(zero.title, /volume is zero/);
  assert.equal(describeMainAudioStatus(input, 'running', 'ready').state, 'ready');
});
test('Disconnected and genuine input errors remain visible even when the source is muted', () => {
  const muted = { audio: { ...input.audio, muted: true } };
  const missing = describeMainAudioStatus(muted, 'running', 'missing');
  assert.equal(missing.label, 'Main · Disconnected'); assert.match(missing.title, /also muted/);
  const failed = describeMainAudioStatus(input, 'running', 'error', 'Input playback was blocked. Reconnect this input.');
  assert.equal(failed.label, 'Main · Error'); assert.match(failed.title, /playback was blocked/);
  const noTrack = describeMainAudioStatus(input, 'running', 'missing', 'Main input has no live audio track.');
  assert.match(noTrack.title, /no live audio track/);
});
test('Offline, starting and loading engines never falsely claim a disconnected input', () => {
  for (const engine of ['offline', 'error'] as const) assert.equal(describeMainAudioStatus(input, engine, 'missing').state, 'offline');
  assert.equal(describeMainAudioStatus(input, 'starting', 'missing').state, 'loading');
  assert.equal(describeMainAudioStatus(input, 'running').state, 'loading');
  assert.equal(describeMainAudioStatus(input, 'running', 'loading').state, 'loading');
  assert.equal(describeMainAudioStatus({ audio: { ...input.audio, muted: true } }, 'offline').state, 'muted');
});
test('Paused media and text-only legacy main selections have explicit badges', () => {
  assert.equal(describeMainAudioStatus({ ...input, playback: { paused: true, restart: 0 } }, 'running', 'ready').label, 'Main · Paused');
  assert.equal(describeMainAudioStatus(input, 'running', 'ready', undefined, true).label, 'Main · No audio');
});
