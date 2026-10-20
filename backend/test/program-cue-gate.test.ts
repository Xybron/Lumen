import assert from 'node:assert/strict';
import test from 'node:test';
import { acceptChannelProjection, programCueReady, programCuesReady } from '../../frontend/src/lib/studio/program-cue-gate';
import type { ProjectionState } from '../../frontend/src/types';

const gate = { channelId: 'chnl_scripture', revision: 12 };
test('a Studio scene waits for every authoritative text source, not just its first channel', () => {
  const gates = [gate, { channelId: 'chnl_lyrics', revision: 7 }];
  const states = new Map<string, ProjectionState>([[gate.channelId, projection()]]);
  assert.equal(programCuesReady(undefined, id => states.get(id)), true);
  assert.equal(programCuesReady(gates, id => states.get(id)), false);
  states.set('chnl_lyrics', projection({ channelId: 'chnl_lyrics', channelRevision: 6, cue: null }));
  assert.equal(programCuesReady(gates, id => states.get(id)), false);
  states.set('chnl_lyrics', projection({ channelId: 'chnl_lyrics', channelRevision: 7, cue: null }));
  assert.equal(programCuesReady(gates, id => states.get(id)), true);
});
function projection(patch: Partial<ProjectionState> = {}): ProjectionState {
  return { channelId: gate.channelId, channelRevision: 12, cue: { id: 'cue_chnl_scripture_12', type: 'scripture', body: 'Ready', durationMs: 0 },
    playlistId: null, index: 0, mode: 'manual', playing: false, blanked: false, startedAt: null, durationMs: 0, ...patch };
}

test('Program cue handoff holds stale or missing projection state and accepts the exact committed channel revision', () => {
  assert.equal(programCueReady(undefined, undefined), true, 'ordinary Studio routes never wait for a channel');
  assert.equal(programCueReady(gate, undefined), false, 'a restarted renderer waits for authoritative channel replay');
  assert.equal(programCueReady(gate, projection({ channelRevision: 11 })), false);
  assert.equal(programCueReady(gate, projection({ channelId: 'chnl_lyrics', channelRevision: 15 })), false);
  assert.equal(programCueReady(gate, projection()), true);
  assert.equal(programCueReady(gate, projection({ channelRevision: 13 })), true, 'a newer authoritative cue supersedes the requested verse');
});

test('generic or optimistic state cannot satisfy the Program cue gate', () => {
  const withoutCue = projection(); delete withoutCue.cue;
  assert.equal(programCueReady(gate, withoutCue), false);
  const inheritedCue = Object.assign(Object.create({ cue: projection().cue }), withoutCue) as ProjectionState;
  assert.equal(programCueReady(gate, inheritedCue), false, 'cue must be an own authoritative payload property');
  assert.equal(programCueReady(gate, projection({ channelRevision: undefined })), false, 'a generated-looking cue ID alone is not authoritative');
  assert.equal(programCueReady(gate, projection({ channelRevision: undefined, cue: null, blanked: true })), false);
  for (const channelRevision of [NaN, Infinity, -1, 12.5, Number.MAX_SAFE_INTEGER + 1, '12' as unknown as number]) {
    assert.equal(programCueReady(gate, projection({ channelRevision })), false, String(channelRevision));
  }
  for (const revision of [NaN, Infinity, -1, 12.5, Number.MAX_SAFE_INTEGER + 1]) {
    assert.equal(programCueReady({ ...gate, revision }, projection()), false, String(revision));
  }
});

test('newer authoritative blank or null content releases the handoff instead of freezing an old verse', () => {
  assert.equal(programCueReady(gate, projection({ channelRevision: 13, blanked: true })), true);
  assert.equal(programCueReady(gate, projection({ channelRevision: 13, cue: null, blanked: true })), true);
  assert.equal(programCueReady(gate, projection({ channelRevision: 13, cue: null })), true);
  assert.equal(programCueReady(gate, projection({ channelRevision: 11, cue: null, blanked: true })), false);
});

test('authoritative projection revisions advance monotonically through replay and newer blank commands', () => {
  const previous = projection({ channelRevision: 12 });
  assert.equal(acceptChannelProjection(gate.channelId, undefined, previous), true);
  assert.equal(acceptChannelProjection(gate.channelId, previous, projection({ channelRevision: 11 })), false);
  assert.equal(acceptChannelProjection(gate.channelId, previous, projection({ channelRevision: 12 })), true, 'idempotent current replay is safe');
  const blank = projection({ channelRevision: 13, cue: null, blanked: true });
  assert.equal(acceptChannelProjection(gate.channelId, previous, blank), true);
  assert.equal(acceptChannelProjection(gate.channelId, blank, previous), false, 'an old cue cannot resurrect after a newer blank');
  const generic = projection(); delete generic.channelRevision; delete generic.cue;
  assert.equal(acceptChannelProjection(gate.channelId, previous, generic), false, 'unmarked optimistic/replay state cannot replace authoritative content');
  assert.equal(acceptChannelProjection(gate.channelId, previous, projection({ channelRevision: NaN })), false);
  assert.equal(acceptChannelProjection(gate.channelId, previous, projection({ channelId: 'wrong_channel', channelRevision: 99 })), false);
});

test('unrevisioned Presentation channels continue to accept normal updates before an authoritative baseline', () => {
  const previous = projection({ channelId: 'presentation' }); delete previous.channelRevision; delete previous.cue;
  const incoming = { ...previous, index: 4, playing: true };
  assert.equal(acceptChannelProjection('presentation', undefined, previous), true);
  assert.equal(acceptChannelProjection('presentation', previous, incoming), true);
  assert.equal(acceptChannelProjection('presentation', previous, { ...incoming, channelId: 'another_channel' }), false);
  assert.equal(acceptChannelProjection(gate.channelId, undefined, projection({ channelRevision: 3.5 })), false);
  const malformed = projection({ channelRevision: 15 }); delete malformed.cue;
  assert.equal(acceptChannelProjection(gate.channelId, undefined, malformed), false, 'malformed marker states never establish an authoritative baseline');
});
