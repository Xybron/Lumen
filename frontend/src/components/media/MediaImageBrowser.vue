<script setup lang="ts">
import { computed, nextTick, onBeforeUnmount, onMounted, ref, watch } from 'vue';
import { RouterLink, useRoute } from 'vue-router';
import { ArrowUpRight, Check, CircleCheck, Clapperboard, Images, Layers, LayoutGrid, Link2, List, LoaderCircle, LockKeyhole, Music2, Pencil, Presentation, Radio, RefreshCw, Scissors, Search, ShieldCheck, Trash2, Upload } from 'lucide-vue-next';
import { toast } from 'vue-sonner';
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { LoadingSkeleton, Skeleton } from '@/components/ui/skeleton';
import { api } from '@/lib/api';
import { mediaAssetKind, mediaAssetReference, mediaDuration, mediaImageFormat, mediaImageName, mediaKindLabel, mediaLibraryApi, mediaUsageLabel, mediaUsageUrl, type MediaLibraryAsset, type MediaLibraryKind, type MediaUsage } from '@/lib/media-library';
import { MAX_MEDIA_BYTES, mediaAccept, mediaAssetUrl, mediaExtensions, mediaFileSize, mediaFormatHint } from '@/lib/studio/media-library';
import { useConfirmation } from '@/composables/useConfirmation';
import { useIdentityStore } from '@/stores/identity';
import MediaAssetThumbnail from './MediaAssetThumbnail.vue';
import MediaAssetInspectorPreview from './MediaAssetInspectorPreview.vue';
import '@/styles/media-library.css';

const props = withDefaults(defineProps<{ picker?: boolean; selectedPath?: string; initialAssetId?: string; acceptedKinds?: MediaLibraryKind[] }>(), { picker: false, selectedPath: '', initialAssetId: '' });
const emit = defineEmits<{ select: [asset: MediaLibraryAsset]; cancel: [] }>();
type UsageFilter = 'all' | 'used' | 'unused';
type OriginFilter = 'all' | 'library' | 'clip';
const identity = useIdentityStore(), route = useRoute(), { confirmAction } = useConfirmation();
const assets = ref<MediaLibraryAsset[]>([]), loading = ref(true), refreshing = ref(false), error = ref(''), warning = ref('');
const query = ref(''), usageFilter = ref<UsageFilter>('all'), origin = ref<OriginFilter>('all'), view = ref<'grid' | 'list'>('grid'), order = ref<'recent' | 'name'>('recent');
const kindFilter = ref<'all' | MediaLibraryKind>('all');
const selectedId = ref(''), selecting = ref(false), checkedIds = ref<string[]>([]), deleting = ref(false);
const renameOpen = ref(false), renameId = ref(''), renameName = ref(''), renaming = ref(false), renameError = ref('');
const uploading = ref(false), uploadProgress = ref(0), uploadName = ref(''), uploadNumber = ref(0), uploadTotal = ref(0), dragging = ref(false);
const searchField = ref<HTMLInputElement>(), fileInput = ref<HTMLInputElement>(), renameField = ref<HTMLInputElement>(), inspector = ref<HTMLElement>();
const initialLoaded = ref(false), storageReady = ref(false);
const pickerSelectionNotice = ref(''), measuredMetadata = ref<Record<string, { width?: number; height?: number; durationMs?: number }>>({});
const preparationState = ref<'idle' | 'checking' | 'processing' | 'ready' | 'failed'>('idle'), preparationError = ref(''), preparedPath = ref('');
let listController: AbortController | undefined, uploadController: AbortController | undefined, poll: ReturnType<typeof setInterval> | undefined, mounted = true;
let preparationTimer: ReturnType<typeof setTimeout> | undefined, preparationEpoch = 0;
let dragDepth = 0;
const stateKey = computed(() => `lumen.media.library.v1.${identity.me?.id || 'signed-out'}`);
const busy = computed(() => deleting.value || renaming.value);
const canMutate = computed(() => identity.can('*', 'author'));
const allowedKinds = computed<MediaLibraryKind[]>(() => props.picker ? [...new Set<MediaLibraryKind>(props.acceptedKinds || ['image'])] : ['image', 'video', 'audio']);
const singleKind = computed(() => allowedKinds.value.length === 1 ? allowedKinds.value[0] : null);
const searchLabel = computed(() => singleKind.value ? `Search ${mediaKindLabel(singleKind.value, true)}` : 'Search media');
const uploadLabel = computed(() => singleKind.value ? `Upload ${mediaKindLabel(singleKind.value, true)}` : 'Upload media');
const uploadAccept = computed(() => allowedKinds.value.map(kind => mediaAccept[kind]).join(','));
const uploadHint = computed(() => allowedKinds.value.map(kind => mediaFormatHint[kind]).join(' · '));
const origins = computed(() => assets.value.filter(asset => allowedKinds.value.includes(mediaAssetKind(asset))).filter(asset => !props.picker || asset.origin === 'library').filter(asset => props.picker || origin.value === 'all' || asset.origin === origin.value));
const typedAssets = computed(() => origins.value.filter(asset => kindFilter.value === 'all' || mediaAssetKind(asset) === kindFilter.value));
const usageKnown = (asset: MediaLibraryAsset) => !error.value && asset.usageStatus === 'known';
const unused = (asset: MediaLibraryAsset) => usageKnown(asset) && asset.usage.length === 0;
const counts = computed(() => ({ all: typedAssets.value.length, used: typedAssets.value.filter(asset => asset.usage.length > 0).length, unused: typedAssets.value.filter(unused).length }));
const filters: { id: UsageFilter; label: string }[] = [{ id: 'all', label: 'All' }, { id: 'used', label: 'In use' }, { id: 'unused', label: 'Unused' }];
const visibleAssets = computed(() => {
  const words = query.value.trim().toLocaleLowerCase().split(/\s+/).filter(Boolean);
  return typedAssets.value.filter(asset => (usageFilter.value === 'all' || (usageFilter.value === 'used' ? asset.usage.length > 0 : unused(asset))) &&
    words.every(word => `${mediaImageName(asset)} ${asset.name}`.toLocaleLowerCase().includes(word)))
    .sort((a, b) => order.value === 'name' ? mediaImageName(a).localeCompare(mediaImageName(b)) : (Date.parse(b.modifiedAt) || 0) - (Date.parse(a.modifiedAt) || 0) || mediaImageName(a).localeCompare(mediaImageName(b)));
});
const selected = computed(() => visibleAssets.value.find(asset => asset.id === selectedId.value));
const selectedAssets = computed(() => assets.value.filter(asset => checkedIds.value.includes(asset.id)));
const selectedUnused = computed(() => selectedAssets.value.filter(unused));
const protectedCount = computed(() => selectedAssets.value.length - selectedUnused.value.length);
const allVisibleSelected = computed(() => visibleAssets.value.length > 0 && visibleAssets.value.every(asset => checkedIds.value.includes(asset.id)));
const emptyFiltered = computed(() => !!query.value || usageFilter.value !== 'all' || origin.value !== 'all' || kindFilter.value !== 'all');
const selectionLabel = computed(() => selected.value ? mediaImageName(selected.value) : singleKind.value ? `Select ${singleKind.value === 'video' ? 'a' : 'an'} ${mediaKindLabel(singleKind.value)} to use` : 'Select media to use');
const selectedKind = computed(() => selected.value ? mediaAssetKind(selected.value) : singleKind.value);
const selectedPreview = computed(() => selected.value ? { ...selected.value, ...(preparedPath.value ? { playbackPath: preparedPath.value, playbackUrl: mediaAssetUrl(preparedPath.value) } : {}) } : undefined);
const selectedMetadata = computed(() => selected.value ? { ...measuredMetadata.value[selected.value.id], ...(selected.value.width ? { width: selected.value.width } : {}), ...(selected.value.height ? { height: selected.value.height } : {}), ...(selected.value.durationMs !== undefined ? { durationMs: selected.value.durationMs } : {}) } : {});
const preparing = computed(() => preparationState.value === 'checking' || preparationState.value === 'processing');
const canChoose = computed(() => !!selectedPreview.value && !uploading.value && !error.value && !preparing.value && preparationState.value !== 'failed');
const selectActionLabel = computed(() => `Use ${selectedKind.value || 'media'}`);
const renameKind = computed(() => { const asset = assets.value.find(value => value.id === renameId.value); return asset ? mediaKindLabel(mediaAssetKind(asset)) : 'media'; });
const usageStatus = (asset: MediaLibraryAsset) => !usageKnown(asset) ? 'Usage unavailable' : asset.usage.length ? `Used in ${asset.usage.length} ${asset.usage.length === 1 ? 'place' : 'places'}` : 'Unused';
const usageIcon = (usage: MediaUsage) => ({ source: Clapperboard, presentation: Presentation, background: Layers, program: Radio, output: Radio, routing: Clapperboard, clip: Scissors, export: Scissors, music: Music2 }[usage.type] || Link2);
function modifiedDate(value: string) { return new Date(value).toLocaleDateString(undefined, { day: 'numeric', month: 'short', year: 'numeric' }); }
function resetFilters() { query.value = ''; usageFilter.value = 'all'; origin.value = 'all'; kindFilter.value = 'all'; }
function resultNoun(count: number) { const kind = kindFilter.value !== 'all' ? kindFilter.value : singleKind.value; return kind ? mediaKindLabel(kind, count !== 1) : count === 1 ? 'file' : 'files'; }
function capital(value: string) { return value.charAt(0).toUpperCase() + value.slice(1); }
function assetNoun(asset: MediaLibraryAsset) { return mediaKindLabel(mediaAssetKind(asset)); }
function toggleSelect(id: string) { checkedIds.value = checkedIds.value.includes(id) ? checkedIds.value.filter(value => value !== id) : [...checkedIds.value, id]; }
function showDetails(id: string) {
  selectedId.value = id; pickerSelectionNotice.value = '';
  if (window.matchMedia('(max-width: 720px)').matches) void nextTick(() => inspector.value?.scrollIntoView({ behavior: 'instant', block: 'start' }));
}
function selectVisible() {
  const ids = new Set(checkedIds.value);
  for (const asset of visibleAssets.value) allVisibleSelected.value ? ids.delete(asset.id) : ids.add(asset.id);
  checkedIds.value = [...ids];
}
function changeUsage(next: UsageFilter) { usageFilter.value = next; checkedIds.value = []; }
function statusIcon(asset: MediaLibraryAsset) { return !usageKnown(asset) ? ShieldCheck : asset.usage.length ? Link2 : CircleCheck; }
function persist() {
  if (props.picker || !storageReady.value) return;
  try { sessionStorage.setItem(stateKey.value, JSON.stringify({ query: query.value, filter: usageFilter.value, origin: origin.value, kind: kindFilter.value, view: view.value, order: order.value, selectedId: selectedId.value })); } catch { /* Storage is optional. */ }
}
function restore() {
  if (!props.picker) {
    try {
      const saved = JSON.parse(sessionStorage.getItem(stateKey.value) || '{}');
      if (typeof saved.query === 'string') query.value = saved.query.slice(0, 200);
      if (['all', 'used', 'unused'].includes(saved.filter)) usageFilter.value = saved.filter;
      if (['all', 'library', 'clip'].includes(saved.origin)) origin.value = saved.origin;
      if (['all', 'image', 'video', 'audio'].includes(saved.kind)) kindFilter.value = saved.kind;
      if (['grid', 'list'].includes(saved.view)) view.value = saved.view;
      if (['recent', 'name'].includes(saved.order)) order.value = saved.order;
      if (typeof saved.selectedId === 'string') selectedId.value = saved.selectedId;
    } catch { /* Ignore stale or unavailable session state. */ }
  }
  if (props.initialAssetId) selectedId.value = props.initialAssetId;
  storageReady.value = true;
}
function chooseInitialSelection() {
  const requested = props.selectedPath.replace(/^\/+/, '');
  if (props.picker && requested) {
    selectedId.value = assets.value.find(asset => asset.origin === 'library' && allowedKinds.value.includes(mediaAssetKind(asset)) && ([asset.libraryPath, asset.playbackPath, asset.url, asset.playbackUrl].some(value => value?.replace(/^\/+/, '') === requested) || mediaAssetUrl(requested).replace(/^\/+/, '') === asset.url.replace(/^\/+/, '')))?.id || '';
  }
  if (props.initialAssetId && assets.value.some(asset => asset.id === props.initialAssetId)) {
    selectedId.value = props.initialAssetId;
    // A direct usage return should reveal the requested asset even if its last
    // reference was removed and it no longer matches the previous filter.
    if (!visibleAssets.value.some(asset => asset.id === selectedId.value)) resetFilters();
  }
}
async function load(quiet = false) {
  listController?.abort();
  const controller = new AbortController(); listController = controller;
  if (!quiet && !initialLoaded.value) loading.value = true; else refreshing.value = true;
  try {
    const result = await mediaLibraryApi.list(controller.signal);
    if (controller.signal.aborted || !mounted) return;
    const firstLoad = !initialLoaded.value, previousSelection = selectedId.value;
    assets.value = result.assets; error.value = ''; warning.value = result.warning || '';
    if (firstLoad) chooseInitialSelection();
    initialLoaded.value = true;
    checkedIds.value = checkedIds.value.filter(id => assets.value.some(asset => asset.id === id));
    if (!visibleAssets.value.some(asset => asset.id === selectedId.value)) {
      if (props.picker && !firstLoad) {
        // A collaborator deleting media or changing its usage must never
        // silently change which file the operator is about to insert.
        selectedId.value = '';
        if (previousSelection) pickerSelectionNotice.value = assets.value.some(asset => asset.id === previousSelection)
          ? 'The selected file no longer matches this filter. Choose another file.'
          : 'The selected file is no longer available. Choose another file.';
      } else selectedId.value = visibleAssets.value[0]?.id || '';
    }
  } catch (cause) { if (!controller.signal.aborted && mounted) error.value = (cause as Error).message; }
  finally { if (listController === controller) { loading.value = false; refreshing.value = false; } }
}
function openRename(asset: MediaLibraryAsset) { renameId.value = asset.id; renameName.value = mediaImageName(asset); renameError.value = ''; renameOpen.value = true; }
async function rename() {
  const name = renameName.value.trim();
  if (!name) { renameError.value = 'Enter a display name for this file.'; return; }
  if (renaming.value || !canMutate.value) return;
  renaming.value = true; renameError.value = '';
  try { await mediaLibraryApi.rename(renameId.value, name); renameOpen.value = false; await load(true); toast.success('Media renamed.'); }
  catch (cause) { renameError.value = (cause as Error).message; }
  finally { renaming.value = false; }
}
async function remove(items: MediaLibraryAsset[]) {
  if (busy.value || !canMutate.value) return;
  const candidates = items.filter(unused); if (!candidates.length) return;
  const count = candidates.length, kinds = new Set(candidates.map(mediaAssetKind));
  const noun = kinds.size === 1 ? mediaKindLabel(mediaAssetKind(candidates[0]), count !== 1) : 'files';
  const confirmed = await confirmAction({ title: count === 1 ? `Delete ${noun}?` : `Delete ${count} unused ${noun}?`,
    description: count === 1 ? `“${mediaImageName(candidates[0])}” has no saved or live references.` : `${count} unused ${noun} will be removed from this station.`,
    note: 'The original files and their thumbnails will be permanently removed. Usage is checked again before deletion; files that are in use are protected.',
    confirmLabel: count === 1 ? `Delete ${noun}` : `Delete ${count} ${noun}`, tone: 'danger' });
  if (!confirmed || !mounted) return;
  deleting.value = true;
  try {
    const result = await mediaLibraryApi.remove(candidates.map(asset => asset.id));
    checkedIds.value = checkedIds.value.filter(id => !result.deleted.includes(id));
    if (result.deleted.length) toast.success(result.deleted.length === 1 ? 'Media deleted.' : `${result.deleted.length} files deleted.`);
    if (result.blocked.length) toast.warning(result.blocked.length === 1 ? result.blocked[0].error : `${result.blocked.length} files were kept. ${result.blocked[0].error}`);
    await load(true);
  } catch (cause) { toast.error((cause as Error).message); await load(true); }
  finally { deleting.value = false; }
}
async function uploadFiles(files: File[]) {
  if (uploading.value || busy.value || !canMutate.value || !files.length) return;
  const valid: { file: File; kind: MediaLibraryKind }[] = [], rejected: string[] = [];
  for (const file of files) {
    const kind = allowedKinds.value.find(kind => mediaExtensions[kind].test(file.name));
    if (!kind) rejected.push(`${file.name}: choose a supported ${singleKind.value ? mediaKindLabel(singleKind.value) : 'image, video or audio file'}.`);
    else if (!file.size) rejected.push(`${file.name}: the file is empty.`);
    else if (file.size > MAX_MEDIA_BYTES) rejected.push(`${file.name}: choose a file smaller than 512 MB.`);
    else valid.push({ file, kind });
  }
  if (rejected.length) toast.error(rejected.length === 1 ? rejected[0] : `${rejected.length} files could not be uploaded. ${rejected[0]}`);
  if (!valid.length) return;
  uploading.value = true; uploadTotal.value = valid.length; uploadNumber.value = 0; uploadProgress.value = 0;
  const controller = new AbortController(); uploadController = controller;
  let uploaded = 0, lastId = '';
  const failures: string[] = [];
  for (const { file, kind } of valid) {
    if (controller.signal.aborted || !mounted) break;
    uploadNumber.value++; uploadName.value = file.name; uploadProgress.value = 0;
    try {
      const result = await api.uploadMedia(kind === 'audio' ? 'music' : 'backgrounds', file, { signal: controller.signal, sourceVideo: kind === 'video', onProgress: percent => { uploadProgress.value = percent; } });
      uploaded++; lastId = `${kind === 'audio' ? 'music' : 'library'}:${result.path.split('/').pop() || ''}`;
    } catch (cause) { if (!controller.signal.aborted) failures.push((cause as Error).message); }
  }
  if (mounted) {
    uploading.value = false;
    if (uploaded) { resetFilters(); await load(true); selectedId.value = visibleAssets.value.some(asset => asset.id === lastId) ? lastId : visibleAssets.value[0]?.id || ''; pickerSelectionNotice.value = ''; toast.success(uploaded === 1 ? 'File added to Media.' : `${uploaded} files added to Media.`); }
    if (failures.length) toast.error(`${failures.length} ${failures.length === 1 ? 'upload failed' : 'uploads failed'}. ${failures[0]}`);
  }
  if (uploadController === controller) uploadController = undefined;
}
function uploadInput(event: Event) { const input = event.target as HTMLInputElement; const files = [...input.files || []]; input.value = ''; void uploadFiles(files); }
function dragEnter(event: DragEvent) { if (!event.dataTransfer?.types.includes('Files') || !canMutate.value) return; event.preventDefault(); dragDepth++; dragging.value = true; }
function dragLeave(event: DragEvent) { event.preventDefault(); dragDepth = Math.max(0, dragDepth - 1); if (!dragDepth) dragging.value = false; }
function drop(event: DragEvent) { event.preventDefault(); dragDepth = 0; dragging.value = false; void uploadFiles([...event.dataTransfer?.files || []]); }
async function prepareSelectedVideo() {
  const epoch = ++preparationEpoch;
  if (preparationTimer) clearTimeout(preparationTimer);
  preparationTimer = undefined; preparedPath.value = ''; preparationError.value = ''; preparationState.value = 'idle';
  const asset = selected.value;
  if (!asset || mediaAssetKind(asset) !== 'video' || asset.origin !== 'library' || !/\.mov$/i.test(asset.name)) return;
  if (asset.playbackPath) { preparedPath.value = asset.playbackPath; preparationState.value = 'ready'; return; }
  preparationState.value = 'checking';
  async function check() {
    try {
      const status = await api.sourceVideoStatus(mediaAssetReference(asset!));
      if (epoch !== preparationEpoch || !mounted) return;
      if (status.status === 'ready' && status.path) { preparedPath.value = status.path; preparationState.value = 'ready'; }
      else if (status.status === 'processing') { preparationState.value = 'processing'; preparationTimer = setTimeout(() => { void check(); }, 2000); }
      else { preparationState.value = 'failed'; preparationError.value = 'This video is not ready for playback. Try uploading it again, or choose an MP4 (H.264) file.'; }
    } catch { if (epoch === preparationEpoch && mounted) { preparationState.value = 'failed'; preparationError.value = 'Video preparation could not be checked. Try again when the station is available.'; } }
  }
  await check();
}
function choose() { if (canChoose.value && selectedPreview.value) emit('select', selectedPreview.value); }
function visibilityChanged() { if (!document.hidden && !loading.value && !refreshing.value && !busy.value && !uploading.value) void load(true); }
function keyboard(event: KeyboardEvent) {
  if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === 'k' && !renameOpen.value) { event.preventDefault(); searchField.value?.focus(); searchField.value?.select(); }
}
watch([query, usageFilter, origin, kindFilter, view, order, selectedId], persist);
watch([query, usageFilter, origin, kindFilter], () => {
  checkedIds.value = []; pickerSelectionNotice.value = '';
  if (initialLoaded.value && !visibleAssets.value.some(asset => asset.id === selectedId.value)) selectedId.value = visibleAssets.value[0]?.id || '';
});
watch(() => [selected.value?.id, selected.value?.libraryPath, selected.value?.playbackPath, selected.value?.playbackUrl, selected.value?.preparation], () => { void prepareSelectedVideo(); }, { flush: 'sync' });
watch(() => allowedKinds.value.join(','), () => { kindFilter.value = 'all'; if (initialLoaded.value && !visibleAssets.value.some(asset => asset.id === selectedId.value)) selectedId.value = visibleAssets.value[0]?.id || ''; });
watch(() => props.initialAssetId, id => { if (id) { selectedId.value = id; if (initialLoaded.value && !visibleAssets.value.some(asset => asset.id === id)) resetFilters(); } });
watch(() => route.fullPath, () => { if (!props.picker) persist(); });
onMounted(() => {
  restore(); void load();
  document.addEventListener('visibilitychange', visibilityChanged); window.addEventListener('focus', visibilityChanged); window.addEventListener('lumen:library-imported', visibilityChanged);
  if (!props.picker) window.addEventListener('keydown', keyboard);
  poll = setInterval(() => { if (!document.hidden && !loading.value && !refreshing.value && !busy.value && !uploading.value && !renameOpen.value) void load(true); }, 10000);
});
onBeforeUnmount(() => { mounted = false; preparationEpoch++; if (preparationTimer) clearTimeout(preparationTimer); persist(); listController?.abort(); uploadController?.abort(); if (poll) clearInterval(poll); document.removeEventListener('visibilitychange', visibilityChanged); window.removeEventListener('focus', visibilityChanged); window.removeEventListener('lumen:library-imported', visibilityChanged); window.removeEventListener('keydown', keyboard); });
</script>

<template>
  <section class="media-browser" :class="{ 'media-browser-picker': picker, 'is-dragging': dragging }" :aria-busy="loading" @dragenter="dragEnter" @dragleave="dragLeave" @dragover.prevent @drop="drop">
    <div v-if="dragging" class="media-drop-cover"><Upload :size="34" /><strong>Drop files to add to Media</strong><span>{{ uploadHint }}</span></div>
    <header class="media-titlebar">
      <div v-if="!picker"><h1>Media library</h1><p>Images, videos and audio. One place to manage it all.</p></div>
      <p v-else class="media-picker-intro">Choose from your library or upload a new file.</p>
      <div class="media-title-actions"><button type="button" class="media-button media-button-quiet" aria-label="Refresh media library" :disabled="loading || refreshing || busy" @click="load(true)"><RefreshCw :size="15" :class="{ 'media-spin': refreshing }" /></button><button type="button" class="media-button media-button-primary" :disabled="uploading || busy || !canMutate" @click="fileInput?.click()"><Upload :size="15" />{{ uploadLabel }}</button><input ref="fileInput" class="media-file-input" type="file" :accept="uploadAccept" multiple :aria-label="`${uploadLabel} to Media`" :disabled="uploading || busy || !canMutate" @change="uploadInput" /></div>
    </header>
    <div v-if="uploading" class="media-upload-progress" role="status" aria-live="polite"><div><span><LoaderCircle :size="14" class="media-spin" />{{ uploadProgress === 100 ? 'Saving' : 'Uploading' }} {{ uploadNumber }} of {{ uploadTotal }}</span><strong>{{ uploadName }}</strong><progress :value="uploadProgress" max="100" :aria-label="`Uploading ${uploadName}`" /></div><button type="button" class="media-button" @click="uploadController?.abort()">Cancel upload</button></div>
    <div class="media-controls"><label class="media-search"><Search :size="16" /><input ref="searchField" v-model="query" type="search" :placeholder="`${searchLabel}…`" :aria-label="searchLabel" maxlength="200" /></label><select v-if="allowedKinds.length > 1" v-model="kindFilter" aria-label="Media type"><option value="all">All types</option><option v-if="allowedKinds.includes('image')" value="image">Images</option><option v-if="allowedKinds.includes('video')" value="video">Videos</option><option v-if="allowedKinds.includes('audio')" value="audio">Audio</option></select><select v-if="!picker" v-model="origin" aria-label="Media location"><option value="all">All locations</option><option value="library">Media library</option><option value="clip">Clip editor</option></select><select v-model="order" :aria-label="singleKind === 'image' ? 'Sort images' : 'Sort media'"><option value="recent">Recently added</option><option value="name">Name A–Z</option></select><button type="button" class="media-button media-view-toggle" :aria-label="view === 'grid' ? 'Switch to list view' : 'Switch to grid view'" @click="view = view === 'grid' ? 'list' : 'grid'"><List v-if="view === 'grid'" :size="16" /><LayoutGrid v-else :size="16" /></button></div>
    <div class="media-filters"><div role="group" aria-label="Filter by media usage"><button v-for="filter in filters" :key="filter.id" type="button" :aria-pressed="usageFilter === filter.id" :data-testid="`media-filter-${filter.id}`" @click="changeUsage(filter.id)">{{ filter.label }}<span>{{ loading ? '—' : counts[filter.id] }}</span></button></div><button v-if="!picker && assets.length" type="button" class="media-button media-button-quiet" :disabled="busy" @click="selecting = !selecting; checkedIds = []"><Check v-if="selecting" :size="14" />{{ selecting ? 'Done' : 'Select' }}</button></div>
    <div v-if="error || warning" class="media-error" :role="error ? 'alert' : 'status'"><ShieldCheck :size="17" /><div><strong>{{ error ? 'Media could not be refreshed' : 'Some usage could not be verified' }}</strong><p>{{ error || warning }}</p><p v-if="assets.length">Deletion is protected until usage can be checked.</p></div><button type="button" class="media-button" :disabled="refreshing" @click="load(true)">Try again</button></div>
    <LoadingSkeleton v-if="loading" class="media-loading" label="Loading media library"><div class="media-loading-grid"><div v-for="n in 9" :key="n"><Skeleton height="auto" class="media-loading-image" /><Skeleton :width="n % 2 ? '78%' : '62%'" :height="12" /><Skeleton width="45%" :height="10" /></div></div><div class="media-loading-inspector"><Skeleton height="auto" class="media-loading-image" /><Skeleton width="78%" :height="16" /><Skeleton v-for="n in 3" :key="n" height="62px" /></div></LoadingSkeleton>
    <template v-else>
      <div class="media-content" :class="{ 'media-content-empty': !assets.length }">
        <div class="media-library-main">
          <div v-if="selecting" class="media-selection-bar"><label><input type="checkbox" :checked="allVisibleSelected" :disabled="busy || !visibleAssets.length" aria-label="Select all visible media" @change="selectVisible" /><span>{{ checkedIds.length }} selected<small v-if="protectedCount"> · {{ protectedCount }} protected</small></span></label><button type="button" class="media-button media-button-danger" :disabled="!selectedUnused.length || busy || !canMutate" @click="remove(selectedUnused)"><LoaderCircle v-if="deleting" :size="14" class="media-spin" /><Trash2 v-else :size="14" />Delete unused ({{ selectedUnused.length }})</button></div>
          <div v-if="visibleAssets.length" class="media-asset-grid" :class="{ 'media-asset-list': view === 'list' }" data-testid="media-grid">
            <article v-for="asset in visibleAssets" :key="asset.id" class="media-asset" :class="{ 'is-selected': selectedId === asset.id, 'is-checked': checkedIds.includes(asset.id), 'is-selecting': selecting }" :data-asset-id="asset.id" :data-asset-kind="mediaAssetKind(asset)">
              <label v-if="selecting" class="media-asset-check"><input type="checkbox" :checked="checkedIds.includes(asset.id)" :aria-label="`Select ${mediaImageName(asset)}`" :disabled="busy" @change="toggleSelect(asset.id)" /></label>
              <button type="button" class="media-asset-button" :aria-pressed="selectedId === asset.id" :aria-label="`${mediaImageName(asset)}, ${assetNoun(asset)}, ${usageStatus(asset)}`" @click="showDetails(asset.id)">
                <MediaAssetThumbnail :asset="asset" /><span class="media-asset-copy"><strong :title="mediaImageName(asset)">{{ mediaImageName(asset) }}</strong><small>{{ mediaImageFormat(asset) }} · {{ mediaFileSize(asset.bytes) }}<template v-if="mediaAssetKind(asset) !== 'image' && asset.durationMs !== undefined"> · {{ mediaDuration(asset.durationMs) }}</template></small><span class="media-asset-status" :class="{ 'is-used': asset.usage.length > 0, 'is-unknown': !usageKnown(asset) }"><component :is="statusIcon(asset)" :size="12" />{{ usageStatus(asset) }}</span></span>
              </button><span v-if="asset.origin === 'clip'" class="media-origin-badge"><LockKeyhole :size="10" />Clip editor</span>
            </article>
          </div>
          <div v-else class="media-empty"><Images :size="32" /><h2>{{ error && !assets.length ? 'The library is unavailable' : emptyFiltered ? `No matching ${resultNoun(2)}` : 'Your media library starts here' }}</h2><p>{{ error && !assets.length ? 'Try refreshing when your connection is available.' : emptyFiltered ? usageFilter === 'unused' ? 'No files are confirmed unused with these filters.' : 'Try another search or choose a different filter.' : 'Upload media once, then reuse it in sources and presentations.' }}</p><button v-if="emptyFiltered" type="button" class="media-button" @click="resetFilters">Clear filters</button><button v-else-if="!error" type="button" class="media-button media-button-primary" :disabled="uploading || !canMutate" @click="fileInput?.click()"><Upload :size="15" />{{ uploadLabel }}</button></div>
          <p class="media-grid-footer" role="status" aria-live="polite">{{ visibleAssets.length }} {{ resultNoun(visibleAssets.length) }}<span v-if="!picker"> · Usage includes saved content and live outputs.</span></p>
        </div>
        <aside v-if="selected" ref="inspector" class="media-inspector" :aria-label="`${capital(selectedKind || 'media')} details`" data-testid="media-inspector">
          <div class="media-eyebrow">{{ capital(selectedKind || 'media') }} details</div><MediaAssetInspectorPreview v-if="selectedPreview" :asset="selectedPreview" :preparing="preparing" :preparation-error="preparationError" @metadata="value => { measuredMetadata[value.id] = { ...measuredMetadata[value.id], ...value }; }" @retry="prepareSelectedVideo" /><h2>{{ mediaImageName(selected) }}</h2><p class="media-file-meta">{{ mediaImageFormat(selected) }} · {{ mediaFileSize(selected.bytes) }}<template v-if="selectedMetadata.width && selectedMetadata.height"> · {{ selectedMetadata.width }} × {{ selectedMetadata.height }}</template><template v-if="selectedKind !== 'image' && selectedMetadata.durationMs !== undefined"> · {{ mediaDuration(selectedMetadata.durationMs) }}</template><br />{{ selected.origin === 'clip' ? 'Clip editor · Private asset' : `Media library · Uploaded ${assetNoun(selected)}` }}<br />Added {{ modifiedDate(selected.modifiedAt) }}</p>
          <div class="media-inspector-divider" /><h3 class="media-usage-title"><component :is="statusIcon(selected)" :size="15" />{{ usageStatus(selected) }}</h3>
          <p v-if="!usageKnown(selected)" class="media-help">Usage could not be checked. Refresh the library before deleting this file.</p>
          <div v-if="selected.usage.length" class="media-usage-list"><component :is="picker ? 'div' : RouterLink" v-for="usage in selected.usage" :key="usage.id" :to="picker ? undefined : mediaUsageUrl(usage, selected.id)" class="media-usage" :class="{ 'media-usage-readonly': picker }" :aria-label="picker ? undefined : `Open ${mediaUsageLabel(usage)}: ${usage.label}. ${usage.detail}`"><component :is="usageIcon(usage)" :size="15" /><span><strong>{{ usage.label }}</strong><small>{{ mediaUsageLabel(usage) }}<span v-if="usage.live" class="media-live-badge">Live</span></small><small>{{ usage.detail }}</small></span><ArrowUpRight v-if="!picker" :size="14" /></component></div>
          <p v-else-if="usageKnown(selected)" class="media-help">No saved or live references. This file can be deleted.</p>
          <template v-if="!picker"><div class="media-inspector-divider" /><div class="media-inspector-actions"><button type="button" class="media-button" :disabled="busy || !canMutate" @click="openRename(selected)"><Pencil :size="14" />Rename</button><button type="button" class="media-button media-button-danger" :disabled="!unused(selected) || busy || !canMutate" aria-describedby="media-delete-help" @click="remove([selected])"><LoaderCircle v-if="deleting" :size="14" class="media-spin" /><Trash2 v-else :size="14" />Delete</button></div><p id="media-delete-help" class="media-help">{{ selected.usage.length ? 'Remove or replace this file in every location above before deleting it.' : !usageKnown(selected) ? 'Deletion is protected until usage can be verified.' : 'Deleting removes this file and its thumbnails from the station.' }}</p></template>
          <p v-if="selected.origin === 'clip'" class="media-help media-private-note"><LockKeyhole :size="13" />Private to the Clip editor. Reusing it in Studio requires an explicit copy to the media library.</p>
        </aside>
      </div>
    </template>
    <p v-if="pickerSelectionNotice" class="media-help" role="status">{{ pickerSelectionNotice }}</p>
    <footer v-if="picker" class="media-picker-footer"><span :title="selectionLabel">{{ selectionLabel }}</span><div><button type="button" class="media-button" @click="emit('cancel')">Cancel</button><button type="button" class="media-button media-button-primary" :disabled="!canChoose" @click="choose">{{ selectActionLabel }}</button></div></footer>
    <Dialog v-if="!picker" v-model:open="renameOpen"><DialogContent class="media-rename-dialog" @open-auto-focus="event => { event.preventDefault(); nextTick(() => renameField?.focus()); }"><DialogHeader><DialogTitle>Rename {{ renameKind }}</DialogTitle><DialogDescription>Give this file a recognizable name in your library.</DialogDescription></DialogHeader><form @submit.prevent="rename"><label class="media-rename-label">Display name<input ref="renameField" v-model="renameName" maxlength="160" autocomplete="off" :disabled="renaming" /></label><p v-if="renameError" class="media-rename-error" role="alert">{{ renameError }}</p><DialogFooter><button type="button" class="media-button" :disabled="renaming" @click="renameOpen = false">Cancel</button><button type="submit" class="media-button media-button-primary" :disabled="renaming || !renameName.trim()"><LoaderCircle v-if="renaming" :size="14" class="media-spin" />Save name</button></DialogFooter></form></DialogContent></Dialog>
  </section>
</template>
