import fs from 'node:fs/promises';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { Router, type Request, type Response, type NextFunction } from 'express';
import { z } from 'zod';
import multer from 'multer';
import { requireSession, type SessionUser } from './auth.js';
import { atomicWriteJson } from './atomic.js';
import type { RecordingStore } from './production-recordings.js';
import type { ClipDraft, ClipDraftInput, ClipExport, ClipSettings, ClipTimeline, ClipWorkspace } from '../../shared/clips.js';
import { clipExportOptionsSchema, clipExportProfile, normalizeClipExportOptions, clipExportMatches, exportArguments, MAX_CLIP_MS, MAX_EXPORT_BYTES, parseMediaInfo, runClipMedia, type MediaProcess } from './clip-media.js';
import { createClipAssets, ClipAssetError, CLIP_INPUT_FORMATS } from './clip-assets.js';
import { timelineSchema, timelineDuration, timelineSourceKey, validateTimelineSources, exportTimelineArguments, prepareTimelineText, parseTimelineMediaInfo, TimelineError, type ResolvedTimelineSource } from './clip-timeline.js';
import { createClipPreviews, ClipPreviewError } from './clip-previews.js';

const idSchema = z.string().regex(/^[a-z]+_[\w-]{1,100}$/);
const settingsShape = {
  inMs: z.number().int().min(0).max(24 * 60 * 60 * 1000),
  outMs: z.number().int().min(1).max(24 * 60 * 60 * 1000),
  format: z.enum(['16:9', '9:16', '1:1']),
  fit: z.enum(['cover', 'contain']),
  positionX: z.number().min(0).max(1), positionY: z.number().min(0).max(1),
  timeline: timelineSchema.optional(),
} as const;
const inputObject = z.object({ name: z.string().trim().min(1).max(120), ...settingsShape }).strict();
export const clipDraftInputSchema = inputObject.refine(v => {
  const duration = v.timeline ? timelineDuration(v.timeline) : v.outMs - v.inMs;
  return duration >= 250 && duration <= MAX_CLIP_MS;
}, {
  message: 'Choose a clip between a quarter of a second and two hours.', path: ['outMs'],
});
const dateSchema = z.string().datetime();
const savedDraftSchema = inputObject.extend({
  id: idSchema, recordingId: idSchema, revision: z.number().int().nonnegative(),
  ownerId: z.string().min(1).max(150), ownerName: z.string().min(1).max(150),
  createdAt: dateSchema, updatedAt: dateSchema,
}).strict();
const savedExportSchema = z.object({
  id: idSchema, draftId: idSchema, draftRevision: z.number().int().nonnegative(), recordingId: idSchema,
  name: z.string().min(1).max(120), ownerId: z.string().min(1).max(150),
  status: z.enum(['queued', 'waiting-live', 'exporting', 'complete', 'cancelled', 'error', 'interrupted']),
  progress: z.number().min(0).max(1), createdAt: dateSchema, completedAt: dateSchema.optional(),
  bytes: z.number().int().nonnegative(), error: z.string().max(1000).optional(),
  settings: z.object(settingsShape).strict(),
  options: clipExportOptionsSchema.optional(),
  temporary: z.boolean().optional(), expiresAt: dateSchema.optional(), deliveredAt: dateSchema.optional(), expiredAt: dateSchema.optional(),
}).strict();
const indexSchema = z.object({
  version: z.literal(1), drafts: z.array(savedDraftSchema).max(10_000), exports: z.array(savedExportSchema).max(10_000),
  media: z.record(z.object({ durationMs: z.number().positive(), width: z.number().int().min(2).max(16384), height: z.number().int().min(2).max(16384) })).default({}),
}).strict();
type SavedDraft = z.infer<typeof savedDraftSchema>;
type SavedExport = z.infer<typeof savedExportSchema>;
type ClipIndex = z.infer<typeof indexSchema>;
class ClipError extends Error { constructor(public status: number, message: string) { super(message); } }
const asyncRoute = (fn: (req: Request, res: Response) => Promise<unknown>) =>
  (req: Request, res: Response, next: NextFunction) => { void fn(req, res).catch(next); };
const unsettled = (job: SavedExport) => ['queued', 'waiting-live', 'exporting'].includes(job.status);
export const TEMP_EXPORT_TTL_MS = 24 * 60 * 60 * 1000;
export const MAX_TEMP_EXPORT_BYTES = 4 * 1024 * 1024 * 1024;
const settingsOf = (draft: ClipSettings): ClipSettings => ({
  inMs: draft.inMs, outMs: draft.outMs, format: draft.format, fit: draft.fit,
  positionX: draft.positionX, positionY: draft.positionY,
  ...(draft.timeline ? { timeline: structuredClone(draft.timeline) } : {}),
});
function input(value: unknown): ClipDraftInput {
  const result = clipDraftInputSchema.safeParse(value);
  if (!result.success) throw new ClipError(422, result.error.issues[0]?.message ?? 'Invalid clip settings.');
  return result.data;
}

interface ActiveWork { kind: 'poster' | 'export' | 'preview'; id: string; process: MediaProcess | null; reason: 'live' | 'cancel' | 'shutdown' | null; done: Promise<void> }
export async function createClips(options: { dir: string; recordings: RecordingStore; isLive: () => boolean }) {
  const { dir, recordings, isLive } = options;
  await fs.mkdir(dir, { recursive: true });
  const exportsDir = path.join(dir, 'exports');
  await fs.mkdir(exportsDir, { recursive: true });
  const scratchDir = path.join(dir, 'scratch');
  await fs.mkdir(scratchDir, { recursive: true });
  const artifactDir = (job: SavedExport) => job.temporary ? scratchDir : exportsDir;
  const artifactPath = (job: SavedExport) => path.join(artifactDir(job), `${job.id}.${clipExportProfile(job.options).extension}`);
  const exportPosterPath = (job: SavedExport) => path.join(artifactDir(job), `${job.id}.thumbnail.jpg`);
  const unavailableExport = (job: SavedExport) => !!job.deliveredAt || !!job.expiredAt;
  const assets = await createClipAssets(path.join(dir, 'assets'));
  const indexPath = path.join(dir, 'clips.json');
  let data: ClipIndex = { version: 1, drafts: [], exports: [], media: {} };
  try { data = indexSchema.parse(JSON.parse(await fs.readFile(indexPath, 'utf8'))); }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw new Error('The Clips index could not be read. The existing file has been preserved.');
  }
  // A process cannot survive its station. Never misrepresent unfinished work as
  // complete, and never silently start old exports after a station restart.
  const exportPosterReady = new Set<string>(), retainedTemporary = new Set<string>(), downloads = new Map<string, number>();
  const previousFiles = new Map(await Promise.all([exportsDir, scratchDir].map(async directory => [directory, await fs.readdir(directory, { withFileTypes: true })] as const)));
  for (const job of data.exports) {
    if (unsettled(job)) {
      job.status = 'interrupted'; job.error = 'Station restarted before this export finished. Export the saved draft again.';
    }
    const extension = clipExportProfile(job.options).extension;
    await fs.unlink(path.join(artifactDir(job), `${job.id}.partial.${extension}`)).catch(() => {});
    if (extension !== 'mp4') await fs.unlink(path.join(artifactDir(job), `${job.id}.partial.mp4`)).catch(() => {});
    await fs.unlink(`${exportPosterPath(job)}.partial`).catch(() => {});
    if (job.temporary && job.status !== 'complete') {
      // A crash can occur after the staging rename but before the completion
      // receipt is durable. This is still an unfinished scratch job, never an
      // archive: reclaim only its own generated final paths on restart.
      await fs.unlink(artifactPath(job)).catch(() => {});
      await fs.unlink(exportPosterPath(job)).catch(() => {});
    }
    // Only generated work directories belonging to a known persisted job.
    for (const entry of previousFiles.get(artifactDir(job)) ?? []) if (entry.isDirectory() && entry.name.startsWith(`${job.id}.work-`) && /^[\w-]{6}$/.test(entry.name.slice(`${job.id}.work-`.length))) {
      await fs.rm(path.join(artifactDir(job), entry.name), { recursive: true, force: true });
    }
    if (job.status === 'complete' && !unavailableExport(job)) {
      try { if ((await fs.stat(exportPosterPath(job))).size > 0) exportPosterReady.add(job.id); } catch { /* Optional derived poster. */ }
    }
    if (job.temporary && job.status === 'complete') {
      try { if ((await fs.stat(artifactPath(job))).isFile()) retainedTemporary.add(job.id); } catch { /* Missing scratch file is already reclaimed. */ }
      job.expiresAt ??= new Date(Date.parse(job.completedAt ?? job.createdAt) + TEMP_EXPORT_TTL_MS).toISOString();
    }
  }
  await atomicWriteJson(indexPath, data);
  let closed = false, liveHold = false, observedLive = false, holdUntil = 0;
  let active: ActiveWork | null = null, ticking = false;
  let writes: Promise<unknown> = Promise.resolve();
  const posterReady = new Set<string>(), posterFailures = new Map<string, number>();
  function serial<T>(operation: () => Promise<T>): Promise<T> {
    const run = writes.then(operation); writes = run.catch(() => {}); return run;
  }
  const persist = () => atomicWriteJson(indexPath, data);
  const temporaryBytes = () => data.exports.filter(job => retainedTemporary.has(job.id)).reduce((sum, job) => sum + job.bytes, 0);
  async function removeReleasedFiles(job: SavedExport) {
    if (!job.temporary || !unavailableExport(job) || downloads.get(job.id)) return;
    // Paths are derived only from a validated persisted job ID and fixed codec
    // extensions. Originals, project drafts and permanent exports are never targets.
    await fs.unlink(artifactPath(job)).catch(error => { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; });
    retainedTemporary.delete(job.id);
    await fs.unlink(exportPosterPath(job)).catch(error => { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; });
    exportPosterReady.delete(job.id);
  }
  async function cleanTemporaryExports() {
    return serial(async () => {
      let changed = false;
      for (const job of data.exports) {
        if (!job.temporary || job.status !== 'complete') continue;
        if (!unavailableExport(job) && !downloads.get(job.id) && job.expiresAt && Date.parse(job.expiresAt) <= Date.now()) {
          job.expiredAt = new Date().toISOString(); changed = true;
        }
      }
      if (changed) await persist();
      for (const job of data.exports) await removeReleasedFiles(job).catch(error => console.warn('[clips] Scratch cleanup will retry:', job.id, (error as Error).message));
    });
  }
  await cleanTemporaryExports();
  const protectedNow = () => liveHold || isLive();
  const previews = await createClipPreviews({
    dir: path.resolve(dir, 'timeline-previews'), isProtected: protectedNow,
    resolveSource: source => {
      if (source.kind === 'recording') {
        const original = recording(source.id);
        return { path: path.resolve(recordings.download(source.id).path), kind: 'video', durationMs: data.media[source.id]?.durationMs ?? original.durationMs };
      }
      const resolved = assets.resolve(source.id);
      return { path: path.resolve(resolved.path), kind: resolved.asset.kind, durationMs: resolved.asset.durationMs };
    },
  });
  const userFor = (req: Request) => (req as Request & { user: SessionUser }).user;
  const editable = (ownerId: string, user: SessionUser) => ownerId === user.id || user.isAdmin;
  const draftFor = (draft: SavedDraft, user: SessionUser): ClipDraft => ({ ...draft, canEdit: editable(draft.ownerId, user) });
  const exportFor = (job: SavedExport, user: SessionUser): ClipExport => ({ ...structuredClone(job), posterReady: exportPosterReady.has(job.id) && !unavailableExport(job), canCancel: unsettled(job) && editable(job.ownerId, user) });
  function recording(id: string) {
    const item = recordings.list().find(value => value.id === id);
    if (!item) throw new ClipError(404, 'Recording not found.');
    if (item.status !== 'complete') throw new ClipError(409, 'Wait until the original recording has finished processing.');
    return item;
  }
  function validateRecordingSettings(id: string, value: ClipDraftInput) {
    const original = recording(id);
    if (value.timeline) { validateTimelineSources(value.timeline, resolveTimeline(value.timeline)); return; }
    const durationMs = data.media[id]?.durationMs ?? original.durationMs;
    if (!Number.isFinite(durationMs) || durationMs <= 0) throw new ClipError(409, 'The recording duration is not available yet.');
    // A few recorder milliseconds can differ from the container timebase. Do
    // not permit arbitrary trims past the real source when its probe is ready.
    if (value.inMs >= durationMs || value.outMs > durationMs + 100) throw new ClipError(422, 'The clip must stay within the original recording.');
  }
  function resolveTimeline(timeline: ClipTimeline) {
    const sources = new Map<string, ResolvedTimelineSource>();
    for (const track of timeline.tracks) for (const item of track.items) {
      if (!item.source) continue;
      const key = timelineSourceKey(item.source);
      if (sources.has(key)) continue;
      if (item.source.kind === 'recording') {
        const source = recording(item.source.id), media = data.media[source.id];
        sources.set(key, { path: recordings.download(source.id).path, kind: 'video', durationMs: media?.durationMs ?? source.durationMs, width: media?.width ?? 1920, height: media?.height ?? 1080, hasAudio: true });
      } else {
        const { asset, path: filename } = assets.resolve(item.source.id);
        sources.set(key, { path: filename, kind: asset.kind, durationMs: asset.durationMs, width: asset.width, height: asset.height, hasAudio: asset.kind !== 'image' });
      }
    }
    return sources;
  }
  async function probeTimeline(work: ActiveWork, timeline: ClipTimeline) {
    const sources = resolveTimeline(timeline);
    for (const [key, source] of sources) {
      if (protectedNow() || work.reason) { work.reason ??= 'live'; return sources; }
      // Inspect headers without decoding untrusted full-resolution frames. No
      // playlists, remote protocols or user-provided filesystem paths allowed.
      const probe = runClipMedia([
        '-hide_banner', '-nostdin', '-threads', '1', '-protocol_whitelist', 'file,pipe', '-format_whitelist', CLIP_INPUT_FORMATS,
        '-i', source.path, '-map', '0:v:0?', '-map', '0:a:0?', '-t', '0.001', '-c', 'copy', '-f', 'null', '-',
      ], 15_000);
      work.process = probe;
      if (protectedNow() || work.reason) { work.reason ??= 'live'; probe.stop('Live production takes priority.'); }
      const diagnostics = await probe.result;
      if (work.reason) return sources;
      const info = parseTimelineMediaInfo(diagnostics, source.kind, source.durationMs);
      if (!info || info.width * info.height > 33554432) throw new ClipError(422, 'Imported media is unreadable or exceeds the 32-megapixel limit.');
      sources.set(key, { ...info, path: source.path });
    }
    validateTimelineSources(timeline, sources);
    return sources;
  }
  function requireDraft(id: string) {
    const draft = data.drafts.find(value => value.id === id);
    if (!draft) throw new ClipError(404, 'Clip draft not found.');
    return draft;
  }
  function requireExport(id: string) {
    const job = data.exports.find(value => value.id === id);
    if (!job) throw new ClipError(404, 'Export not found.');
    return job;
  }
  function checkOwner(ownerId: string, user: SessionUser) {
    if (!editable(ownerId, user)) throw new ClipError(403, 'This draft belongs to another teammate. Make your own copy to edit it.');
  }
  function checkRevision(current: number, incoming: unknown) {
    if (!Number.isInteger(incoming) || (incoming as number) < 0) throw new ClipError(422, 'A valid draft revision is required.');
    if (current !== incoming) throw new ClipError(409, 'This draft changed in another window. Refresh it before saving or exporting.');
  }
  function posterPath(id: string) { return path.join(path.dirname(recordings.download(id).path), 'clips-thumbnail.jpg'); }
  for (const item of recordings.list().filter(value => value.status === 'complete')) {
    try { if ((await fs.stat(posterPath(item.id))).size > 0) posterReady.add(item.id); } catch { /* Generated when idle. */ }
  }

  async function finishJob(job: SavedExport, patch: Partial<SavedExport>) {
    await serial(async () => { Object.assign(job, patch); await persist(); });
  }
  async function freeBytes() {
    const disk = await fs.statfs(dir);
    return disk.bavail * disk.bsize;
  }
  async function syncFile(filename: string) {
    const handle = await fs.open(filename, 'r');
    try { await handle.sync(); } finally { await handle.close(); }
  }
  async function processExport(work: ActiveWork, job: SavedExport) {
    const profile = clipExportProfile(job.options);
    const partial = path.join(artifactDir(job), `${job.id}.partial.${profile.extension}`);
    const posterPartial = `${exportPosterPath(job)}.partial`;
    let diskTimer: ReturnType<typeof setInterval> | undefined;
    let workDir: string | undefined;
    let renderedPoster = false;
    try {
      const original = recording(job.recordingId);
      if (protectedNow() || work.reason) { work.reason ??= 'live'; return; }
      // Explicit exports can jump ahead of background thumbnails. Obtain the
      // container's real duration first rather than trusting recorder clocks.
      if (!job.settings.timeline && !data.media[job.recordingId]) await processPoster(work, job.recordingId);
      if (work.reason) return;
      if (!job.settings.timeline && !data.media[job.recordingId]) throw new Error('The original video could not be read.');
      validateRecordingSettings(job.recordingId, { name: job.name, ...job.settings });
      const durationMs = job.settings.timeline ? timelineDuration(job.settings.timeline) : job.settings.outMs - job.settings.inMs;
      const estimate = Math.min(MAX_EXPORT_BYTES, durationMs * (profile.video ? 1000 : profile.container === 'wav' ? 192 : 24));
      if (job.temporary && temporaryBytes() + estimate > MAX_TEMP_EXPORT_BYTES) throw new ClipError(507, 'Temporary export storage is full. Save or clear a completed temporary export, then try again.');
      if (await freeBytes() < Math.max(256 * 1024 * 1024, estimate + 128 * 1024 * 1024)) throw new ClipError(507, 'Not enough free space to safely export this clip. Free some station storage, then export the saved draft again.');
      if (protectedNow() || work.reason) { work.reason ??= 'live'; return; }
      await finishJob(job, { status: 'exporting', progress: 0, error: undefined });
      if (protectedNow() || work.reason) { work.reason ??= 'live'; return; }
      const durationUs = durationMs * 1000;
      const timeout = Math.min(2 * 60 * 60 * 1000, Math.max(90_000, durationMs * 6));
      let args: string[];
      if (job.settings.timeline) {
        const sources = await probeTimeline(work, job.settings.timeline);
        if (work.reason || protectedNow()) { work.reason ??= 'live'; return; }
        let textPaths = new Map<string, string>();
        if (profile.video) {
          workDir = await fs.mkdtemp(path.join(artifactDir(job), `${job.id}.work-`));
          textPaths = await prepareTimelineText(job.settings.timeline, job.settings.format, workDir, () => {
            if (protectedNow()) work.reason ??= 'live';
            return !!work.reason;
          });
        }
        if (work.reason || protectedNow()) { work.reason ??= 'live'; return; }
        args = exportTimelineArguments(job.settings.timeline, job.settings.format, sources, partial, textPaths, job.options);
      } else {
        let hasAudio = true;
        if (!profile.video) {
          const headers = runClipMedia(['-hide_banner', '-nostdin', '-threads', '1', '-protocol_whitelist', 'file,pipe', '-format_whitelist', CLIP_INPUT_FORMATS,
            '-i', recordings.download(original.id).path, '-map', '0:v:0?', '-map', '0:a:0?', '-t', '0.001', '-c', 'copy', '-f', 'null', '-'], 15_000);
          work.process = headers;
          if (protectedNow() || work.reason) { work.reason ??= 'live'; headers.stop('Live production takes priority.'); }
          hasAudio = /Stream.*Audio:/.test(await headers.result);
          if (work.reason || protectedNow()) { work.reason ??= 'live'; return; }
        }
        args = exportArguments(recordings.download(original.id).path, partial, job.settings, job.options, hasAudio);
      }
      const process = runClipMedia(args, timeout, us => {
        if (!work.reason && job.status === 'exporting') job.progress = Math.max(job.progress, Math.min(.99, us / durationUs));
      });
      work.process = process;
      let checkingDisk = false;
      diskTimer = setInterval(() => {
        if (checkingDisk || work.reason) return;
        checkingDisk = true;
        void freeBytes().then(available => {
          if (available < 128 * 1024 * 1024) process.stop('Export stopped to preserve free disk space.');
        }).catch(() => process.stop('Export stopped because storage is unavailable.')).finally(() => { checkingDisk = false; });
      }, 2000);
      diskTimer.unref();
      // pauseForLive can be called at any await boundary, including just before
      // the child was attached. Recheck the latch immediately after spawning.
      if (protectedNow() || work.reason) { work.reason ??= 'live'; process.stop('Live production takes priority.'); }
      await process.result;
      if (work.reason) return;
      const probe = runClipMedia([
        '-hide_banner', '-nostdin', '-threads', '1', '-i', partial,
        ...(profile.video ? ['-map', '0:v:0', '-an', '-frames:v', '1'] : ['-map', '0:a:0', '-vn', '-t', '0.050']),
        '-threads', '1', '-f', 'null', '-',
      ], 15_000);
      work.process = probe;
      if (protectedNow() || work.reason) { work.reason ??= 'live'; probe.stop('Live production takes priority.'); }
      const diagnostics = await probe.result;
      if (work.reason) return;
      if (!clipExportMatches(diagnostics, job.settings.format, job.options, durationMs)) {
        throw new Error('The export did not pass its duration, codec and format checks.');
      }
      const info = await fs.stat(partial);
      if (info.size < 100 || info.size >= MAX_EXPORT_BYTES) throw new ClipError(422, 'This clip exceeded the 2 GB export limit. Choose a shorter section and export again.');
      if (job.temporary && temporaryBytes() + info.size > MAX_TEMP_EXPORT_BYTES) throw new ClipError(507, 'Temporary export storage is full. Save or clear a completed temporary export, then try again.');
      if (profile.video) {
        try {
          if (protectedNow() || work.reason) { work.reason ??= 'live'; return; }
          const poster = runClipMedia(['-hide_banner', '-nostdin', '-y', '-threads', '1', '-ss', String(Math.min(1, durationMs / 10000)), '-i', partial,
            '-map', '0:v:0', '-an', '-sn', '-dn', '-frames:v', '1', '-vf', 'scale=640:360:force_original_aspect_ratio=decrease,pad=640:360:(ow-iw)/2:(oh-ih)/2:color=black',
            '-filter_threads', '1', '-threads', '1', '-q:v', '3', '-c:v', 'mjpeg', '-update', '1', '-f', 'image2', posterPartial], 15_000);
          work.process = poster;
          if (protectedNow() || work.reason) { work.reason ??= 'live'; poster.stop('Live production takes priority.'); }
          await poster.result;
          if (protectedNow() || work.reason) { work.reason ??= 'live'; return; }
          renderedPoster = (await fs.stat(posterPartial)).size > 100;
        } catch (error) {
          if (work.reason) return;
          console.warn('[clips] Export poster unavailable:', job.id, (error as Error).message);
        }
      }
      // Cancellation and the durable completion boundary share the same lock.
      // If cancellation was accepted first, it cannot later become Complete.
      // If this commit wins first, cancellation sees an already finished job.
      await serial(async () => {
        if (work.reason || job.status === 'cancelled') return;
        await syncFile(partial);
        if (work.reason) return;
        const completed = artifactPath(job);
        await fs.rename(partial, completed);
        const previous = { status: job.status, progress: job.progress, bytes: job.bytes, completedAt: job.completedAt, error: job.error, expiresAt: job.expiresAt };
        const completedAt = new Date().toISOString();
        Object.assign(job, { status: 'complete', progress: 1, bytes: info.size, completedAt, error: undefined,
          ...(job.temporary ? { expiresAt: new Date(Date.parse(completedAt) + TEMP_EXPORT_TTL_MS).toISOString() } : {}) });
        try {
          if (renderedPoster) await fs.rename(posterPartial, exportPosterPath(job));
          await persist();
          if (renderedPoster) exportPosterReady.add(job.id);
          if (job.temporary) retainedTemporary.add(job.id);
        }
        catch (error) {
          Object.assign(job, previous);
          await fs.unlink(completed).catch(() => {});
          await fs.unlink(exportPosterPath(job)).catch(() => {});
          throw error;
        }
      });
    } catch (error) {
      if (!work.reason) {
        console.warn('[clips] Export failed:', job.id, (error as Error).message);
        const message = (error as Error).message;
        const visible = error instanceof ClipError || error instanceof TimelineError ? message
          : message === 'The media job exceeded its time limit.' ? 'This clip took too long to export. Try a shorter section. The original and draft are unchanged.'
          : message === 'Export stopped to preserve free disk space.' ? 'Export stopped because station storage is nearly full. Free some space and export the saved draft again.'
          : `${profile.container.toUpperCase()} export failed or exceeded the processing limit. The original and saved draft are unchanged.`;
        await finishJob(job, { status: 'error', error: visible });
      }
    } finally {
      if (diskTimer) clearInterval(diskTimer);
      await fs.unlink(partial).catch(() => {});
      await fs.unlink(posterPartial).catch(() => {});
      if (workDir) await fs.rm(workDir, { recursive: true, force: true }).catch(() => {});
      // A child may have finished just before startup requested the pause. A
      // fully committed file is already safe; do not requeue completed work.
      if (job.status !== 'complete') {
        if (work.reason === 'live') await finishJob(job, { status: 'waiting-live', progress: 0, error: undefined });
        if (work.reason === 'cancel') await finishJob(job, { status: 'cancelled', progress: 0, error: undefined });
        if (work.reason === 'shutdown') await finishJob(job, { status: 'interrupted', error: 'Station stopped before the export finished. Export the saved draft again.' });
      }
    }
  }

  async function processPoster(work: ActiveWork, id: string) {
    const target = posterPath(id), partial = `${target}.partial.jpg`;
    try {
      const original = recording(id);
      if (protectedNow() || work.reason) return;
      if (await freeBytes() < 256 * 1024 * 1024) throw new Error('Not enough free space for a thumbnail.');
      if (protectedNow() || work.reason) return;
      const source = recordings.download(id).path;
      const process = runClipMedia([
        '-hide_banner', '-nostdin', '-y', '-threads', '1',
        '-ss', String(Math.min(3, Math.max(0, original.durationMs / 1000 * .1))),
        '-i', source, '-map', '0:v:0', '-an', '-frames:v', '1',
        '-vf', 'scale=640:360:force_original_aspect_ratio=decrease,pad=640:360:(ow-iw)/2:(oh-ih)/2:color=black',
        '-filter_threads', '1', '-threads', '1', '-q:v', '3', '-update', '1', '-f', 'image2', partial,
      ], 30_000);
      work.process = process;
      if (protectedNow() || work.reason) { work.reason ??= 'live'; process.stop('Live production takes priority.'); }
      const stderr = await process.result;
      if (work.reason) return;
      const info = parseMediaInfo(stderr, original.durationMs);
      if (!info || (await fs.stat(partial)).size < 100) throw new Error('No usable video frame was found.');
      await syncFile(partial);
      await fs.rename(partial, target);
      await serial(async () => { data.media[id] = info; await persist(); });
      posterReady.add(id); posterFailures.delete(id);
    } catch (error) {
      if (!work.reason) {
        posterFailures.set(id, Date.now());
        console.warn('[clips] Thumbnail unavailable:', id, (error as Error).message);
      }
    } finally { await fs.unlink(partial).catch(() => {}); }
  }

  async function tick() {
    if (closed || ticking) return;
    ticking = true;
    try {
      const live = isLive();
      if (live) observedLive = true;
      if (liveHold && !live && (observedLive || Date.now() >= holdUntil)) { liveHold = false; observedLive = false; }
      if (protectedNow()) {
        if (active && !active.reason) { active.reason = 'live'; active.process?.stop('Live production takes priority.'); }
        const queued = data.exports.filter(job => job.status === 'queued');
        if (queued.length) await serial(async () => { queued.forEach(job => { if (job.status === 'queued') job.status = 'waiting-live'; }); await persist(); });
        return;
      }
      if (active) return;
      // One worker owns exports, timeline previews and passive posters. Never
      // start a second decoder alongside production or another editing job.
      const job = data.exports.find(value => value.status === 'queued' || value.status === 'waiting-live');
      const preview = job ? null : previews.nextJob();
      const pendingPoster = job || preview ? undefined : recordings.list().find(value => value.status === 'complete' && !posterReady.has(value.id) && Date.now() - (posterFailures.get(value.id) ?? 0) > 60_000);
      if (!job && !preview && !pendingPoster) return;
      const work: ActiveWork = { kind: job ? 'export' : preview ? 'preview' : 'poster', id: job?.id ?? preview?.key ?? pendingPoster!.id, process: null, reason: null, done: Promise.resolve() };
      active = work;
      work.done = (job ? processExport(work, job) : preview ? previews.process(preview, work) : processPoster(work, pendingPoster!.id))
        .catch(error => console.error('[clips] Could not save media job status:', (error as Error).message))
        .finally(() => {
          if (active === work) active = null;
          // Drain visible previews promptly rather than waiting a second per
          // filmstrip frame. The same protection and single-worker checks apply.
          queueMicrotask(() => { void tick().catch(() => {}); });
        });
    } finally { ticking = false; }
  }
  const timer = setInterval(() => { void tick().catch(error => console.warn('[clips] Worker unavailable:', (error as Error).message)); }, 1000);
  timer.unref();
  const expiryTimer = setInterval(() => { void cleanTemporaryExports().catch(error => console.warn('[clips] Temporary exports cleanup:', (error as Error).message)); }, 60_000);
  expiryTimer.unref();

  const router = Router();
  router.use('/clips', requireSession, (req, res, next) => {
    res.setHeader('Cache-Control', 'private, no-store');
    if (closed && !['GET', 'HEAD'].includes(req.method)) { res.status(503).json({ error: 'Clips is shutting down. Please retry shortly.' }); return; }
    next();
  });
  router.use(assets.router);
  router.get('/clips/timeline/:sourceKind/:sourceId/:type', asyncRoute(async (req, res) => {
    if (closed) throw new ClipError(503, 'Clips is shutting down. Please retry shortly.');
    const parsed = z.object({
      sourceKind: z.enum(['recording', 'asset']), sourceId: idSchema,
      type: z.enum(['frame', 'waveform']), atMs: z.string().regex(/^\d{1,8}$/).transform(Number).pipe(z.number().int().min(0).max(86_400_000)),
    }).safeParse({ ...req.params, atMs: req.query.atMs });
    if (!parsed.success) throw new ClipError(422, 'Choose a valid media source, preview type and time.');
    const { sourceKind, sourceId, type, atMs } = parsed.data;
    const result = await previews.request({ kind: sourceKind, id: sourceId }, type, atMs);
    res.setHeader('Cache-Control', 'private, no-store');
    if (result.status === 'ready') {
      res.type(result.mime).sendFile(result.path, error => { if (error && !res.headersSent) res.status(404).json({ error: 'This cached preview is unavailable. Please retry.' }); });
    } else {
      res.status(result.status === 'unavailable' ? 200 : 202).json(result);
      if (result.status !== 'unavailable') void tick().catch(() => {});
    }
  }));
  router.get('/clips', asyncRoute(async (req, res) => {
    const user = userFor(req);
    const liveProtected = protectedNow();
    const workspace: ClipWorkspace = {
      recordings: recordings.list().map(value => ({
        ...value, ...(data.media[value.id] ? { ...data.media[value.id] } : {}), posterReady: posterReady.has(value.id),
      })),
      drafts: data.drafts.map(value => draftFor(value, user)).sort((a, b) => b.updatedAt.localeCompare(a.updatedAt)),
      exports: data.exports.map(value => exportFor(value, user)).sort((a, b) => b.createdAt.localeCompare(a.createdAt)),
      assets: assets.list(),
      liveProtected, blockReason: liveProtected ? 'Live production is protected. Exports and thumbnail processing resume when the engine and recording have stopped.' : null,
    };
    res.setHeader('Cache-Control', 'no-store'); res.json(workspace);
    void tick().catch(() => {});
  }));
  router.post('/clips/drafts', asyncRoute(async (req, res) => {
    const user = userFor(req);
    const parsed = z.object({ recordingId: idSchema, ...inputObject.shape }).strict().safeParse(req.body);
    if (!parsed.success) throw new ClipError(422, 'Choose a recording and valid clip settings.');
    const { recordingId, ...fields } = parsed.data;
    const value = input(fields);
    const draft = await serial(async () => {
      if (closed) throw new ClipError(503, 'Clips is shutting down. Please retry shortly.');
      validateRecordingSettings(recordingId, value);
      if (data.drafts.length >= 10_000 || data.drafts.filter(d => d.ownerId === user.id).length >= 500) throw new ClipError(409, 'The saved draft limit has been reached.');
      const now = new Date().toISOString();
      const result: SavedDraft = { ...value, recordingId, id: `clip_${randomUUID()}`, revision: 0, ownerId: user.id, ownerName: user.displayName || user.username, createdAt: now, updatedAt: now };
      data.drafts.push(result);
      try { await persist(); } catch (error) { data.drafts.pop(); throw error; }
      return draftFor(result, user);
    });
    res.status(201).json(draft);
  }));
  router.put('/clips/drafts/:id', asyncRoute(async (req, res) => {
    const user = userFor(req);
    const parsed = z.object({ revision: z.number().int().nonnegative(), ...inputObject.shape }).strict().safeParse(req.body);
    if (!parsed.success) throw new ClipError(422, 'Provide valid clip settings and the current draft revision.');
    const { revision, ...fields } = parsed.data, value = input(fields);
    const saved = await serial(async () => {
      const draft = requireDraft(String(req.params.id)); checkOwner(draft.ownerId, user); checkRevision(draft.revision, revision);
      validateRecordingSettings(draft.recordingId, value);
      const next: SavedDraft = { ...draft, ...value, revision: draft.revision + 1, updatedAt: new Date().toISOString() };
      const index = data.drafts.indexOf(draft); data.drafts[index] = next;
      try { await persist(); } catch (error) { data.drafts[index] = draft; throw error; }
      return draftFor(next, user);
    });
    res.json(saved);
  }));
  router.post('/clips/drafts/:id/exports', asyncRoute(async (req, res) => {
    const user = userFor(req);
    const parsed = z.object({ revision: z.number().int().nonnegative(), options: clipExportOptionsSchema.optional(), temporary: z.boolean().optional() }).strict().safeParse(req.body);
    if (!parsed.success) throw new ClipError(422, 'Choose valid export options and provide the current draft revision.');
    const job = await serial(async () => {
      const draft = requireDraft(String(req.params.id)); checkOwner(draft.ownerId, user); checkRevision(draft.revision, parsed.data.revision);
      validateRecordingSettings(draft.recordingId, draft);
      if (data.exports.length >= 10_000 || data.exports.filter(unsettled).length >= 20 || data.exports.filter(value => unsettled(value) && value.ownerId === user.id).length >= 5) throw new ClipError(409, 'The export queue is full. Wait for an existing export to finish.');
      if (parsed.data.temporary && temporaryBytes() >= MAX_TEMP_EXPORT_BYTES) throw new ClipError(507, 'Temporary export storage is full. Save or clear a completed temporary export, then try again.');
      const result: SavedExport = {
        id: `export_${randomUUID()}`, draftId: draft.id, draftRevision: draft.revision,
        recordingId: draft.recordingId, name: draft.name, ownerId: user.id,
        status: protectedNow() ? 'waiting-live' : 'queued', progress: 0, bytes: 0,
        createdAt: new Date().toISOString(), settings: settingsOf(draft), options: normalizeClipExportOptions(parsed.data.options),
        ...(parsed.data.temporary ? { temporary: true } : {}),
      };
      data.exports.push(result);
      try { await persist(); } catch (error) { data.exports.pop(); throw error; }
      return exportFor(result, user);
    });
    res.status(202).json(job); void tick().catch(() => {});
  }));
  router.post('/clips/exports/:id/cancel', asyncRoute(async (req, res) => {
    const user = userFor(req), id = String(req.params.id);
    await serial(async () => {
      const job = requireExport(id); checkOwner(job.ownerId, user);
      if (!unsettled(job)) return;
      if (active?.kind === 'export' && active.id === id) { active.reason = 'cancel'; active.process?.stop('Export cancelled.'); }
      job.status = 'cancelled'; job.progress = 0; job.error = undefined;
      await persist();
    });
    const work = active?.kind === 'export' && active.id === id ? active : null;
    if (work) await work.done;
    res.json(exportFor(requireExport(id), user));
  }));
  router.post('/clips/exports/:id/release', asyncRoute(async (req, res) => {
    if (!z.object({}).strict().safeParse(req.body ?? {}).success) throw new ClipError(422, 'Release accepts no file paths or export changes.');
    const user = userFor(req);
    const job = await serial(async () => {
      const job = requireExport(String(req.params.id)); checkOwner(job.ownerId, user);
      if (!job.temporary) throw new ClipError(409, 'Permanent library exports cannot be released as temporary files.');
      if (job.status !== 'complete') throw new ClipError(409, 'Wait for this export to finish before confirming delivery.');
      if (!job.deliveredAt) {
        job.deliveredAt = new Date().toISOString();
        try { await persist(); } catch (error) { delete job.deliveredAt; throw error; }
      }
      await removeReleasedFiles(job).catch(error => console.warn('[clips] Delivered scratch cleanup will retry:', job.id, (error as Error).message));
      return job;
    });
    res.json(exportFor(job, user));
  }));
  router.get('/clips/recordings/:id/media', (req, res, next) => {
    try {
      const id = String(req.params.id); recording(id);
      res.type('video/webm'); res.setHeader('Cache-Control', 'private, max-age=3600');
      res.sendFile(path.resolve(recordings.download(id).path), error => { if (error && !res.headersSent) next(error); });
    } catch (error) { next(error); }
  });
  router.get('/clips/recordings/:id/thumbnail', (req, res, next) => {
    try {
      const id = String(req.params.id); recording(id);
      if (!posterReady.has(id)) throw new ClipError(404, 'The thumbnail will be prepared when live production is idle.');
      res.setHeader('Cache-Control', 'private, max-age=86400');
      res.type('image/jpeg').sendFile(path.resolve(posterPath(id)), error => { if (error && !res.headersSent) next(error); });
    } catch (error) { next(error); }
  });
  function checkExportDownload(job: SavedExport) {
    if (job.temporary && (unavailableExport(job) || job.expiresAt && Date.parse(job.expiresAt) <= Date.now())) {
      void cleanTemporaryExports().catch(() => {});
      throw new ClipError(410, job.deliveredAt ? 'This temporary export was delivered and removed from the station.' : 'This temporary export has expired. Export the saved project again.');
    }
    if (job.status !== 'complete') throw new ClipError(409, 'This export is not ready yet.');
  }
  function beginExportTransfer(job: SavedExport, res: Response) {
    downloads.set(job.id, (downloads.get(job.id) ?? 0) + 1);
    let ended = false;
    const done = () => {
      if (ended) return; ended = true;
      const count = (downloads.get(job.id) ?? 1) - 1;
      if (count > 0) downloads.set(job.id, count); else downloads.delete(job.id);
      if (!count) void serial(() => removeReleasedFiles(job)).catch(error => console.warn('[clips] Transfer cleanup will retry:', job.id, (error as Error).message));
    };
    res.once('finish', done); res.once('close', done);
    return done;
  }
  router.get('/clips/exports/:id/thumbnail', (req, res, next) => {
    try {
      const job = requireExport(String(req.params.id)); checkExportDownload(job);
      if (!exportPosterReady.has(job.id)) throw new ClipError(404, 'This export has no video thumbnail.');
      const done = beginExportTransfer(job, res);
      res.setHeader('Cache-Control', 'private, no-store');
      res.type('image/jpeg').sendFile(path.resolve(exportPosterPath(job)), error => { done(); if (error && !res.headersSent) next(error); });
    } catch (error) { next(error); }
  });
  router.get('/clips/exports/:id/download', (req, res, next) => {
    try {
      const job = requireExport(String(req.params.id)); checkExportDownload(job);
      const profile = clipExportProfile(job.options);
      const name = job.name.replace(/[^\p{L}\p{N} ._-]/gu, '_').slice(0, 120) || 'Lumen clip';
      const done = beginExportTransfer(job, res);
      res.setHeader('Cache-Control', 'private, no-store');
      res.type(profile.mime).download(path.resolve(artifactPath(job)), `${name}.${profile.extension}`, error => { done(); if (error && !res.headersSent) next(error); });
    } catch (error) { next(error); }
  });
  router.use((error: unknown, _req: Request, res: Response, _next: NextFunction) => {
    const sendError = error as NodeJS.ErrnoException & { status?: number; headers?: Record<string, string> };
    const known = error instanceof ClipError || error instanceof ClipAssetError || error instanceof TimelineError || error instanceof ClipPreviewError;
    const status = known ? error.status : error instanceof z.ZodError ? 422 : error instanceof multer.MulterError ? error.code === 'LIMIT_FILE_SIZE' ? 413 : 422 : sendError.status === 416 ? 416 : sendError.code === 'ENOENT' ? 404 : 500;
    if (status === 416 && sendError.headers?.['Content-Range']) res.setHeader('Content-Range', sendError.headers['Content-Range']);
    if (status === 500) console.error('[clips]', (error as Error).message);
    const message = known ? error.message : error instanceof z.ZodError ? error.issues[0]?.message : error instanceof multer.MulterError ? status === 413 ? 'Choose media smaller than 512 MB.' : 'Choose one supported media file and valid metadata.' : status === 416 ? 'The requested byte range is outside this recording.' : status === 404 ? 'The requested media is unavailable.' : 'Clips could not save this change. The original recording is unchanged.';
    res.status(status).json({ error: message });
  });

  async function pauseForLive() {
    // This latch is deliberately set before the first await. Engine startup
    // awaits the worker exit, not just a signal delivery or a polling cycle.
    liveHold = true; observedLive = isLive(); holdUntil = Date.now() + 15_000;
    const work = active;
    if (work && !work.reason) { work.reason = 'live'; work.process?.stop('Live production takes priority.'); }
    if (work) await work.done;
    // Once the child has exited, a disk-full Clips index must not stop the
    // live engine from starting. The in-memory latch still protects CPU work.
    await serial(async () => {
      data.exports.forEach(job => { if (job.status === 'queued') job.status = 'waiting-live'; });
      await persist();
    }).catch(error => console.warn('[clips] Live production protected; could not persist paused exports:', (error as Error).message));
  }
  async function close() {
    closed = true; clearInterval(timer); clearInterval(expiryTimer);
    const work = active;
    if (work) { work.reason = 'shutdown'; work.process?.stop('Station is shutting down.'); await work.done; }
    await previews.close();
    await serial(async () => {
      data.exports.forEach(job => {
        if (unsettled(job)) { job.status = 'interrupted'; job.error = 'Station stopped before the export finished. Export the saved draft again.'; }
      });
      await persist();
    });
    await assets.close();
  }
  return { router, pauseForLive, close };
}
