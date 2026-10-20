import type { ClipExport, ClipExportOptions } from '../../../shared/clips';

export const CLIP_DELIVERY_CHUNK_BYTES = 64 * 1024;
export interface ClipWritableFile {
  write(data: Uint8Array): Promise<void>;
  close(): Promise<void>;
  abort?(reason?: unknown): Promise<void>;
}
export interface ClipSaveHandle {
  readonly name: string;
  createWritable(options?: { keepExistingData?: boolean }): Promise<ClipWritableFile>;
  getFile(): Promise<File>;
  queryPermission?(options: { mode: 'readwrite' }): Promise<PermissionState>;
  requestPermission?(options: { mode: 'readwrite' }): Promise<PermissionState>;
}
export interface ClipPickerOptions {
  suggestedName: string;
  excludeAcceptAllOption: boolean;
  types: Array<{ description: string; accept: Record<string, string[]> }>;
}
export interface ClipPickerEnvironment {
  secureContext: boolean;
  showSaveFilePicker?: (options: ClipPickerOptions) => Promise<ClipSaveHandle>;
}
export type ClipDestination =
  | { kind: 'file'; name: string; handle: ClipSaveHandle; canRevealFolder: false }
  | { kind: 'download'; name: string; canRevealFolder: false };
export type ClipDeliveryPhase = 'permission' | 'download' | 'write' | 'close' | 'release';
export class ClipDeliveryError extends Error {
  constructor(message: string, public phase: ClipDeliveryPhase, public fileSaved = false, public bytesWritten = 0, options?: ErrorOptions) {
    super(message, options); this.name = 'ClipDeliveryError';
  }
}
const profiles: Record<ClipExportOptions['container'], { mime: string; description: string }> = {
  mp4: { mime: 'video/mp4', description: 'MP4 video' }, webm: { mime: 'video/webm', description: 'WebM video' },
  mov: { mime: 'video/quicktime', description: 'QuickTime video' }, mp3: { mime: 'audio/mpeg', description: 'MP3 audio' }, wav: { mime: 'audio/wav', description: 'WAV audio' },
};
export function clipDeliveryFilename(options: ClipExportOptions, name: string) {
  let base = name.replace(/[\u0000-\u001f\u007f/\\:*?"<>|]/g, '-').replace(/\.(?:mp4|webm|mov|mp3|wav)$/i, '').replace(/[. ]+$/g, '').trim().slice(0, 140) || 'Lumen export';
  if (/^(?:con|prn|aux|nul|com[1-9]|lpt[1-9])$/i.test(base)) base = `_${base}`;
  return `${base}.${options.container}`;
}
export function clipPickerEnvironment(): ClipPickerEnvironment {
  if (typeof window === 'undefined') return { secureContext: false };
  const browser = window as unknown as { isSecureContext: boolean; showSaveFilePicker?: (options: ClipPickerOptions) => Promise<ClipSaveHandle> };
  return { secureContext: browser.isSecureContext, ...(browser.showSaveFilePicker ? { showSaveFilePicker: browser.showSaveFilePicker.bind(window) } : {}) };
}
export function supportsClipSavePicker(environment = clipPickerEnvironment()) { return environment.secureContext && typeof environment.showSaveFilePicker === 'function'; }
export function destinationLabel(destination: ClipDestination) { return destination.kind === 'file' ? destination.name : 'Browser Downloads'; }

/** Invoke directly from a click handler, BEFORE any save/export await. */
export function chooseClipDestination(options: ClipExportOptions, name: string, environment = clipPickerEnvironment()): Promise<ClipDestination | null> {
  const suggestedName = clipDeliveryFilename(options, name);
  if (!supportsClipSavePicker(environment)) return Promise.resolve({ kind: 'download', name: suggestedName, canRevealFolder: false });
  const profile = profiles[options.container];
  // Do not move this call into a continuation: browsers require user activation.
  let request: Promise<ClipSaveHandle>;
  try { request = environment.showSaveFilePicker!({ suggestedName, excludeAcceptAllOption: true, types: [{ description: profile.description, accept: { [profile.mime]: [`.${options.container}`] } }] }); }
  catch (cause) { if ((cause as Error)?.name === 'AbortError') return Promise.resolve(null); return Promise.reject(new ClipDeliveryError('The save location could not be opened. Choose another location or use browser Downloads.', 'permission', false, 0, { cause })); }
  return request.then(handle => ({ kind: 'file' as const, name: handle.name, handle, canRevealFolder: false as const })).catch(cause => {
    if ((cause as Error)?.name === 'AbortError') return null;
    throw new ClipDeliveryError('Lumen could not use that save location. Choose another location or use browser Downloads.', 'permission', false, 0, { cause });
  });
}
export async function requestClipDestinationPermission(destination: ClipDestination) {
  if (destination.kind !== 'file' || !destination.handle.queryPermission) return true;
  if (await destination.handle.queryPermission({ mode: 'readwrite' }) === 'granted') return true;
  return destination.handle.requestPermission ? await destination.handle.requestPermission({ mode: 'readwrite' }) === 'granted' : false;
}
export interface ClipSaveProgress { written: number; total: number; fraction: number | null }
export interface ClipStreamOptions {
  signal?: AbortSignal;
  fetcher?: typeof fetch;
  onProgress?: (value: ClipSaveProgress) => void;
  acknowledge?: (signal: AbortSignal) => Promise<unknown>;
  /** Injectable short limits make stalled-transfer safeguards testable. */
  timeoutMs?: number;
  stallTimeoutMs?: number;
}
function throwIfAborted(signal?: AbortSignal) { if (signal?.aborted) throw new DOMException('Saving was stopped.', 'AbortError'); }
function abortable<T>(operation: Promise<T>, signal: AbortSignal): Promise<T> {
  return new Promise((resolve, reject) => {
    const abort = () => reject(signal.reason ?? new DOMException('Saving was stopped.', 'AbortError'));
    if (signal.aborted) { operation.catch(() => {}); abort(); return; }
    signal.addEventListener('abort', abort, { once: true });
    operation.then(value => { signal.removeEventListener('abort', abort); resolve(value); }, error => { signal.removeEventListener('abort', abort); reject(error); });
  });
}
function phaseMessage(phase: ClipDeliveryPhase, cause: unknown) {
  if (phase === 'release') return 'The file was saved, but the station could not confirm cleanup of its temporary copy. Retry cleanup when connected.';
  if ((cause as Error)?.name === 'TimeoutError') return 'Saving stopped because the transfer or disk did not respond in time. The temporary export is still available to retry.';
  if ((cause as Error)?.name === 'AbortError') return 'Saving was stopped. The temporary export is still available.';
  if (phase === 'permission') return 'Permission to save this file was not available. Choose a location and try again.';
  if (phase === 'download') return 'The export could not be transferred from this station. Your temporary file is still available to retry.';
  if (phase === 'close' || phase === 'write') return 'The file could not be fully saved. Check the disk and permissions, or choose another location.';
  return 'The file could not be saved. Choose a location and try again.';
}

/** Streams without buffering the full export; success means close() completed. */
export async function saveClipExport(job: Pick<ClipExport, 'id' | 'bytes'>, destination: ClipDestination, options: ClipStreamOptions = {}) {
  if (destination.kind !== 'file') throw new ClipDeliveryError('Browser Downloads cannot confirm that a file reached your disk.', 'permission');
  let phase: ClipDeliveryPhase = 'permission', writer: ClipWritableFile | undefined, reader: ReadableStreamDefaultReader<Uint8Array> | undefined, written = 0, closed = false, aborting: Promise<void> | undefined;
  const controller = new AbortController(), signal = controller.signal;
  const forwardAbort = () => controller.abort(options.signal?.reason ?? new DOMException('Saving was stopped.', 'AbortError'));
  if (options.signal?.aborted) forwardAbort(); else options.signal?.addEventListener('abort', forwardAbort, { once: true });
  const timeout = () => controller.abort(new DOMException('The export save did not complete in time.', 'TimeoutError'));
  const deadline = setTimeout(timeout, Math.max(1, options.timeoutMs ?? 30 * 60 * 1000));
  let stall: ReturnType<typeof setTimeout> | undefined, lastProgress = 0;
  const touch = () => { if (stall) clearTimeout(stall); stall = setTimeout(timeout, Math.max(1, options.stallTimeoutMs ?? 30000)); };
  const abortWriter = (reason: unknown) => aborting ??= writer?.abort?.(reason).catch(() => {}) ?? Promise.resolve();
  const abort = () => { void reader?.cancel().catch(() => {}); if (!closed) void abortWriter(signal.reason); };
  const notify = (total: number) => { const now = Date.now(); if (written && written !== total && now - lastProgress < 100) return; lastProgress = now; try { options.onProgress?.({ written, total, fraction: total > 0 ? Math.min(1, written / total) : null }); } catch { /* Observers cannot interrupt a file write. */ } };
  try {
    throwIfAborted(signal); touch();
    const output = await abortable(destination.handle.createWritable({ keepExistingData: false }).then(value => { if (signal.aborted) { void value.abort?.(signal.reason).catch(() => {}); throw signal.reason; } return value; }), signal);
    writer = output;
    signal.addEventListener('abort', abort, { once: true });
    phase = 'download'; throwIfAborted(signal); touch();
    const response = await abortable((options.fetcher ?? fetch)(`/api/clips/exports/${encodeURIComponent(job.id)}/download`, { credentials: 'include', signal }), signal);
    if (!response.ok) throw new Error(`The station returned ${response.status}.`);
    if (!response.body) throw new Error('This browser could not stream the export.');
    const headerBytes = Number(response.headers.get('content-length') ?? 0), expected = job.bytes > 0 ? job.bytes : headerBytes > 0 ? headerBytes : 0;
    if (job.bytes > 0 && headerBytes > 0 && headerBytes !== job.bytes) throw new Error('The export size changed before saving.');
    reader = response.body.getReader(); notify(expected);
    for (;;) {
      phase = 'download'; throwIfAborted(signal); touch();
      const next = await abortable(reader.read(), signal); if (next.done) break;
      phase = 'write';
      for (let offset = 0; offset < next.value.byteLength; offset += CLIP_DELIVERY_CHUNK_BYTES) {
        throwIfAborted(signal); touch();
        const chunk = next.value.subarray(offset, Math.min(next.value.byteLength, offset + CLIP_DELIVERY_CHUNK_BYTES));
        await abortable(output.write(chunk), signal); written += chunk.byteLength;
        if (expected && written > expected) throw new Error('The export exceeded its expected size.');
        notify(expected);
      }
    }
    if (!written || expected && written !== expected) throw new Error('The export transfer ended before the file was complete.');
    phase = 'close'; throwIfAborted(signal); touch(); await abortable(output.close(), signal); closed = true;
    phase = 'release'; throwIfAborted(signal); touch();
    if (options.acknowledge) await abortable(options.acknowledge(signal), signal);
    return { bytesWritten: written, name: destination.name, acknowledged: !!options.acknowledge };
  } catch (cause) {
    if (!closed) void abortWriter(cause);
    throw new ClipDeliveryError(phaseMessage(phase, cause), phase, closed, written, { cause });
  } finally {
    clearTimeout(deadline); if (stall) clearTimeout(stall);
    signal.removeEventListener('abort', abort); options.signal?.removeEventListener('abort', forwardAbort);
    if (reader) { void reader.cancel().catch(() => {}); try { reader.releaseLock(); } catch { /* A stalled reader will release when its cancelled read settles. */ } }
  }
}

/** A download request is NOT proof that the browser saved it. Never release. */
export function requestClipBrowserDownload(jobId: string, filename: string, documentRef: Document = document) {
  const link = documentRef.createElement('a'); link.href = `/api/clips/exports/${encodeURIComponent(jobId)}/download`; link.download = filename; link.rel = 'noopener'; link.hidden = true;
  documentRef.body.appendChild(link); link.click(); link.remove();
}
export async function openSavedClip(destination: ClipDestination) {
  if (destination.kind !== 'file') throw new Error('Open the file from your browser Downloads. Lumen cannot inspect that folder.');
  const target = window.open('about:blank', '_blank');
  if (!target) throw new Error('Your browser blocked the file preview. Allow popups, or open the file in its saved location.');
  target.opener = null;
  try { const file = await destination.handle.getFile(), url = URL.createObjectURL(file); target.location.href = url; setTimeout(() => URL.revokeObjectURL(url), 10 * 60 * 1000); }
  catch (error) { target.close(); throw error; }
}
