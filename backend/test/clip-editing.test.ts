import test from 'node:test';
import assert from 'node:assert/strict';
import type { ClipRecording, ClipSettings, ClipTimeline } from '../../shared/clips.js';
import {
  copyTimeline, endOf, findItem, formatClipTime, hydrateTimeline, makeItem, makeTrack,
  MAX_TIMELINE_MS, MIN_ITEM_MS, parseClipTime, reorderSequence, snapTime, splitItem, timelineDuration,
} from '../../frontend/src/lib/clip-timeline.js';

const recording: ClipRecording = { id: 'rec_test', name: 'Sunday service', status: 'complete', createdAt: '2026-10-19T10:00:00.000Z', durationMs: 12_000, bytes: 1000, posterReady: false };
const settings: ClipSettings = { inMs: 1500, outMs: 8500, format: '9:16', fit: 'cover', positionX: .3, positionY: .8 };

test('legacy trims hydrate into a fresh four-track project without changing the original settings', () => {
  const original = structuredClone(settings), hydrated = hydrateTimeline(settings, recording);
  assert.deepEqual(settings, original);
  assert.equal(hydrated.version, 1); assert.equal(hydrated.background, '#000000');
  assert.deepEqual(hydrated.tracks.map(track => [track.kind, track.name]), [['video', 'Main video'], ['video', 'Overlay'], ['text', 'Text'], ['audio', 'Audio']]);
  const first = hydrated.tracks[0].items[0];
  assert.equal(first.kind, 'video'); assert.deepEqual(first.source, { kind: 'recording', id: recording.id });
  assert.equal(first.startMs, 0); assert.equal(first.inMs, 1500); assert.equal(first.durationMs, 7000);
  assert.equal(first.fit, 'cover'); assert.equal(first.positionX, .3); assert.equal(first.positionY, .8);
  assert.equal(timelineDuration(hydrated), 7000);
  const second = hydrateTimeline(settings, recording);
  assert.notEqual(first.id, second.tracks[0].items[0].id);
  assert.notEqual(hydrated.tracks[0].id, second.tracks[0].id);
});

test('saved timelines and undo snapshots are deep copies, not references into another teammate’s project', () => {
  const project = hydrateTimeline(settings, recording);
  const hydrated = hydrateTimeline({ ...settings, timeline: project }, recording);
  assert.deepEqual(hydrated, project);
  hydrated.tracks[0].items[0].source!.id = 'rec_other';
  hydrated.tracks[0].items[0].x = .4;
  assert.equal(project.tracks[0].items[0].source!.id, recording.id);
  assert.equal(project.tracks[0].items[0].x, 0);
  const snapshot = copyTimeline(project); snapshot.tracks[0].name = 'Changed';
  assert.equal(project.tracks[0].name, 'Main video');
});

test('splitting video or audio preserves source time and continuous timeline positions', () => {
  for (const kind of ['video', 'audio'] as const) {
    const track = makeTrack(kind, kind), clip = makeItem(kind, 'Media', 3000, { kind: 'asset', id: 'asset_test' });
    Object.assign(clip, { startMs: 500, inMs: 2000 }); track.items.push(clip);
    const project: ClipTimeline = { version: 1, background: '#000000', tracks: [track] };
    const id = splitItem(project, clip.id, 1750); assert.ok(id);
    const right = findItem(project, id!)!.item;
    assert.equal(clip.startMs, 500); assert.equal(clip.inMs, 2000); assert.equal(clip.durationMs, 1250);
    assert.equal(right.startMs, 1750); assert.equal(right.inMs, 3250); assert.equal(right.durationMs, 1750);
    assert.equal(endOf(clip), right.startMs); assert.equal(endOf(right), 3500);
    right.source!.id = 'asset_independent'; assert.equal(clip.source!.id, 'asset_test');
  }
});

test('splitting text and images never invents a media seek offset', () => {
  for (const kind of ['text', 'image'] as const) {
    const track = makeTrack(kind === 'text' ? 'text' : 'video', kind);
    const clip = makeItem(kind, 'Overlay', 2000, kind === 'image' ? { kind: 'asset', id: 'asset_logo' } : undefined);
    Object.assign(clip, { startMs: 500, text: 'A title', x: .2, opacity: .7 }); track.items.push(clip);
    const project: ClipTimeline = { version: 1, background: '#000000', tracks: [track] };
    const id = splitItem(project, clip.id, 1250); assert.ok(id);
    const right = findItem(project, id!)!.item;
    assert.equal(clip.inMs, 0); assert.equal(right.inMs, 0);
    assert.equal(right.startMs, 1250); assert.equal(right.durationMs, 1250);
    assert.equal(right.text, 'A title'); assert.equal(right.x, .2); assert.equal(right.opacity, .7);
  }
});

test('split safeguards retain locked items and reject tiny edge fragments', () => {
  const project = hydrateTimeline(settings, recording), track = project.tracks[0], item = track.items[0];
  const before = copyTimeline(project);
  assert.equal(splitItem(project, item.id, MIN_ITEM_MS - 1), null);
  assert.equal(splitItem(project, item.id, item.durationMs - MIN_ITEM_MS + 1), null);
  assert.equal(splitItem(project, 'missing', 1000), null);
  assert.deepEqual(project, before);
  track.locked = true;
  assert.equal(splitItem(project, item.id, 1000), null); assert.equal(track.items.length, 1);
  track.locked = false;
  assert.ok(splitItem(project, item.id, MIN_ITEM_MS));
  assert.equal(track.items[0].durationMs, MIN_ITEM_MS);
});

test('main-sequence reordering keeps relative clip order, source trims and a gapless sequence', () => {
  const track = makeTrack('video', 'Main'), source = { kind: 'asset' as const, id: 'asset_test' };
  const clips = [makeItem('video', 'A', 1000, source), makeItem('video', 'B', 2000, source), makeItem('video', 'C', 1500, source)];
  Object.assign(clips[1], { startMs: 1000, inMs: 500 }); Object.assign(clips[2], { startMs: 3000, inMs: 2000 }); track.items.push(...clips);
  reorderSequence(track, clips[2].id, 0);
  assert.deepEqual(track.items.map(item => item.name), ['C', 'A', 'B']);
  assert.deepEqual(track.items.map(item => item.startMs), [0, 1500, 2500]);
  assert.equal(track.items[0].inMs, 2000); assert.equal(track.items[2].inMs, 500);
  reorderSequence(track, clips[2].id, 99_000);
  assert.deepEqual(track.items.map(item => item.name), ['A', 'B', 'C']);
  assert.deepEqual(track.items.map(item => item.startMs), [0, 1000, 3000]);
  const before = copyTimeline(track); track.locked = true;
  reorderSequence(track, clips[0].id, 99_000);
  assert.deepEqual(track.items, before.items);
});

test('snapping chooses nearby boundaries/playhead, excludes the moving item and leaves distant positions unchanged', () => {
  const project = hydrateTimeline(settings, recording), clip = project.tracks[0].items[0];
  const extra = makeItem('text', 'Title', 500); extra.startMs = 3000; project.tracks[2].items.push(extra);
  assert.equal(snapTime(2992, project, clip.id, 6000, 20), 3000);
  assert.equal(snapTime(3491, project, clip.id, 6000, 20), 3500);
  assert.equal(snapTime(5999, project, clip.id, 6000, 20), 6000);
  assert.equal(snapTime(10, project, clip.id, 6000, 20), 0);
  assert.equal(snapTime(6991, project, clip.id, 6000, 20), 6991, 'The moving item must not snap to its own end.');
  assert.equal(snapTime(2000.4, project, clip.id, 6000, 20), 2000);
});

test('new items obey current source-independent duration/name limits and time controls reject ambiguous values', () => {
  assert.equal(makeItem('text', 'x'.repeat(160), 1).name.length, 120);
  assert.equal(makeItem('text', 'Short', 1).durationMs, MIN_ITEM_MS);
  assert.equal(makeItem('text', 'Long', MAX_TIMELINE_MS + 1).durationMs, MAX_TIMELINE_MS);
  assert.equal(formatClipTime(3_723_045, true), '01:02:03.045');
  assert.equal(parseClipTime('01:02:03.045'), 3_723_045);
  assert.equal(parseClipTime('90'), 90_000); assert.equal(parseClipTime('1:30'), 90_000);
  assert.equal(parseClipTime(' 2.125 '), 2125);
  for (const input of ['', '-1', '1:99', '1:01:99', 'words', '1.1234']) assert.equal(parseClipTime(input), null, input);
});
