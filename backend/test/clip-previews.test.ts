import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import sharp from 'sharp';
import type { ClipSourceRef } from '../../shared/clips.js';
import { runClipMedia } from '../src/clip-media.js';
import { createClipPreviews, PREVIEW_CACHE_BYTES, PREVIEW_QUEUE_LIMIT, type ClipPreviewSource, type ClipPreviewWork } from '../src/clip-previews.js';

const sourceRef: ClipSourceRef = { kind: 'recording', id: 'rec_test' };
const freshWork = (): ClipPreviewWork => ({ process: null, reason: null });
async function fixture() {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'lumen-clip-previews-'));
  const video = path.join(dir, 'changing.mp4'), audio = path.join(dir, 'speech.wav');
  await runClipMedia(['-hide_banner', '-nostdin', '-y', '-f', 'lavfi', '-i', 'color=c=red:s=160x90:r=30:d=0.5', '-f', 'lavfi', '-i', 'color=c=blue:s=160x90:r=30:d=0.5', '-filter_complex', '[0:v][1:v]concat=n=2:v=1:a=0[v]', '-map', '[v]', '-c:v', 'libx264', '-threads', '1', video], 15_000).result;
  await runClipMedia(['-hide_banner', '-nostdin', '-y', '-f', 'lavfi', '-i', "aevalsrc='if(between(t,0.2,0.4),0.5*sin(2*PI*440*t),0)|if(between(t,0.6,0.8),0.4*sin(2*PI*220*t),0)':s=48000:d=1", '-c:a', 'pcm_s16le', audio], 15_000).result;
  return { dir, video, audio };
}

test('frame requests produce real changing JPEG frames at quantized times, with private identity caches', { timeout: 30_000 }, async () => {
  const files = await fixture(); let protectedLive = false;
  const helper = await createClipPreviews({ dir: path.join(files.dir, 'cache'), resolveSource: () => ({ path: files.video, kind: 'video', durationMs: 1000 }), isProtected: () => protectedLive });
  try {
    assert.equal((await helper.request(sourceRef, 'frame', 149)).status, 'queued');
    assert.equal((await helper.request(sourceRef, 'frame', 199)).status, 'queued');
    const job = helper.nextJob()!; assert.equal(job.atMs, 100); assert.match(job.id, /^[a-f0-9]{64}$/);
    assert.equal((await helper.request(sourceRef, 'frame', 100)).status, 'processing');
    let firstChildren = 0;
    const firstWork = freshWork();
    Object.defineProperty(firstWork, 'process', { get: () => null, set: value => { if (value) firstChildren++; }, configurable: true });
    const firstProcessing = helper.process(job, firstWork);
    assert.equal(helper.process(job, freshWork()), firstProcessing, 'Even duplicate worker dispatch shares a single media job.');
    await firstProcessing;
    assert.equal(firstChildren, 2, 'The first source request probes headers, then decodes one frame.');
    assert.equal(helper.nextJob(), null, 'Repeated requests within a quantized frame share one job.');
    const first = await helper.request(sourceRef, 'frame', 199); assert.equal(first.status, 'ready');
    if (first.status !== 'ready') throw new Error('No first frame.');
    assert.equal(first.mime, 'image/jpeg'); assert.equal(path.dirname(first.path), path.join(files.dir, 'cache'));
    assert.match(path.basename(first.path), /^[a-f0-9]{64}\.jpg$/);
    const image = await sharp(first.path).metadata(); assert.equal(image.width, 192); assert.equal(image.height, 108); assert.equal(image.format, 'jpeg');
    const rgb = await sharp(first.path).raw().toBuffer(); assert.ok(rgb[0] > 220 && rgb[1] < 20 && rgb[2] < 20);
    await helper.request(sourceRef, 'frame', 750);
    let laterChildren = 0;
    const laterWork = freshWork();
    Object.defineProperty(laterWork, 'process', { get: () => null, set: value => { if (value) laterChildren++; }, configurable: true });
    await helper.process(helper.nextJob()!, laterWork);
    assert.equal(laterChildren, 1, 'Following frames reuse bounded source metadata instead of probing each frame.');
    const second = await helper.request(sourceRef, 'frame', 750); assert.equal(second.status, 'ready');
    if (second.status !== 'ready') throw new Error('No second frame.');
    const blue = await sharp(second.path).raw().toBuffer(); assert.ok(blue[2] > 220 && blue[0] < 20);
    protectedLive = true;
    assert.equal((await helper.request(sourceRef, 'frame', 750)).status, 'ready', 'Cached previews are available during live production.');
    assert.equal((await helper.request(sourceRef, 'frame', 400)).status, 'waiting-live'); assert.equal(helper.nextJob(), null);
    const stamp = new Date(Date.now() + 1000); await fs.utimes(files.video, stamp, stamp);
    assert.equal((await helper.request(sourceRef, 'frame', 750)).status, 'waiting-live', 'Replacing source identity invalidates stale cached frames.');
  } finally { await helper.close(); await fs.rm(files.dir, { recursive: true, force: true }); }
});

test('later waveform chunks seek to their real thirty-second source window', { timeout: 30_000 }, async () => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'lumen-preview-chunk-')), audio = path.join(directory, 'later.wav');
  await runClipMedia(['-hide_banner', '-nostdin', '-y', '-f', 'lavfi', '-i', "aevalsrc='if(between(t,30.2,30.4),0.5*sin(2*PI*440*t),0)':s=48000:d=31", '-c:a', 'pcm_s16le', audio], 15_000).result;
  const helper = await createClipPreviews({ dir: path.join(directory, 'cache'), resolveSource: () => ({ path: audio, kind: 'audio', durationMs: 31_000 }), isProtected: () => false });
  try {
    const source: ClipSourceRef = { kind: 'asset', id: 'asset_later' };
    await helper.request(source, 'waveform', 30_199);
    const job = helper.nextJob()!; assert.equal(job.atMs, 30_000);
    await helper.process(job, freshWork());
    const result = await helper.request(source, 'waveform', 30_001); assert.equal(result.status, 'ready');
    if (result.status !== 'ready') throw new Error('No later chunk.');
    const { data, info } = await sharp(result.path).ensureAlpha().raw().toBuffer({ resolveWithObject: true });
    const ink = (left: number, right: number) => {
      let result = 0;
      for (let y = 0; y < info.height; y++) for (let x = left; x < right; x++) if (data[(y * info.width + x) * 4 + 3]) result++;
      return result;
    };
    assert.equal(ink(0, 15), 0); assert.ok(ink(22, 38) > 20); assert.equal(ink(110, 2999), 0);
  } finally { await helper.close(); await fs.rm(directory, { recursive: true, force: true }); }
});

test('real stereo waveform preserves 10ms horizontal timing and pads the final short chunk to thirty seconds', { timeout: 30_000 }, async () => {
  const files = await fixture();
  const helper = await createClipPreviews({ dir: path.join(files.dir, 'cache'), resolveSource: () => ({ path: files.audio, kind: 'audio', durationMs: 1000 }), isProtected: () => false });
  try {
    await helper.request({ kind: 'asset', id: 'asset_speech' }, 'waveform', 400);
    const job = helper.nextJob()!; assert.equal(job.atMs, 0);
    await helper.process(job, freshWork());
    const result = await helper.request({ kind: 'asset', id: 'asset_speech' }, 'waveform', 700); assert.equal(result.status, 'ready');
    if (result.status !== 'ready') throw new Error('No waveform.');
    const info = await sharp(result.path).metadata(); assert.equal(info.width, 3000); assert.equal(info.height, 64); assert.equal(info.hasAlpha, true);
    const { data, info: rawInfo } = await sharp(result.path).ensureAlpha().raw().toBuffer({ resolveWithObject: true });
    const ink = (startX: number, endX: number, startY = 0, endY = 64) => {
      let count = 0;
      for (let y = startY; y < endY; y++) for (let x = startX; x < endX; x++) if (data[(y * rawInfo.width + x) * 4 + 3] > 0) count++;
      return count;
    };
    assert.equal(ink(0, 15), 0, 'Silence before 0.2s is transparent, not invented audio.');
    assert.ok(ink(22, 38, 0, 32) > 20, 'Left channel tone belongs around 0.2–0.4s (20–40 pixels).');
    assert.equal(ink(22, 38, 32, 64), 0, 'Stereo channels remain separate.');
    assert.ok(ink(62, 78, 32, 64) > 20, 'Right channel tone belongs around 0.6–0.8s.');
    assert.equal(ink(110, 2999), 0, 'A one-second source does not stretch across the thirty-second chunk.');
    const sameChunk = await helper.request({ kind: 'asset', id: 'asset_speech' }, 'waveform', 20_000); assert.equal(sameChunk.status, 'ready');
    await helper.request({ kind: 'asset', id: 'asset_speech' }, 'waveform', 30_000);
    const beyond = await helper.request({ kind: 'asset', id: 'asset_speech' }, 'waveform', 30_000); assert.equal(beyond.status, 'unavailable');
  } finally { await helper.close(); await fs.rm(files.dir, { recursive: true, force: true }); }
});

test('silent videos explicitly report no audio; unsupported source types and invalid public requests do not decode', { timeout: 30_000 }, async () => {
  const files = await fixture();
  let current: ClipPreviewSource = { path: files.video, kind: 'video', durationMs: 1000 };
  const helper = await createClipPreviews({ dir: path.join(files.dir, 'cache'), resolveSource: () => current, isProtected: () => false });
  try {
    await helper.request(sourceRef, 'waveform', 0); await helper.process(helper.nextJob()!, freshWork());
    assert.deepEqual(await helper.request(sourceRef, 'waveform', 0), { status: 'unavailable', reason: 'no-audio' });
    current = { path: files.audio, kind: 'audio', durationMs: 1000 };
    assert.deepEqual(await helper.request({ kind: 'asset', id: 'asset_audio' }, 'frame', 0), { status: 'unavailable', reason: 'not-video' });
    current = { path: files.audio, kind: 'image' };
    assert.equal((await helper.request({ kind: 'asset', id: 'asset_image' }, 'waveform', 0)).status, 'unavailable');
    for (const [source, type, atMs] of [[{ kind: 'asset', id: '../secret' }, 'frame', 0], [{ ...sourceRef, path: '/etc/passwd' }, 'frame', 0], [sourceRef, 'frame', -1], [sourceRef, 'waveform', 1.5], [sourceRef, 'other', 0], [sourceRef, 'frame', 86_400_001], [{ kind: 'url', id: 'https://example.com' }, 'frame', 0]] as const) {
      await assert.rejects(helper.request(source as ClipSourceRef, type as 'frame', atMs), /valid/);
    }
  } finally { await helper.close(); await fs.rm(files.dir, { recursive: true, force: true }); }
});

test('deduplicated preview queues are bounded, protected work requeues, and shutdown rejects new work', async () => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'lumen-preview-queue-')), source = path.join(directory, 'source.mp4'); await fs.writeFile(source, 'metadata is not decoded in this queue test');
  let protectedLive = false, checks = 0;
  const helper = await createClipPreviews({ dir: path.join(directory, 'cache'), resolveSource: () => { checks++; return { path: source, kind: 'video', durationMs: 100_000 }; }, isProtected: () => protectedLive });
  try {
    for (let index = 0; index < PREVIEW_QUEUE_LIMIT; index++) assert.equal((await helper.request(sourceRef, 'frame', index * 100)).status, 'queued');
    assert.equal((await helper.request(sourceRef, 'frame', 0)).status, 'queued');
    await assert.rejects(helper.request(sourceRef, 'frame', 10_000), error => (error as { status: number }).status === 429);
    const job = helper.nextJob()!, work = freshWork(); protectedLive = true;
    await helper.process(job, work); assert.equal(work.reason, 'live'); assert.equal(work.process, null); assert.equal(helper.nextJob(), null);
    protectedLive = false;
    const jobs = []; let next; while ((next = helper.nextJob())) jobs.push(next);
    assert.equal(jobs.length, PREVIEW_QUEUE_LIMIT, 'The interrupted job stays queued exactly once.');
    assert.ok(checks >= PREVIEW_QUEUE_LIMIT);
    await helper.close(); assert.deepEqual(await helper.request(sourceRef, 'frame', 0), { status: 'unavailable', reason: 'shutting-down' });
  } finally { await helper.close(); await fs.rm(directory, { recursive: true, force: true }); }
});

test('startup cache eviction is size-bounded and removes only generated private cache names', async () => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'lumen-preview-evict-'));
  const generated = path.join(directory, `${'a'.repeat(64)}.jpg`), untouched = path.join(directory, 'operator-owned.jpg');
  const partial = path.join(directory, `${'b'.repeat(64)}.png.partial`); await fs.writeFile(partial, 'Interrupted generated output.');
  await fs.writeFile(generated, 'generated fixture'); await fs.truncate(generated, PREVIEW_CACHE_BYTES + 1); await fs.writeFile(untouched, 'Preserve this unrelated file.');
  // Sparse files exercise the apparent-byte quota without consuming 130 MiB
  // of test storage; no fixture is ever returned as a decoded preview.
  for (let index = 0; index < 65; index++) {
    const filename = path.join(directory, `${index.toString(16).padStart(64, '0')}.png`);
    await fs.writeFile(filename, 'bounded cache fixture'); await fs.truncate(filename, 2 * 1024 * 1024);
  }
  const helper = await createClipPreviews({ dir: directory, resolveSource: () => { throw new Error('No sources needed.'); }, isProtected: () => true });
  try {
    await assert.rejects(fs.stat(generated), { code: 'ENOENT' }); await assert.rejects(fs.stat(partial), { code: 'ENOENT' }); assert.equal(await fs.readFile(untouched, 'utf8'), 'Preserve this unrelated file.');
    assert.equal((await fs.readdir(directory)).filter(filename => /^[a-f0-9]{64}\.png$/.test(filename)).length, 64);
  }
  finally { await helper.close(); await fs.rm(directory, { recursive: true, force: true }); }
});

test('low storage prevents all media work and malformed streams are held instead of repeatedly decoded', async t => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'lumen-preview-pressure-')), source = path.join(directory, 'unreadable.mp4');
  await fs.writeFile(source, 'This is not a supported media stream.');
  const helper = await createClipPreviews({ dir: path.join(directory, 'cache'), resolveSource: () => ({ path: source, kind: 'video', durationMs: 1000 }), isProtected: () => false });
  try {
    await helper.request(sourceRef, 'frame', 0);
    const storage = t.mock.method(fs, 'statfs', async () => ({ bavail: 0, bsize: 4096 }));
    const work = freshWork(); await helper.process(helper.nextJob()!, work);
    assert.equal(work.process, null);
    assert.deepEqual(await helper.request(sourceRef, 'frame', 0), { status: 'unavailable', reason: 'storage-full' });
    storage.mock.restore();
    await helper.request(sourceRef, 'frame', 100); await helper.process(helper.nextJob()!, freshWork());
    assert.deepEqual(await helper.request(sourceRef, 'frame', 100), { status: 'unavailable', reason: 'unreadable' });
    for (let index = 0; index < 5; index++) await helper.request(sourceRef, 'frame', 100);
    assert.deepEqual(await helper.request(sourceRef, 'frame', 200), { status: 'unavailable', reason: 'unreadable' }, 'Bad source headers are cached across timestamps, not probed per filmstrip image.');
    assert.equal(helper.nextJob(), null, 'Repeated requests do not keep spawning failed decoders.');
  } finally { await helper.close(); await fs.rm(directory, { recursive: true, force: true }); }
});
