import test from 'node:test';
import assert from 'node:assert/strict';
import type { ClipTimeline, ClipTimelineTrack, ClipTransition } from '../../shared/clips.js';
import { makeItem, makeTrack } from '../../frontend/src/lib/clip-timeline.js';
import { applyTransition, applyTransitionToAll, transitionBulkSummary } from '../../frontend/src/lib/clip-transitions.js';
import { timelineSchema } from '../src/clip-timeline.js';

const effect: ClipTransition = { kind: 'wipe-left', durationMs: 500 };
function sequence(name: string, lengths = [2000, 2000, 2000]): ClipTimelineTrack {
  const track = makeTrack('video', name); let startMs = 0;
  track.items = lengths.map((duration, index) => {
    const item = { ...makeItem('video', `${name} ${index + 1}`, duration, { kind: 'asset', id: `asset_${name}_${index}` }), startMs, inMs: 1250, audioFadeInMs: 50, audioFadeOutMs: 50 };
    startMs += duration; return item;
  });
  return track;
}
const document = (...tracks: ClipTimelineTrack[]): ClipTimeline => ({ version: 1, background: '#000000', tracks });
const copy = <T>(value: T): T => JSON.parse(JSON.stringify(value));

test('bulk transitions use one exact duration across unlocked video tracks and report skipped cuts', () => {
  const main = sequence('Main'), overlay = sequence('Overlay'), locked = sequence('Locked'); locked.locked = true;
  const short = sequence('Short', [400, 1000]), gap = sequence('Gap', [2000, 2000]), overlap = sequence('Overlap', [2000, 2000]);
  for (const track of [locked, short, gap, overlap]) track.hidden = true;
  gap.items[1]!.startMs += 200; overlap.items[1]!.startMs -= 200;
  const audio = makeTrack('audio', 'Music'); audio.items = [makeItem('audio', 'Tone', 5000, { kind: 'asset', id: 'asset_tone' }), { ...makeItem('audio', 'Tone 2', 5000, { kind: 'asset', id: 'asset_tone' }), startMs: 5000 }];
  const text = makeTrack('text', 'Titles'); text.items = [makeItem('text', 'Title', 2000), { ...makeItem('text', 'Title 2', 2000), startMs: 2000 }];
  applyTransition(main, main.items[1]!.id, effect);
  const timeline = document(main, overlay, locked, short, gap, overlap, audio, text), before = copy(timeline);
  const references = timeline.tracks.flatMap(track => track.items);
  assert.deepEqual(transitionBulkSummary(timeline, effect), { eligible: 4, changed: 3, skipped: 5 });
  assert.deepEqual(timeline, before, 'Counting cuts is read-only.');
  assert.deepEqual(applyTransitionToAll(timeline, effect), { applied: true, changed: 3, skipped: 5 });
  assert.deepEqual(main.items.map(item => item.startMs), [0, 1500, 3000]);
  assert.deepEqual(overlay.items.map(item => item.startMs), [0, 1500, 3000]);
  for (const track of [main, overlay]) for (const item of track.items.slice(1)) assert.deepEqual(item.transitionIn, effect);
  for (let index = 2; index < timeline.tracks.length; index++) assert.deepEqual(timeline.tracks[index], before.tracks[index]);
  for (const [index, item] of timeline.tracks.flatMap(track => track.items).entries()) {
    assert.equal(item, references[index]); assert.equal(item.inMs, references[index]!.inMs);
    const previous = before.tracks.flatMap(track => track.items)[index]!;
    assert.deepEqual([item.source, item.durationMs, item.inMs, item.audioFadeInMs, item.audioFadeOutMs], [previous.source, previous.durationMs, previous.inMs, previous.audioFadeInMs, previous.audioFadeOutMs]);
  }
  assert.equal(timelineSchema.safeParse(timeline).success, true);
});

test('short neighbours and unrelated gaps retain their existing effects and are never clamped to another bulk duration', () => {
  const short = sequence('Short', [600, 1000]); applyTransition(short, short.items[1]!.id, { kind: 'dissolve', durationMs: 200 });
  const gap = sequence('Gap', [2000, 2000]); gap.items[1]!.startMs += 100;
  const valid = sequence('Valid', [2000, 2000]); const timeline = document(short, gap, valid), before = copy(timeline);
  assert.deepEqual(applyTransitionToAll(timeline, effect), { applied: true, changed: 1, skipped: 2 });
  assert.deepEqual(short, before.tracks[0]); assert.deepEqual(gap, before.tracks[1]);
  assert.deepEqual(valid.items[1]!.transitionIn, effect);
});

test('bulk ripple preserves gaps while applying later adjoining cuts in stable logical order', () => {
  const track = sequence('Main', [2000, 2000, 2000, 2000]);
  track.items[2]!.startMs += 300; track.items[3]!.startMs += 300;
  const timeline = document(track);
  assert.deepEqual(applyTransitionToAll(timeline, effect), { applied: true, changed: 2, skipped: 1 });
  assert.deepEqual(track.items.map(item => item.startMs), [0, 1500, 3800, 5300]);
  assert.equal(track.items[2]!.startMs - (track.items[1]!.startMs + track.items[1]!.durationMs), 300);
  assert.equal(track.items[2]!.transitionIn, undefined); assert.equal(timelineSchema.safeParse(timeline).success, true);
});

test('bulk is idempotent and removing one transition afterwards affects only that selected cut', () => {
  const track = sequence('Main'), timeline = document(track);
  assert.deepEqual(applyTransitionToAll(timeline, effect), { applied: true, changed: 2, skipped: 0 });
  const before = copy(timeline);
  assert.deepEqual(transitionBulkSummary(timeline, effect), { eligible: 2, changed: 0, skipped: 0, reason: 'All suitable cuts already use this transition and duration.' });
  assert.equal(applyTransitionToAll(timeline, effect).applied, false); assert.deepEqual(timeline, before);
  assert.equal(applyTransition(track, track.items[1]!.id, null).applied, true);
  assert.equal(track.items[1]!.transitionIn, undefined); assert.deepEqual(track.items[2]!.transitionIn, effect);
  assert.deepEqual(track.items.map(item => item.startMs), [0, 2000, 3500]);
  assert.equal(timelineSchema.safeParse(timeline).success, true);
});

test('invalid bulk preset/duration and no suitable cuts leave all state untouched', () => {
  const timeline = document(sequence('Main')), before = copy(timeline);
  for (const durationMs of [99, 2001, 500.5, NaN, Infinity]) {
    assert.equal(applyTransitionToAll(timeline, { ...effect, durationMs }).applied, false); assert.deepEqual(timeline, before);
  }
  assert.equal(applyTransitionToAll(timeline, { ...effect, kind: 'custom-filter' } as unknown as ClipTransition).applied, false); assert.deepEqual(timeline, before);
  timeline.tracks[0]!.locked = true;
  assert.deepEqual(applyTransitionToAll(timeline, effect), { applied: false, changed: 0, skipped: 2, reason: 'No adjoining, unlocked video cuts can use this exact duration.' });
});

test('a fatal two-hour overflow rejects the entire bulk operation including earlier tracks', () => {
  const valid = sequence('Valid', [2000, 2000]), overflow = sequence('Overflow');
  applyTransition(overflow, overflow.items[1]!.id, { kind: 'dissolve', durationMs: 1000 });
  // A deliberate gap makes the final cut unsuitable; shortening the earlier
  // transition would move this suffix past two hours.
  overflow.items[2]!.startMs += 100; overflow.items[2]!.durationMs = 7_200_000 - overflow.items[2]!.startMs;
  const timeline = document(valid, overflow), before = copy(timeline), references = timeline.tracks.flatMap(track => track.items);
  const result = applyTransitionToAll(timeline, effect);
  assert.equal(result.applied, false); assert.equal(result.changed, 0); assert.match(result.reason!, /two hours/);
  assert.deepEqual(timeline, before);
  timeline.tracks.flatMap(track => track.items).forEach((item, index) => assert.equal(item, references[index]));
});

test('the final atomic plan can fit two hours even when an intermediate cut temporarily extends its suffix', () => {
  const track = sequence('Main'); applyTransition(track, track.items[1]!.id, { kind: 'dissolve', durationMs: 1000 });
  track.items[2]!.durationMs = 7_200_000 - track.items[2]!.startMs;
  const timeline = document(track);
  assert.deepEqual(applyTransitionToAll(timeline, effect), { applied: true, changed: 2, skipped: 0 });
  assert.deepEqual(track.items.map(item => item.startMs), [0, 1500, 3000]);
  assert.equal(track.items[2]!.startMs + track.items[2]!.durationMs, 7_200_000);
  assert.equal(timelineSchema.safeParse(timeline).success, true);
});

test('bulk never creates more than eight visible items, but hidden tracks do not count as visible', () => {
  const timeline = document(...Array.from({ length: 5 }, (_, index) => sequence(`Video${index}`, [2000, 2000]))), before = copy(timeline);
  assert.equal(timelineSchema.safeParse(timeline).success, true);
  let result = applyTransitionToAll(timeline, effect);
  assert.equal(result.applied, false); assert.match(result.reason!, /eight items/); assert.deepEqual(timeline, before);
  timeline.tracks[4]!.hidden = true;
  result = applyTransitionToAll(timeline, effect); assert.equal(result.applied, true); assert.equal(result.changed, 5);
  assert.equal(timelineSchema.safeParse(timeline).success, true);
});

test('bulk respects audio concurrency even when all video tracks are hidden', () => {
  const timeline = document(...Array.from({ length: 9 }, (_, index) => ({ ...sequence(`Video${index}`, [2000, 2000]), hidden: true }))), before = copy(timeline);
  assert.equal(timelineSchema.safeParse(timeline).success, true);
  const result = applyTransitionToAll(timeline, effect);
  assert.equal(result.applied, false); assert.match(result.reason!, /sixteen audio/); assert.deepEqual(timeline, before);
  timeline.tracks[8]!.muted = true;
  assert.equal(applyTransitionToAll(timeline, effect).applied, true); assert.equal(timelineSchema.safeParse(timeline).success, true);
});

test('bounded bulk planning refuses oversized timelines rather than partially applying cuts', () => {
  const tooManyTracks = document(...Array.from({ length: 13 }, (_, index) => sequence(`Video${index}`, [2000])));
  assert.equal(applyTransitionToAll(tooManyTracks, effect).applied, false);
  const tooManyItems = document(sequence('Many', Array.from({ length: 121 }, () => 2000)));
  assert.equal(applyTransitionToAll(tooManyItems, effect).applied, false);
  const tooManyInputs = document(sequence('Many', Array.from({ length: 65 }, () => 2000))), before = copy(tooManyInputs);
  const result = applyTransitionToAll(tooManyInputs, effect); assert.equal(result.applied, false); assert.match(result.reason!, /64 enabled/); assert.deepEqual(tooManyInputs, before);
});
