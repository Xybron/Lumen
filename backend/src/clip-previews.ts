import fs from 'node:fs/promises';
import path from 'node:path';
import { createHash } from 'node:crypto';
import sharp from 'sharp';
import type { ClipSourceRef } from '../../shared/clips.js';
import { runClipMedia, type MediaProcess } from './clip-media.js';
import { parseTimelineMediaInfo, type TimelineSourceInfo } from './clip-timeline.js';

export const PREVIEW_FRAME_MS = 100;
export const PREVIEW_WAVEFORM_MS = 30_000;
export const PREVIEW_QUEUE_LIMIT = 100;
export const PREVIEW_CACHE_FILES = 2000;
export const PREVIEW_CACHE_BYTES = 128 * 1024 * 1024;
const MAX_SOURCE_MS = 24 * 60 * 60 * 1000;
const INPUT_FORMATS = 'mov,matroska,webm,mp3,wav,ogg,flac,aac';
const generatedName = /^[a-f0-9]{64}\.(?:jpg|png)$/;
export type ClipPreviewType = 'frame' | 'waveform';
export interface ClipPreviewSource {
  path: string;
  kind: 'video' | 'audio' | 'image';
  durationMs?: number;
  width?: number;
  height?: number;
  hasAudio?: boolean;
}
export interface ClipPreviewWork { process: MediaProcess | null; reason: 'live' | 'cancel' | 'shutdown' | null }
export interface ClipPreviewJob {
  readonly id: string;
  readonly key: string;
  readonly source: ClipSourceRef;
  readonly type: ClipPreviewType;
  readonly atMs: number;
  readonly identity: string;
  readonly resolved: ClipPreviewSource;
}
export type ClipPreviewResult =
  | { status: 'ready'; path: string; mime: 'image/jpeg' | 'image/png' }
  | { status: 'queued' | 'processing' | 'waiting-live'; retryAfterMs: number }
  | { status: 'unavailable'; reason: 'not-video' | 'not-audio' | 'no-audio' | 'outside-source' | 'unreadable' | 'storage-full' | 'shutting-down' };
export class ClipPreviewError extends Error { constructor(public status: number, message: string) { super(message); } }
export { ClipPreviewError as PreviewError };
interface CacheFile { path: string; size: number; used: number }

/** Small decoded images only. The caller's existing single media worker owns every process. */
export async function createClipPreviews(options: {
  dir: string;
  resolveSource: (source: ClipSourceRef) => ClipPreviewSource | Promise<ClipPreviewSource>;
  isProtected: () => boolean;
}) {
  const { dir, resolveSource, isProtected } = options;
  if (!path.isAbsolute(dir)) throw new Error('Preview storage must be an absolute private directory.');
  await fs.mkdir(dir, { recursive: true });
  const files = new Map<string, CacheFile>(), metadata = new Map<string, TimelineSourceInfo>();
  const unavailable = new Map<string, { result: ClipPreviewResult & { status: 'unavailable' }; retryAt: number }>();
  const failedSources = new Map<string, number>();
  const pending = new Map<string, ClipPreviewJob>(), queue: ClipPreviewJob[] = [];
  const claimed = new Set<string>();
  const activeJobs = new Map<string, Promise<void>>();
  const working = new Set<{ work: ClipPreviewWork; done: Promise<void> }>();
  let closed = false, cacheBytes = 0, cacheWrites: Promise<unknown> = Promise.resolve();
  const mimeFor = (type: ClipPreviewType) => type === 'frame' ? 'image/jpeg' as const : 'image/png' as const;
  const filenameFor = (job: Pick<ClipPreviewJob, 'key' | 'type'>) => path.join(dir, `${job.key}.${job.type === 'frame' ? 'jpg' : 'png'}`);
  function remember<K, V>(map: Map<K, V>, key: K, value: V, maximum: number) {
    map.delete(key); map.set(key, value);
    while (map.size > maximum) map.delete(map.keys().next().value!);
  }
  function noteUnavailable(key: string, reason: Extract<ClipPreviewResult, { status: 'unavailable' }>['reason']) {
    const result = { status: 'unavailable' as const, reason };
    // Invalid streams and pressure failures never trigger a poll/decode loop.
    // A later editor visit can retry transient errors after a conservative hold.
    const retryAt = reason === 'storage-full' ? Date.now() + 30_000 : reason === 'unreadable' ? Date.now() + 5 * 60_000 : Infinity;
    remember(unavailable, key, { result, retryAt }, PREVIEW_CACHE_FILES); return result;
  }
  async function evict() {
    const sorted = [...files.entries()].sort((a, b) => a[1].used - b[1].used);
    for (const [key, file] of sorted) {
      if (files.size <= PREVIEW_CACHE_FILES && cacheBytes <= PREVIEW_CACHE_BYTES) break;
      files.delete(key); cacheBytes -= file.size;
      await fs.unlink(file.path).catch(() => {});
    }
  }
  function cacheSerial<T>(fn: () => Promise<T>): Promise<T> {
    const run = cacheWrites.then(fn); cacheWrites = run.catch(() => {}); return run;
  }
  // Only this helper's opaque generated files are eligible for eviction. Do not
  // remove unknown operator files or follow symlinks from a legacy cache folder.
  for (const entry of await fs.readdir(dir, { withFileTypes: true })) {
    if (!entry.isFile()) continue;
    if (/^[a-f0-9]{64}\.(?:jpg|png)\.partial$/.test(entry.name)) { await fs.unlink(path.join(dir, entry.name)).catch(() => {}); continue; }
    if (!generatedName.test(entry.name)) continue;
    const filename = path.join(dir, entry.name), stat = await fs.stat(filename);
    if (stat.size === 0 || stat.size > 2 * 1024 * 1024) { await fs.unlink(filename).catch(() => {}); continue; }
    files.set(entry.name, { path: filename, size: stat.size, used: stat.mtimeMs }); cacheBytes += stat.size;
  }
  await evict();

  async function request(source: ClipSourceRef, type: ClipPreviewType, atMs: number): Promise<ClipPreviewResult> {
    if (!source || Object.keys(source).some(key => key !== 'kind' && key !== 'id') || !['recording', 'asset'].includes(source.kind) || typeof source.id !== 'string' || !/^[a-zA-Z0-9][a-zA-Z0-9_-]{0,119}$/.test(source.id) || !['frame', 'waveform'].includes(type) || !Number.isInteger(atMs) || atMs < 0 || atMs > MAX_SOURCE_MS) {
      throw new ClipPreviewError(422, 'Choose a valid source, preview type and time.');
    }
    if (closed) return { status: 'unavailable', reason: 'shutting-down' };
    const resolved = await resolveSource({ kind: source.kind, id: source.id });
    if (closed) return { status: 'unavailable', reason: 'shutting-down' };
    if (!resolved || !path.isAbsolute(resolved.path)) throw new ClipPreviewError(404, 'The requested media is unavailable.');
    if (resolved.kind === 'image') return { status: 'unavailable', reason: type === 'frame' ? 'not-video' : 'not-audio' };
    if (type === 'frame' && resolved.kind !== 'video') return { status: 'unavailable', reason: 'not-video' };
    const stat = await fs.lstat(resolved.path);
    if (closed) return { status: 'unavailable', reason: 'shutting-down' };
    if (!stat.isFile() || stat.isSymbolicLink()) throw new ClipPreviewError(404, 'The requested media is unavailable.');
    const identity = createHash('sha256').update(JSON.stringify([source.kind, source.id, stat.size, stat.mtimeMs, stat.ctimeMs])).digest('hex');
    const quantized = Math.floor(atMs / (type === 'frame' ? PREVIEW_FRAME_MS : PREVIEW_WAVEFORM_MS)) * (type === 'frame' ? PREVIEW_FRAME_MS : PREVIEW_WAVEFORM_MS);
    const key = createHash('sha256').update(`${identity}:${type}:${quantized}:v1`).digest('hex');
    const job: ClipPreviewJob = { id: key, key, identity, source: { ...source }, type, atMs: quantized, resolved };
    const cacheName = path.basename(filenameFor(job)), cached = files.get(cacheName);
    if (cached) {
      cached.used = Date.now();
      return { status: 'ready', path: cached.path, mime: mimeFor(type) };
    }
    const failedUntil = failedSources.get(identity);
    if (failedUntil && Date.now() < failedUntil) return { status: 'unavailable', reason: 'unreadable' };
    if (failedUntil) failedSources.delete(identity);
    const rejected = unavailable.get(key);
    if (rejected && Date.now() < rejected.retryAt) return rejected.result;
    if (rejected) unavailable.delete(key);
    const info = metadata.get(identity);
    if (info && type === 'waveform' && !info.hasAudio) return noteUnavailable(key, 'no-audio');
    if (info && quantized >= info.durationMs) return noteUnavailable(key, 'outside-source');
    const queued = (): ClipPreviewResult => ({ status: isProtected() ? 'waiting-live' : claimed.has(key) ? 'processing' : 'queued', retryAfterMs: isProtected() ? 2000 : 600 });
    if (pending.has(key)) return queued();
    if (pending.size >= PREVIEW_QUEUE_LIMIT) throw new ClipPreviewError(429, 'The preview queue is full. Retry shortly.');
    pending.set(key, job); queue.push(job);
    return queued();
  }
  function nextJob(): ClipPreviewJob | null {
    if (closed || isProtected()) return null;
    const job = queue.shift();
    if (job) claimed.add(job.key);
    return job ?? null;
  }
  function process(job: ClipPreviewJob, work: ClipPreviewWork): Promise<void> {
    const existing = activeJobs.get(job.key); if (existing) return existing;
    const operation = processJob(job, work);
    activeJobs.set(job.key, operation);
    const entry = { work, done: operation }; working.add(entry);
    void operation.finally(() => { working.delete(entry); activeJobs.delete(job.key); });
    return operation;
  }
  async function processJob(job: ClipPreviewJob, work: ClipPreviewWork) {
    if (pending.get(job.key) !== job) return;
    const partial = `${filenameFor(job)}.partial`, target = filenameFor(job);
    const stop = () => {
      if (isProtected() && !work.reason) work.reason = 'live';
      return closed || !!work.reason;
    };
    const run = async (args: string[], timeout: number) => {
      if (stop()) return null;
      const child = runClipMedia(args, timeout); work.process = child;
      if (stop()) child.stop('Live production takes priority.');
      const diagnostics = await child.result;
      return stop() ? null : diagnostics;
    };
    let completed = false, probing = false;
    try {
      if (stop()) return;
      const disk = await fs.statfs(dir);
      if (stop()) return;
      if (disk.bavail * disk.bsize < 130 * 1024 * 1024) { noteUnavailable(job.key, 'storage-full'); return; }
      // Re-stat after queuing: an externally replaced source must not poison an
      // identity-derived cache key with a frame from a different file version.
      const resolved = await resolveSource(job.source);
      if (stop()) return;
      const stat = await fs.lstat(resolved.path);
      const identity = createHash('sha256').update(JSON.stringify([job.source.kind, job.source.id, stat.size, stat.mtimeMs, stat.ctimeMs])).digest('hex');
      if (!stat.isFile() || identity !== job.identity || resolved.path !== job.resolved.path) { noteUnavailable(job.key, 'unreadable'); return; }
      let info = metadata.get(job.identity);
      if (!info) {
        const failedUntil = failedSources.get(job.identity);
        if (failedUntil && Date.now() < failedUntil) { noteUnavailable(job.key, 'unreadable'); return; }
        probing = true;
        const diagnostic = await run([
          '-hide_banner', '-nostdin', '-threads', '1', '-protocol_whitelist', 'file,pipe', '-format_whitelist', INPUT_FORMATS,
          '-i', resolved.path, '-map', '0:v:0?', '-map', '0:a:0?', '-t', '0.001', '-c', 'copy', '-f', 'null', '-',
        ], 15_000);
        if (!diagnostic || stop()) return;
        info = parseTimelineMediaInfo(diagnostic, resolved.kind, resolved.durationMs ?? 0) ?? undefined;
        if (!info || info.width * info.height > 33_554_432 || info.durationMs > MAX_SOURCE_MS) {
          remember(failedSources, job.identity, Date.now() + 5 * 60_000, 512); noteUnavailable(job.key, 'unreadable'); return;
        }
        remember(metadata, job.identity, info, 512);
        probing = false;
      }
      if (job.atMs >= info.durationMs) { noteUnavailable(job.key, 'outside-source'); return; }
      if (job.type === 'waveform' && !info.hasAudio) { noteUnavailable(job.key, 'no-audio'); return; }
      if (stop()) return;
      const common = ['-hide_banner', '-nostdin', '-y', '-threads', '1', '-protocol_whitelist', 'file,pipe', '-format_whitelist', INPUT_FORMATS, '-ss', (job.atMs / 1000).toFixed(3), '-i', resolved.path];
      const args = job.type === 'frame' ? [
        ...common, '-map', '0:v:0', '-an', '-sn', '-dn', '-frames:v', '1',
        '-vf', 'scale=192:108:force_original_aspect_ratio=decrease,pad=192:108:(ow-iw)/2:(oh-ih)/2:color=black,setsar=1',
        '-filter_threads', '1', '-threads', '1', '-q:v', '4', '-update', '1', '-f', 'image2', partial,
      ] : [
        ...common, '-t', '30', '-sn', '-dn',
        '-filter_complex', '[0:a:0]atrim=duration=30,asetpts=PTS-STARTPTS,aresample=48000,aformat=channel_layouts=stereo,apad=whole_dur=30,atrim=duration=30,showwavespic=s=3000x64:split_channels=1:colors=0x70c9e5|0x70c9e5:scale=sqrt:draw=full,format=rgba[wave]',
        '-map', '[wave]', '-filter_complex_threads', '1', '-threads', '1', '-frames:v', '1', '-update', '1', '-f', 'image2', '-c:v', 'png', partial,
      ];
      if (!await run(args, job.type === 'frame' ? 20_000 : 30_000) || stop()) return;
      const image = await sharp(partial, { limitInputPixels: 3000 * 108 }).metadata();
      if (stop()) return;
      if (image.width !== (job.type === 'frame' ? 192 : 3000) || image.height !== (job.type === 'frame' ? 108 : 64)) throw new Error('Preview dimensions did not verify.');
      const outputStat = await fs.stat(partial);
      if (outputStat.size <= 0 || outputStat.size > 2 * 1024 * 1024) throw new Error('Preview exceeded its bounded image size.');
      await cacheSerial(async () => {
        if (stop()) return;
        await fs.rename(partial, target);
        if (stop()) { await fs.unlink(target).catch(() => {}); return; }
        const name = path.basename(target), previous = files.get(name);
        cacheBytes -= previous?.size ?? 0;
        files.set(name, { path: target, size: outputStat.size, used: Date.now() }); cacheBytes += outputStat.size;
        await evict(); completed = true;
      });
    } catch {
      if (!stop()) {
        if (probing) remember(failedSources, job.identity, Date.now() + 5 * 60_000, 512);
        noteUnavailable(job.key, 'unreadable');
      }
    } finally {
      await fs.unlink(partial).catch(() => {});
      work.process = null;
      claimed.delete(job.key);
      if (!completed && !closed && work.reason === 'live') queue.push(job);
      else pending.delete(job.key);
    }
  }
  async function close() {
    closed = true; queue.length = 0;
    for (const entry of working) { entry.work.reason ??= 'shutdown'; entry.work.process?.stop('Preview worker is shutting down.'); }
    await Promise.allSettled([...working].map(entry => entry.done)); await cacheWrites; pending.clear();
  }
  return { request, nextJob, process, close };
}
