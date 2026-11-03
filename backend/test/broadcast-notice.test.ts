import test from 'node:test';
import assert from 'node:assert/strict';
import type { BroadcastSession } from '../../shared/broadcast.js';
import { streamNotice, restoredNotice } from '../../frontend/src/lib/broadcast-notice.js';

function session(): BroadcastSession {
  return { id: 'service', profile: '720p', state: 'live', startedAt: '', chunks: 1, bytes: 1024,
    destinations: [{ id: 'youtube', state: 'live', retries: 0, bytes: 512 }, { id: 'facebook', state: 'live', retries: 0, bytes: 512 }],
    watch: { id: 'watch', state: 'disabled', retries: 0, bytes: 0 } };
}
test('one lost destination identifies the affected service and the destination still sending', () => {
  const value = session(), watch = (unreachable = false) => streamNotice(value, value.id, unreachable);
  assert.equal(watch(), null);
  value.destinations[0].state = 'retrying'; value.destinations[0].retries++;
  const retry = watch();
  assert.match(retry!.message, /YouTube is reconnecting.*Still sending to Facebook/);
  value.destinations[0].state = 'connecting';
  assert.equal(watch()?.key, retry?.key, 'Retry attempts share one notice');
  value.destinations[0].state = 'error';
  assert.equal(watch()?.tone, 'danger');
  assert.equal(watch(true)?.label, 'Stream status unknown');
  value.destinations[0].state = 'stopped';
  assert.equal(watch()?.tone, 'info');
  value.destinations[0].state = 'disabled';
  assert.equal(watch(), null);
});
test('normal sign-off, fatal termination and an interrupted session after a station restart are distinct', () => {
  const value = session();
  value.state = 'error';
  assert.equal(streamNotice(value, null, false)?.tone, 'danger');
  value.state = 'stopping';
  assert.equal(streamNotice(value, value.id, false), null);
  value.state = 'stopped';
  assert.equal(streamNotice(value, null, false), null, 'Old completed broadcasts do not greet a new operator');
  assert.equal(streamNotice(value, value.id, false)?.label, 'Stream ended');
  assert.equal(streamNotice(null, value.id, false)?.label, 'Stream interrupted');
});
test('a brief retry between polls reports recovery once, within the same broadcast', () => {
  const before = session(), after = session();
  after.destinations[0].retries++;
  assert.match(restoredNotice(after, before)!.message, /YouTube again/);
  assert.equal(restoredNotice(after, structuredClone(after)), null);
  before.id = 'another';
  assert.equal(restoredNotice(after, before), null);
});
