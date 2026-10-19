<script setup lang="ts">
import { computed, nextTick, onBeforeUnmount, onMounted, reactive, ref, watch, type Directive } from 'vue';
import { onBeforeRouteLeave, onBeforeRouteUpdate, useRoute, useRouter } from 'vue-router';
import { useFullscreen } from '@vueuse/core';
import { toast } from 'vue-sonner';
import { ArrowDown, ArrowLeft, ArrowRightLeft, ArrowUp, Copy, Download, Film, FolderOpen, Layers, LoaderCircle, LockKeyhole, Maximize2, Minimize2, Music2, PanelRightClose, Plus, Save, Search, ShieldCheck, SlidersHorizontal, Type, Upload, X } from 'lucide-vue-next';
import WorkspaceHeader from '@/components/shell/WorkspaceHeader.vue';
import LoginGate from '@/components/shell/LoginGate.vue';
import EditorTimeline from '@/components/clips/EditorTimeline.vue';
import EditorPreview from '@/components/clips/EditorPreview.vue';
import EditorMediaThumbnail from '@/components/clips/EditorMediaThumbnail.vue';
import EditorTransitions from '@/components/clips/EditorTransitions.vue';
import EditorExportDialog from '@/components/clips/EditorExportDialog.vue';
import { useIdentityStore } from '@/stores/identity';
import { useClipDeliveryStore } from '@/stores/clip-delivery';
import { useConfirmation } from '@/composables/useConfirmation';
import { clipsApi, ClipsRequestError } from '@/lib/clips';
import { refreshTimelinePreviews, setTimelinePreviewSession } from '@/lib/timeline-previews';
import { applyTransition, applyTransitionToAll, detachTransitionLinks, normalizeTrackTransitions, transitionAtCut } from '@/lib/clip-transitions';
import type { ClipDestination } from '@/lib/clip-delivery';
import { clamp, clipId, copyTimeline, endOf, findItem, formatClipTime as time, hydrateTimeline, makeItem, makeTrack, MAX_TIMELINE_MS, MIN_ITEM_MS, parseClipTime, reorderSequence, splitItem, timelineDuration } from '@/lib/clip-timeline';
import type { ClipAsset, ClipDraft, ClipDraftInput, ClipExportOptions, ClipFormat, ClipSourceRef, ClipTimelineItem, ClipTimelineTrack, ClipWorkspace } from '../../../shared/clips';
import '@/styles/clips.css';
import '@/styles/clip-editor.css';
import '@/styles/clip-transitions.css';

const route = useRoute(), router = useRouter(), identity = useIdentityStore(), delivery = useClipDeliveryStore(), { confirmAction } = useConfirmation();
const workspace = ref<ClipWorkspace | null>(null), draft = ref<ClipDraft | null>(null);
const loading = ref(true), busy = ref(false), error = ref(''), conflict = ref(false), loadFailed = ref(false), inspectorOpen = ref(window.innerWidth >= 950), mediaPanelOpen = ref(false);
const currentMs = ref(0), playing = ref(false), muted = ref(true), selectedId = ref<string | null>(null);
const pendingInspector = ref(false);
const tab = ref<'media' | 'audio' | 'text' | 'transitions' | 'drafts'>('media'), mediaFilter = ref<'all' | 'video' | 'image'>('all'), search = ref('');
const exportDialogOpen = ref(false), previewRange = ref<{ start: number; end: number } | null>(null);
const uploadInput = ref<HTMLInputElement | null>(null), importing = ref(false), importProgress = ref(0), timelineHeight = ref(340);
const fields = reactive<ClipDraftInput>({ name: '', inMs: 0, outMs: 1000, format: '16:9', fit: 'cover', positionX: .5, positionY: .5, timeline: { version: 1, background: '#000000', tracks: [] } });
const baseline = ref(''), undo = ref<string[]>([]), redo = ref<string[]>([]), startInput = ref(''), endInput = ref('');
const recordingId = computed(() => String(route.params.recordingId ?? ''));
const recording = computed(() => workspace.value?.recordings.find(item => item.id === recordingId.value));
const timeline = computed(() => fields.timeline!);
const duration = computed(() => timelineDuration(timeline.value));
const drafts = computed(() => workspace.value?.drafts.filter(item => item.recordingId === recordingId.value) ?? []);
const selected = computed(() => findItem(timeline.value, selectedId.value));
const selectedTrackIndex = computed(() => timeline.value.tracks.findIndex(track => track.id === selected.value?.track.id));
const editable = computed(() => !loading.value && !loadFailed.value && recording.value?.status === 'complete' && (!draft.value || draft.value.canEdit));
const canEditItem = computed(() => editable.value && !busy.value && !selected.value?.track.locked);
const dirty = computed(() => !!baseline.value && (pendingInspector.value || JSON.stringify(fields) !== baseline.value));
const valid = computed(() => !!fields.name.trim() && fields.name.length <= 120 && duration.value >= 250 && duration.value <= MAX_TIMELINE_MS && timeline.value.tracks.some(track => track.items.some(item => item.kind !== 'audio')));
const savedElsewhere = computed(() => !!draft.value && !!workspace.value?.drafts.some(item => item.id === draft.value?.id && item.revision > draft.value.revision));
watch(() => workspace.value?.liveProtected, (live, previous) => { if (previous === true && live === false) refreshTimelinePreviews(); });
watch(() => identity.isAuthenticated ? identity.me?.id ?? null : null, id => setTimelinePreviewSession(id), { immediate: true });
const { isFullscreen, isSupported: fullscreenSupported, toggle: toggleNativeFullscreen } = useFullscreen(document.documentElement);
const mediaItems = computed(() => {
  const originals = (workspace.value?.recordings ?? []).filter(item => item.status === 'complete').map(item => ({ source: { kind: 'recording' as const, id: item.id }, name: item.name, kind: 'video' as const, durationMs: item.durationMs, width: item.width ?? 1920, height: item.height ?? 1080, url: clipsApi.media(item.id), poster: item.posterReady ? clipsApi.poster(item.id) : '' }));
  const imported = (workspace.value?.assets ?? []).map(item => ({ ...item, source: { kind: 'asset' as const, id: item.id }, url: clipsApi.asset(item.id), poster: '' }));
  return [...originals, ...imported].filter(item => item.name.toLowerCase().includes(search.value.toLowerCase()) && (tab.value === 'audio' ? item.kind === 'audio' : item.kind !== 'audio' && (mediaFilter.value === 'all' || item.kind === mediaFilter.value)));
});
let sequence = 0, workspaceReadToken = 0, poll: ReturnType<typeof setInterval> | undefined, playbackFrame = 0;
let clockStart = 0, clockOffset = 0, gesture: string | null = null, gestureTimeline: ClipDraftInput['timeline'] = undefined;
let importController: AbortController | null = null;
// Playback and background workspace refreshes must not reset an unfinished
// inspector edit. Keep the active native field intact until change/blur commits.
const localFields = new WeakMap<HTMLElement, { input: HTMLInputElement | HTMLTextAreaElement; value: string; start: number | null; end: number | null; identity: unknown }>();
const vLocalFields: Directive<HTMLElement, unknown> = {
  beforeUpdate(element, binding) {
    const input = document.activeElement;
    if ((input instanceof HTMLInputElement || input instanceof HTMLTextAreaElement) && element.contains(input) && !['checkbox', 'radio'].includes(input.type)) localFields.set(element, { input, value: input.value, start: input.selectionStart, end: input.selectionEnd, identity: binding.oldValue });
  },
  updated(element, binding) {
    const state = localFields.get(element); localFields.delete(element);
    if (!state || state.identity !== binding.value || document.activeElement !== state.input) return;
    state.input.value = state.value;
    if (state.start !== null) { try { state.input.setSelectionRange(state.start, state.end); } catch { /* Number inputs do not support a selection range. */ } }
  },
};

function json() { return JSON.stringify(fields); }
function pushHistory(before: string) { if (before === json()) return; undo.value = [...undo.value.slice(-79), before]; redo.value = []; }
function commit(action: () => void) { if (!editable.value || busy.value) return; pause(); const before = json(); action(); if (duration.value > MAX_TIMELINE_MS) { Object.assign(fields, JSON.parse(before)); toast.info('Keep the project within two hours. Trim the end before extending this cut.'); return; } pushHistory(before); }
function beginGesture() { if (!editable.value || busy.value) return; pause(); gesture = json(); gestureTimeline = copyTimeline(timeline.value); }
function endGesture() { if (gesture) pushHistory(gesture); gesture = null; gestureTimeline = undefined; }
function undoEdit() { if (!editable.value || busy.value || !undo.value.length) return; pause(); redo.value.push(json()); Object.assign(fields, JSON.parse(undo.value.pop()!)); if (!selected.value) selectedId.value = null; syncTrimInputs(); }
function redoEdit() { if (!editable.value || busy.value || !redo.value.length) return; pause(); undo.value.push(json()); Object.assign(fields, JSON.parse(redo.value.pop()!)); if (!selected.value) selectedId.value = null; syncTrimInputs(); }
function sourceUrl(item: ClipTimelineItem) { return item.source?.kind === 'recording' ? clipsApi.media(item.source.id) : item.source ? clipsApi.asset(item.source.id) : ''; }
function sourceMetadata(source?: ClipSourceRef) { return source?.kind === 'recording' ? workspace.value?.recordings.find(item => item.id === source.id) : workspace.value?.assets?.find(item => item.id === source?.id); }
function sourceDuration(item: ClipTimelineItem) { return item.kind === 'text' || item.kind === 'image' ? MAX_TIMELINE_MS : sourceMetadata(item.source)?.durationMs ?? MAX_TIMELINE_MS; }
function thumbnail(item: ClipTimelineItem) { return item.source?.kind === 'recording' ? clipsApi.poster(item.source.id) : item.kind === 'image' && item.source ? clipsApi.asset(item.source.id) : ''; }
function syncLegacy() {
  const original = timeline.value.tracks[0]?.items.find(item => item.source?.kind === 'recording' && item.source.id === recordingId.value);
  if (original) Object.assign(fields, { inMs: original.inMs, outMs: original.inMs + original.durationMs, fit: original.fit, positionX: original.positionX, positionY: original.positionY });
}
function syncTrimInputs() { const item = selected.value?.item; startInput.value = time(item?.inMs ?? 0, true); endInput.value = time(item ? item.inMs + item.durationMs : 0, true); }
watch(() => [selectedId.value, selected.value?.item.inMs, selected.value?.item.durationMs], syncTrimInputs);
function flushActiveInspectorInput() {
  const input = document.activeElement;
  if (!(input instanceof HTMLInputElement || input instanceof HTMLTextAreaElement || input instanceof HTMLSelectElement) || !input.closest('.nle-editor .nle-inspector, .nle-editor .nle-transition-panel')) { pendingInspector.value = false; return; }
  // Native change normally waits for blur. Saving from the keyboard (or closing
  // the tab) must commit the exact text that is visible, not its earlier value.
  input.dispatchEvent(new Event('change', { bubbles: true }));
  input.blur();
  pendingInspector.value = false;
}
function select(id: string | null) { flushActiveInspectorInput(); selectedId.value = id; if (id) inspectorOpen.value = true; }
function activateTab(value: typeof tab.value) { tab.value = value; mediaPanelOpen.value = true; if (window.innerWidth <= 720) inspectorOpen.value = false; }
function clearDetachedCuts(track: ClipTimelineTrack) { if (track.locked) return; for (const item of track.items) if (item.transitionIn && !transitionAtCut(track, item.id).eligible) delete item.transitionIn; }
function normalizeTiming(track: ClipTimelineTrack, before: ClipTimelineTrack) { const result = normalizeTrackTransitions(track); if (result?.applied === false) { Object.assign(track, before); toast.info(result.reason || 'This timing change would extend the project past two hours.'); return false; } return true; }
function rawPatch(id: string, patch: Partial<ClipTimelineItem>) { const entry = findItem(timeline.value, id); if (!entry || entry.track.locked || !editable.value || busy.value) return; const before = 'durationMs' in patch || 'inMs' in patch ? copyTimeline(entry.track) : null; if ('startMs' in patch) detachTransitionLinks(entry.track, id); Object.assign(entry.item, patch); if (before) normalizeTiming(entry.track, before); if ('startMs' in patch) clearDetachedCuts(entry.track); syncLegacy(); }
function patch(patch: Partial<ClipTimelineItem>) { if (!selected.value) return; const id = selected.value.item.id; commit(() => rawPatch(id, patch)); }
function setFormat(value: ClipFormat) { commit(() => { fields.format = value; }); }
function numeric(event: Event, key: keyof ClipTimelineItem, min: number, max: number, factor = 1) { const value = Number((event.target as HTMLInputElement).value); if (Number.isFinite(value)) { const bounded = clamp(value / factor, min, max); patch({ [key]: ['startMs', 'durationMs', 'inMs', 'fontSize', 'fontWeight'].includes(key) ? Math.round(bounded) : bounded }); } }
function trimItem(id: string, side: 'in' | 'out', delta: number) {
  const entry = findItem(timeline.value, id), baselineEntry = gestureTimeline ? findItem(gestureTimeline, id) : null, origin = baselineEntry?.item ?? entry?.item;
  if (!entry || !origin || entry.track.locked || !editable.value || busy.value) return;
  const before = copyTimeline(entry.track);
  // Every pointer delta is measured from pointer-down. Restore the same cut
  // metadata and following clips before normalising, so dragging out and back
  // also restores a temporarily shortened (or removed) transition and fades.
  if (baselineEntry?.track.id === entry.track.id) { Object.assign(entry.track, copyTimeline(baselineEntry.track)); entry.item = entry.track.items.find(item => item.id === id)!; }
  if (side === 'in') { const still = origin.kind === 'text' || origin.kind === 'image', change = Math.round(clamp(delta, still ? -origin.startMs : -Math.min(origin.inMs, origin.startMs), origin.durationMs - MIN_ITEM_MS)); Object.assign(entry.item, { inMs: still ? 0 : origin.inMs + change, startMs: origin.startMs + change, durationMs: origin.durationMs - change }); }
  else entry.item.durationMs = Math.round(clamp(origin.durationMs + delta, MIN_ITEM_MS, Math.min(sourceDuration(origin) - origin.inMs, MAX_TIMELINE_MS - origin.startMs)));
  normalizeTiming(entry.track, before);
  syncLegacy(); syncTrimInputs();
}
function commitTime(side: 'in' | 'out') {
  if (!selected.value) return;
  const parsed = parseClipTime(side === 'in' ? startInput.value : endInput.value), item = selected.value.item;
  if (parsed === null || parsed < 0 || parsed > sourceDuration(item) || (side === 'in' ? item.inMs + item.durationMs - parsed : parsed - item.inMs) < MIN_ITEM_MS) { toast.error('Choose a time inside this source, leaving at least 0.1 seconds.'); syncTrimInputs(); return; }
  commit(() => { const before = copyTimeline(selected.value!.track); if (side === 'in') { const oldEnd = item.inMs + item.durationMs; item.inMs = parsed; item.durationMs = oldEnd - parsed; } else item.durationMs = parsed - item.inMs; normalizeTiming(selected.value!.track, before); syncLegacy(); }); syncTrimInputs();
}
function moveItem(id: string, startMs: number, trackId: string, reorder: boolean) {
  const entry = findItem(timeline.value, id), target = timeline.value.tracks.find(track => track.id === trackId);
  if (!entry || !target || entry.track.locked || target.locked || !editable.value || busy.value) return;
  const compatible = entry.item.kind === 'audio' ? target.kind === 'audio' : entry.item.kind === 'text' ? target.kind === 'text' : target.kind === 'video';
  if (!compatible) return;
  if (reorder && target.id === timeline.value.tracks[0]?.id) reorderSequence(target, id, startMs);
  else { detachTransitionLinks(entry.track, id); if (entry.track.id !== target.id) { entry.track.items = entry.track.items.filter(item => item.id !== id); target.items.push(entry.item); } entry.item.startMs = Math.round(clamp(startMs, 0, MAX_TIMELINE_MS - entry.item.durationMs)); clearDetachedCuts(entry.track); clearDetachedCuts(target); }
}
function split() { if (!selected.value) return; if (itemCount() >= 120) { toast.error('Use no more than 120 clips in a project.'); return; } commit(() => { const id = splitItem(timeline.value, selected.value!.item.id, currentMs.value); if (id) selectedId.value = id; else toast.info('Place the playhead inside the selected clip to split it.'); syncLegacy(); }); }
function remove() { if (!selected.value || selected.value.track.locked) return; commit(() => { detachTransitionLinks(selected.value!.track, selectedId.value!); selected.value!.track.items = selected.value!.track.items.filter(item => item.id !== selectedId.value); selectedId.value = null; }); }
function duplicate() { if (!selected.value || selected.value.track.locked) return; commit(() => { const { item, track } = selected.value!; if (itemCount() >= 120) return; const copy = { ...copyTimeline(item), id: clipId('item'), startMs: endOf(item) }; delete copy.transitionIn; if (endOf(copy) > MAX_TIMELINE_MS) return; track.items.push(copy); clearDetachedCuts(track); selectedId.value = copy.id; }); }
function openTransitions(id?: string) {
  flushActiveInspectorInput(); pause(); activateTab('transitions');
  const preferred = id ? findItem(timeline.value, id) : selected.value;
  const entry = preferred && transitionAtCut(preferred.track, preferred.item.id).eligible ? preferred : timeline.value.tracks.flatMap(track => track.items.map(item => ({ track, item }))).find(value => !value.track.locked && transitionAtCut(value.track, value.item.id).eligible);
  if (entry) selectedId.value = entry.item.id;
}
function setTransition(value: ClipTimelineItem['transitionIn'] | null) {
  if (!selected.value || !canEditItem.value) return;
  commit(() => { const result = applyTransition(selected.value!.track, selected.value!.item.id, value ?? null); if (!result.applied) toast.info(result.reason || 'Select two adjoining video clips.'); syncLegacy(); });
}
function setAllTransitions(value: NonNullable<ClipTimelineItem['transitionIn']>) {
  flushActiveInspectorInput(); if (!editable.value || busy.value) return;
  // Flush can commit a duration still being typed. Use the now-current preset
  // rather than the event's pre-flush snapshot, and keep the batch one undo.
  const effect = selected.value?.item.transitionIn ?? value;
  commit(() => { const result = applyTransitionToAll(timeline.value, effect); if (!result.applied) toast.info(result.reason || 'No suitable cuts to update.'); else toast.success(`Updated ${result.changed} ${result.changed === 1 ? 'cut' : 'cuts'}${result.skipped ? ` · ${result.skipped} skipped` : ''}.`); syncLegacy(); });
}
function previewTransition() {
  const item = selected.value?.item, transition = item?.transitionIn; if (!item || !transition) return;
  pause(); const start = Math.max(0, item.startMs - 250), end = Math.min(duration.value, item.startMs + transition.durationMs + 250);
  seek(start); previewRange.value = { start, end }; clockStart = performance.now(); clockOffset = currentMs.value; playing.value = true; tick();
}
function audioFade(event: Event, key: 'audioFadeInMs' | 'audioFadeOutMs') { if (!selected.value) return; const value = Number((event.target as HTMLInputElement).value); if (Number.isFinite(value)) patch({ [key]: Math.round(clamp(value * 1000, 0, Math.min(2000, Math.floor(selected.value.item.durationMs / 2)))) }); }
function itemCount() { return timeline.value.tracks.reduce((total, track) => total + track.items.length, 0); }
function trackPatch(id: string, changes: Partial<ClipTimelineTrack>) { commit(() => { const track = timeline.value.tracks.find(item => item.id === id); if (track) Object.assign(track, changes); }); }
function addTrack() { commit(() => { if (timeline.value.tracks.length >= 12) { toast.error('A project supports up to 12 tracks.'); return; } timeline.value.tracks.push(makeTrack('video', `Video ${timeline.value.tracks.filter(item => item.kind === 'video').length + 1}`)); }); }
function changeTrackOrder(direction: number) {
  if (!selected.value) return;
  const index = timeline.value.tracks.findIndex(track => track.id === selected.value!.track.id), next = index + direction;
  // Track zero is the primary sequence, not an interchangeable overlay. Keep
  // its identity stable for gapless reordering, source trims and Add to main.
  if (index <= 0 || next <= 0 || next >= timeline.value.tracks.length) return;
  commit(() => { const tracks = timeline.value.tracks; [tracks[index], tracks[next]] = [tracks[next]!, tracks[index]!]; });
}
function addSource(media: (typeof mediaItems.value)[number], overlay = false) {
  commit(() => {
    if (itemCount() >= 120 || timeline.value.tracks.flatMap(track => track.items).filter(item => item.kind !== 'text').length >= 64) { toast.error('This project has reached its media limit. Split it into another draft.'); return; }
    let track = media.kind === 'audio' ? timeline.value.tracks.find(value => value.kind === 'audio' && !value.locked) : overlay ? timeline.value.tracks.find((value, index) => index > 0 && value.kind === 'video' && !value.locked) : timeline.value.tracks[0];
    if (track?.locked) { toast.info('Unlock the main video track before adding clips to its sequence.'); return; }
    if (!track) { if (timeline.value.tracks.length >= 12) return; track = makeTrack(media.kind === 'audio' ? 'audio' : 'video', media.kind === 'audio' ? 'Audio' : 'Overlay'); timeline.value.tracks.push(track); }
    const length = media.kind === 'image' ? 5000 : Math.min(media.durationMs, MAX_TIMELINE_MS), item = makeItem(media.kind, media.name, length, media.source);
    item.startMs = overlay || media.kind === 'audio' ? Math.round(currentMs.value) : Math.max(0, ...track.items.map(endOf));
    item.durationMs = Math.min(item.durationMs, MAX_TIMELINE_MS - item.startMs); if (item.durationMs < MIN_ITEM_MS) return;
    if (overlay) Object.assign(item, { x: .18, y: .18, width: .64, height: .64, muted: true });
    track.items.push(item); selectedId.value = item.id; inspectorOpen.value = true; mediaPanelOpen.value = false; seek(item.startMs);
  });
}
function addText() { commit(() => { if (MAX_TIMELINE_MS - currentMs.value < MIN_ITEM_MS) return; let track = timeline.value.tracks.find(value => value.kind === 'text' && !value.locked); if (!track) { if (timeline.value.tracks.length >= 12) return; track = makeTrack('text', 'Text'); timeline.value.tracks.push(track); } if (itemCount() >= 120) return; const item = makeItem('text', 'Text', Math.min(5000, MAX_TIMELINE_MS - currentMs.value)); Object.assign(item, { text: 'Your message here', startMs: Math.round(currentMs.value), x: .1, y: .7, width: .8, height: .2 }); track.items.push(item); selectedId.value = item.id; inspectorOpen.value = true; mediaPanelOpen.value = false; }); }
function mediaMetadata(file: File, signal: AbortSignal): Promise<{ durationMs: number; width: number; height: number }> {
  return new Promise((resolve, reject) => {
    const url = URL.createObjectURL(file), cleanup = () => { URL.revokeObjectURL(url); signal.removeEventListener('abort', abort); }, abort = () => { clearTimeout(timeout); cleanup(); reject(new Error('Media import cancelled.')); }, timeout = setTimeout(() => { cleanup(); reject(new Error('This media could not be read. Try an MP4, WebM, common image or audio file.')); }, 15000);
    signal.addEventListener('abort', abort, { once: true });
    if (signal.aborted) { abort(); return; }
    if (file.type.startsWith('image/')) { const image = new window.Image(); image.onload = () => { clearTimeout(timeout); cleanup(); resolve({ durationMs: 0, width: image.naturalWidth, height: image.naturalHeight }); }; image.onerror = () => { clearTimeout(timeout); cleanup(); reject(new Error('This image could not be read.')); }; image.src = url; }
    else { const element = document.createElement(file.type.startsWith('audio/') ? 'audio' : 'video'); element.preload = 'metadata'; element.onloadedmetadata = () => { clearTimeout(timeout); const width = element instanceof HTMLVideoElement ? element.videoWidth : 0, height = element instanceof HTMLVideoElement ? element.videoHeight : 0, durationMs = Math.round(element.duration * 1000); element.removeAttribute('src'); element.load(); cleanup(); if (!Number.isFinite(durationMs) || durationMs < MIN_ITEM_MS) reject(new Error('This media has no readable duration.')); else resolve({ durationMs, width, height }); }; element.onerror = () => { clearTimeout(timeout); cleanup(); reject(new Error('This browser cannot read that file. Try MP4/H.264, WebM or a common audio format.')); }; element.src = url; }
  });
}
async function importFiles(event: Event) {
  const files = Array.from((event.target as HTMLInputElement).files ?? []); (event.target as HTMLInputElement).value = '';
  if (!editable.value || importing.value || !files.length) return;
  const run = sequence, controller = new AbortController(); importController = controller; importing.value = true;
  try { for (const file of files) { if (file.size > 512 * 1024 * 1024) throw new Error('Choose media files smaller than 512 MB.'); importProgress.value = 0; const metadata = await mediaMetadata(file, controller.signal); if (run !== sequence) return; const asset: ClipAsset = await clipsApi.upload(file, metadata, value => { if (run === sequence) importProgress.value = value; }, controller.signal); if (run !== sequence) return; workspaceReadToken++; if (workspace.value) workspace.value.assets = [asset, ...(workspace.value.assets ?? []).filter(item => item.id !== asset.id)]; activateTab(asset.kind === 'audio' ? 'audio' : 'media'); } toast.success('Media imported. Add it to your timeline.'); }
  catch (cause) { if (run === sequence && !controller.signal.aborted) toast.error((cause as Error).message); } finally { if (run === sequence) importing.value = false; if (importController === controller) importController = null; }
}
function resetLocal(saved: ClipDraft | null) {
  if (!recording.value) return;
  pause(); exportDialogOpen.value = false; draft.value = saved;
  const initial = saved ? { name: saved.name, inMs: saved.inMs, outMs: saved.outMs, format: saved.format, fit: saved.fit, positionX: saved.positionX, positionY: saved.positionY } : { name: `${recording.value.name} · Clip`.slice(0, 120), inMs: 0, outMs: Math.min(recording.value.durationMs, MAX_TIMELINE_MS), format: '16:9' as const, fit: 'cover' as const, positionX: .5, positionY: .5 };
  Object.assign(fields, initial, { timeline: hydrateTimeline(saved ?? initial, recording.value) });
  pendingInspector.value = false; baseline.value = json(); undo.value = []; redo.value = []; selectedId.value = timeline.value.tracks[0]?.items[0]?.id ?? null; syncTrimInputs(); conflict.value = false; error.value = ''; seek(0); refreshTimelinePreviews();
}
async function load() {
  const run = ++sequence, read = ++workspaceReadToken; pause(); loading.value = true; loadFailed.value = false; error.value = '';
  try { const result = await clipsApi.workspace(); if (run !== sequence || read !== workspaceReadToken) return; workspace.value = result;
    if (!recording.value) { loadFailed.value = true; error.value = 'This recording is no longer available on this station.'; return; }
    const id = typeof route.query.draft === 'string' ? route.query.draft : '', saved = id ? drafts.value.find(item => item.id === id) : null;
    if (id && !saved) { loadFailed.value = true; error.value = 'This draft is no longer available. Return to the recording library or create a new project.'; return; }
    resetLocal(saved ?? null); await nextTick(); if (route.query.play === '1') togglePlay();
  } catch (cause) { if (run === sequence) { loadFailed.value = true; error.value = (cause as Error).message; } } finally { if (run === sequence) loading.value = false; }
}
async function refresh() {
  const run = sequence, read = ++workspaceReadToken;
  try { const result = await clipsApi.workspace(); if (run !== sequence || read !== workspaceReadToken || !identity.isAuthenticated) return; workspace.value = result; const saved = result.drafts.find(item => item.id === draft.value?.id); if (saved && draft.value) draft.value = { ...draft.value, canEdit: saved.canEdit }; }
  catch { /* Retain local edits through temporary station disconnects. */ }
}
async function save(copy = false): Promise<ClipDraft | null> {
  flushActiveInspectorInput();
  if (busy.value || loading.value || loadFailed.value || !recording.value || !valid.value || (!copy && !editable.value)) return null;
  const run = sequence, input = copyTimeline({ ...fields, name: fields.name.trim() }); if (copy) input.name = `${input.name.slice(0, 115)} copy`;
  busy.value = true; error.value = '';
  try { const saved = draft.value && !copy ? await clipsApi.save(draft.value.id, draft.value.revision, input) : await clipsApi.create(recordingId.value, input); if (run !== sequence) return null; workspaceReadToken++; draft.value = saved; Object.assign(fields, input); pendingInspector.value = false; baseline.value = json(); conflict.value = false; if (workspace.value) workspace.value.drafts = [...workspace.value.drafts.filter(item => item.id !== saved.id), saved]; if (route.query.draft !== saved.id) await router.replace({ path: route.path, query: { draft: saved.id } }); toast.success(copy ? 'Your independent project copy is ready.' : 'Project draft saved.'); return saved; }
  catch (cause) { if (run !== sequence) return null; conflict.value = cause instanceof ClipsRequestError && cause.status === 409; error.value = conflict.value ? 'This draft changed in another window. Your edits are still here. Reload the saved draft or save your work as a copy.' : (cause as Error).message; return null; } finally { if (run === sequence) busy.value = false; }
}
async function reloadDraft() { if (dirty.value && !await confirmAction({ title: 'Reload the saved project?', description: 'Your unsaved edits will be replaced with the latest saved draft. Original media stays untouched.', confirmLabel: 'Reload draft', cancelLabel: 'Keep editing' })) return; await load(); }
async function newClip() { if (route.query.draft) { await router.push({ path: route.path }); return; } if (await mayLeave()) resetLocal(null); }
function openExport() { flushActiveInspectorInput(); pause(); if (!busy.value && valid.value && editable.value) { error.value = ''; exportDialogOpen.value = true; } }
async function exportClip(options: ClipExportOptions, destination: ClipDestination) { flushActiveInspectorInput(); if (busy.value || !valid.value || !editable.value) return; const saved = dirty.value || !draft.value ? await save() : draft.value; if (!saved) return; const run = sequence; busy.value = true;
  try { const job = await clipsApi.export(saved.id, saved.revision, options, true); if (run !== sequence) return; delivery.start(job, destination); exportDialogOpen.value = false; workspaceReadToken++; if (workspace.value) workspace.value.exports = [job, ...workspace.value.exports.filter(item => item.id !== job.id)]; } catch (cause) { if (run === sequence) { conflict.value = cause instanceof ClipsRequestError && cause.status === 409; error.value = (cause as Error).message; } } finally { if (run === sequence) busy.value = false; } }
function seek(ms: number) { currentMs.value = Math.round(clamp(ms, 0, Math.max(0, duration.value - 1))); if (playing.value) { clockStart = performance.now(); clockOffset = currentMs.value; } }
function pause() { playing.value = false; previewRange.value = null; cancelAnimationFrame(playbackFrame); }
function tick() { if (!playing.value) return; currentMs.value = clockOffset + performance.now() - clockStart; const end = previewRange.value?.end ?? duration.value; if (currentMs.value >= end) { currentMs.value = Math.max(0, end - 1); pause(); return; } playbackFrame = requestAnimationFrame(tick); }
function togglePlay() { if (playing.value) { pause(); return; } if (duration.value < MIN_ITEM_MS) return; if (currentMs.value >= duration.value - 50) seek(0); clockStart = performance.now(); clockOffset = currentMs.value; playing.value = true; tick(); }
async function fullscreen() { try { await toggleNativeFullscreen(); } catch { toast.error('Fullscreen is unavailable here. Open the editor in a browser window.'); } }
function keydown(event: KeyboardEvent) {
  if (event.defaultPrevented || event.isComposing || document.querySelector('[role="dialog"], [role="alertdialog"]') || !identity.isAuthenticated || loading.value) return;
  const target = event.target instanceof HTMLElement ? event.target : null, input = target?.closest('input, textarea, select, [contenteditable="true"], [role="slider"]');
  if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === 's') { event.preventDefault(); void save(); return; }
  // The playhead owns its arrow keys, but it is not a text/trim field. Keep
  // playback and editing shortcuts usable immediately after dragging it.
  if (input && !target?.closest('[data-timeline-playhead]')) return;
  if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === 'z') { event.preventDefault(); event.shiftKey ? redoEdit() : undoEdit(); return; }
  if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === 'd') { event.preventDefault(); duplicate(); return; }
  if (event.metaKey || event.ctrlKey || event.altKey || event.repeat) return;
  const key = event.key.toLowerCase();
  if (event.code === 'Space') { event.preventDefault(); togglePlay(); }
  else if (event.key === 'ArrowLeft' || event.key === 'ArrowRight') { event.preventDefault(); pause(); seek(currentMs.value + (event.key === 'ArrowLeft' ? -1 : 1) * (event.shiftKey ? 1000 : 1000 / 30)); }
  else if (key === 'j' || key === 'l') { event.preventDefault(); pause(); seek(currentMs.value + (key === 'j' ? -1000 : 1000)); }
  else if (key === 'k') { event.preventDefault(); pause(); }
  else if (key === 's') { event.preventDefault(); split(); }
  else if (key === 't') { event.preventDefault(); openTransitions(); }
  else if (event.key === 'Delete' || event.key === 'Backspace') { event.preventDefault(); remove(); }
  else if (key === 'i' || key === 'o') { if (!selected.value) return; event.preventDefault(); const item = selected.value.item; beginGesture(); trimItem(item.id, key === 'i' ? 'in' : 'out', currentMs.value - (key === 'i' ? item.startMs : endOf(item))); endGesture(); }
}
async function mayLeave() { flushActiveInspectorInput(); if (busy.value || importing.value) { toast.info('Wait for the current save or import to finish.'); return false; } return !dirty.value || await confirmAction({ title: 'Leave this project without saving?', description: 'Your unsaved timeline edits will be lost. Saved drafts and original media stay safe.', confirmLabel: 'Leave without saving', cancelLabel: 'Keep editing', tone: 'danger' }); }
function beforeUnload(event: BeforeUnloadEvent) { flushActiveInspectorInput(); if (dirty.value || importing.value) { event.preventDefault(); event.returnValue = ''; } }
onBeforeRouteLeave(mayLeave);
onBeforeRouteUpdate(async to => { if (to.fullPath !== route.fullPath && !(to.path === route.path && to.query.draft === draft.value?.id)) return mayLeave(); });
watch(() => [identity.ready && identity.isAuthenticated, recordingId.value, route.query.draft], ([authenticated]) => { if (authenticated) { if (typeof route.query.draft === 'string' && route.query.draft === draft.value?.id && draft.value?.recordingId === recordingId.value) return; void load(); } else { sequence++; importController?.abort(); pause(); workspace.value = null; draft.value = null; baseline.value = ''; selectedId.value = null; pendingInspector.value = false; undo.value = []; redo.value = []; busy.value = false; importing.value = false; fields.timeline = { version: 1, background: '#000000', tracks: [] }; fields.name = ''; } }, { immediate: true });
onMounted(async () => { document.addEventListener('keydown', keydown); window.addEventListener('beforeunload', beforeUnload); if (!identity.ready) await identity.load(); poll = setInterval(() => { if (identity.isAuthenticated && !document.hidden && !loading.value) void refresh(); }, 2500); });
onBeforeUnmount(() => { sequence++; importController?.abort(); pause(); if (poll) clearInterval(poll); document.removeEventListener('keydown', keydown); window.removeEventListener('beforeunload', beforeUnload); });
</script>

<template>
  <LoginGate v-if="identity.ready && !identity.isAuthenticated" />
  <main v-else class="clips-app clips-editor nle-editor" data-testid="clip-editor">
    <WorkspaceHeader><div class="clips-header-location"><RouterLink to="/recordings" class="clip-icon-button" aria-label="Back to recordings"><ArrowLeft :size="16" /></RouterLink><span class="clips-header-divider" /><span class="clips-editor-recording-name" :title="recording?.name">{{ recording?.name ?? 'Clip editor' }}</span></div><div class="clips-header-actions"><span class="clips-draft-state" :class="{ 'clips-draft-unsaved': dirty }"><i />{{ draft && !draft.canEdit ? 'Read-only draft' : dirty ? 'Unsaved changes' : draft ? 'Saved' : 'New project' }}</span><button v-if="fullscreenSupported" class="clip-icon-button" :aria-label="isFullscreen ? 'Exit fullscreen' : 'Enter fullscreen'" @click="fullscreen"><Minimize2 v-if="isFullscreen" :size="15" /><Maximize2 v-else :size="15" /></button><button class="clip-icon-button" aria-label="Make a copy of this clip" title="Save independent copy" :disabled="busy || !valid || loading" @click="save(true)"><Copy :size="15" /></button><button class="clip-button" data-testid="clip-save" :disabled="busy || !valid || !editable || (!!draft && !dirty)" @click="save()"><LoaderCircle v-if="busy" :size="13" class="clip-spin" /><Save v-else :size="13" />Save draft</button><button class="clip-button clip-button-primary" data-testid="clip-export" :disabled="busy || !valid || !editable" @click="openExport"><Download :size="13" />Export</button></div></WorkspaceHeader>
    <div v-if="loading && !recording" class="clips-empty"><LoaderCircle :size="25" class="clip-spin" /><h2>Opening editor</h2></div>
    <div v-else-if="loadFailed || !recording || recording.status !== 'complete'" class="clips-empty"><Film :size="30" /><h2>Recording unavailable</h2><p>{{ error || 'This recording is still being prepared. You can edit it as soon as it is complete.' }}</p><div class="clips-empty-actions"><button class="clip-button" @click="load">Try again</button><RouterLink to="/recordings" class="clip-button">Recording library</RouterLink></div></div>
    <div v-else class="nle-workspace">
      <div v-if="error" class="nle-notice nle-error" role="alert"><span>{{ error }}</span><template v-if="conflict"><button class="clip-link" @click="reloadDraft">Reload saved draft</button><button class="clip-link" :disabled="busy" @click="save(true)">Save a copy</button></template><button v-else class="clip-icon-button" aria-label="Dismiss error" @click="error = ''"><X :size="13" /></button></div>
      <div v-else-if="savedElsewhere" class="nle-notice"><span>A newer version was saved in another window. Your local edits are untouched.</span><button class="clip-link" @click="reloadDraft">Review latest</button></div>
      <div v-if="draft && !draft.canEdit" class="nle-notice"><LockKeyhole :size="13" /><span>{{ draft.ownerName }} owns this draft. Preview it, or make your own copy to edit.</span><button class="clip-link" :disabled="busy" @click="save(true)">Make a copy</button></div>
      <div class="nle-top" :class="{ 'inspector-closed': !inspectorOpen }">
        <nav class="nle-rail" aria-label="Editor tools"><button :class="{ active: tab === 'media' }" aria-label="Media library" @click="activateTab('media')"><FolderOpen :size="19" :stroke-width="1.5" />Media</button><button :class="{ active: tab === 'audio' }" aria-label="Audio library" @click="activateTab('audio')"><Music2 :size="19" :stroke-width="1.5" />Audio</button><button :class="{ active: tab === 'text' }" aria-label="Text tools" @click="activateTab('text')"><Type :size="19" :stroke-width="1.5" />Text</button><button :class="{ active: tab === 'transitions' }" aria-label="Transitions" title="Transitions · T" @click="openTransitions()"><ArrowRightLeft :size="19" :stroke-width="1.5" />Transitions</button><button :class="{ active: tab === 'drafts' }" aria-label="Saved clip drafts" @click="activateTab('drafts')"><Layers :size="19" :stroke-width="1.5" />Drafts</button><button class="nle-import-rail" aria-label="Import video, images or audio" :disabled="!editable || importing" @click="uploadInput?.click()"><Upload :size="18" :stroke-width="1.5" />Import</button></nav>
        <aside class="nle-bin" :class="{ 'mobile-open': mediaPanelOpen }" :aria-label="tab === 'drafts' ? 'Saved clip drafts' : 'Project media'">
          <div class="nle-heading"><h2>{{ tab === 'media' ? 'Project media' : tab === 'audio' ? 'Audio' : tab === 'text' ? 'Text' : tab === 'transitions' ? 'Transitions' : 'Project drafts' }}<span v-if="tab === 'media' || tab === 'audio'">{{ mediaItems.length }}</span></h2><button v-if="tab !== 'transitions'" class="clip-icon-button" :aria-label="tab === 'drafts' ? 'Create a new clip' : 'Import media'" :disabled="!editable || importing || busy" @click="tab === 'drafts' ? newClip() : uploadInput?.click()"><Plus :size="15" /></button><button class="clip-icon-button nle-bin-close" aria-label="Close media panel" @click="mediaPanelOpen = false"><X :size="14" /></button></div>
          <template v-if="tab === 'media' || tab === 'audio'"><label class="nle-bin-search"><Search :size="12" /><input v-model="search" aria-label="Search project media" placeholder="Search media" /></label><div v-if="tab === 'media'" class="nle-bin-tabs"><button :class="{ active: mediaFilter === 'all' }" @click="mediaFilter = 'all'">All media</button><button :class="{ active: mediaFilter === 'video' }" @click="mediaFilter = 'video'">Video</button><button :class="{ active: mediaFilter === 'image' }" @click="mediaFilter = 'image'">Images</button></div>
            <div class="nle-bin-scroll"><div v-if="importing" class="nle-upload-busy"><LoaderCircle :size="13" class="clip-spin" />Importing {{ Math.round(importProgress * 100) }}%</div><div class="nle-media-grid"><article v-for="item in mediaItems" :key="`${item.source.kind}:${item.source.id}`" class="nle-media-card"><button class="nle-media-thumb" :aria-label="`Add ${item.name} to timeline`" :disabled="!editable || busy" @click="addSource(item)"><EditorMediaThumbnail :url="item.url" :kind="item.kind" :poster="item.poster" /><span v-if="item.kind !== 'image'">{{ time(item.durationMs).slice(3) }}</span></button><strong :title="item.name">{{ item.name }}</strong><div class="nle-media-actions"><button :disabled="!editable || busy" :aria-label="`Add ${item.name} to main sequence`" @click="addSource(item)"><Plus :size="9" />{{ item.kind === 'audio' ? 'Audio' : 'Add' }}</button><button v-if="item.kind !== 'audio'" :disabled="!editable || busy" :aria-label="`Overlay ${item.name}`" @click="addSource(item, true)"><Layers :size="9" />Overlay</button></div></article></div><p v-if="!mediaItems.length" class="nle-empty-note">{{ tab === 'audio' ? 'Import music, voiceovers or sound effects to mix with the recording.' : 'Import videos and images, or clear your search.' }}</p></div>
          </template>
          <div v-else-if="tab === 'text'" class="nle-bin-scroll" style="padding-top: 14px"><button class="nle-text-card" :disabled="!editable || busy" @click="addText"><span>Aa</span>Add a text layer <Plus :size="15" /></button><p class="nle-empty-note">Add titles, lower thirds and messages. Edit the text and its styling in the inspector, then drag it into position on the picture.</p></div>
          <EditorTransitions v-else-if="tab === 'transitions'" v-local-fields="`${draft?.id}:${selectedId}`" :timeline="timeline" :selected-id="selectedId" :disabled="!editable || busy" :previewing="playing && !!previewRange" @input.capture="pendingInspector = true" @change.capture="pendingInspector = false" @select="selectedId = $event" @apply="setTransition" @apply-all="setAllTransitions" @preview="previewTransition" />
          <nav v-else class="nle-bin-scroll" aria-label="Clip drafts"><RouterLink v-if="!draft" :to="route.path" class="nle-draft-row active"><Plus :size="14" /><div><strong>New project</strong><small>Not saved yet</small></div></RouterLink><RouterLink v-for="item in drafts" :key="item.id" :to="{ path: route.path, query: { draft: item.id } }" class="nle-draft-row" :class="{ active: item.id === draft?.id }" data-testid="clip-draft" :data-draft-id="item.id"><Film :size="14" /><div><strong>{{ item.name }}</strong><small>{{ item.format }} · {{ item.ownerName }}{{ item.canEdit ? '' : ' · Read only' }}</small></div></RouterLink><p v-if="!drafts.length" class="nle-empty-note">Save your first draft. Teammates can make independent edits from this recording.</p></nav>
          <div v-if="tab !== 'transitions'" class="nle-bin-footer"><button class="clip-button" :disabled="!editable || importing" @click="uploadInput?.click()"><Upload :size="12" />Import media</button><a :href="clipsApi.original(recording.id)" class="clip-link"><Download :size="11" />Download original</a><small>Original media stays untouched.</small></div>
        </aside>
        <EditorPreview :timeline="timeline" :format="fields.format" :current="currentMs" :duration="duration" :playing="playing" :muted="muted" :selected-id="selectedId" :disabled="!editable || busy" :inspector-open="inspectorOpen" :source-url="sourceUrl" @play="togglePlay" @pause="pause" @seek="seek" @mute="muted = !muted" @select="select" @begin="beginGesture" @end="endGesture" @patch="rawPatch" @inspector="inspectorOpen = !inspectorOpen" @error="message => { if (!error) error = message; }" />
        <aside v-if="inspectorOpen" v-local-fields="`${draft?.id}:${selectedId}`" class="nle-inspector" aria-label="Clip properties" @input.capture="pendingInspector = true" @change.capture="pendingInspector = false"><div class="nle-heading"><h2><SlidersHorizontal :size="13" />{{ selected ? selected.item.kind === 'text' ? 'Text settings' : 'Clip settings' : 'Project settings' }}</h2><button class="clip-icon-button" aria-label="Collapse inspector" @click="inspectorOpen = false"><PanelRightClose :size="14" /></button></div><div class="nle-inspector-body">
          <label class="clip-field"><span>Project name</span><input v-model="fields.name" data-testid="clip-name" aria-label="Clip name" maxlength="120" :disabled="!editable || busy" @focus="beginGesture" @blur="endGesture" /></label>
          <div class="clips-format-options"><button v-for="option in (['16:9', '9:16', '1:1'] as ClipFormat[])" :key="option" :class="{ active: fields.format === option }" :aria-pressed="fields.format === option" :aria-label="`Frame format ${option}`" :disabled="!editable || busy" @click="setFormat(option)"><span :style="{ aspectRatio: option.replace(':', ' / '), height: option === '9:16' ? '20px' : option === '1:1' ? '17px' : '13px' }" />{{ option }}</button></div>
          <template v-if="selected">
            <div class="nle-inspector-section"><h3>{{ selected.item.kind === 'text' ? 'Text layer' : 'Selected clip' }}<span class="clips-subtle">{{ selected.track.name }}</span></h3>
              <label class="clip-field"><span>Layer name</span><input :value="selected.item.name" aria-label="Timeline clip name" maxlength="120" :disabled="!canEditItem" @change="patch({ name: ($event.target as HTMLInputElement).value || 'Untitled clip' })" /></label>
              <template v-if="selected.item.kind === 'text'"><label class="clip-field"><span>Text</span><textarea :value="selected.item.text" aria-label="Overlay text" maxlength="2000" :disabled="!canEditItem" @change="patch({ text: ($event.target as HTMLTextAreaElement).value })" /></label><div class="nle-field-grid"><label class="clip-field"><span>Size</span><input :value="selected.item.fontSize" type="number" min="12" max="300" aria-label="Text size" :disabled="!canEditItem" @change="numeric($event, 'fontSize', 12, 300)" /></label><label class="clip-field"><span>Weight</span><select :value="selected.item.fontWeight" aria-label="Text weight" :disabled="!canEditItem" @change="numeric($event, 'fontWeight', 100, 900)"><option :value="400">Regular</option><option :value="600">Semibold</option><option :value="700">Bold</option></select></label><label class="clip-field"><span>Colour</span><input :value="selected.item.color.slice(0, 7)" type="color" aria-label="Text colour" :disabled="!canEditItem" @change="patch({ color: ($event.target as HTMLInputElement).value })" /></label><label class="clip-field"><span>Alignment</span><select :value="selected.item.align" aria-label="Text alignment" :disabled="!canEditItem" @change="patch({ align: ($event.target as HTMLSelectElement).value as 'left' | 'center' | 'right' })"><option value="left">Left</option><option value="center">Centre</option><option value="right">Right</option></select></label></div><label class="clip-field"><span>Text background</span><input :value="selected.item.background.slice(0, 7)" type="color" aria-label="Text background colour" :disabled="!canEditItem" @change="patch({ background: ($event.target as HTMLInputElement).value })" /></label><label class="nle-check"><input type="checkbox" :checked="selected.item.background.length === 9 && selected.item.background.endsWith('00')" :disabled="!canEditItem" @change="patch({ background: ($event.target as HTMLInputElement).checked ? '#00000000' : '#000000' })" />Transparent text background</label></template>
              <div class="nle-field-grid"><label class="clip-field"><span>Timeline start (s)</span><input :value="(selected.item.startMs / 1000).toFixed(2)" type="number" min="0" max="7200" step="0.1" aria-label="Timeline start" :disabled="!canEditItem" @change="numeric($event, 'startMs', 0, MAX_TIMELINE_MS - selected.item.durationMs, .001)" /></label><label class="clip-field"><span>Duration (s)</span><input :value="(selected.item.durationMs / 1000).toFixed(2)" type="number" min="0.1" max="7200" step="0.1" aria-label="Timeline clip duration" :disabled="!canEditItem" @change="numeric($event, 'durationMs', MIN_ITEM_MS, Math.min(sourceDuration(selected.item) - selected.item.inMs, MAX_TIMELINE_MS - selected.item.startMs), .001)" /></label></div>
              <div v-if="selected.item.kind === 'video' || selected.item.kind === 'audio'" class="nle-field-grid"><label class="clip-field"><span>Source in</span><input v-model="startInput" aria-label="Clip start time" :disabled="!canEditItem" inputmode="decimal" @change="commitTime('in')" @keydown.enter="commitTime('in')" /></label><label class="clip-field"><span>Source out</span><input v-model="endInput" aria-label="Clip end time" :disabled="!canEditItem" inputmode="decimal" @change="commitTime('out')" @keydown.enter="commitTime('out')" /></label></div>
            </div>
            <div v-if="selected.item.kind !== 'audio'" class="nle-inspector-section"><h3>Transform<span><button class="clip-icon-button" aria-label="Move track down" title="Send track backward" :disabled="!canEditItem || selectedTrackIndex <= 1" @click="changeTrackOrder(-1)"><ArrowDown :size="12" /></button><button class="clip-icon-button" aria-label="Move track up" title="Bring track forward" :disabled="!canEditItem || selectedTrackIndex <= 0 || selectedTrackIndex >= timeline.tracks.length - 1" @click="changeTrackOrder(1)"><ArrowUp :size="12" /></button></span></h3>
              <div class="nle-field-grid"><label v-for="key in (['x', 'y', 'width', 'height'] as const)" :key="key" class="clip-field"><span>{{ key === 'x' ? 'X position' : key === 'y' ? 'Y position' : key === 'width' ? 'Width' : 'Height' }} %</span><input :value="Math.round(selected.item[key] * 1000) / 10" type="number" :min="key === 'width' || key === 'height' ? 2 : 0" max="100" step="0.1" :aria-label="`Element ${key}`" :disabled="!canEditItem" @change="numeric($event, key, key === 'width' || key === 'height' ? .02 : 0, key === 'x' ? 1 - selected.item.width : key === 'y' ? 1 - selected.item.height : key === 'width' ? 1 - selected.item.x : 1 - selected.item.y, 100)" /></label></div>
              <label class="clip-field clip-slider-field"><span>Opacity<output>{{ Math.round(selected.item.opacity * 100) }}%</output></span><input :value="selected.item.opacity" type="range" min="0" max="1" step="0.01" aria-label="Element opacity" :disabled="!canEditItem" @change="numeric($event, 'opacity', 0, 1)" /></label>
              <template v-if="selected.item.kind !== 'text'"><label class="clip-field"><span>Image fitting</span><select :value="selected.item.fit" aria-label="Image fitting" :disabled="!canEditItem" @change="patch({ fit: ($event.target as HTMLSelectElement).value as 'cover' | 'contain' })"><option value="cover">Fill frame · Crop</option><option value="contain">Fit frame · Black bars</option></select></label><label class="clip-field clip-slider-field"><span>Horizontal crop<output>{{ Math.round(selected.item.positionX * 100) }}%</output></span><input :value="selected.item.positionX" type="range" min="0" max="1" step="0.001" aria-label="Horizontal framing position" :disabled="!canEditItem || selected.item.fit === 'contain'" @change="numeric($event, 'positionX', 0, 1)" /></label><label class="clip-field clip-slider-field"><span>Vertical crop<output>{{ Math.round(selected.item.positionY * 100) }}%</output></span><input :value="selected.item.positionY" type="range" min="0" max="1" step="0.001" aria-label="Vertical framing position" :disabled="!canEditItem || selected.item.fit === 'contain'" @change="numeric($event, 'positionY', 0, 1)" /></label><button class="clip-link" :disabled="!canEditItem" @click="patch({ x: 0, y: 0, width: 1, height: 1, positionX: .5, positionY: .5 })">Reset framing</button></template>
            </div>
            <div v-if="selected.item.kind === 'audio' || selected.item.kind === 'video'" class="nle-inspector-section"><h3>Audio</h3><label class="clip-field clip-slider-field"><span>Volume<output>{{ Math.round(selected.item.volume * 100) }}%</output></span><input :value="selected.item.volume" type="range" min="0" max="1" step="0.01" aria-label="Clip volume" :disabled="!canEditItem" @change="numeric($event, 'volume', 0, 1)" /></label><div class="nle-field-grid"><label class="clip-field"><span>Fade in (s)</span><input :value="(selected.item.audioFadeInMs ?? 0) / 1000" type="number" min="0" :max="Math.min(2, selected.item.durationMs / 2000)" step="0.05" aria-label="Audio fade in" :disabled="!canEditItem" @change="audioFade($event, 'audioFadeInMs')" /></label><label class="clip-field"><span>Fade out (s)</span><input :value="(selected.item.audioFadeOutMs ?? 0) / 1000" type="number" min="0" :max="Math.min(2, selected.item.durationMs / 2000)" step="0.05" aria-label="Audio fade out" :disabled="!canEditItem" @change="audioFade($event, 'audioFadeOutMs')" /></label></div><label class="nle-check"><input :checked="selected.item.muted" type="checkbox" :disabled="!canEditItem" @change="patch({ muted: ($event.target as HTMLInputElement).checked })" />Mute this clip</label><label class="nle-check"><input :checked="selected.track.muted" type="checkbox" :disabled="!editable || busy" @change="trackPatch(selected.track.id, { muted: ($event.target as HTMLInputElement).checked })" />Mute entire track</label><p class="clips-subtle">Only recorded media is mixed here. Live Main audio is never changed.</p></div>
          </template>
          <div v-else class="nle-inspector-section"><h3>Canvas</h3><label class="clip-field"><span>Background</span><input :value="timeline.background" type="color" aria-label="Project background colour" :disabled="!editable || busy" @change="commit(() => { timeline.background = ($event.target as HTMLInputElement).value; })" /></label><p class="clips-subtle">Select a clip on the timeline or picture to trim, position and style it.</p><div class="nle-shortcuts"><span><kbd>Space</kbd>Play</span><span><kbd>S</kbd>Split</span><span><kbd>⌘ Z</kbd>Undo</span><span><kbd>J / L</kbd>Step 1s</span></div></div>
        </div></aside>
      </div>
      <EditorTimeline :timeline="timeline" :current="currentMs" :duration="duration" :selected-id="selectedId" :disabled="!editable || busy" :undo-available="undo.length > 0" :redo-available="redo.length > 0" :thumbnail="thumbnail" :height="timelineHeight" @seek="ms => { pause(); seek(ms); }" @select="select" @move="moveItem" @trim="trimItem" @begin="beginGesture" @end="endGesture" @track="trackPatch" @split="split" @remove="remove" @duplicate="duplicate" @undo="undoEdit" @redo="redoEdit" @add-track="addTrack" @height="timelineHeight = $event" @transition="openTransitions" />
      <footer class="nle-statusbar"><span><ShieldCheck :size="11" />{{ workspace?.liveProtected ? 'Production is protected · Heavy exports wait until idle' : 'Originals protected · Editing is independent of live production' }}</span><span>{{ timeline.tracks.length }} tracks · {{ itemCount() }} clips · {{ time(duration) }}</span></footer>
    </div>
    <input ref="uploadInput" type="file" accept="video/*,image/*,audio/*" multiple hidden aria-label="Import media files" @change="importFiles" />
    <EditorExportDialog v-model:open="exportDialogOpen" :name="fields.name" :format="fields.format" :duration="duration" :live-protected="!!workspace?.liveProtected" :disabled="busy" :error="error" @export="exportClip" />
  </main>
</template>
