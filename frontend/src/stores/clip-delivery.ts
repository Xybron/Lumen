import { computed, onScopeDispose, ref, watch } from 'vue';
import { defineStore } from 'pinia';
import type { ClipExport, ClipWorkspace } from '../../../shared/clips';
import { useIdentityStore } from '@/stores/identity';
import { clipsApi } from '@/lib/clips';
import { exportOptions } from '@/lib/clip-export';
import { chooseClipDestination, clipDeliveryFilename, ClipDeliveryError, destinationLabel, openSavedClip, requestClipBrowserDownload, requestClipDestinationPermission, saveClipExport, type ClipDestination } from '@/lib/clip-delivery';

type DeliveryJob = ClipExport & { temporary?: boolean; expiresAt?: string; deliveredAt?: string; expiredAt?: string; posterReady?: boolean };
export type ClipDeliveryState = 'queued' | 'waiting-live' | 'rendering' | 'ready' | 'saving' | 'saved' | 'download-requested' | 'error' | 'cancelled' | 'expired' | 'delivered';
export interface ClipDeliveryEntry {
  id: string;
  job: DeliveryJob;
  state: ClipDeliveryState;
  progress: number;
  written: number;
  filename: string;
  destination: string;
  thumbnail?: string;
  message?: string;
  cleanupPending: boolean;
  fileSaved: boolean;
  busy: boolean;
}
const running = (state: ClipDeliveryState) => ['queued', 'waiting-live', 'rendering', 'saving'].includes(state);
const terminal = (state: ClipDeliveryState) => ['saved', 'delivered', 'expired', 'cancelled'].includes(state);

export const useClipDeliveryStore = defineStore('clip-delivery', () => {
  const identity = useIdentityStore(), entries = ref<ClipDeliveryEntry[]>([]), collapsed = ref(false);
  // Browser handles are private, non-serializable capabilities. Never put them
  // into a job, localStorage, an API payload, or another user's session.
  const destinations = new Map<string, ClipDestination>(), controllers = new Map<string, AbortController>(), dismissed = new Set<string>();
  let timer: ReturnType<typeof setTimeout> | undefined, polling: AbortController | undefined, session = 0;
  const activeCount = computed(() => entries.value.filter(entry => running(entry.state)).length);
  const entryFor = (id: string) => entries.value.find(entry => entry.id === id);
  const ownerId = () => identity.ready && identity.isAuthenticated ? identity.me?.id : undefined;
  const isCurrent = (entry: ClipDeliveryEntry, token: number) => token === session && entry.job.ownerId === ownerId() && entryFor(entry.id) === entry;
  function clearTimer() { if (timer) clearTimeout(timer); timer = undefined; }
  function revoke(entry: ClipDeliveryEntry) { if (entry.thumbnail?.startsWith('blob:')) URL.revokeObjectURL(entry.thumbnail); }
  function pruneReceipts() {
    const receipts = entries.value.filter(entry => terminal(entry.state) && !entry.busy);
    for (const old of receipts.slice(0, Math.max(0, receipts.length - 8))) { dismissed.add(old.id); destinations.delete(old.id); revoke(old); entries.value = entries.value.filter(entry => entry.id !== old.id); }
  }
  function reset() {
    session++; clearTimer(); polling?.abort(); polling = undefined;
    for (const controller of controllers.values()) controller.abort(); controllers.clear(); destinations.clear();
    for (const entry of entries.value) revoke(entry); entries.value = []; dismissed.clear(); collapsed.value = false;
  }
  function schedule() {
    clearTimer();
    if (!ownerId() || typeof document !== 'undefined' && document.hidden) return;
    timer = setTimeout(() => { void resumeMetadata(); }, activeCount.value ? 1500 : 12000);
  }
  function stateOf(job: DeliveryJob): ClipDeliveryState {
    if (job.expiredAt) return 'expired';
    if (job.deliveredAt) return 'delivered';
    if (job.status === 'complete') return 'ready';
    if (job.status === 'exporting') return 'rendering';
    if (job.status === 'error' || job.status === 'interrupted') return 'error';
    if (job.status === 'cancelled') return 'cancelled';
    return job.status === 'waiting-live' ? 'waiting-live' : 'queued';
  }
  function add(job: DeliveryJob) {
    const entry: ClipDeliveryEntry = { id: job.id, job, state: stateOf(job), progress: Math.max(0, Math.min(1, job.progress)), written: 0, filename: clipDeliveryFilename(exportOptions(job), job.name), destination: 'Choose a save location', cleanupPending: false, fileSaved: false, busy: false };
    entries.value = [...entries.value, entry];
    // Return the reactive entry so async updates and identity guards refer to
    // the same object exposed to the overlay.
    return entryFor(job.id)!;
  }
  async function release(entry: ClipDeliveryEntry, signal?: AbortSignal) {
    if (!entry.job.temporary) return;
    const controller = new AbortController(), cancel = () => controller.abort(), timeout = setTimeout(cancel, 15000);
    signal?.addEventListener('abort', cancel, { once: true }); if (signal?.aborted) cancel();
    try {
      const response = await fetch(`/api/clips/exports/${encodeURIComponent(entry.id)}/release`, { method: 'POST', credentials: 'include', signal: controller.signal, headers: { 'Content-Type': 'application/json' }, body: '{}' });
      if (!response.ok) throw new Error('The station could not confirm temporary-file cleanup.');
      const updated = await response.json() as DeliveryJob;
      if (entry.job.ownerId === ownerId()) entry.job = updated;
    } finally { clearTimeout(timeout); signal?.removeEventListener('abort', cancel); }
  }
  async function thumbnail(entry: ClipDeliveryEntry, signal: AbortSignal) {
    if (entry.thumbnail || entry.job.expiredAt || entry.job.deliveredAt) return;
    const controller = new AbortController(), cancel = () => controller.abort(), timeout = setTimeout(cancel, 15000);
    signal.addEventListener('abort', cancel, { once: true }); if (signal.aborted) cancel();
    try {
      const response = await fetch(`/api/clips/exports/${encodeURIComponent(entry.id)}/thumbnail`, { credentials: 'include', signal: controller.signal });
      if (!response.ok || !/^image\//.test(response.headers.get('content-type') ?? '') || !response.body) return;
      const reader = response.body.getReader(), chunks: Uint8Array[] = []; let bytes = 0;
      try {
        for (;;) { const next = await reader.read(); if (next.done) break; bytes += next.value.byteLength; if (bytes > 2 * 1024 * 1024) throw new Error('Thumbnail exceeded its size limit.'); chunks.push(next.value); }
      } finally { await reader.cancel().catch(() => {}); reader.releaseLock(); }
      if (!bytes || signal.aborted || entry.job.ownerId !== ownerId()) return;
      const url = URL.createObjectURL(new Blob(chunks as BlobPart[], { type: response.headers.get('content-type') || 'image/jpeg' }));
      if (entryFor(entry.id) === entry) entry.thumbnail = url; else URL.revokeObjectURL(url);
    } catch { /* A missing thumbnail must not block a correctly saved file. */ }
    finally { clearTimeout(timeout); signal.removeEventListener('abort', cancel); }
  }
  async function transfer(entry: ClipDeliveryEntry, userInitiated = false) {
    const destination = destinations.get(entry.id), token = session;
    if (!destination || controllers.has(entry.id) || entry.job.status !== 'complete' || entry.job.deliveredAt || entry.job.expiredAt) return;
    const controller = new AbortController(); controllers.set(entry.id, controller); entry.busy = true; entry.message = undefined;
    try {
      // Retain the real rendered image before release makes the temporary
      // server thumbnail unavailable. The small Blob survives route changes.
      await thumbnail(entry, controller.signal);
      if (!isCurrent(entry, token) || controller.signal.aborted) return;
      if (destination.kind === 'download') {
        if (!userInitiated) { entry.state = 'ready'; entry.progress = 1; entry.message = 'Your export is ready. Use Download to save it with this browser.'; collapsed.value = false; return; }
        requestClipBrowserDownload(entry.id, destination.name); entry.state = 'download-requested'; entry.progress = 1;
        entry.message = 'Check your browser Downloads. Lumen cannot confirm that the file reached your disk.';
        return;
      }
      entry.state = 'saving'; entry.progress = 0; entry.written = 0;
      await saveClipExport(entry.job, destination, { signal: controller.signal, onProgress: value => { if (isCurrent(entry, token)) { entry.written = value.written; entry.progress = value.fraction ?? 0; } }, acknowledge: entry.job.temporary ? signal => release(entry, signal) : undefined });
      if (!isCurrent(entry, token)) return;
      entry.fileSaved = true; entry.cleanupPending = false; entry.state = 'saved'; entry.progress = 1; entry.message = undefined; collapsed.value = false;
    } catch (cause) {
      if (!isCurrent(entry, token)) return;
      const error = cause as ClipDeliveryError;
      if (error.fileSaved) { entry.fileSaved = true; entry.state = 'saved'; entry.progress = 1; entry.cleanupPending = true; }
      else { entry.state = 'ready'; entry.progress = 0; }
      entry.message = error.message || 'The file is still available. Choose a location and try saving again.'; collapsed.value = false;
    } finally {
      if (controllers.get(entry.id) === controller) controllers.delete(entry.id);
      if (isCurrent(entry, token)) { entry.busy = false; pruneReceipts(); schedule(); }
    }
  }
  function update(entry: ClipDeliveryEntry, job: DeliveryJob) {
    entry.job = job;
    if (entry.fileSaved) return;
    if (entry.state === 'saving' || entry.state === 'download-requested' && !job.expiredAt && !job.deliveredAt) return;
    const next = stateOf(job), changed = entry.state !== next;
    entry.state = next; entry.progress = Math.max(0, Math.min(1, job.progress));
    if (next === 'error') entry.message = job.error || 'Rendering was interrupted. Open the project to export again.';
    if (changed && ['ready', 'error', 'expired'].includes(next)) collapsed.value = false;
    if (next === 'ready' && destinations.has(job.id) && !entry.message) void transfer(entry);
  }
  async function resumeMetadata() {
    const id = ownerId(), token = session;
    if (!id || polling || typeof document !== 'undefined' && document.hidden) return;
    const controller = new AbortController(), deadline = setTimeout(() => controller.abort(), 12000); polling = controller;
    try {
      const response = await fetch('/api/clips', { credentials: 'include', signal: controller.signal });
      if (!response.ok) return;
      const workspace = await response.json() as ClipWorkspace;
      if (token !== session || id !== ownerId()) return;
      for (const value of workspace.exports) {
        const job = value as DeliveryJob;
        if (job.ownerId !== id || dismissed.has(job.id)) continue;
        let entry = entryFor(job.id);
        if (!entry && job.temporary && !job.deliveredAt && !job.expiredAt && job.status !== 'cancelled') entry = add(job);
        if (entry) update(entry, job);
      }
    } catch { /* Connection loss retains useful progress and retry actions. */ }
    finally { clearTimeout(deadline); if (polling === controller) polling = undefined; if (token === session) schedule(); }
  }
  function start(job: ClipExport, destination: ClipDestination) {
    if (job.ownerId !== ownerId()) return;
    dismissed.delete(job.id); destinations.set(job.id, destination);
    const entry = entryFor(job.id) ?? add(job); entry.filename = destination.name; entry.destination = destinationLabel(destination); entry.message = undefined;
    collapsed.value = false; update(entry, job); schedule();
  }
  async function chooseLocation(id: string) {
    const entry = entryFor(id); if (!entry || entry.busy || entry.fileSaved || entry.job.deliveredAt || entry.job.expiredAt) return;
    try {
      // First await is the picker itself, preserving this button's activation.
      const destination = await chooseClipDestination(exportOptions(entry.job), entry.job.name); if (!destination || entry.job.ownerId !== ownerId()) return;
      destinations.set(id, destination); entry.filename = destination.name; entry.destination = destinationLabel(destination); entry.message = undefined;
      await transfer(entry);
    } catch (cause) { entry.message = (cause as Error).message; }
  }
  async function retry(id: string) {
    const entry = entryFor(id); if (!entry || entry.busy) return;
    if (entry.fileSaved && entry.cleanupPending) {
      entry.busy = true;
      try { await release(entry); entry.cleanupPending = false; entry.message = undefined; }
      catch { entry.message = 'The file is saved. Temporary cleanup will be retried when the station is reachable.'; }
      finally { entry.busy = false; }
      return;
    }
    const destination = destinations.get(id);
    if (!destination) { await chooseLocation(id); return; }
    try {
      // Permission requests are allowed only from this explicit retry gesture.
      if (!await requestClipDestinationPermission(destination)) { entry.message = 'Permission was not granted. Choose a different save location.'; return; }
      entry.message = undefined; await transfer(entry, true);
    } catch (cause) { entry.message = (cause as Error).message || 'Choose a location and try saving again.'; }
  }
  async function cancel(id: string) {
    const entry = entryFor(id); if (!entry) return;
    if (entry.state === 'saving') { controllers.get(id)?.abort(); return; }
    if (!entry.job.canCancel || entry.busy) return;
    entry.busy = true;
    try { const job = await clipsApi.cancel(id); if (entry.job.ownerId === ownerId()) update(entry, job); }
    catch (cause) { entry.message = (cause as Error).message; }
    finally { entry.busy = false; }
  }
  async function openFile(id: string) {
    const entry = entryFor(id), destination = destinations.get(id); if (!entry?.fileSaved || !destination) return;
    try { await openSavedClip(destination); }
    catch (cause) { entry.message = (cause as Error).message; }
  }
  function dismiss(id: string) {
    const entry = entryFor(id); if (!entry || running(entry.state) || entry.busy) return;
    dismissed.add(id); destinations.delete(id); revoke(entry); entries.value = entries.value.filter(value => value.id !== id);
  }
  function visibility() { if (typeof document !== 'undefined' && document.hidden) clearTimer(); else void resumeMetadata(); }
  const stopIdentity = watch(() => identity.ready ? identity.me?.id ?? null : undefined, () => { reset(); if (ownerId()) void resumeMetadata(); }, { immediate: true });
  if (typeof document !== 'undefined') document.addEventListener('visibilitychange', visibility);
  onScopeDispose(() => { stopIdentity(); reset(); if (typeof document !== 'undefined') document.removeEventListener('visibilitychange', visibility); });
  return { entries, activeCount, collapsed, start, resumeMetadata, cancel, retry, chooseLocation, openFile, dismiss };
});
