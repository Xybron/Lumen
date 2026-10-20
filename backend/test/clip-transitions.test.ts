import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import sharp from 'sharp';
import ffmpeg from 'ffmpeg-static';
import type { ClipTimeline, ClipTimelineItem } from '../../shared/clips.js';
import { makeItem, makeTrack, reorderSequence, splitItem } from '../../frontend/src/lib/clip-timeline.js';
import { applyTransition, audioFadeGain, detachTransitionLinks, normalizeTrackTransitions, TRANSITION_PRESETS, transitionAtCut, transitionVisual } from '../../frontend/src/lib/clip-transitions.js';
import { exportTimelineArguments, timelineDuration, timelineSchema, type ResolvedTimelineSource } from '../src/clip-timeline.js';
import { runClipMedia } from '../src/clip-media.js';

const execute = promisify(execFile);
function fixture() {
  const track = makeTrack('video', 'Main video');
  track.items = ['A', 'B', 'C'].map((name, i) => ({ ...makeItem('video', name, 2000, { kind: 'asset', id: `asset_${name}` }), id: `item_${name}`, startMs: i * 2000, inMs: 1000 }));
  const overlay = makeTrack('text', 'Independent overlay'); overlay.items.push({ ...makeItem('text', 'Overlay', 1000), text: 'Unchanged', startMs: 3500 });
  const document: ClipTimeline = { version: 1, background: '#000000', tracks: [track, overlay] };
  return { document, track, a: track.items[0]!, b: track.items[1]!, c: track.items[2]! };
}

test('applying, replacing and clearing a real transition preserves source time and shifts only the owned sequence', () => {
  const { document, track, a, b, c } = fixture(), original = JSON.parse(JSON.stringify(document)), overlay = JSON.stringify(document.tracks[1]);
  assert.equal(transitionAtCut(track, b.id).eligible, true);
  assert.deepEqual(applyTransition(track, b.id, { kind: 'dissolve', durationMs: 500 }), { applied: true, durationMs: 500 });
  assert.equal(b.startMs, 1500); assert.equal(c.startMs, 3500); assert.equal(timelineDuration(document), 5500);
  assert.deepEqual([a.inMs, b.inMs, c.inMs], [1000, 1000, 1000]); assert.deepEqual(track.items.map(item => item.durationMs), [2000, 2000, 2000]);
  applyTransition(track, b.id, { kind: 'wipe-left', durationMs: 900 }); assert.equal(b.startMs, 1100); assert.equal(c.startMs, 3100);
  applyTransition(track, b.id, null); assert.deepEqual(document, original); assert.equal(JSON.stringify(document.tracks[1]), overlay);
});

test('cut eligibility rejects unrelated gaps/overlaps, first clips, locked tracks and nonvisual tracks', () => {
  const { track, a, b } = fixture();
  assert.equal(transitionAtCut(track, a.id).eligible, false);
  b.startMs++; assert.equal(transitionAtCut(track, b.id).eligible, true, 'One millisecond clock tolerance is allowed.');
  b.startMs += 100; assert.equal(transitionAtCut(track, b.id).eligible, false); assert.equal(applyTransition(track, b.id, { kind: 'dissolve', durationMs: 500 }).applied, false);
  b.startMs = 1900; assert.equal(transitionAtCut(track, b.id).eligible, false, 'Arbitrary overlaps are not silently claimed.');
  b.startMs = 2000; track.locked = true; assert.equal(transitionAtCut(track, b.id).eligible, false); track.locked = false;
  const audio = makeTrack('audio', 'Music'); audio.items = [makeItem('audio', 'One', 1000, { kind: 'asset', id: 'asset_one' }), { ...makeItem('audio', 'Two', 1000, { kind: 'asset', id: 'asset_two' }), startMs: 1000 }];
  assert.equal(transitionAtCut(audio, audio.items[1]!.id).eligible, false);
});

test('duration clamps to half both neighbours and normalization repairs a trimmed owned cut without moving other tracks', () => {
  const { track, b, c } = fixture();
  applyTransition(track, b.id, { kind: 'dissolve', durationMs: 9999 }); assert.equal(b.transitionIn?.durationMs, 1000); assert.equal(b.startMs, 1000);
  b.durationMs = 300; b.audioFadeInMs = 500; b.audioFadeOutMs = 500;
  normalizeTrackTransitions(track); assert.equal(b.transitionIn?.durationMs, 150); assert.equal(b.startMs, 1850); assert.equal(c.startMs, 3850); assert.equal(b.audioFadeInMs, 150); assert.equal(b.audioFadeOutMs, 150);
  b.durationMs = 100; normalizeTrackTransitions(track); assert.equal(b.transitionIn, undefined); assert.equal(b.startMs, 2000); assert.equal(c.startMs, 4000);
});

test('free move detachment clears links without unexpectedly changing any item time', () => {
  const { track, b, c } = fixture(); applyTransition(track, b.id, { kind: 'dissolve', durationMs: 500 }); applyTransition(track, c.id, { kind: 'slide-right', durationMs: 300 });
  const before = track.items.map(item => [item.startMs, item.inMs, item.durationMs]); detachTransitionLinks(track, b.id);
  assert.equal(b.transitionIn, undefined); assert.equal(c.transitionIn, undefined); assert.deepEqual(track.items.map(item => [item.startMs, item.inMs, item.durationMs]), before);
});

test('transition removal, normalization, splitting and reordering reject two-hour overflow without partial mutations', () => {
  const { document, track, b, c } = fixture(); applyTransition(track, b.id, { kind: 'dissolve', durationMs: 500 }); c.durationMs = 7_200_000 - c.startMs;
  const original = JSON.parse(JSON.stringify(document));
  assert.equal(applyTransition(track, b.id, null).applied, false); assert.deepEqual(document, original);
  assert.equal(applyTransition(track, b.id, { kind: 'wipe-left', durationMs: 250 }).applied, false); assert.deepEqual(document, original);
  b.durationMs = 100; const beforeNormalization = JSON.parse(JSON.stringify(document)); assert.equal(normalizeTrackTransitions(track).applied, false); assert.deepEqual(document, beforeNormalization); b.durationMs = 2000;
  assert.equal(splitItem(document, b.id, b.startMs + 100), null); assert.deepEqual(document, original);
  reorderSequence(track, b.id, 0); assert.deepEqual(document, original); assert.equal(b.startMs, 1500, 'Rollback restores existing item object references too.');
});

test('splits preserve source offsets, keep only outside audio fades and clamp transition neighbours including short tail fragments', () => {
  for (const offset of [100, 700, 1900]) {
    const { document, track, b, c } = fixture(); applyTransition(track, b.id, { kind: 'dissolve', durationMs: 500 }); applyTransition(track, c.id, { kind: 'wipe-right', durationMs: 500 });
    b.audioFadeInMs = 500; b.audioFadeOutMs = 500;
    const rightId = splitItem(document, b.id, b.startMs + offset); assert.ok(rightId);
    const right = track.items.find(item => item.id === rightId)!;
    assert.equal(b.durationMs, offset); assert.equal(right.durationMs, 2000 - offset); assert.equal(right.inMs, 1000 + offset); assert.equal(right.transitionIn, undefined); assert.equal(right.audioFadeInMs, undefined); assert.equal(b.audioFadeOutMs, undefined);
    assert.equal(timelineSchema.safeParse(document).success, true, JSON.stringify(document));
  }
});

test('reordering keeps incoming presets on their clips, clears the new first transition and retains a valid overlapping sequence', () => {
  const { document, track, a, b, c } = fixture(); applyTransition(track, b.id, { kind: 'dissolve', durationMs: 500 }); applyTransition(track, c.id, { kind: 'wipe-right', durationMs: 500 });
  reorderSequence(track, c.id, 0); assert.equal(track.items[0]!.id, c.id); assert.equal(c.transitionIn, undefined); assert.equal(a.startMs, 2000); assert.equal(b.startMs, 3500); assert.equal(b.transitionIn?.kind, 'dissolve'); assert.equal(timelineSchema.safeParse(document).success, true);
});

test('preview progress, directional masks/slides and independent audio fades use matching bounded linear envelopes', () => {
  const item = makeItem('video', 'Video', 2000, { kind: 'asset', id: 'asset_one' }); item.startMs = 1000;
  for (const preset of TRANSITION_PRESETS) {
    item.transitionIn = { kind: preset.kind, durationMs: 500 };
    assert.equal(transitionVisual(item, 900).progress, 0); assert.equal(transitionVisual(item, 1250).progress, .5); assert.equal(transitionVisual(item, 1500).progress, 1);
    const effect = transitionVisual(item, 1250);
    assert.equal(effect.opacityMultiplier, preset.kind === 'dissolve' ? .5 : 1);
    assert.equal(effect.translateXFraction, preset.kind === 'slide-left' ? .5 : preset.kind === 'slide-right' ? -.5 : 0);
    assert.equal(effect.clipInsetLeft, preset.kind === 'wipe-left' ? .5 : 0); assert.equal(effect.clipInsetRight, preset.kind === 'wipe-right' ? .5 : 0);
  }
  item.audioFadeInMs = 400; item.audioFadeOutMs = 500;
  assert.equal(audioFadeGain(item, 900), 0); assert.equal(audioFadeGain(item, 1100), .25); assert.equal(audioFadeGain(item, 1800), 1); assert.equal(audioFadeGain(item, 2750), .5); assert.equal(audioFadeGain(item, 3000), 0);
});

test('untrusted transition and audio-fade data is rejected while old timelines remain valid', () => {
  const { document, track, a, b } = fixture(); assert.equal(timelineSchema.safeParse(document).success, true);
  for (const transition of [{ kind: 'dissolve', durationMs: 99 }, { kind: 'dissolve', durationMs: 2001 }, { kind: 'custom-filter', durationMs: 500 }]) { b.transitionIn = transition as ClipTimelineItem['transitionIn']; assert.equal(timelineSchema.safeParse(document).success, false); }
  delete b.transitionIn; a.transitionIn = { kind: 'dissolve', durationMs: 500 }; assert.equal(timelineSchema.safeParse(document).success, false); delete a.transitionIn;
  b.transitionIn = { kind: 'dissolve', durationMs: 500 }; assert.equal(timelineSchema.safeParse(document).success, false, 'Metadata without the actual overlap is not an effect.');
  delete b.transitionIn; applyTransition(track, b.id, { kind: 'dissolve', durationMs: 500 }); b.audioFadeInMs = 1001; assert.equal(timelineSchema.safeParse(document).success, false); b.audioFadeInMs = 500; assert.equal(timelineSchema.safeParse(document).success, true);
});

test('real FFmpeg renders every transition direction with a true blended overlap and no black frame', { timeout: 120_000 }, async () => {
  assert.ok(ffmpeg); const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'lumen-transitions-'));
  try {
    const red = path.join(directory, 'red.png'), incoming = path.join(directory, 'green-blue.png');
    await sharp({ create: { width: 64, height: 64, channels: 3, background: '#ff0000' } }).png().toFile(red);
    await sharp({ create: { width: 64, height: 64, channels: 3, background: '#0000ff' } }).composite([{ input: await sharp({ create: { width: 32, height: 64, channels: 3, background: '#00ff00' } }).png().toBuffer(), left: 0, top: 0 }]).png().toFile(incoming);
    const sources: Map<string, ResolvedTimelineSource> = new Map([['asset:asset_red', { kind: 'image', durationMs: 0, width: 64, height: 64, hasAudio: false, path: red }], ['asset:asset_incoming', { kind: 'image', durationMs: 0, width: 64, height: 64, hasAudio: false, path: incoming }]]);
    for (const preset of TRANSITION_PRESETS) {
      const track = makeTrack('video', 'Main'), a = { ...makeItem('image', 'Red', 1000, { kind: 'asset', id: 'asset_red' }), id: 'item_red' }, b = { ...makeItem('image', 'Incoming', 1000, { kind: 'asset', id: 'asset_incoming' }), id: 'item_incoming', startMs: 1000 };
      track.items.push(a, b); const document: ClipTimeline = { version: 1, background: '#000000', tracks: [track] }; applyTransition(track, b.id, { kind: preset.kind, durationMs: 500 });
      const output = path.join(directory, `${preset.kind}.mp4`); await runClipMedia(exportTimelineArguments(document, '1:1', sources, output, new Map(), { container: 'mp4', resolution: '720p' }), 45_000).result;
      const pixel = async (seconds: number, x: number) => [...(await execute(ffmpeg!, ['-hide_banner', '-loglevel', 'error', '-ss', String(seconds), '-i', output, '-vf', `crop=8:8:${x}:356,scale=1:1`, '-frames:v', '1', '-f', 'rawvideo', '-pix_fmt', 'rgb24', '-'], { encoding: 'buffer', maxBuffer: 1_000_000 })).stdout];
      const before = await pixel(.25, 540), left = await pixel(.75, 180), right = await pixel(.75, 540), after = await pixel(1.1, 540);
      assert.ok(before[0]! > 230 && before[1]! < 20 && before[2]! < 20, `${preset.kind} before ${before}`); assert.ok(after[2]! > 230 && after[0]! < 20, `${preset.kind} after ${after}`);
      if (preset.kind === 'dissolve') assert.ok(right[0]! > 80 && right[0]! < 175 && right[2]! > 80 && right[2]! < 175, `True red/blue blend, not fade through black: ${right}`);
      if (preset.kind === 'wipe-left') assert.ok(left[0]! > 230 && right[2]! > 230, `Right-to-left reveal: ${left}/${right}`);
      if (preset.kind === 'wipe-right') assert.ok(left[1]! > 230 && right[0]! > 230, `Left-to-right reveal: ${left}/${right}`);
      if (preset.kind === 'slide-left') assert.ok(left[0]! > 230 && right[1]! > 230, `Incoming left half physically moves from right: ${left}/${right}`);
      if (preset.kind === 'slide-right') assert.ok(left[2]! > 230 && right[0]! > 230, `Incoming right half physically moves from left: ${left}/${right}`);
      const all = (await execute(ffmpeg!, ['-hide_banner', '-loglevel', 'error', '-i', output, '-vf', 'scale=1:1', '-f', 'rawvideo', '-pix_fmt', 'rgb24', '-'], { encoding: 'buffer', maxBuffer: 1_000_000 })).stdout;
      assert.ok(all.length >= 40 * 3); for (let index = 0; index < all.length; index += 3) assert.ok(Math.max(all[index]!, all[index + 1]!, all[index + 2]!) > 80, `${preset.kind} has no black flash at decoded frame ${index / 3}`);
    }
  } finally { await fs.rm(directory, { recursive: true, force: true }); }
});

test('real audio-only export retains recorded tone with independent linear fades', { timeout: 45_000 }, async () => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'lumen-transition-audio-'));
  try {
    const source = path.join(directory, 'tone.wav'), output = path.join(directory, 'faded.wav');
    await runClipMedia(['-hide_banner', '-nostdin', '-y', '-f', 'lavfi', '-i', 'sine=f=440:r=48000:d=1', '-c:a', 'pcm_s16le', source], 15_000).result;
    const track = makeTrack('audio', 'Recorded audio'), item = makeItem('audio', 'Tone', 1000, { kind: 'asset', id: 'asset_tone' }); item.audioFadeInMs = 400; item.audioFadeOutMs = 400; track.items.push(item);
    const document: ClipTimeline = { version: 1, background: '#000000', tracks: [track] }, sources: Map<string, ResolvedTimelineSource> = new Map([['asset:asset_tone', { kind: 'audio', durationMs: 1000, width: 0, height: 0, hasAudio: true, path: source }]]);
    const args = exportTimelineArguments(document, '16:9', sources, output, new Map(), { container: 'wav', resolution: '720p' }); assert.equal(args.includes('[video]'), false); await runClipMedia(args, 15_000).result;
    const level = async (seconds: number) => { const samples = (await execute(ffmpeg!, ['-hide_banner', '-loglevel', 'error', '-ss', String(seconds), '-i', output, '-t', '0.05', '-ac', '1', '-f', 'f32le', '-'], { encoding: 'buffer', maxBuffer: 1_000_000 })).stdout; let sum = 0; for (let offset = 0; offset < samples.length; offset += 4) sum += samples.readFloatLE(offset) ** 2; return Math.sqrt(sum / (samples.length / 4)); };
    const middle = await level(.45); assert.ok(middle > .04); assert.ok(await level(.025) < middle * .25); assert.ok(await level(.925) < middle * .25);
  } finally { await fs.rm(directory, { recursive: true, force: true }); }
});
