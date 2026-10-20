<script setup lang="ts">
import { computed, nextTick, onBeforeUnmount, ref, watch } from 'vue';
import { toast } from 'vue-sonner';
import { Camera, Monitor, Mic, Image, Film, Music2, Presentation, Upload, LoaderCircle, Search, Check, FolderOpen, RefreshCw, X, ArrowUpRight, ShieldCheck } from 'lucide-vue-next';
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogDescription } from '@/components/ui/dialog';
import MediaAssetPreview from './MediaAssetPreview.vue';
import { api, type MediaLibraryFile } from '@/lib/api';
import { shortId } from '@/lib/ids';
import { mediaAccept, mediaAssetUrl, mediaDisplayName, mediaExtensions, mediaFileSize, mediaFilesForKind, mediaFormatHint, mediaSourceName, MAX_MEDIA_BYTES, type MediaAssetKind } from '@/lib/studio/media-library';
import { useContentStore } from '@/stores/content';
import { useStudioStore } from '@/stores/studio';
import type { StudioSource } from '../../../../shared/production';

const open = defineModel<boolean>('open', { required: true });
const studio = useStudioStore(), content = useContentStore();
const kind = ref<StudioSource['kind']>('camera'), name = ref(''), nameEdited = ref(false), url = ref(''), channelId = ref('');
const adding = ref(false), error = ref(''), libraryError = ref(''), files = ref<MediaLibraryFile[]>([]), query = ref(''), listing = ref(false);
const devices = ref<MediaDeviceInfo[]>([]), videoDevice = ref(''), audioDevice = ref(''), withAudio = ref(false);
const uploading = ref(false), progress = ref(0), pendingFile = ref<File | null>(null), localPreview = ref(''), justUploaded = ref('');
const uploadInput = ref<HTMLInputElement>(), dragDepth = ref(0), brokenThumbs = ref(new Set<string>());
const previewDetail = ref<HTMLElement>();
let epoch = 0, uploadSequence = 0, listSequence = 0;
let uploadController: AbortController | undefined, listController: AbortController | undefined;

const kinds = [
  { id: 'camera', label: 'Camera / OBS', hint: 'Webcam or virtual camera', icon: Camera, group: 'Live inputs' },
  { id: 'screen', label: 'Screen share', hint: 'A display, window, or tab', icon: Monitor, group: 'Live inputs' },
  { id: 'microphone', label: 'Microphone', hint: 'Audio interface or mic', icon: Mic, group: 'Live inputs' },
  { id: 'image', label: 'Image', hint: 'Artwork, logo, or backdrop', icon: Image, group: 'Media library' },
  { id: 'video', label: 'Video', hint: 'A film or motion background', icon: Film, group: 'Media library' },
  { id: 'audio', label: 'Audio file', hint: 'Music or a recorded message', icon: Music2, group: 'Media library' },
  { id: 'channel', label: 'Presentation', hint: 'An existing Lumen channel', icon: Presentation, group: 'Channels' },
] as const;
const activeKind = computed(() => kinds.find(item => item.id === kind.value)!);
const mediaKind = computed<MediaAssetKind | null>(() => ['image', 'video', 'audio'].includes(kind.value) ? kind.value as MediaAssetKind : null);
const libraryTitle = computed(() => kind.value === 'image' ? 'Images' : kind.value === 'video' ? 'Videos' : 'Audio files');
const matchingFiles = computed(() => mediaKind.value ? mediaFilesForKind(files.value, mediaKind.value, query.value) : []);
const totalFiles = computed(() => mediaKind.value ? mediaFilesForKind(files.value, mediaKind.value).length : 0);
const selected = computed(() => files.value.find(file => file.path === url.value));
const selectedName = computed(() => pendingFile.value?.name ?? (selected.value ? mediaDisplayName(selected.value.name) : ''));
const previewSrc = computed(() => localPreview.value || (url.value ? mediaAssetUrl(url.value) : ''));
const previewPoster = computed(() => selected.value?.thumbnail ? mediaAssetUrl(selected.value.thumbnail) : undefined);
const selectedBytes = computed(() => mediaFileSize(pendingFile.value?.size ?? selected.value?.bytes));
const canAdd = computed(() => !!name.value.trim() && !adding.value && !uploading.value && (!mediaKind.value || !!url.value) && (kind.value !== 'channel' || !!channelId.value));
const targetHint = computed(() => ['audio', 'microphone'].includes(kind.value)
  ? 'Audio starts muted. Use Set as Main in Audio mixer, or unmute it there.'
  : 'Added to Preview. Program stays unchanged until you Cut or Fade.');

function clearLocalPreview() {
  if (localPreview.value) URL.revokeObjectURL(localPreview.value);
  localPreview.value = '';
}
function stopUpload() {
  uploadSequence++;
  uploadController?.abort(); uploadController = undefined;
  uploading.value = false; pendingFile.value = null; progress.value = 0;
  clearLocalPreview();
}
function invalidate() {
  epoch++; listSequence++;
  listController?.abort(); listController = undefined; listing.value = false;
  stopUpload(); dragDepth.value = 0;
}
async function loadFiles() {
  const assetKind = mediaKind.value;
  if (!open.value || !assetKind) return;
  const context = epoch, sequence = ++listSequence;
  listController?.abort();
  const controller = new AbortController(); listController = controller;
  listing.value = true; libraryError.value = '';
  try {
    const result = await api.listMedia(assetKind === 'audio' ? 'music' : 'backgrounds', controller.signal);
    if (open.value && context === epoch && sequence === listSequence) files.value = result;
  } catch (cause) {
    if (!controller.signal.aborted && context === epoch && sequence === listSequence) libraryError.value = 'The media library could not be loaded. Check the station connection and try again.';
  } finally {
    if (context === epoch && sequence === listSequence) listing.value = false;
  }
}
watch(open, value => {
  invalidate();
  if (!value) return;
  name.value = ''; nameEdited.value = false; url.value = ''; query.value = ''; files.value = [];
  error.value = ''; libraryError.value = ''; justUploaded.value = ''; brokenThumbs.value = new Set(); withAudio.value = false;
  const context = epoch;
  void content.load().catch(() => { if (open.value && context === epoch && kind.value === 'channel') error.value = 'Channels could not be loaded. Close this window and try again.'; });
  // Enumerating labels never requests device access. Capture is still explicit.
  void navigator.mediaDevices?.enumerateDevices().then(result => { if (open.value && context === epoch) devices.value = result; }).catch(() => {});
  void loadFiles();
}, { flush: 'sync' });
watch(kind, () => {
  invalidate();
  url.value = ''; files.value = []; query.value = ''; error.value = ''; libraryError.value = ''; justUploaded.value = ''; brokenThumbs.value = new Set();
  if (!nameEdited.value) name.value = '';
  void loadFiles();
}, { flush: 'sync' });
onBeforeUnmount(invalidate);

function choose(file: MediaLibraryFile) {
  if (adding.value) return;
  stopUpload(); error.value = ''; url.value = file.path;
  if (!nameEdited.value) name.value = mediaSourceName(file.name);
  revealPreview();
}
function revealPreview() {
  const context = epoch;
  void nextTick(() => {
    if (open.value && context === epoch && window.matchMedia('(max-width: 700px)').matches) previewDetail.value?.scrollIntoView({ block: 'nearest', behavior: 'auto' });
  });
}
function thumb(file: MediaLibraryFile): string | undefined {
  if (brokenThumbs.value.has(file.path)) return;
  const relative = file.thumbnail || (kind.value === 'image' ? file.path : undefined);
  return relative ? mediaAssetUrl(relative) : undefined;
}
function thumbnailFailed(path: string) { brokenThumbs.value = new Set([...brokenThumbs.value, path]); }
function dateLabel(value?: string) {
  const date = value ? new Date(value) : null;
  return date && !Number.isNaN(date.getTime()) ? date.toLocaleDateString(undefined, { day: 'numeric', month: 'short', year: 'numeric' }) : '';
}
async function uploadFile(file: File) {
  const assetKind = mediaKind.value;
  if (!assetKind || adding.value) return;
  if (!mediaExtensions[assetKind].test(file.name)) { error.value = 'Choose ' + mediaFormatHint[assetKind] + ' for this source type.'; return; }
  if (!file.size) { error.value = 'This file is empty. Choose another file.'; return; }
  if (file.size > MAX_MEDIA_BYTES) { error.value = 'This file is larger than 200 MB. Choose a smaller file.'; return; }
  stopUpload();
  const context = epoch, sequence = uploadSequence;
  const controller = new AbortController(); uploadController = controller;
  uploading.value = true; pendingFile.value = file; error.value = ''; url.value = ''; justUploaded.value = '';
  localPreview.value = URL.createObjectURL(file);
  if (!nameEdited.value) name.value = mediaSourceName(file.name);
  revealPreview();
  try {
    const result = await api.uploadMedia(assetKind === 'audio' ? 'music' : 'backgrounds', file, {
      signal: controller.signal,
      onProgress: value => { if (context === epoch && sequence === uploadSequence) progress.value = value; },
    });
    if (!open.value || context !== epoch || sequence !== uploadSequence) return;
    const uploaded: MediaLibraryFile = { name: result.path.split('/').pop() ?? file.name, path: result.path, thumbnail: result.thumbnail, bytes: file.size, modifiedAt: new Date().toISOString() };
    files.value = [uploaded, ...files.value.filter(item => item.path !== result.path)];
    url.value = result.path; justUploaded.value = result.path;
    pendingFile.value = null; clearLocalPreview();
    void loadFiles();
  } catch (cause) {
    if (controller.signal.aborted || !open.value || context !== epoch || sequence !== uploadSequence) return;
    error.value = 'Upload failed. Check your connection or choose another file, then try again.';
    pendingFile.value = null; clearLocalPreview();
  } finally {
    if (context === epoch && sequence === uploadSequence) { uploading.value = false; uploadController = undefined; }
  }
}
function fileChanged(event: Event) {
  const input = event.target as HTMLInputElement, file = input.files?.[0];
  input.value = '';
  if (file) void uploadFile(file);
}
function hasFiles(event: DragEvent) { return Array.from(event.dataTransfer?.types ?? []).includes('Files'); }
function dragEnter(event: DragEvent) { if (hasFiles(event) && mediaKind.value && !adding.value) { event.preventDefault(); dragDepth.value++; } }
function dragLeave(event: DragEvent) { if (hasFiles(event)) { event.preventDefault(); dragDepth.value = Math.max(0, dragDepth.value - 1); } }
function dragOver(event: DragEvent) { if (hasFiles(event)) { event.preventDefault(); if (event.dataTransfer) event.dataTransfer.dropEffect = adding.value ? 'none' : 'copy'; } }
function drop(event: DragEvent) {
  if (!hasFiles(event)) return;
  event.preventDefault(); dragDepth.value = 0;
  if (adding.value) return;
  const dropped = Array.from(event.dataTransfer?.files ?? []);
  if (dropped.length !== 1) { error.value = 'Choose one file at a time.'; return; }
  void uploadFile(dropped[0]);
}
function galleryKeys(event: KeyboardEvent) {
  if (!['ArrowRight', 'ArrowLeft', 'ArrowDown', 'ArrowUp', 'Home', 'End'].includes(event.key) || event.altKey || event.ctrlKey || event.metaKey) return;
  const grid = event.currentTarget as HTMLElement, buttons = Array.from(grid.querySelectorAll<HTMLButtonElement>('.source-asset'));
  const index = buttons.indexOf(event.target as HTMLButtonElement);
  if (index < 0) return;
  const columns = Math.max(1, getComputedStyle(grid).gridTemplateColumns.split(' ').length);
  const step = event.key === 'ArrowDown' ? columns : event.key === 'ArrowUp' ? -columns : event.key === 'ArrowLeft' ? -1 : 1;
  const next = event.key === 'Home' ? 0 : event.key === 'End' ? buttons.length - 1 : Math.max(0, Math.min(buttons.length - 1, index + step));
  event.preventDefault(); buttons[next]?.focus();
}
async function add() {
  if (!canAdd.value) return;
  adding.value = true; error.value = '';
  const context = epoch, source: StudioSource = {
    id: shortId('input'), name: name.value.trim(), kind: kind.value, loop: true,
    ...(mediaKind.value ? { url: url.value } : {}), ...(kind.value === 'channel' ? { channelId: channelId.value } : {}),
    audio: { volume: 0.8, muted: true, mode: ['microphone', 'audio'].includes(kind.value) ? 'always' : 'follow', delayMs: 0 },
  };
  try {
    await studio.addSource(source);
    if (!open.value || context !== epoch) return;
    if (['camera', 'screen', 'microphone'].includes(source.kind)) {
      try { await studio.connectSource(source, videoDevice.value, audioDevice.value, withAudio.value); }
      catch (cause) { toast.error('Source saved, but device access failed: ' + (cause as Error).message + '. Connect it again from Sources.'); }
    }
    open.value = false;
  } catch (cause) { if (open.value && context === epoch) error.value = (cause as Error).message; }
  finally { adding.value = false; }
}
</script>

<template>
  <Dialog v-model:open="open">
    <DialogContent class="studio-dialog source-dialog" :show-close-button="!adding" @escape-key-down="adding && $event.preventDefault()" @interact-outside="adding && $event.preventDefault()">
      <DialogHeader class="source-header">
        <DialogTitle>Add a source</DialogTitle>
        <DialogDescription>Live inputs, media and channels. One place to build your scene.</DialogDescription>
      </DialogHeader>
      <form class="source-form" @submit.prevent="add">
        <div class="source-body">
          <nav class="source-sidebar" role="group" aria-label="Source type">
            <template v-for="(item, index) in kinds" :key="item.id">
              <span v-if="index === 0 || item.group !== kinds[index - 1].group" class="source-group-label">{{ item.group }}</span>
              <button type="button" :class="{ chosen: kind === item.id }" :aria-label="item.label" :aria-pressed="kind === item.id" :title="item.hint" :disabled="adding" @click="kind = item.id">
                <component :is="item.icon" :size="16" /><span>{{ item.label }}</span>
              </button>
            </template>
            <p class="source-station-note"><ShieldCheck :size="13" /><span>Stored on this station</span></p>
          </nav>

          <section v-if="mediaKind" class="source-media-workspace" @dragenter="dragEnter" @dragleave="dragLeave" @dragover="dragOver" @drop="drop">
            <div class="source-library">
              <div class="source-library-heading"><h3>{{ libraryTitle }}</h3><span>{{ totalFiles }} {{ totalFiles === 1 ? 'asset' : 'assets' }}</span><button type="button" class="source-small-icon" aria-label="Refresh media library" title="Refresh library" :disabled="listing" @click="loadFiles"><RefreshCw :size="13" :class="{ spin: listing }" /></button></div>
              <div class="source-library-tools">
                <label class="source-search"><Search :size="15" /><input v-model="query" aria-label="Search media" placeholder="Search media…" type="search" @keydown.enter.prevent /><button v-if="query" type="button" aria-label="Clear media search" @click="query = ''"><X :size="12" /></button></label>
                <button type="button" class="source-upload-button" :disabled="adding" @click="uploadInput?.click()"><Upload :size="14" /><span>Upload</span></button>
                <input ref="uploadInput" class="source-file-input" type="file" :accept="mediaAccept[mediaKind]" aria-label="Upload media" data-testid="source-media-upload" tabindex="-1" :disabled="adding" @change="fileChanged" />
              </div>
              <p v-if="libraryError" class="source-library-error" role="alert">{{ libraryError }}<button type="button" @click="loadFiles">Try again</button></p>
              <div v-if="listing && !files.length" class="source-grid-loading" aria-label="Loading media library"><span v-for="n in 6" :key="n" /><span class="sr-only">Loading media library…</span></div>
              <div v-else-if="matchingFiles.length" class="source-media-grid" :class="{ 'audio-grid': mediaKind === 'audio' }" data-testid="source-media-grid" role="group" aria-label="Media library" @keydown="galleryKeys">
                <button v-for="file in matchingFiles" :key="file.path" type="button" class="source-asset" :class="{ selected: url === file.path }" :aria-label="'Select ' + mediaDisplayName(file.name)" :aria-pressed="url === file.path" :disabled="adding" :title="mediaDisplayName(file.name)" @click="choose(file)">
                  <span class="source-asset-image" :class="{ 'source-audio-tile': mediaKind === 'audio' }">
                    <img v-if="thumb(file)" :src="thumb(file)" alt="" loading="lazy" decoding="async" @error="thumbnailFailed(file.path)" />
                    <component :is="activeKind.icon" v-else :size="25" :stroke-width="1.3" />
                    <span v-if="mediaKind === 'video'" class="source-video-badge"><Film :size="11" />VIDEO</span>
                    <span v-if="url === file.path" class="source-selected-check"><Check :size="12" /></span>
                  </span>
                  <span class="source-asset-caption"><b>{{ mediaDisplayName(file.name) }}</b><small>{{ file.name.split('.').pop()?.toUpperCase() }}<span v-if="file.bytes !== undefined"> · {{ mediaFileSize(file.bytes) }}</span></small></span>
                </button>
              </div>
              <div v-else-if="!libraryError" class="source-library-empty">
                <component :is="query ? Search : FolderOpen" :size="30" :stroke-width="1.2" />
                <h4>{{ query ? 'No matching files' : 'Your media belongs here' }}</h4>
                <p>{{ query ? 'Try a different name or clear your search.' : 'Drop a file here, or upload one to get started.' }}</p>
                <button type="button" class="s-button" @click="query ? query = '' : uploadInput?.click()">{{ query ? 'Clear search' : 'Choose a file' }}<ArrowUpRight :size="12" /></button>
              </div>
              <div class="source-library-footnote"><span>{{ mediaFormatHint[mediaKind] }}</span><span>Up to 200 MB</span></div>
            </div>

            <aside ref="previewDetail" class="source-detail" aria-label="Selected media">
              <div data-testid="source-media-preview">
                <MediaAssetPreview :kind="mediaKind" :src="previewSrc" :name="selectedName" :poster="previewPoster" />
              </div>
              <div v-if="selectedName" class="source-file-detail"><b :title="selectedName">{{ selectedName }}</b><span>{{ selectedBytes }}<template v-if="selectedBytes && selected?.modifiedAt"> · </template>{{ dateLabel(selected?.modifiedAt) }}</span><small v-if="url && url === justUploaded && !uploading"><Check :size="11" />Uploaded to library</small></div>
              <div v-if="uploading" class="source-upload-progress" role="status" aria-live="polite"><div><span>{{ progress >= 100 ? 'Finishing upload…' : 'Uploading… ' + progress + '%' }}</span><button type="button" @click="stopUpload" aria-label="Cancel upload"><X :size="13" /></button></div><progress :value="progress" max="100" aria-label="Upload progress" /><small>Your preview is ready. Add once the file is saved.</small></div>
              <label class="studio-field source-name-field">Name<input v-model="name" placeholder="Name this source" maxlength="100" required :disabled="adding" @input="nameEdited = true" /></label>
              <p class="source-detail-help">Use a clear name so your team can find this source in Studio.</p>
              <p class="source-preview-note"><Monitor :size="13" />Preview is local to this window.</p>
            </aside>
            <div v-if="dragDepth > 0" class="source-drop-overlay"><Upload :size="28" /><b>Drop to upload</b><span>{{ mediaFormatHint[mediaKind] }} · Up to 200 MB</span></div>
          </section>

          <section v-else class="source-input-workspace">
            <div class="source-input-intro"><span class="source-input-icon"><component :is="activeKind.icon" :size="29" :stroke-width="1.3" /></span><div><h3>{{ activeKind.label }}</h3><p>{{ activeKind.hint }}</p></div></div>
            <div class="source-input-properties">
              <label class="studio-field">Name<input v-model="name" :placeholder="kind === 'camera' ? 'e.g. Main camera' : kind === 'microphone' ? 'e.g. Preacher microphone' : kind === 'channel' ? 'e.g. Scripture overlay' : 'e.g. Presentation display'" maxlength="100" required :disabled="adding" @input="nameEdited = true" /></label>
              <label v-if="kind === 'channel'" class="studio-field">Presentation channel<select v-model="channelId" :disabled="adding"><option value="">Choose a channel…</option><option v-for="channel in content.channels" :key="channel.id" :value="channel.id">{{ channel.name }}</option></select></label>
              <template v-if="kind === 'camera'">
                <label class="studio-field">Video device<select v-model="videoDevice" :disabled="adding"><option value="">Default camera</option><option v-for="(device, i) in devices.filter(d => d.kind === 'videoinput')" :key="device.deviceId" :value="device.deviceId">{{ device.label || 'Camera ' + (i + 1) }}</option></select></label>
                <label class="studio-check"><input v-model="withAudio" type="checkbox" :disabled="adding" /> Include microphone audio</label>
                <p class="studio-help">Using OBS? Start its Virtual Camera, then select it as your video device.</p>
              </template>
              <label v-if="kind === 'microphone' || (kind === 'camera' && withAudio)" class="studio-field">Audio device<select v-model="audioDevice" :disabled="adding"><option value="">Default microphone</option><option v-for="(device, i) in devices.filter(d => d.kind === 'audioinput')" :key="device.deviceId" :value="device.deviceId">{{ device.label || 'Microphone ' + (i + 1) }}</option></select></label>
            </div>
            <div class="source-input-note"><component :is="kind === 'channel' ? Presentation : ShieldCheck" :size="17" /><p v-if="kind === 'channel'">The channel stays connected. Scripture, lyrics and slide changes update this source wherever it is used.</p><p v-else>This browser supplies your live input. Device access is requested when you add it. Keep this tab open while using the source.<span v-if="kind === 'screen'">Screen audio depends on the browser and the surface you share.</span></p></div>
          </section>
        </div>
        <footer class="source-footer">
          <p v-if="error" class="source-form-error" role="alert">{{ error }}</p>
          <p class="source-target-note"><span />{{ targetHint }}</p>
          <div class="dialog-actions"><button type="button" class="s-button" :disabled="adding" @click="open = false">Cancel</button><button type="submit" class="s-button primary" :disabled="!canAdd"><LoaderCircle v-if="adding" :size="14" class="spin" />{{ adding ? 'Adding source…' : 'Add to Studio' }}</button></div>
        </footer>
      </form>
    </DialogContent>
  </Dialog>
</template>

<style scoped>
:global(.studio-dialog.source-dialog){width:calc(100vw - 32px);max-width:1040px;max-height:min(760px,calc(100dvh - 40px));height:700px;padding:0!important;gap:0;overflow:hidden;transition:none;background:var(--surface-1)!important;box-shadow:0 30px 110px #0009,0 1px 0 #ffffff05 inset}
.source-header{padding:22px 54px 20px 24px;border-bottom:1px solid var(--border-hair);flex-shrink:0;gap:5px;text-align:left}
.source-header h2{font-size:18px;letter-spacing:-.4px}.source-header [data-slot="dialog-description"]{font-size:12px;color:var(--text-muted)}
.source-form{display:flex;flex-direction:column;flex:1;min-height:0;min-width:0}
.source-body{display:grid;grid-template-columns:164px minmax(0,1fr);min-height:0;flex:1}
.source-sidebar{display:flex;flex-direction:column;gap:3px;padding:17px 11px;min-width:0;overflow-y:auto;border-right:1px solid var(--border-hair);background:#10111355}
.source-group-label{font-size:9px;font-weight:550;color:var(--text-subtle);padding:15px 9px 7px;letter-spacing:.05em}.source-group-label:first-child{padding-top:1px}
.source-sidebar>button{display:flex;align-items:center;gap:9px;padding:10px 9px;border-radius:6px;font-size:11px;text-align:left;white-space:nowrap;color:var(--text-muted);border:1px solid transparent}
.source-sidebar>button svg{flex-shrink:0}.source-sidebar>button:hover:not(:disabled){background:var(--bg-hover);color:var(--text-primary)}.source-sidebar>button.chosen{background:#7dd3fc0c;color:var(--text-primary);border-color:#7dd3fc1a}.source-sidebar>button.chosen svg{color:var(--accent)}
.source-station-note{display:flex;align-items:center;gap:6px;margin-top:auto;padding:25px 5px 2px;color:var(--text-subtle);font-size:9px;white-space:nowrap}
.source-media-workspace{display:grid;grid-template-columns:minmax(0,1fr) 290px;min-height:0;min-width:0;position:relative}
.source-library{display:flex;flex-direction:column;min-height:0;min-width:0;padding:19px 18px 0}
.source-library-heading{display:flex;align-items:center;gap:8px;margin-bottom:15px}.source-library-heading h3{font-size:13px;font-weight:550;color:var(--text-primary)}.source-library-heading>span{font-size:10px;color:var(--text-subtle)}.source-small-icon{margin-left:auto;width:26px;height:26px;display:grid;place-items:center;border-radius:5px;color:var(--text-muted)}.source-small-icon:hover{background:var(--bg-hover);color:var(--text-primary)}
.source-library-tools{display:flex;align-items:center;gap:8px;margin-bottom:16px;flex-shrink:0}.source-search{display:flex;align-items:center;gap:7px;min-width:0;flex:1;background:var(--surface-2);border:1px solid var(--border-hair);border-radius:6px;padding:0 9px;color:var(--text-subtle);height:33px}.source-search:focus-within{border-color:#7dd3fc70}.source-search input{min-width:0;width:100%;background:transparent;border:0;outline:0!important;box-shadow:none;padding:0;font-size:11px;color:var(--text-primary)}.source-search>svg{flex-shrink:0}.source-search>button{display:grid;place-items:center;color:var(--text-muted)}.source-search input::-webkit-search-cancel-button{display:none}
.source-upload-button{display:flex;align-items:center;justify-content:center;gap:6px;height:33px;padding:0 10px;font-size:11px;border:1px solid var(--border-glow);border-radius:6px;background:var(--surface-3);color:var(--text-primary)}.source-upload-button:hover{background:#32353b}.source-file-input{position:absolute;width:1px;height:1px;padding:0;overflow:hidden;clip-path:inset(50%);white-space:nowrap;opacity:0}
.source-media-grid{display:grid;grid-template-columns:repeat(auto-fill,minmax(112px,1fr));gap:16px 11px;align-content:start;overflow-y:auto;min-height:0;padding:3px 2px 15px;margin:-3px -2px 0;flex:1;overscroll-behavior:contain}.source-asset{text-align:left;min-width:0;border-radius:6px;align-self:start;outline-offset:3px!important}.source-asset-image{position:relative;display:flex;align-items:center;justify-content:center;aspect-ratio:4/3;overflow:hidden;border:1px solid #ffffff0a;border-radius:7px;background:repeating-conic-gradient(#25272a 0% 25%,#202225 0% 50%) 50% / 14px 14px;color:#737780}.source-asset-image>img{height:100%;width:100%;object-fit:contain}.source-asset:hover .source-asset-image{border-color:#ffffff35}.source-asset.selected .source-asset-image{border-color:var(--accent);box-shadow:0 0 0 1px #7dd3fc66}.source-selected-check{position:absolute;right:6px;top:6px;width:19px;height:19px;background:var(--accent);color:#102632;border-radius:50%;display:grid;place-items:center;box-shadow:0 1px 5px #0004}.source-video-badge{position:absolute;bottom:6px;left:6px;display:flex;align-items:center;gap:4px;font-size:8px;font-weight:550;letter-spacing:.03em;padding:3px 5px;border-radius:3px;color:#f4f4f5;background:#000a}.source-asset-caption{display:block;padding:8px 1px 0}.source-asset-caption>b{display:block;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;font-size:10px;font-weight:450;color:var(--text-primary)}.source-asset-caption>small{display:block;margin-top:3px;font-size:9px;color:var(--text-subtle)}.source-audio-tile{background:var(--surface-2);aspect-ratio:2/1}.source-audio-tile>svg{color:#969da8}
.source-grid-loading{display:grid;grid-template-columns:repeat(3,minmax(0,1fr));gap:13px;align-content:start;flex:1}.source-grid-loading>span:not(.sr-only){aspect-ratio:4/3;background:var(--surface-2);border-radius:7px}
.source-library-empty{display:flex;align-items:center;justify-content:center;flex-direction:column;flex:1;text-align:center;padding:30px 12px;color:var(--text-subtle);min-height:180px}.source-library-empty h4{font-size:13px;font-weight:500;color:var(--text-primary);margin-top:14px}.source-library-empty p{font-size:11px;line-height:1.6;margin:6px 0 16px;max-width:220px}.source-library-empty .s-button{font-size:11px}
.source-library-footnote{display:flex;flex-wrap:wrap;justify-content:space-between;gap:5px;color:var(--text-subtle);font-size:9px;line-height:1.5;padding:13px 0;margin-top:auto;border-top:1px solid var(--border-hair);flex-shrink:0}
.source-detail{border-left:1px solid var(--border-hair);background:#10111348;padding:19px 17px;overflow-y:auto;min-width:0}.source-file-detail{padding:14px 0 17px;min-width:0}.source-file-detail>b{display:block;overflow-wrap:anywhere;font-weight:500;font-size:12px;line-height:1.5;color:var(--text-primary)}.source-file-detail>span{display:block;font-size:10px;color:var(--text-subtle);line-height:1.6;margin-top:4px}.source-file-detail>small{display:flex;align-items:center;gap:4px;font-size:9px;color:var(--status-ready);margin-top:8px}.source-detail .source-name-field{margin-top:18px;font-size:10px;gap:7px}.source-detail .source-name-field input,.source-input-properties .studio-field input,.source-input-properties .studio-field select{background:var(--surface-2);border:1px solid var(--border-hair);border-radius:6px;height:34px;font-size:12px;padding:7px 9px}.source-detail-help{font-size:10px;color:var(--text-subtle);line-height:1.65;margin-top:8px}.source-preview-note{display:flex;gap:6px;align-items:center;font-size:9px;color:var(--text-subtle);margin-top:23px}
.source-upload-progress{margin:8px 0 16px}.source-upload-progress>div{display:flex;align-items:center;justify-content:space-between;font-size:10px;color:var(--accent)}.source-upload-progress>div>button{color:var(--text-muted);padding:3px}.source-upload-progress progress{appearance:none;width:100%;height:3px;display:block;margin:9px 0;background:var(--surface-3);border:0;border-radius:3px;overflow:hidden;accent-color:var(--accent)}.source-upload-progress progress::-webkit-progress-bar{background:var(--surface-3)}.source-upload-progress progress::-webkit-progress-value{background:var(--accent)}.source-upload-progress progress::-moz-progress-bar{background:var(--accent)}.source-upload-progress>small{font-size:9px;color:var(--text-subtle);line-height:1.5}
.source-drop-overlay{position:absolute;inset:8px;background:#17181bf2;border:1px dashed var(--accent);border-radius:8px;z-index:3;pointer-events:none;display:flex;align-items:center;justify-content:center;flex-direction:column;gap:12px;color:var(--accent)}.source-drop-overlay>b{font-weight:500;font-size:16px;color:var(--text-primary)}.source-drop-overlay>span{font-size:11px;color:var(--text-muted)}
.source-input-workspace{padding:30px 35px;overflow-y:auto;min-width:0;display:flex;flex-direction:column}.source-input-intro{display:flex;align-items:center;gap:14px;padding-bottom:25px;border-bottom:1px solid var(--border-hair)}.source-input-icon{width:56px;height:56px;display:grid;place-items:center;background:var(--surface-2);border:1px solid var(--border-hair);border-radius:10px;color:var(--accent)}.source-input-intro h3{font-size:17px;font-weight:500;letter-spacing:-.3px}.source-input-intro p{color:var(--text-muted);font-size:12px;margin-top:5px}.source-input-properties{display:grid;gap:19px;max-width:430px;padding-top:25px;width:100%}.source-input-properties .studio-check{display:flex;align-items:center;gap:8px;font-size:11px;color:var(--text-muted)}.studio-check input{accent-color:var(--accent)}.source-input-note{display:flex;align-items:flex-start;gap:10px;margin-top:auto;padding-top:30px;max-width:500px;color:var(--text-subtle)}.source-input-note>svg{flex-shrink:0;margin-top:2px}.source-input-note p{font-size:11px;line-height:1.7}.source-input-note p>span{display:block;margin-top:7px}
.source-footer{display:flex;align-items:center;gap:16px;flex-wrap:wrap;padding:14px 20px;border-top:1px solid var(--border-hair);background:var(--surface-1);flex-shrink:0;min-width:0}.source-target-note{display:flex;gap:6px;align-items:flex-start;font-size:10px;color:var(--text-subtle);line-height:1.6;flex:1;min-width:170px}.source-target-note>span{width:4px;height:4px;flex-shrink:0;margin-top:6px;background:var(--text-subtle);border-radius:50%}.source-footer .dialog-actions{margin:0;gap:8px;flex-shrink:0}.source-footer .s-button{min-height:33px;font-size:11px;padding:7px 12px}.source-form-error{width:100%;font-size:11px;line-height:1.5;color:#efb6aa}.source-library-error{font-size:11px;color:#efb6aa;line-height:1.6;padding:10px 0}.source-library-error button{display:block;color:var(--accent);padding-top:6px}
@media(max-width:900px){.source-body{grid-template-columns:142px minmax(0,1fr)}.source-media-workspace{grid-template-columns:minmax(0,1fr) 240px}.source-library{padding:17px 13px 0}.source-detail{padding:17px 13px}.source-sidebar{padding:17px 7px}.source-sidebar>button{font-size:10px;padding:10px 7px;gap:7px}.source-station-note{white-space:normal;line-height:1.5}.source-media-grid{grid-template-columns:repeat(auto-fill,minmax(98px,1fr))}}
@media(max-width:700px){:global(.studio-dialog.source-dialog){width:calc(100vw - 16px);height:calc(100dvh - 24px);max-height:calc(100dvh - 24px)}.source-header{padding:18px 44px 15px 18px}.source-header h2{font-size:17px}.source-header [data-slot="dialog-description"]{font-size:11px}.source-body{display:flex;flex-direction:column;overflow-y:auto}.source-sidebar{position:sticky;top:0;z-index:2;background:var(--surface-1);flex-direction:row;overflow-x:auto;overflow-y:hidden;flex-shrink:0;border-right:0;border-bottom:1px solid var(--border-hair);padding:9px 12px;gap:4px}.source-group-label,.source-station-note{display:none}.source-sidebar>button{padding:8px;gap:6px;font-size:10px;flex-shrink:0}.source-sidebar>button>svg{width:14px;height:14px}.source-media-workspace{display:flex;flex-direction:column;flex:1;overflow:visible;min-height:auto}.source-library{padding:15px 15px 0;min-height:230px;overflow:visible}.source-library-heading{margin-bottom:10px}.source-library-tools{margin-bottom:13px}.source-media-grid{grid-template-columns:repeat(auto-fill,minmax(108px,1fr));max-height:235px;min-height:130px;flex:initial}.source-grid-loading{min-height:140px}.source-library-empty{padding:16px 8px;min-height:140px}.source-library-empty>svg{width:24px;height:24px}.source-library-empty h4{margin-top:10px}.source-library-empty p{margin-bottom:10px}.source-library-footnote{padding:10px 0;margin-top:10px}.source-detail{border-left:0;border-top:1px solid var(--border-hair);padding:15px;overflow:visible;display:grid;grid-template-columns:minmax(0,1fr) minmax(0,1fr);gap:0 15px;align-content:start}.source-detail>[data-testid="source-media-preview"]{grid-column:1/-1;max-width:400px;width:100%;justify-self:center}.source-file-detail{padding:13px 0 5px}.source-detail .source-name-field{margin-top:13px}.source-upload-progress{grid-column:1/-1}.source-detail-help{display:none}.source-preview-note{grid-column:1/-1;margin-top:14px}.source-input-workspace{padding:22px 20px;min-height:390px;flex-shrink:0}.source-input-intro h3{font-size:16px}.source-input-note{padding-top:26px}.source-footer{padding:12px 15px;gap:8px}.source-target-note{font-size:9px;flex-basis:100%;min-width:0}.source-footer .dialog-actions{margin-left:auto}.source-footer .s-button{min-height:36px}.source-form-error{font-size:10px}}
@media(max-width:360px){.source-detail{grid-template-columns:minmax(0,1fr)}.source-detail .source-name-field{margin-top:9px}.source-media-grid{grid-template-columns:repeat(2,minmax(0,1fr))}.source-library-tools{gap:5px}.source-upload-button{padding:0 8px}.source-header [data-slot="dialog-description"]{max-width:230px}}
@media(pointer:coarse){.source-sidebar>button,.source-small-icon{min-height:36px}.source-upload-button,.source-search{height:36px}}
</style>
