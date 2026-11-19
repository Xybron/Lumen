import assert from 'node:assert/strict';
import test from 'node:test';
import { elapsedProductionTime, liveStatus, memoryLabel, recordingStatus } from '../../frontend/src/lib/studio/production-status';
import type { StudioRecording } from '../../shared/production';
import type { BroadcastSession } from '../../shared/broadcast';

const createdAt = '2026-11-18T12:00:00Z', now = Date.parse(createdAt) + (2 * 3600 + 18 * 60 + 42) * 1000;
const recording: StudioRecording = { id: 'r', name: 'Program', status: 'recording', createdAt, bytes: 1024, durationMs: 0 };
const session: BroadcastSession = { id: 'b', profile: '1080p', state: 'live', startedAt: createdAt, chunks: 0, bytes: 0, destinations: [], watch: { id: 'watch', state: 'disabled', retries: 0, bytes: 0 } };
test('production clocks track independent start times and never invent zero durations for unknown timestamps', () => {
  assert.equal(elapsedProductionTime(createdAt, now), '02:18:42');
  assert.equal(elapsedProductionTime(createdAt, Date.parse(createdAt) - 1000), '00:00:00');
  assert.equal(elapsedProductionTime('bad', now), '—'); assert.equal(elapsedProductionTime(undefined, now), '—');
  assert.equal(recordingStatus(recording, now).text, '02:18:42');
  assert.equal(liveStatus({ ...session, startedAt: '2026-11-18T13:00:00Z' }, now).text, '01:18:42');
});
test('starting, stopping, finalizing, interrupted and idle sessions show truthful states rather than running clocks', () => {
  for (const [state, label] of [['starting', 'Starting'], ['stopping', 'Finishing'], ['finalizing', 'Finishing'], ['error', 'Error'], ['interrupted', 'Interrupted'], ['complete', 'Off']] as const) {
    assert.equal(recordingStatus({ ...recording, status: state }, now).text, label);
    assert.equal(recordingStatus({ ...recording, status: state }, now).active, false);
  }
  for (const [state, label] of [['starting', 'Connecting'], ['stopping', 'Ending'], ['error', 'Interrupted'], ['stopped', 'Off air']] as const) {
    assert.equal(liveStatus({ ...session, state }, now).text, label);
    assert.equal(liveStatus({ ...session, state }, now).active, false);
  }
  assert.equal(recordingStatus(null, now).text, 'Off'); assert.equal(liveStatus(null, now).text, 'Off air');
  assert.equal(liveStatus(null, now, true).text, 'Connecting');
});
test('memory labels require a valid scoped native reading; absence cannot be mistaken for zero RAM', () => {
  assert.equal(memoryLabel(null), 'Unavailable');
  const value = { available: true, bytes: 842 * 1024 ** 2, processes: 5, sampledAt: now, scope: 'desktop-processes' as const, metric: 'working-set' as const };
  assert.equal(memoryLabel(value), '842 MB'); assert.equal(memoryLabel({ ...value, bytes: 1.5 * 1024 ** 3 }), '1.5 GB');
  for (const bytes of [null, -1, 0, NaN]) assert.equal(memoryLabel({ ...value, bytes }), 'Unavailable');
});
