import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { clipDraftInputSchema, createClips } from '../src/clips.js';
import type { RecordingStore } from '../src/production-recordings.js';
import { clipVideoFilter, exportArguments, MAX_CLIP_MS, MAX_EXPORT_BYTES, parseMediaInfo } from '../src/clip-media.js';

const settings = { inMs: 0, outMs: 15_000, format: '9:16' as const, fit: 'cover' as const, positionX: .75, positionY: .5 };

test('clip input accepts bounded settings and trims names', () => {
  const parsed = clipDraftInputSchema.parse({ name: '  Sermon highlight  ', ...settings });
  assert.equal(parsed.name, 'Sermon highlight');
  assert.deepEqual({ ...parsed, name: undefined }, { name: undefined, ...settings });
});

test('clip input rejects invalid trims, NaN, arbitrary settings and path fields', () => {
  const base = { name: 'Highlight', ...settings };
  for (const patch of [
    { inMs: -1 }, { inMs: .5 }, { outMs: 0 }, { outMs: 100 }, { inMs: 20_000 },
    { outMs: MAX_CLIP_MS + 1 }, { positionX: -1 }, { positionY: 1.01 },
    { positionX: NaN }, { format: '4:3' }, { fit: 'stretch' },
    { name: '' }, { name: 'a'.repeat(121) }, { path: '/etc/passwd' }, { filter: 'movie=/etc/passwd' },
  ]) assert.equal(clipDraftInputSchema.safeParse({ ...base, ...patch }).success, false, JSON.stringify(patch));
});

test('all supported frame presets match browser cover and contain geometry', () => {
  assert.equal(clipVideoFilter(settings), 'scale=1080:1920:force_original_aspect_ratio=increase:force_divisible_by=2,crop=1080:1920:(iw-ow)*0.75:(ih-oh)*0.5,setsar=1');
  assert.match(clipVideoFilter({ ...settings, format: '1:1' }), /^scale=1080:1080:.*crop=1080:1080:/);
  assert.match(clipVideoFilter({ ...settings, format: '16:9' }), /^scale=1920:1080:.*crop=1920:1080:/);
  assert.equal(clipVideoFilter({ ...settings, fit: 'contain' }), 'scale=1080:1920:force_original_aspect_ratio=decrease:force_divisible_by=2,pad=1080:1920:(ow-iw)/2:(oh-ih)/2:color=black,setsar=1');
});

test('export argument vector preserves opaque paths and bounds codec resources', () => {
  const input = '/safe/recording; $(false).webm', output = '/safe/clip.mp4';
  const args = exportArguments(input, output, { ...settings, inMs: 1250, outMs: 5250 });
  assert.equal(args[args.indexOf('-i') + 1], input);
  assert.equal(args.at(-1), output);
  assert.equal(args[args.indexOf('-ss') + 1], '1.250');
  assert.equal(args[args.indexOf('-t') + 1], '4.000');
  assert.equal(args[args.indexOf('-c:v') + 1], 'libx264');
  assert.equal(args[args.indexOf('-c:a') + 1], 'aac');
  assert.equal(args[args.indexOf('-fs') + 1], String(MAX_EXPORT_BYTES));
  assert.ok(args.includes('0:a:0?'));
  assert.equal(args[args.indexOf('-threads') + 1], '1');
  assert.equal(args[args.indexOf('-filter_threads') + 1], '1');
  assert.ok(args.includes('+faststart'));
});

test('source metadata is extracted from real stream diagnostics and rejects bogus dimensions', () => {
  const log = 'Duration: 01:02:03.45, start: 0.000000, bitrate: 100 kb/s\nStream #0:0: Video: vp9, yuv420p, 1920x1080, 30 fps\n';
  assert.deepEqual(parseMediaInfo(log, 1), { durationMs: 3_723_450, width: 1920, height: 1080 });
  assert.deepEqual(parseMediaInfo('Stream #0:0: Video: vp9, yuv420p, 640x360', 20_000), { durationMs: 20_000, width: 640, height: 360 });
  assert.equal(parseMediaInfo('Stream #0:0: Audio: opus, 48000 Hz', 20_000), null);
  assert.equal(parseMediaInfo('Stream #0:0: Video: vp9, 99999x99999', 20_000), null);
  assert.equal(parseMediaInfo('Stream #0:0: Video: vp9, 1920x1080', -1), null);
});

const noRecordings = { list: () => [], download: () => { throw new Error('No recordings in this disposable fixture.'); } } as unknown as RecordingStore;
const savedDraft = {
  ...settings, name: 'Saved original draft', id: 'clip_test', recordingId: 'rec_test', revision: 3,
  ownerId: 'usr_test', ownerName: 'Editor', createdAt: '2026-10-19T09:00:00.000Z', updatedAt: '2026-10-19T09:10:00.000Z',
};
const savedExport = {
  id: 'export_test', draftId: 'clip_test', draftRevision: 2, recordingId: 'rec_test', name: 'Older immutable snapshot',
  ownerId: 'usr_test', status: 'exporting', progress: .5, bytes: 0,
  createdAt: '2026-10-19T09:05:00.000Z', settings: { ...settings, outMs: 12_000 },
};

test('restart marks unfinished exports interrupted and preserves independent draft/snapshot revisions', async () => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'lumen-clips-unit-'));
  let clips: Awaited<ReturnType<typeof createClips>> | undefined;
  try {
    await fs.mkdir(path.join(directory, 'exports'));
    await fs.writeFile(path.join(directory, 'exports', 'export_test.partial.mp4'), 'unfinished fixture bytes');
    await fs.writeFile(path.join(directory, 'original.webm'), 'untouched original fixture');
    await fs.writeFile(path.join(directory, 'clips.json'), JSON.stringify({ version: 1, drafts: [savedDraft], exports: [savedExport], media: {} }));
    clips = await createClips({ dir: directory, recordings: noRecordings, isLive: () => false });
    const index = JSON.parse(await fs.readFile(path.join(directory, 'clips.json'), 'utf8'));
    assert.deepEqual(index.drafts, [savedDraft]);
    assert.equal(index.exports[0].status, 'interrupted');
    assert.equal(index.exports[0].draftRevision, 2);
    assert.equal(index.drafts[0].revision, 3);
    assert.deepEqual(index.exports[0].settings, savedExport.settings);
    assert.match(index.exports[0].error, /restarted/);
    await assert.rejects(fs.stat(path.join(directory, 'exports', 'export_test.partial.mp4')), { code: 'ENOENT' });
    assert.equal(await fs.readFile(path.join(directory, 'original.webm'), 'utf8'), 'untouched original fixture');
  } finally { await clips?.close(); await fs.rm(directory, { recursive: true, force: true }); }
});

test('an unreadable or invalid index is preserved rather than replaced with an empty workspace', async () => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'lumen-clips-unit-'));
  try {
    for (const source of ['{broken', JSON.stringify({ version: 1, drafts: [{ ...savedDraft, positionX: 5 }], exports: [], media: {} })]) {
      await fs.writeFile(path.join(directory, 'clips.json'), source);
      await assert.rejects(createClips({ dir: directory, recordings: noRecordings, isLive: () => false }), /existing file has been preserved/);
      assert.equal(await fs.readFile(path.join(directory, 'clips.json'), 'utf8'), source);
    }
  } finally { await fs.rm(directory, { recursive: true, force: true }); }
});

test('a clean Clips workspace has its own durable index and closes without touching production files', async () => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'lumen-clips-unit-'));
  let clips: Awaited<ReturnType<typeof createClips>> | undefined;
  try {
    await fs.writeFile(path.join(directory, 'production.json'), 'operator-owned fixture');
    clips = await createClips({ dir: path.join(directory, 'clips'), recordings: noRecordings, isLive: () => true });
    await clips.pauseForLive(); await clips.close(); clips = undefined;
    assert.deepEqual(JSON.parse(await fs.readFile(path.join(directory, 'clips', 'clips.json'), 'utf8')), { version: 1, drafts: [], exports: [], media: {} });
    assert.equal(await fs.readFile(path.join(directory, 'production.json'), 'utf8'), 'operator-owned fixture');
  } finally { await clips?.close(); await fs.rm(directory, { recursive: true, force: true }); }
});

test('Clips storage failure after the worker stops cannot block live engine startup', async () => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'lumen-clips-unit-'));
  let clips: Awaited<ReturnType<typeof createClips>> | undefined;
  try {
    clips = await createClips({ dir: directory, recordings: noRecordings, isLive: () => true });
    // Force the exact index-commit failure without touching any station data.
    // Atomic rename cannot replace a directory with the new metadata file.
    await fs.unlink(path.join(directory, 'clips.json'));
    await fs.mkdir(path.join(directory, 'clips.json'));
    await assert.doesNotReject(clips.pauseForLive());
  } finally {
    await clips?.close().catch(() => {});
    await fs.rm(directory, { recursive: true, force: true });
  }
});
