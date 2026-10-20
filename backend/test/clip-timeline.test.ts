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
import { runClipMedia } from '../src/clip-media.js';
import {
  exportTimelineArguments, MAX_TIMELINE_INPUTS, parseTimelineMediaInfo,
  prepareTimelineText, timelineDuration, timelineSchema, timelineSourceKey,
  validateTimelineSources, type ResolvedTimelineSource,
} from '../src/clip-timeline.js';

const execute = promisify(execFile);
const baseItem = (patch: Partial<ClipTimelineItem> = {}): ClipTimelineItem => ({
  id: 'item_test', name: 'Test media', kind: 'video', source: { kind: 'recording', id: 'rec_test' },
  startMs: 0, inMs: 0, durationMs: 1000, x: 0, y: 0, width: 1, height: 1,
  fit: 'cover', positionX: .5, positionY: .5, opacity: 1, volume: 1, muted: true,
  text: '', fontSize: 48, fontWeight: 600, color: '#ffffff', background: '#00000000', align: 'center', ...patch,
});
const timeline = (items: ClipTimelineItem[] = [baseItem()]): ClipTimeline => ({
  version: 1, background: '#000000', tracks: [{ id: 'track_video', name: 'Video', kind: 'video', muted: false, hidden: false, locked: false, items }],
});
const metadata = new Map([['recording:rec_test', { kind: 'video' as const, durationMs: 10_000, width: 1920, height: 1080, hasAudio: true }]]);

test('timeline schema accepts the canonical edit document without changing item order', () => {
  const document = timeline([baseItem({ id: 'item_second', startMs: 2000 }), baseItem()]);
  assert.deepEqual(timelineSchema.parse(document), document);
  assert.equal(timelineDuration(document), 3000);
  assert.equal(timelineSourceKey({ kind: 'asset', id: 'asset_test' }), 'asset:asset_test');
  assert.doesNotThrow(() => validateTimelineSources(document, metadata));
  const laterSermon = timeline([baseItem({ inMs: 4 * 60 * 60 * 1000 })]);
  assert.equal(timelineSchema.safeParse(laterSermon).success, true, 'A short project may trim from later in a long original service.');
  assert.doesNotThrow(() => validateTimelineSources(laterSermon, new Map([['recording:rec_test', { ...metadata.get('recording:rec_test')!, durationMs: 5 * 60 * 60 * 1000 }]])));
});

test('timeline schema rejects arbitrary paths/filters, mismatched tracks, duplicate IDs and unbounded edits', () => {
  const document = timeline();
  for (const patch of [
    { durationMs: 0 }, { durationMs: 99 }, { startMs: -1 }, { inMs: .5 },
    { startMs: 7_200_000 }, { width: 0 }, { height: 2.01 }, { x: Infinity },
    { x: -1.1 }, { y: NaN }, { opacity: 1.1 }, { volume: 1.01 },
    { text: 'x'.repeat(5001) }, { fontSize: 301 }, { fontWeight: 450 },
    { color: 'red;movie=/etc/passwd' }, { background: 'url(/etc/passwd)' },
    { source: { kind: 'asset', id: '../secret' } }, { source: undefined },
    { path: '/etc/passwd' }, { filter: 'movie=file:/etc/passwd' },
  ]) assert.equal(timelineSchema.safeParse(timeline([baseItem(patch as Partial<ClipTimelineItem>)])).success, false, JSON.stringify(patch));
  assert.equal(timelineSchema.safeParse(timeline([baseItem(), baseItem()])).success, false);
  assert.equal(timelineSchema.safeParse({ ...document, tracks: [document.tracks[0], document.tracks[0]] }).success, false);
  assert.equal(timelineSchema.safeParse({ ...document, tracks: [{ ...document.tracks[0], kind: 'audio' }] }).success, false);
  assert.equal(timelineSchema.safeParse(timeline([])).success, false);
  assert.equal(timelineSchema.safeParse({ ...document, tracks: Array.from({ length: 13 }, (_, i) => ({ ...document.tracks[0], id: `track_${i}`, items: [] })) }).success, false);
  assert.equal(timelineSchema.safeParse(timeline(Array.from({ length: MAX_TIMELINE_INPUTS + 1 }, (_, i) => baseItem({ id: `item_${i}` })))).success, false);
  assert.equal(timelineSchema.safeParse(timeline(Array.from({ length: 9 }, (_, i) => baseItem({ id: `item_${i}` })))).success, false);
  assert.equal(timelineSchema.safeParse(timeline(Array.from({ length: 20 }, (_, i) => baseItem({ id: `item_${i}`, startMs: i * 1000 })))).success, true, 'Sequential cuts do not count as concurrent overlays.');
});

test('source validation checks hidden and muted items too, without accepting a stale or forged source type', () => {
  const hidden = timeline(); hidden.tracks[0].hidden = true;
  assert.throws(() => validateTimelineSources(hidden, new Map()), /unavailable/);
  assert.throws(() => validateTimelineSources(timeline([baseItem({ inMs: 9500 })]), metadata), /outside/);
  assert.throws(() => validateTimelineSources(timeline(), new Map([['recording:rec_test', { kind: 'audio', durationMs: 10_000, width: 0, height: 0 }]])), /type/);
  assert.throws(() => validateTimelineSources(timeline(), new Map([['recording:rec_test', { kind: 'video', durationMs: 10_000, width: 99999, height: 1080 }]])), /dimensions/);
  assert.throws(() => validateTimelineSources(timeline([baseItem({ id: 'bad/path' })]), metadata), /Invalid|unique|String/);
  assert.doesNotThrow(() => validateTimelineSources(timeline([baseItem({ inMs: 9100, durationMs: 1000 })]), metadata));
});

test('safe metadata probing handles silent video, audio-only and still-image sources', () => {
  const video = 'Duration: 00:00:10.50, start: 0\nStream #0:0: Video: h264, yuv420p, 1920x1080, 30 fps\n';
  assert.deepEqual(parseTimelineMediaInfo(video, 'video'), { kind: 'video', durationMs: 10_500, width: 1920, height: 1080, hasAudio: false });
  assert.equal(parseTimelineMediaInfo(`${video}Stream #0:1: Audio: aac, 48000 Hz\n`, 'video')?.hasAudio, true);
  assert.deepEqual(parseTimelineMediaInfo('Duration: 00:00:04.00\nStream #0:0: Audio: mp3, 48000 Hz\n', 'audio'), { kind: 'audio', durationMs: 4000, width: 0, height: 0, hasAudio: true });
  assert.deepEqual(parseTimelineMediaInfo('Stream #0:0: Video: png, rgba, 640x360\n', 'image'), { kind: 'image', durationMs: 0, width: 640, height: 360, hasAudio: false });
  assert.deepEqual(parseTimelineMediaInfo('Stream #0:0: Video: png, rgba, 2x8\n', 'image'), { kind: 'image', durationMs: 0, width: 2, height: 8, hasAudio: false });
  assert.equal(parseTimelineMediaInfo('Stream #0:0: Video: png, rgba, 1x8\n', 'image'), null);
  const vp8Probe = 'Duration: 00:00:02.00, start: 0.000000, bitrate: 105 kb/s\n  Stream #0:0: Video: vp8 (VP80 / 0x30385056), yuv420p(progressive), 320x180, SAR 1:1 DAR 16:9, 30 fps\n  Stream #0:1: Audio: opus, 48000 Hz, stereo, fltp\n';
  assert.deepEqual(parseTimelineMediaInfo(vp8Probe, 'video'), { kind: 'video', durationMs: 2000, width: 320, height: 180, hasAudio: true });
  assert.deepEqual(parseTimelineMediaInfo(vp8Probe.replace('0x30385056', '0x0000'), 'video'), { kind: 'video', durationMs: 2000, width: 320, height: 180, hasAudio: true });
  assert.equal(parseTimelineMediaInfo('Duration: 00:00:02.00\nStream #0:0: Video: vp8 (VP80 / 0x0000), yuv420p\n', 'video'), null);
  assert.equal(parseTimelineMediaInfo('No stream', 'video'), null);
  assert.equal(parseTimelineMediaInfo(video, 'audio'), null);
});

test('timeline export arguments bound resources, preserve opaque paths and keep silent videos optional', () => {
  const sourcePath = '/safe/recording; $(touch harmless).webm';
  const sources = new Map([['recording:rec_test', { ...metadata.get('recording:rec_test')!, path: sourcePath, hasAudio: false }]]);
  const args = exportTimelineArguments(timeline([baseItem({ inMs: 250, muted: false })]), '9:16', sources, '/safe/export.mp4');
  const graph = args[args.indexOf('-filter_complex') + 1];
  assert.equal(args[args.indexOf('-i') + 1], sourcePath);
  assert.equal(args[args.indexOf('-ss') + 1], '0.250');
  assert.equal(args[args.indexOf('-protocol_whitelist') + 1], 'file,pipe');
  assert.match(args[args.indexOf('-format_whitelist') + 1], /webp_pipe/);
  assert.equal(args[args.indexOf('-threads') + 1], '1');
  assert.equal(args[args.indexOf('-filter_complex_threads') + 1], '1');
  assert.match(graph, /1080x1920/);
  assert.match(graph, /anullsrc=/);
  assert.doesNotMatch(graph, /\[0:a:0\]/);
  assert.equal(args.at(-1), '/safe/export.mp4');
  assert.throws(() => exportTimelineArguments(timeline(), '16:9', sources, 'relative.mp4'), /absolute/);
});

test('text preparation escapes markup, wraps text and writes only worker-private bounded PNGs', async () => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'lumen-timeline-text-'));
  try {
    const textItem = baseItem({ id: 'text_safe', name: 'Text', kind: 'text', source: undefined, text: '<span>Do not execute & render this</span>\nSecond line', width: .5, height: .2 });
    const document: ClipTimeline = { version: 1, background: '#000000', tracks: [{ id: 'track_text', name: 'Text', kind: 'text', hidden: false, muted: false, locked: false, items: [textItem] }] };
    const files = await prepareTimelineText(document, '16:9', directory);
    assert.equal(files.size, 1);
    const filename = files.get(textItem.id)!;
    assert.equal(path.dirname(filename), directory);
    const info = await sharp(filename).metadata();
    assert.equal(info.width, 960); assert.equal(info.height, 216); assert.equal(info.hasAlpha, true);
    const image = await sharp(filename).stats();
    assert.ok(image.channels[3].max > 0);
    assert.ok(image.channels[3].min === 0);
    await assert.rejects(prepareTimelineText(document, '16:9', directory, () => true), /interrupted/);
  } finally { await fs.rm(directory, { recursive: true, force: true }); }
});

test('real FFmpeg exports a text-only portrait project and delayed colour framing without a media audio stream', { timeout: 60_000 }, async () => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'lumen-timeline-title-'));
  try {
    const title = baseItem({ id: 'title_text', kind: 'text', name: 'Title', source: undefined, text: 'Lumen < & >', durationMs: 500, startMs: 250, width: .5, height: .25, x: .25, y: .25, background: '#ff00ff', fontSize: 60 });
    const document: ClipTimeline = { version: 1, background: '#002200', tracks: [{ id: 'track_title', name: 'Titles', kind: 'text', muted: false, hidden: false, locked: false, items: [title] }] };
    const text = await prepareTimelineText(document, '9:16', directory), output = path.join(directory, 'title.mp4');
    const diagnostic = await runClipMedia(exportTimelineArguments(document, '9:16', new Map(), output, text), 30_000).result;
    assert.match(diagnostic, /1080x1920/);
    const pixel = async (seconds: number, x: number, y: number) => {
      const result = await execute(ffmpeg!, ['-hide_banner', '-nostdin', '-threads', '1', '-ss', String(seconds), '-i', output, '-vf', `crop=2:2:${x}:${y},scale=1:1`, '-frames:v', '1', '-f', 'rawvideo', '-pix_fmt', 'rgb24', '-'], { encoding: 'buffer', maxBuffer: 1_000_000 });
      return [...result.stdout];
    };
    const before = await pixel(.1, 300, 500), after = await pixel(.4, 300, 500), outside = await pixel(.4, 10, 10);
    assert.ok(before[1] > 20 && before[0] < 10 && before[2] < 10, `Green project background before delayed title: ${before}`);
    assert.ok(after[0] > 230 && after[2] > 230 && after[1] < 15, `Magenta title box after its start: ${after}`);
    assert.ok(outside[1] > 20 && outside[0] < 10 && outside[2] < 10, `Title positioning should not cover the whole output: ${outside}`);
  } finally { await fs.rm(directory, { recursive: true, force: true }); }
});

test('real FFmpeg timeline render preserves reordered cuts, alpha overlays, silent gaps and separately mixed audio', { timeout: 90_000 }, async () => {
  assert.ok(ffmpeg);
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'lumen-timeline-render-'));
  try {
    const red = path.join(directory, 'red.mp4'), blue = path.join(directory, 'blue.mp4'), image = path.join(directory, 'overlay.png'), output = path.join(directory, 'edited.mp4');
    await runClipMedia(['-hide_banner', '-nostdin', '-y', '-f', 'lavfi', '-i', 'color=c=red:s=160x90:r=30:d=2', '-f', 'lavfi', '-i', 'sine=f=440:r=48000:d=2', '-map', '0:v', '-map', '1:a', '-c:v', 'libx264', '-threads', '1', '-c:a', 'aac', red], 15_000).result;
    await runClipMedia(['-hide_banner', '-nostdin', '-y', '-f', 'lavfi', '-i', 'color=c=blue:s=160x90:r=30:d=2', '-an', '-c:v', 'libx264', '-threads', '1', blue], 15_000).result;
    await sharp({ create: { width: 80, height: 80, channels: 4, background: '#00000000' } }).composite([{ input: await sharp({ create: { width: 40, height: 80, channels: 4, background: '#00ff00' } }).png().toBuffer(), left: 0, top: 0 }]).png().toFile(image);
    const sources: Map<string, ResolvedTimelineSource> = new Map([
      ['recording:rec_test', { kind: 'video', durationMs: 2000, width: 160, height: 90, path: red, hasAudio: true }],
      ['asset:asset_blue', { kind: 'video', durationMs: 2000, width: 160, height: 90, path: blue, hasAudio: false }],
      ['asset:asset_image', { kind: 'image', durationMs: 0, width: 80, height: 80, path: image, hasAudio: false }],
      ['asset:asset_audio', { kind: 'audio', durationMs: 2000, width: 0, height: 0, path: red, hasAudio: true }],
    ]);
    const document = timeline([
      baseItem({ id: 'item_blue', source: { kind: 'asset', id: 'asset_blue' }, startMs: 500, durationMs: 500 }),
      baseItem({ id: 'item_red', durationMs: 500 }),
      baseItem({ id: 'item_image', kind: 'image', source: { kind: 'asset', id: 'asset_image' }, startMs: 1000, durationMs: 500, x: .25, y: .25, width: .5, height: .5, fit: 'contain', opacity: .5 }),
    ]);
    document.tracks.push({ id: 'track_audio', name: 'Music', kind: 'audio', muted: false, hidden: false, locked: false, items: [baseItem({ id: 'audio_tone', kind: 'audio', source: { kind: 'asset', id: 'asset_audio' }, inMs: 500, durationMs: 500, muted: false, volume: .5 })] });
    // A hidden text item sets the project duration without rendering or making sound.
    document.tracks.push({ id: 'track_hidden', name: 'Hidden title', kind: 'text', muted: false, hidden: true, locked: false, items: [baseItem({ id: 'text_hidden', kind: 'text', source: undefined, text: 'Hidden', durationMs: 2000 })] });
    const args = exportTimelineArguments(document, '16:9', sources, output);
    const diagnostics = await runClipMedia(args, 60_000).result;
    assert.match(diagnostics, /Video: h264/); assert.match(diagnostics, /Audio: aac/);
    const pixel = async (seconds: number, x = 960, y = 540) => {
      const result = await execute(ffmpeg!, ['-hide_banner', '-nostdin', '-threads', '1', '-ss', String(seconds), '-i', output, '-vf', `crop=2:2:${x}:${y},scale=1:1`, '-frames:v', '1', '-f', 'rawvideo', '-pix_fmt', 'rgb24', '-'], { encoding: 'buffer', maxBuffer: 1_000_000 });
      return [...result.stdout];
    };
    const first = await pixel(.2), second = await pixel(.7), gap = await pixel(1.8), green = await pixel(1.2, 850, 540), transparent = await pixel(1.2, 1100, 540);
    assert.ok(first[0] > 230 && first[1] < 15 && first[2] < 15, `Red cut ${first}`);
    assert.ok(second[2] > 230 && second[0] < 15, `Blue cut ${second}`);
    assert.ok(gap.every(value => value < 10), `Black gap ${gap}`);
    assert.ok(green[1] > 100 && green[1] < 160 && green[0] < 15 && green[2] < 15, `Half-opacity green ${green}`);
    assert.ok(transparent.every(value => value < 10), `Transparent overlay half ${transparent}`);
    const samples = async (seconds: number) => {
      const result = await execute(ffmpeg!, ['-hide_banner', '-nostdin', '-threads', '1', '-ss', String(seconds), '-i', output, '-t', '0.1', '-map', '0:a', '-ac', '1', '-ar', '48000', '-f', 's16le', '-'], { encoding: 'buffer', maxBuffer: 1_000_000 });
      const buffer = result.stdout; let sum = 0;
      for (let offset = 0; offset + 1 < buffer.length; offset += 2) sum += Math.abs(buffer.readInt16LE(offset));
      return sum / Math.max(1, buffer.length / 2);
    };
    assert.ok(await samples(.2) > 500, 'Enabled separate audio should be audible.');
    assert.ok(await samples(.8) < 20, 'Video sources are muted by default and the audio gap stays silent.');
  } finally { await fs.rm(directory, { recursive: true, force: true }); }
});
