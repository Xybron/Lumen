import type { ClipSourceRef, ClipTimelineItem } from '../../../shared/clips';
import { clipsApi } from './clips';

export type TimelinePreviewKind = 'frame' | 'waveform';
export type TimelinePreviewState = 'loading' | 'queued' | 'processing' | 'waiting-live' | 'ready' | 'unavailable';
export interface TimelinePreviewResult { state: TimelinePreviewState; url?: string; reason?: string }
export interface TimelinePreviewLease extends TimelinePreviewResult { release: () => void }
export interface VisibleMediaWindow { leftPx: number; widthPx: number; localStartMs: number; localEndMs: number }
export interface FrameTile { leftPx: number; widthPx: number; atMs: number }
export interface WaveformTile { leftPx: number; widthPx: number; atMs: number }
export const FRAME_QUANTUM_MS = 100;
export const WAVEFORM_CHUNK_MS = 30_000;
export const MAX_FRAME_TILES = 36;
export const MAX_WAVEFORM_TILES = 64;
export const MAX_PREVIEW_ENTRIES = 256;
export const MAX_PREVIEW_BYTES = 24 * 1024 * 1024;
const MAX_VIEWPORT_PX = 4096, OVERSCAN_PX = 128, MAX_FETCHES = 2, MAX_IMAGE_BYTES = 2 * 1024 * 1024;
const bounded = (value: number, min: number, max: number) => Math.max(min, Math.min(max, value));

/** Every position is relative to the clip, never to its (possibly huge) sheet. */
export function visibleMediaWindow(item: Pick<ClipTimelineItem, 'startMs' | 'durationMs'>, pixelsPerMs: number, viewportStart: number, viewportWidth: number): VisibleMediaWindow | null {
  if (!Number.isFinite(pixelsPerMs) || pixelsPerMs <= 0 || !Number.isFinite(viewportStart) || !Number.isFinite(viewportWidth) || viewportWidth <= 0 || item.durationMs <= 0) return null;
  const clipStart = item.startMs * pixelsPerMs, clipWidth = item.durationMs * pixelsPerMs, width = Math.min(MAX_VIEWPORT_PX, viewportWidth);
  if (clipStart + clipWidth <= viewportStart || clipStart >= viewportStart + width) return null;
  const leftPx = Math.max(0, viewportStart - clipStart - OVERSCAN_PX), rightPx = Math.min(clipWidth, viewportStart - clipStart + width + OVERSCAN_PX);
  if (rightPx <= leftPx) return null;
  return { leftPx, widthPx: rightPx - leftPx, localStartMs: leftPx / pixelsPerMs, localEndMs: rightPx / pixelsPerMs };
}
export function frameTiles(item: Pick<ClipTimelineItem, 'durationMs' | 'inMs'>, pixelsPerMs: number, window: VisibleMediaWindow): FrameTile[] {
  // Normal monitors use 72px cells. Wider viewports increase tile width instead
  // of generating hundreds of images or allocating a whole-timeline canvas.
  const tileWidth = Math.max(72, Math.ceil(window.widthPx / (MAX_FRAME_TILES - 2))), first = Math.floor(window.leftPx / tileWidth), last = Math.ceil((window.leftPx + window.widthPx) / tileWidth);
  const clipWidth = item.durationMs * pixelsPerMs, result: FrameTile[] = [];
  const firstFrame = Math.ceil(item.inMs / FRAME_QUANTUM_MS) * FRAME_QUANTUM_MS, lastFrame = Math.floor((item.inMs + item.durationMs - 1) / FRAME_QUANTUM_MS) * FRAME_QUANTUM_MS;
  for (let index = first; index < last && result.length < MAX_FRAME_TILES; index++) {
    const leftPx = index * tileWidth, widthPx = Math.min(tileWidth, clipWidth - leftPx);
    const localMs = Math.min(item.durationMs - 1, (leftPx + widthPx / 2) / pixelsPerMs);
    if (widthPx > 0) result.push({ leftPx, widthPx, atMs: bounded(Math.floor(Math.max(0, item.inMs + localMs) / FRAME_QUANTUM_MS) * FRAME_QUANTUM_MS, firstFrame, Math.max(firstFrame, lastFrame)) });
  }
  return result;
}
export function waveformTiles(item: Pick<ClipTimelineItem, 'inMs'>, pixelsPerMs: number, window: VisibleMediaWindow): { tiles: WaveformTile[]; limited: boolean } {
  const start = Math.floor((item.inMs + window.localStartMs) / WAVEFORM_CHUNK_MS), last = Math.floor(Math.max(item.inMs + window.localStartMs, item.inMs + window.localEndMs - .001) / WAVEFORM_CHUNK_MS), tiles: WaveformTile[] = [];
  for (let chunk = start; chunk <= last && tiles.length < MAX_WAVEFORM_TILES; chunk++) {
    const atMs = chunk * WAVEFORM_CHUNK_MS;
    tiles.push({ atMs, leftPx: (atMs - item.inMs) * pixelsPerMs, widthPx: WAVEFORM_CHUNK_MS * pixelsPerMs });
  }
  return { tiles, limited: last - start + 1 > MAX_WAVEFORM_TILES };
}
export function timelinePreviewKey(source: ClipSourceRef, kind: TimelinePreviewKind, atMs: number) {
  const quantum = kind === 'frame' ? FRAME_QUANTUM_MS : WAVEFORM_CHUNK_MS;
  return `${source.kind}:${source.id}:${kind}:${Math.floor(Math.max(0, atMs) / quantum) * quantum}`;
}

interface CacheEntry {
  key: string; source: ClipSourceRef; kind: TimelinePreviewKind; atMs: number;
  state: TimelinePreviewState; reason?: string; url?: string; bytes: number; refs: number; touched: number; settledAt: number;
  controller: AbortController; listeners: Set<(value: TimelinePreviewResult) => void>; promise?: Promise<TimelinePreviewResult>;
}
interface FetchJob { signal: AbortSignal; run: () => Promise<Response>; resolve: (response: Response) => void; reject: (error: unknown) => void; cancel: () => void }
const entries = new Map<string, CacheEntry>(), queue: FetchJob[] = [], refreshListeners = new Set<() => void>();
let activeFetches = 0, bytes = 0, session = '';
function abortError() { return new DOMException('Timeline preview request cancelled.', 'AbortError'); }
function result(entry: CacheEntry): TimelinePreviewResult { return { state: entry.state, ...(entry.url ? { url: entry.url } : {}), ...(entry.reason ? { reason: entry.reason } : {}) }; }
function publish(entry: CacheEntry, state: TimelinePreviewState, reason?: string) { entry.state = state; entry.reason = reason; const value = result(entry); for (const listener of entry.listeners) listener(value); }
function remove(entry: CacheEntry) {
  if (entries.get(entry.key) === entry) entries.delete(entry.key);
  entry.controller.abort(); if (entry.url) { URL.revokeObjectURL(entry.url); bytes -= entry.bytes; entry.url = undefined; entry.bytes = 0; }
}
function evict(requiredBytes = 0, reserveEntry = false) {
  const available = [...entries.values()].filter(entry => !entry.refs).sort((a, b) => a.touched - b.touched);
  while ((entries.size + Number(reserveEntry) > MAX_PREVIEW_ENTRIES || bytes + requiredBytes > MAX_PREVIEW_BYTES) && available.length) remove(available.shift()!);
  return entries.size + Number(reserveEntry) <= MAX_PREVIEW_ENTRIES && bytes + requiredBytes <= MAX_PREVIEW_BYTES;
}
function pump() {
  while (activeFetches < MAX_FETCHES && queue.length) {
    const job = queue.shift()!; job.signal.removeEventListener('abort', job.cancel);
    if (job.signal.aborted) { job.reject(abortError()); continue; }
    activeFetches++;
    void job.run().then(job.resolve, job.reject).finally(() => { activeFetches--; pump(); });
  }
}
function fetchQueued(url: string, signal: AbortSignal) {
  return new Promise<Response>((resolve, reject) => {
    if (signal.aborted) { reject(abortError()); return; }
    const job: FetchJob = { signal, run: async () => {
      const controller = new AbortController(), cancel = () => controller.abort(), timeout = setTimeout(() => controller.abort(new DOMException('Timeline preview request timed out.', 'TimeoutError')), 15_000);
      signal.addEventListener('abort', cancel, { once: true });
      try {
        const response = await fetch(url, { credentials: 'include', signal: controller.signal, headers: { Accept: 'image/jpeg, image/png, application/json' } });
        if (!response.body) return response;
        // Hold the concurrency slot until the bounded body has arrived, not
        // merely until headers arrive. Even a bad media response stays finite.
        const reader = response.body.getReader(), parts: Uint8Array[] = []; let length = 0;
        for (;;) { const part = await reader.read(); if (part.done) break; length += part.value.byteLength; if (length > MAX_IMAGE_BYTES) { await reader.cancel(); throw new Error('oversized-preview'); } parts.push(part.value); }
        const body = new Uint8Array(length); let offset = 0; for (const part of parts) { body.set(part, offset); offset += part.byteLength; }
        return new Response(length ? body : null, { status: response.status, statusText: response.statusText, headers: response.headers });
      } finally { clearTimeout(timeout); signal.removeEventListener('abort', cancel); }
    }, resolve, reject, cancel: () => { const index = queue.indexOf(job); if (index >= 0) queue.splice(index, 1); reject(abortError()); } };
    signal.addEventListener('abort', job.cancel, { once: true }); queue.push(job); pump();
  });
}
function delay(ms: number, signal: AbortSignal) {
  return new Promise<void>((resolve, reject) => {
    if (signal.aborted) { reject(abortError()); return; }
    const finish = () => { signal.removeEventListener('abort', cancel); resolve(); }, timer = setTimeout(finish, ms), cancel = () => { clearTimeout(timer); signal.removeEventListener('abort', cancel); reject(abortError()); };
    signal.addEventListener('abort', cancel, { once: true });
  });
}
async function load(entry: CacheEntry): Promise<TimelinePreviewResult> {
  const signal = entry.controller.signal, started = Date.now();
  const deadline = setTimeout(() => entry.controller.abort(new DOMException('Timeline preview generation timed out.', 'TimeoutError')), 90_000);
  try {
    for (let attempt = 0; attempt < 12 && Date.now() - started < 90_000; attempt++) {
      if (signal.aborted) throw abortError();
      const response = await fetchQueued(clipsApi.timelinePreview(entry.source, entry.kind, entry.atMs), signal);
      if (signal.aborted) throw abortError();
      const type = response.headers.get('content-type') ?? '';
      if (response.ok && /^image\/(jpeg|png)(?:;|$)/i.test(type)) {
        const claimed = Number(response.headers.get('content-length') ?? 0); if (claimed > MAX_IMAGE_BYTES) throw new Error('oversized-preview');
        const blob = await response.blob(); if (signal.aborted) throw abortError();
        if (!blob.size || blob.size > MAX_IMAGE_BYTES) throw new Error('invalid-preview');
        if (!evict(blob.size)) { publish(entry, 'unavailable', 'memory-limit'); return result(entry); }
        entry.url = URL.createObjectURL(blob); entry.bytes = blob.size; bytes += blob.size; publish(entry, 'ready'); return result(entry);
      }
      if (response.status === 401 || response.status === 403) { publish(entry, 'unavailable', 'authentication'); return result(entry); }
      const data = await response.json().catch(() => ({})) as { status?: string; reason?: string; retryAfterMs?: number };
      if (response.status === 429 || response.status === 503) {
        publish(entry, 'queued', 'worker-busy');
        const hint = Number.isFinite(data.retryAfterMs) ? Number(data.retryAfterMs) : 1000;
        await delay(bounded(Math.max(hint, 500 * 2 ** Math.min(attempt, 4)), 300, 10_000), signal); continue;
      }
      if (!response.ok || data.status === 'unavailable') { publish(entry, 'unavailable', typeof data.reason === 'string' ? data.reason.slice(0, 80) : 'media-unavailable'); return result(entry); }
      const state = ['queued', 'processing', 'waiting-live'].includes(data.status ?? '') ? data.status as 'queued' | 'processing' | 'waiting-live' : 'queued';
      publish(entry, state);
      // A live hold can last hours. Stop polling, and let the workspace's idle
      // transition (or an explicit refresh) restart these bounded requests.
      if (state === 'waiting-live') return result(entry);
      const hint = Number.isFinite(data.retryAfterMs) ? Number(data.retryAfterMs) : 500;
      await delay(bounded(Math.max(hint, 500 * 2 ** Math.min(attempt, 4)), 300, 10_000), signal);
    }
    publish(entry, 'unavailable', 'timeout'); return result(entry);
  } catch (error) {
    if (signal.aborted) { if ((signal.reason as Error)?.name === 'TimeoutError') { publish(entry, 'unavailable', 'timeout'); return result(entry); } throw abortError(); }
    publish(entry, 'unavailable', (error as Error).message === 'oversized-preview' ? 'preview-size-limit' : 'connection'); return result(entry);
  } finally { clearTimeout(deadline); entry.settledAt = Date.now(); }
}

/** The lease pins a small Blob URL; release/abort it when its tile leaves view. */
export function acquireTimelinePreview(source: ClipSourceRef, kind: TimelinePreviewKind, atMs: number, signal: AbortSignal, onState?: (value: TimelinePreviewResult) => void): Promise<TimelinePreviewLease> {
  if (signal.aborted) return Promise.reject(abortError());
  const key = timelinePreviewKey(source, kind, atMs); let entry = entries.get(key);
  if (entry && !entry.refs && entry.state !== 'ready' && entry.settledAt && Date.now() - entry.settledAt > 10_000) { remove(entry); entry = undefined; }
  if (!entry) {
    if (!evict(0, true)) return Promise.resolve({ state: 'unavailable', reason: 'memory-limit', release: () => {} });
    const quantum = kind === 'frame' ? FRAME_QUANTUM_MS : WAVEFORM_CHUNK_MS;
    entry = { key, source: { ...source }, kind, atMs: Math.floor(Math.max(0, atMs) / quantum) * quantum, state: 'loading', bytes: 0, refs: 0, touched: Date.now(), settledAt: 0, controller: new AbortController(), listeners: new Set() }; entries.set(key, entry);
  }
  const current = entry; current.refs++; current.touched = Date.now(); if (onState) current.listeners.add(onState);
  let released = false;
  const release = () => { if (released) return; released = true; signal.removeEventListener('abort', cancel); if (onState) current.listeners.delete(onState); current.refs = Math.max(0, current.refs - 1); current.touched = Date.now(); if (!current.refs && !current.settledAt && current.state !== 'ready') remove(current); evict(); };
  let rejectAbort: (error: unknown) => void = () => {};
  const cancel = () => { release(); rejectAbort(abortError()); };
  const aborted = new Promise<TimelinePreviewLease>((_resolve, reject) => { rejectAbort = reject; });
  signal.addEventListener('abort', cancel, { once: true });
  onState?.(result(current));
  if (signal.aborted) { cancel(); return aborted; }
  current.promise ??= load(current);
  // A shared request survives one disappearing consumer, but never all of them.
  const operation = current.promise.then(value => ({ ...value, release }));
  return Promise.race([operation, aborted]).catch(error => { release(); throw error; });
}
export function setTimelinePreviewSession(identity: string | null) {
  const next = identity ?? ''; if (session === next) return; session = next;
  for (const entry of [...entries.values()]) remove(entry);
}
/** Call on live→idle and from the workspace Refresh action. Ready media stays. */
export function refreshTimelinePreviews() {
  for (const entry of [...entries.values()]) if (entry.state !== 'ready' && entry.reason !== 'no-audio') remove(entry);
  for (const listener of refreshListeners) listener();
}
export function onTimelinePreviewRefresh(listener: () => void) { refreshListeners.add(listener); return () => refreshListeners.delete(listener); }
export function timelinePreviewCacheStats() { return { entries: entries.size, bytes, activeFetches, queuedFetches: queue.length }; }
