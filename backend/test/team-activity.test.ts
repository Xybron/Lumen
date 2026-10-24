import test from 'node:test';
import assert from 'node:assert/strict';
import { activityPublisher, parseActivity, type TeamActivity } from '../../frontend/src/lib/team/activity.js';

const sessionId = '932580c3-d36e-4e90-aacf-a9682bf9e057';
const userId = '48c54609-2d4d-4126-a37e-74b53c826658';
const active = (): TeamActivity => ({ version: 1, sessionId, userId, sequence: 1, active: true, surface: 'team:library', x: 0.25, y: 0.75 });

function fakeClock() {
  let current = 0, serial = 0;
  const timers = new Map<number, { due: number; callback: () => void }>();
  return {
    now: () => current,
    schedule(callback: () => void, delay: number) {
      const id = ++serial;
      timers.set(id, { due: current + delay, callback });
      return () => { timers.delete(id); };
    },
    advance(milliseconds: number) {
      const target = current + milliseconds;
      for (;;) {
        const next = [...timers.entries()].sort((a, b) => a[1].due - b[1].due || a[0] - b[0])[0];
        if (!next || next[1].due > target) break;
        current = next[1].due; timers.delete(next[0]); next[1].callback();
      }
      current = target;
    },
    pending: () => timers.size,
  };
}

test('activity parser accepts normalized boundaries and drops unrelated fields', () => {
  const frame = { ...active(), x: 0, y: 1, permission: 'owner', token: 'not-part-of-activity' };
  assert.deepEqual(parseActivity(frame), { ...active(), x: 0, y: 1 });
  assert.deepEqual(parseActivity({ ...active(), sequence: Number.MAX_SAFE_INTEGER }), { ...active(), sequence: Number.MAX_SAFE_INTEGER });
});

test('activity parser rejects malformed envelopes, IDs, sequence numbers and coordinates', () => {
  for (const value of [null, undefined, [], '', 1, true]) assert.equal(parseActivity(value), null);
  for (const version of [undefined, 0, 2, '1']) assert.equal(parseActivity({ ...active(), version }), null);
  for (const key of ['sessionId', 'userId']) {
    for (const value of [undefined, null, 1, '', 'not-an-id', `${sessionId}x`, `${sessionId}\n`, `${sessionId}\r\n`, sessionId.slice(1)]) assert.equal(parseActivity({ ...active(), [key]: value }), null);
  }
  for (const sequence of [undefined, 0, -1, 1.5, NaN, Infinity, Number.MAX_SAFE_INTEGER + 1, '1']) assert.equal(parseActivity({ ...active(), sequence }), null);
  for (const value of [undefined, null, 0, 1, 'true']) assert.equal(parseActivity({ ...active(), active: value }), null);
  for (const key of ['x', 'y']) {
    for (const value of [undefined, null, '0.5', NaN, Infinity, -Infinity, -0.001, 1.001]) assert.equal(parseActivity({ ...active(), [key]: value }), null);
  }
  for (const surface of [undefined, null, 1, '', 'x'.repeat(101)]) assert.equal(parseActivity({ ...active(), surface }), null);
  assert.equal(parseActivity({ ...active(), surface: 'x'.repeat(100) })?.surface?.length, 100);
});

test('inactive activity omits pointer and surface fields even when an untrusted sender supplies them', () => {
  assert.deepEqual(parseActivity({ ...active(), active: false, surface: 'private-dialog', x: NaN, y: 'private' }), { version: 1, sessionId, userId, sequence: 1, active: false });
  assert.deepEqual(parseActivity({ version: 1, sessionId, userId, sequence: 2, active: false }), { version: 1, sessionId, userId, sequence: 2, active: false });
});

test('activity publisher coalesces a pointer burst and sends the latest final position at250ms', () => {
  const clock = fakeClock(), sent: { at: number; position: number }[] = [];
  let position = 0;
  const publisher = activityPublisher(() => true, () => sent.push({ at: clock.now(), position }), clock);
  publisher.publish();
  clock.advance(1); position = 1; publisher.publish();
  clock.advance(24); position = 2; publisher.publish();
  assert.equal(clock.pending(), 1, 'burst schedules only one trailing publication');
  clock.advance(224);
  assert.deepEqual(sent, [{ at: 0, position: 0 }]);
  position = 3; clock.advance(1);
  assert.deepEqual(sent, [{ at: 0, position: 0 }, { at: 250, position: 3 }]);
  assert.equal(clock.pending(), 0);
});

test('normal sustained activity emits at most four messages per second with no retained backlog', () => {
  const clock = fakeClock(), times: number[] = [];
  const publisher = activityPublisher(() => true, () => times.push(clock.now()), clock);
  for (let tick = 0; tick < 500; tick++) { publisher.publish(); clock.advance(20); }
  clock.advance(250);
  assert.ok(times.length >= 40, 'sustained movement stays responsive');
  for (let index = 1; index < times.length; index++) assert.ok(times[index] - times[index - 1] >= 250);
  for (const from of times) assert.ok(times.filter(time => time >= from && time < from + 1000).length <= 4);
  assert.equal(clock.pending(), 0, 'latest state, never a growing motion queue');
});

test('urgent inactive activity cancels a pending active position instead of replaying it', () => {
  const clock = fakeClock(), sent: boolean[] = [];
  let isActive = true;
  const publisher = activityPublisher(() => true, () => sent.push(isActive), clock);
  publisher.publish(); clock.advance(25); publisher.publish();
  assert.equal(clock.pending(), 1);
  isActive = false; publisher.publish(true);
  assert.deepEqual(sent, [true, false]); assert.equal(clock.pending(), 0);
  clock.advance(1000);
  assert.deepEqual(sent, [true, false], 'Focus/offline signal cannot be followed by an old scheduled cursor');
});

test('a false canSend cancels scheduled activity and never replays it on reconnect', () => {
  const clock = fakeClock(), sent: number[] = [];
  let allowed = true;
  const publisher = activityPublisher(() => allowed, () => sent.push(clock.now()), clock);
  publisher.publish(); clock.advance(20); publisher.publish();
  allowed = false; publisher.publish();
  assert.equal(clock.pending(), 0); clock.advance(1000);
  allowed = true; clock.advance(1000);
  assert.deepEqual(sent, [0], 'restoring connectivity does not replay any old motion');
  publisher.publish(); assert.deepEqual(sent, [0, 2020], 'a fresh explicit publication reads current state');
});

test('scheduled activity rechecks canSend at send time', () => {
  const clock = fakeClock(), sent: number[] = [];
  let allowed = true;
  const publisher = activityPublisher(() => allowed, () => sent.push(clock.now()), clock);
  publisher.publish(); clock.advance(25); publisher.publish();
  allowed = false; clock.advance(225);
  assert.deepEqual(sent, [0]); assert.equal(clock.pending(), 0);
});

test('lifecycle cancellation is idempotent and leaves no trailing motion callback', () => {
  const clock = fakeClock(), sent: number[] = [];
  const publisher = activityPublisher(() => true, () => sent.push(clock.now()), clock);
  publisher.publish(); clock.advance(25); publisher.publish();
  publisher.cancel(); publisher.cancel();
  assert.equal(clock.pending(), 0); clock.advance(1000);
  assert.deepEqual(sent, [0]);
});
