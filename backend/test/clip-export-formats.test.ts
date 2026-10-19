import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import type { ClipExportOptions, ClipSettings, ClipTimeline } from '../../shared/clips.js';
import type { RecordingStore } from '../src/production-recordings.js';
import { exportTimelineArguments } from '../src/clip-timeline.js';
import {
  clipExportDimensions, clipExportMatches, clipExportOptionsSchema, clipExportProfile,
  clipOutputArguments, clipVideoFilter, exportArguments, MAX_EXPORT_BYTES, normalizeClipExportOptions, runClipMedia,
} from '../src/clip-media.js';

const settings: ClipSettings = { inMs: 100, outMs: 600, format: '16:9', fit: 'cover', positionX: .5, positionY: .5 };
const containers = ['mp4', 'webm', 'mov', 'mp3', 'wav'] as const;

test('export options default only legacy jobs and reject paths, arbitrary codecs and unsupported dimensions', () => {
  assert.deepEqual(normalizeClipExportOptions(), { container: 'mp4', resolution: '1080p' });
  for (const container of containers) assert.deepEqual(clipExportOptionsSchema.parse({ container, resolution: '720p' }), { container, resolution: '720p' });
  for (const value of [{}, { container: 'avi', resolution: '720p' }, { container: 'mp4', resolution: '4k' }, { container: '../unsafe', resolution: '1080p' }, { container: 'mp4', resolution: '720p', path: '/etc/passwd' }, { container: 'mp4', resolution: '720p', codec: 'copy' }]) assert.equal(clipExportOptionsSchema.safeParse(value).success, false);
  assert.deepEqual(clipExportDimensions('16:9'), [1920, 1080]); assert.deepEqual(clipExportDimensions('9:16'), [1080, 1920]);
  const options: ClipExportOptions = { container: 'webm', resolution: '720p' };
  assert.deepEqual(clipExportDimensions('16:9', options), [1280, 720]); assert.deepEqual(clipExportDimensions('9:16', options), [720, 1280]); assert.deepEqual(clipExportDimensions('1:1', options), [720, 720]);
  assert.match(clipVideoFilter(settings, options), /^scale=1280:720:/);
});

test('every export profile has a matching private extension, MIME and bounded codec argument vector', () => {
  const types = { mp4: 'video/mp4', webm: 'video/webm', mov: 'video/quicktime', mp3: 'audio/mpeg', wav: 'audio/wav' };
  for (const container of containers) {
    const options: ClipExportOptions = { container, resolution: '720p' }, profile = clipExportProfile(options), output = `/safe/final; $(not-a-command).${container}`;
    const args = clipOutputArguments(output, options);
    assert.equal(profile.extension, container); assert.equal(profile.mime, types[container]); assert.equal(args.at(-1), output);
    assert.equal(args[args.indexOf('-f') + 1], container); assert.equal(args[args.indexOf('-fs') + 1], String(MAX_EXPORT_BYTES));
    assert.equal(args[args.indexOf('-threads') + 1], '1'); assert.equal(args[args.indexOf('-ac') + 1], '2'); assert.equal(args[args.indexOf('-ar') + 1], '48000');
    assert.equal(args.includes('-c:v'), profile.video); assert.equal(args.includes('-movflags'), container === 'mp4' || container === 'mov');
    const full = exportArguments('/safe/original; $(also-not-a-command).webm', output, settings, options);
    assert.equal(full[full.indexOf('-i') + 1], '/safe/original; $(also-not-a-command).webm');
    if (!profile.video) { assert.ok(full.includes('-vn')); assert.equal(full.includes('-vf'), false); }
  }
});

test('real legacy-range encodes match all five formats, requested 720p dimensions, stereo audio and duration', { timeout: 90_000 }, async () => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'lumen-export-formats-')), source = path.join(directory, 'original ; harmless.mp4');
  try {
    await runClipMedia(['-hide_banner', '-nostdin', '-y', '-f', 'lavfi', '-i', 'color=c=teal:s=160x90:r=30:d=1', '-f', 'lavfi', '-i', 'sine=f=440:r=48000:d=1', '-map', '0:v', '-map', '1:a', '-c:v', 'libx264', '-threads', '1', '-c:a', 'aac', source], 15_000).result;
    const original = await fs.readFile(source);
    for (const container of containers) {
      const options: ClipExportOptions = { container, resolution: '720p' }, profile = clipExportProfile(options), output = path.join(directory, `encoded.${profile.extension}`);
      await runClipMedia(exportArguments(source, output, settings, options), 30_000).result;
      const diagnostic = await runClipMedia(['-hide_banner', '-nostdin', '-threads', '1', '-i', output,
        ...(profile.video ? ['-map', '0:v', '-frames:v', '1', '-an'] : ['-map', '0:a', '-vn', '-t', '0.05']), '-f', 'null', '-'], 15_000).result;
      assert.equal(clipExportMatches(diagnostic, settings.format, options, 500), true, `${container}: ${diagnostic}`);
      assert.equal(clipExportMatches(diagnostic, settings.format, options, 1000), false);
      if (profile.video) { assert.match(diagnostic, /1280x720/); assert.equal(clipExportMatches(diagnostic, settings.format, { ...options, resolution: '1080p' }, 500), false); }
      else assert.doesNotMatch(diagnostic, /Stream.*Video:/);
      assert.ok((await fs.stat(output)).size > 100);
    }
    assert.deepEqual(await fs.readFile(source), original);
  } finally { await fs.rm(directory, { recursive: true, force: true }); }
});

test('audio exports from silent legacy recordings use bounded stereo silence rather than a missing-stream failure', { timeout: 45_000 }, async () => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'lumen-silent-audio-')), source = path.join(directory, 'silent.mp4');
  try {
    await runClipMedia(['-hide_banner', '-nostdin', '-y', '-f', 'lavfi', '-i', 'color=c=black:s=160x90:r=30:d=1', '-an', '-c:v', 'libx264', '-threads', '1', source], 15_000).result;
    for (const container of ['mp3', 'wav'] as const) {
      const options: ClipExportOptions = { container, resolution: '1080p' }, output = path.join(directory, `silent.${container}`);
      await runClipMedia(exportArguments(source, output, settings, options, false), 15_000).result;
      const diagnostic = await runClipMedia(['-hide_banner', '-nostdin', '-threads', '1', '-i', output, '-map', '0:a', '-t', '0.05', '-f', 'null', '-'], 15_000).result;
      assert.equal(clipExportMatches(diagnostic, settings.format, options, 500), true);
    }
  } finally { await fs.rm(directory, { recursive: true, force: true }); }
});

test('restart interrupts unfinished format jobs and removes only their known staging files', async () => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'lumen-format-restart-'));
  const { createClips } = await import('../src/clips.js');
  let clips: Awaited<ReturnType<typeof createClips>> | undefined;
  try {
    await fs.mkdir(path.join(directory, 'exports'));
    const jobs = containers.map(container => ({ id: `export_${container}`, draftId: 'clip_test', draftRevision: 0, recordingId: 'rec_test', name: 'Saved job', ownerId: 'usr_test', status: 'exporting', progress: .5, bytes: 0,
      createdAt: '2026-10-19T12:00:00.000Z', settings, options: { container, resolution: '720p' } }));
    for (const job of jobs) await fs.writeFile(path.join(directory, 'exports', `${job.id}.partial.${job.options.container}`), 'unfinished export fixture');
    await fs.writeFile(path.join(directory, 'exports', 'operator-owned.txt'), 'Preserve unrelated files.');
    await fs.writeFile(path.join(directory, 'clips.json'), JSON.stringify({ version: 1, drafts: [], exports: jobs, media: {} }));
    clips = await createClips({ dir: directory, recordings: { list: () => [], download: () => { throw new Error('No recordings needed.'); } } as unknown as RecordingStore, isLive: () => true });
    const saved = JSON.parse(await fs.readFile(path.join(directory, 'clips.json'), 'utf8'));
    for (const [index, job] of saved.exports.entries()) { assert.equal(job.status, 'interrupted'); assert.deepEqual(job.options, jobs[index].options); }
    assert.deepEqual(await fs.readdir(path.join(directory, 'exports')), ['operator-owned.txt']);
  } finally { await clips?.close(); await fs.rm(directory, { recursive: true, force: true }); }
});

test('real composed timelines honor the same five export profiles, including visual-free audio-only jobs', { timeout: 90_000 }, async () => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'lumen-composition-formats-')), source = path.join(directory, 'source.mp4');
  try {
    await runClipMedia(['-hide_banner', '-nostdin', '-y', '-f', 'lavfi', '-i', 'color=c=blue:s=160x90:r=30:d=1', '-f', 'lavfi', '-i', 'sine=f=440:r=48000:d=1', '-map', '0:v', '-map', '1:a', '-c:v', 'libx264', '-threads', '1', '-c:a', 'aac', source], 15_000).result;
    const timeline: ClipTimeline = { version: 1, background: '#000000', tracks: [{ id: 'track_main', name: 'Main', kind: 'video', hidden: false, muted: false, locked: false, items: [{
      id: 'item_video', name: 'Source', kind: 'video', source: { kind: 'recording', id: 'rec_test' }, startMs: 0, inMs: 0, durationMs: 500,
      x: 0, y: 0, width: 1, height: 1, fit: 'cover', positionX: .5, positionY: .5, opacity: 1, volume: 1, muted: false,
      text: '', fontSize: 48, fontWeight: 600, color: '#ffffff', background: '#00000000', align: 'center',
    }] }] };
    const sources = new Map([['recording:rec_test', { path: source, kind: 'video' as const, durationMs: 1000, width: 160, height: 90, hasAudio: true }]]);
    for (const container of containers) {
      const options: ClipExportOptions = { container, resolution: '720p' }, profile = clipExportProfile(options), output = path.join(directory, `timeline.${container}`);
      const args = exportTimelineArguments(timeline, '16:9', sources, output, new Map(), options);
      if (!profile.video) assert.doesNotMatch(args[args.indexOf('-filter_complex') + 1], /color=c=|\[video\]|:v:0/);
      await runClipMedia(args, 30_000).result;
      const diagnostic = await runClipMedia(['-hide_banner', '-nostdin', '-threads', '1', '-i', output, ...(profile.video ? ['-map', '0:v', '-an', '-frames:v', '1'] : ['-map', '0:a', '-vn', '-t', '0.05']), '-f', 'null', '-'], 15_000).result;
      assert.equal(clipExportMatches(diagnostic, '16:9', options, 500), true, `${container}: ${diagnostic}`);
    }
  } finally { await fs.rm(directory, { recursive: true, force: true }); }
});
