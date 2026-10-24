<script setup lang="ts">
import { computed, nextTick, onBeforeUnmount, ref, shallowRef, watch } from 'vue';
import { toast } from 'vue-sonner';
import { Camera, Monitor, Mic, Image, Film, Music2, Presentation, Upload, LoaderCircle, Search, Check, FolderOpen, RefreshCw, X, ArrowUpRight, VolumeX, CircleHelp } from 'lucide-vue-next';
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogDescription } from '@/components/ui/dialog';
import MediaAssetPreview from './MediaAssetPreview.vue';
import { api, type MediaLibraryFile } from '@/lib/api';
import { shortId } from '@/lib/ids';
import { mediaAccept, mediaAssetUrl, mediaDisplayName, mediaExtensions, mediaFileSize, mediaFilesForKind, mediaFormatHint, mediaSourceName, MAX_MEDIA_BYTES, type MediaAssetKind } from '@/lib/studio/media-library';
import { inputCaptureError, openDeviceCapture, type InputSelection } from '@/lib/studio/device-capture';
import { CameraPreviewCapture } from '@/lib/studio/camera-preview';
import { useContentStore } from '@/stores/content';
import { useStudioStore } from '@/stores/studio';
import type { StudioSource } from '../../../../shared/production';

const open = defineModel<boolean>('open', { required: true });
const props = defineProps<{ sourceId?: string | null }>();
const studio = useStudioStore(), content = useContentStore();
const editing = computed(() => !!props.sourceId);
const editingSource = computed(() => studio.state?.sources.find(source => source.id === props.sourceId));
const initialInput = ref<InputSelection>({}), initializing = ref(false);
const loop = ref(true), playbackPaused = ref(false), restartOnSave = ref(false), choosingMedia = ref(false);
const screenReplacement = shallowRef<MediaStream | null>(null), screenChoosing = ref(false);
const kind = ref<StudioSource['kind']>('camera'), name = ref(''), nameEdited = ref(false), url = ref(''), channelId = ref('');
const adding = ref(false), error = ref(''), libraryError = ref(''), files = ref<MediaLibraryFile[]>([]), query = ref(''), listing = ref(false);
const devices = ref<MediaDeviceInfo[]>([]), videoDevice = ref(''), audioDevice = ref(''), withAudio = ref(false);
const resolution = ref(''), frameRate = ref('');
const cameraCapabilities = shallowRef<MediaTrackCapabilities>({}), cameraSettings = shallowRef<MediaTrackSettings>({});
const withinRange = (value: number, range?: { min?: number; max?: number }) =>
  value >= (range?.min ?? 0) && value <= (range?.max ?? Infinity);
const resolutionOptions = computed(() => {
  const sizes = [[640, 480], [1280, 720], [1920, 1080], [2560, 1440], [3840, 2160]];
  const { width, height } = cameraSettings.value;
  if (width && height) sizes.push([width, height]);
  const available = sizes.filter(([w, h]) => withinRange(w, cameraCapabilities.value.width) && withinRange(h, cameraCapabilities.value.height)).map(([w, h]) => `${w}x${h}`);
  // Keep a remembered/failed choice visible so it can always be changed to Auto.
  if (resolution.value) available.push(resolution.value);
  return [...new Set(available)].sort((a, b) => Number(a.split('x')[0]) - Number(b.split('x')[0]));
});
const frameRateOptions = computed(() => {
  const rates = [15, 23.976, 24, 25, 29.97, 30, 50, 59.94, 60, 120];
  if (cameraSettings.value.frameRate) rates.push(Number(cameraSettings.value.frameRate.toFixed(3)));
  const available = rates.filter(rate => withinRange(rate, cameraCapabilities.value.frameRate));
  if (frameRate.value) available.push(Number(frameRate.value));
  return [...new Set(available)].sort((a, b) => a - b);
});
function selectedInput(): InputSelection {
  const [width, height] = resolution.value.split('x').map(Number);
  return { videoDeviceId: videoDevice.value, audioDeviceId: audioDevice.value, includeAudio: withAudio.value,
    width: width || undefined, height: height || undefined, frameRate: Number(frameRate.value) || undefined };
}
const deviceError = ref(''), deviceAccessError = ref(''), accessingDevices = ref(false), refreshingDevices = ref(false), devicesScanned = ref(false);
const videoInputs = computed(() => devices.value.filter(device => device.kind === 'videoinput' && device.deviceId));
const audioInputs = computed(() => devices.value.filter(device => device.kind === 'audioinput' && device.deviceId));
// Before permission, browsers can hide IDs even for an attached, remembered
// device. Keep Start preview available so it can request that exact input.
const inputMissing = (inputKind: MediaDeviceKind, id: string) => devicesScanned.value && !!id &&
  !devices.value.some(device => device.kind === inputKind && (!device.deviceId || device.deviceId === id));
const videoMissing = computed(() => kind.value === 'camera' && inputMissing('videoinput', videoDevice.value));
const audioMissing = computed(() => (kind.value === 'microphone' || (kind.value === 'camera' && withAudio.value)) && inputMissing('audioinput', audioDevice.value));
const deviceSummary = computed(() => {
  const camera = kind.value === 'camera', inputKind = camera ? 'videoinput' : 'audioinput', inputs = camera ? videoInputs.value : audioInputs.value;
  if (!devicesScanned.value) return refreshingDevices.value ? 'Scanning…' : '';
  if (devices.value.some(device => device.kind === inputKind) && !inputs.some(device => device.label)) return 'Access needed';
  if (!inputs.length) return 'No devices found';
  return `${inputs.length} ${inputs.length === 1 ? 'device' : 'devices'}`;
});
const cameraElement = ref<HTMLVideoElement>(), cameraStream = shallowRef<MediaStream | null>(null);
const cameraConnecting = ref(false), cameraLive = ref(false), cameraWanted = ref(false), cameraDimensions = ref('');
const cameraCapture = new CameraPreviewCapture();
let cameraRequest = 0;
const uploading = ref(false), progress = ref(0), pendingFile = ref<File | null>(null), localPreview = ref(''), justUploaded = ref('');
const uploadInput = ref<HTMLInputElement>(), dragDepth = ref(0), brokenThumbs = ref(new Set<string>());
const previewDetail = ref<HTMLElement>();
let epoch = 0, uploadSequence = 0, listSequence = 0;
let settingInitialKind = false;
let deviceSequence = 0;
let deviceTimer: number | undefined;
let uploadController: AbortController | undefined, listController: AbortController | undefined;
let uploadFallback: string | null = null;

const kinds = [
  { id: 'camera', label: 'Camera / capture card', hint: 'HDMI capture card, webcam, or OBS Virtual Camera', icon: Camera, group: 'Live inputs' },
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
const selectedName = computed(() => pendingFile.value?.name ?? (selected.value ? mediaDisplayName(selected.value.name) : url.value ? mediaDisplayName(url.value.split('/').pop() || name.value) : ''));
const previewSrc = computed(() => localPreview.value || (url.value ? mediaAssetUrl(url.value) : ''));
const previewPoster = computed(() => selected.value?.thumbnail ? mediaAssetUrl(selected.value.thumbnail) : undefined);
const selectedBytes = computed(() => mediaFileSize(pendingFile.value?.size ?? selected.value?.bytes));
const selectionChanged = computed(() => (kind.value === 'camera' && (videoDevice.value !== (initialInput.value.videoDeviceId || '') || withAudio.value !== !!initialInput.value.includeAudio ||
  selectedInput().width !== initialInput.value.width || selectedInput().height !== initialInput.value.height || selectedInput().frameRate !== initialInput.value.frameRate)) ||
  ((kind.value === 'microphone' || (kind.value === 'camera' && withAudio.value)) && audioDevice.value !== (initialInput.value.audioDeviceId || '')));
const canAdd = computed(() => !!name.value.trim() && !adding.value && !uploading.value && !accessingDevices.value && !screenChoosing.value && !initializing.value &&
  (!editing.value || !!editingSource.value) &&
  ((editing.value && !selectionChanged.value) || (!videoMissing.value && !audioMissing.value)) &&
  (!mediaKind.value || !!url.value) &&
  (kind.value !== 'camera' || (editing.value && !selectionChanged.value) || (cameraLive.value && !cameraConnecting.value)) &&
  (kind.value !== 'channel' || !!channelId.value));
const targetHint = computed(() => editing.value ? 'Changes apply wherever this source is used.' : ['audio', 'microphone'].includes(kind.value)
  ? 'Starts muted'
  : 'Adds to Preview');

function stopCameraPreview(reset = true) {
  cameraRequest++; cameraCapture.stop(); cameraStream.value = null;
  cameraConnecting.value = false; cameraLive.value = false; cameraDimensions.value = '';
  if (reset) cameraWanted.value = false;
}
function cameraPicture() {
  const video = cameraElement.value, stream = cameraStream.value;
  cameraLive.value = !!video && video.srcObject === stream && video.readyState >= 2 && video.videoWidth > 0 &&
    !!stream?.getVideoTracks().some(track => track.readyState === 'live' && !track.muted);
  const actual = stream?.getVideoTracks()[0]?.getSettings();
  cameraDimensions.value = cameraLive.value && video ? `${video.videoWidth} × ${video.videoHeight}${actual?.frameRate ? ' · ' + Number(actual.frameRate.toFixed(3)) + ' fps' : ''}` : '';
}
async function startCameraPreview() {
  if (!open.value || kind.value !== 'camera' || videoMissing.value || audioMissing.value) return;
  cameraWanted.value = true; cameraConnecting.value = true; cameraLive.value = false;
  cameraStream.value = null; cameraDimensions.value = ''; deviceAccessError.value = '';
  const request = ++cameraRequest, context = epoch;
  try {
    const stream = await cameraCapture.start(selectedInput(), studio.cameraStreams());
    if (!stream || !open.value || context !== epoch || request !== cameraRequest) return;
    cameraStream.value = stream;
    const track = stream.getVideoTracks()[0];
    cameraCapabilities.value = track?.getCapabilities?.() ?? {};
    cameraSettings.value = track?.getSettings() ?? {};
    if (!nameEdited.value) name.value = devices.value.find(device => device.deviceId === stream.getVideoTracks()[0]?.getSettings().deviceId)?.label || stream.getVideoTracks()[0]?.label || 'Camera';
    await refreshDevices();
  } catch (cause) {
    if (open.value && context === epoch && request === cameraRequest) {
      await refreshDevices();
      if (open.value && context === epoch && request === cameraRequest) deviceAccessError.value = (cause as Error).message;
    }
  } finally { if (context === epoch && request === cameraRequest) cameraConnecting.value = false; }
}
watch(videoDevice, () => {
  if (initializing.value) return;
  resolution.value = ''; frameRate.value = '';
  cameraCapabilities.value = {}; cameraSettings.value = {};
}, { flush: 'sync' });
watch([videoDevice, audioDevice, withAudio, resolution, frameRate], () => {
  if (!initializing.value && open.value && kind.value === 'camera' && !adding.value && (videoDevice.value || cameraWanted.value)) void startCameraPreview();
}, { flush: 'post' });
watch([videoMissing, audioMissing], ([video, audio]) => {
  if (initializing.value || !cameraWanted.value || kind.value !== 'camera') return;
  if (video || audio) stopCameraPreview(false);
  else void startCameraPreview();
});
watch([cameraElement, cameraStream], ([video, stream], _, cleanup) => {
  if (video) {
    video.srcObject = stream;
    if (stream) void video.play().catch(() => { if (cameraStream.value === stream) deviceAccessError.value = 'Preview could not play. Try again.'; });
  }
  for (const track of stream?.getVideoTracks() ?? []) {
    track.addEventListener('ended', cameraPicture); track.addEventListener('mute', cameraPicture); track.addEventListener('unmute', cameraPicture);
  }
  cleanup(() => { for (const track of stream?.getVideoTracks() ?? []) {
    track.removeEventListener('ended', cameraPicture); track.removeEventListener('mute', cameraPicture); track.removeEventListener('unmute', cameraPicture);
  } });
}, { flush: 'post' });

function clearLocalPreview() {
  if (localPreview.value) URL.revokeObjectURL(localPreview.value);
  localPreview.value = '';
}
function stopUpload() {
  uploadSequence++;
  uploadController?.abort(); uploadController = undefined;
  uploading.value = false; pendingFile.value = null; progress.value = 0;
  if (uploadFallback !== null) url.value = uploadFallback;
  uploadFallback = null;
  clearLocalPreview();
}
function invalidate() {
  epoch++; listSequence++;
  stopCameraPreview();
  screenReplacement.value?.getTracks().forEach(track => track.stop()); screenReplacement.value = null; screenChoosing.value = false;
  deviceSequence++; accessingDevices.value = false; refreshingDevices.value = false;
  clearInterval(deviceTimer); deviceTimer = undefined;
  listController?.abort(); listController = undefined; listing.value = false;
  stopUpload(); dragDepth.value = 0;
}
async function refreshDevices() {
  if (!open.value || !['camera', 'microphone'].includes(kind.value)) return;
  if (!navigator.mediaDevices?.enumerateDevices) {
    deviceError.value = 'Device access requires localhost or HTTPS and a browser with camera support.';
    return;
  }
  const context = epoch, sequence = ++deviceSequence;
  refreshingDevices.value = true;
  try {
    const result = await navigator.mediaDevices.enumerateDevices();
    if (open.value && context === epoch && sequence === deviceSequence) { devices.value = result; deviceError.value = ''; devicesScanned.value = true; }
  } catch {
    if (open.value && context === epoch && sequence === deviceSequence) deviceError.value = 'Devices could not be listed. Check browser permissions, then refresh devices.';
  } finally {
    if (context === epoch && sequence === deviceSequence) refreshingDevices.value = false;
  }
}
async function enableDevices() {
  if (kind.value === 'camera') { await startCameraPreview(); return; }
  const context = epoch;
  if (accessingDevices.value || !open.value) return;
  if (!navigator.mediaDevices?.getUserMedia) { deviceAccessError.value = 'Device access requires localhost or HTTPS and a browser with camera support.'; return; }
  accessingDevices.value = true; deviceAccessError.value = '';
  let stream: MediaStream | undefined;
  try {
    stream = await navigator.mediaDevices.getUserMedia({
      video: false,
      audio: audioDevice.value ? { deviceId: { exact: audioDevice.value } } : true,
    });
    if (open.value && context === epoch) await refreshDevices();
  } catch (cause) {
    if (open.value && context === epoch) {
      // Access may have been granted even when the default camera is busy.
      // Enumerate again so the operator can still find the connected card.
      await refreshDevices();
      if (open.value && context === epoch) deviceAccessError.value = inputCaptureError(cause);
    }
  } finally {
    // Even permission prompts resolved after closing the dialog release input.
    stream?.getTracks().forEach(track => track.stop());
    if (context === epoch) accessingDevices.value = false;
  }
}
function deviceChanged() {
  if (document.visibilityState !== 'hidden' && !accessingDevices.value && !refreshingDevices.value && !adding.value) void refreshDevices();
}
function startDeviceDiscovery() {
  if (!open.value || !['camera', 'microphone'].includes(kind.value)) return;
  void refreshDevices();
  // Driver startup and browser devicechange delivery vary across operating
  // systems. These are passive scans; they never open a camera or microphone.
  if (typeof navigator.mediaDevices?.enumerateDevices === 'function') deviceTimer = window.setInterval(deviceChanged, 2000);
}
navigator.mediaDevices?.addEventListener('devicechange', deviceChanged);
window.addEventListener('focus', deviceChanged);
document.addEventListener('visibilitychange', deviceChanged);
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
watch([open, () => props.sourceId], ([value]) => {
  invalidate();
  if (!value) return;
  initializing.value = true;
  settingInitialKind = true;
  if (editingSource.value) kind.value = editingSource.value.kind;
  settingInitialKind = false;
  name.value = ''; nameEdited.value = false; url.value = ''; query.value = ''; files.value = [];
  channelId.value = ''; loop.value = true; playbackPaused.value = false; restartOnSave.value = false; choosingMedia.value = false;
  error.value = ''; libraryError.value = ''; justUploaded.value = ''; brokenThumbs.value = new Set(); withAudio.value = false;
  devices.value = []; videoDevice.value = ''; audioDevice.value = ''; deviceError.value = ''; deviceAccessError.value = ''; devicesScanned.value = false;
  resolution.value = ''; frameRate.value = ''; cameraCapabilities.value = {}; cameraSettings.value = {};
  initialInput.value = editing.value ? studio.inputSelection(props.sourceId!) : {};
  const source = editingSource.value;
  if (source) {
    name.value = source.name; nameEdited.value = true; url.value = source.url || ''; channelId.value = source.channelId || '';
    loop.value = source.loop; playbackPaused.value = source.playback?.paused ?? false;
    videoDevice.value = initialInput.value.videoDeviceId || ''; audioDevice.value = initialInput.value.audioDeviceId || '';
    withAudio.value = !!initialInput.value.includeAudio;
    if (initialInput.value.width && initialInput.value.height) resolution.value = `${initialInput.value.width}x${initialInput.value.height}`;
    frameRate.value = initialInput.value.frameRate ? String(initialInput.value.frameRate) : '';
  }
  const context = epoch;
  void content.load().catch(() => { if (open.value && context === epoch && kind.value === 'channel') error.value = 'Channels could not be loaded. Close this window and try again.'; });
  // New sources remain passive; editing a connected camera borrows its feed.
  startDeviceDiscovery();
  void loadFiles();
  void nextTick().then(async () => {
    if (!open.value || context !== epoch) return;
    initializing.value = false;
    if (source?.kind === 'camera' && studio.sourceStream(source.id)) {
      await refreshDevices();
      if (open.value && context === epoch) void startCameraPreview();
    }
  });
});
watch(kind, () => {
  if (settingInitialKind) return;
  initializing.value = false;
  invalidate();
  url.value = ''; files.value = []; query.value = ''; error.value = ''; libraryError.value = ''; justUploaded.value = ''; brokenThumbs.value = new Set();
  if (!nameEdited.value) name.value = '';
  deviceError.value = ''; deviceAccessError.value = ''; devicesScanned.value = false; startDeviceDiscovery();
  void loadFiles();
}, { flush: 'sync' });
onBeforeUnmount(() => {
  invalidate(); navigator.mediaDevices?.removeEventListener('devicechange', deviceChanged);
  window.removeEventListener('focus', deviceChanged); document.removeEventListener('visibilitychange', deviceChanged);
});

function choose(file: MediaLibraryFile) {
  if (adding.value) return;
  stopUpload(); error.value = ''; url.value = file.path;
  if (!nameEdited.value) name.value = mediaSourceName(file.name);
  if (editing.value) choosingMedia.value = false;
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
  uploadFallback = editing.value ? url.value : null;
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
    uploadFallback = null;
    if (editing.value) choosingMedia.value = false;
    pendingFile.value = null; clearLocalPreview();
    void loadFiles();
  } catch (cause) {
    if (controller.signal.aborted || !open.value || context !== epoch || sequence !== uploadSequence) return;
    error.value = 'Upload failed. Check your connection or choose another file, then try again.';
    if (uploadFallback !== null) url.value = uploadFallback;
    uploadFallback = null;
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
  if (editing.value) { await saveProperties(); return; }
  adding.value = true; error.value = '';
  const context = epoch, source: StudioSource = {
    id: shortId('input'), name: name.value.trim(), kind: kind.value, loop: loop.value,
    ...(['video', 'audio'].includes(kind.value) ? { playback: { paused: playbackPaused.value, restart: 0 } } : {}),
    ...(mediaKind.value ? { url: url.value } : {}), ...(kind.value === 'channel' ? { channelId: channelId.value } : {}),
    audio: { volume: 0.8, muted: true, mode: ['microphone', 'audio'].includes(kind.value) ? 'always' : 'follow', delayMs: 0 },
  };
  let prepared: MediaStream | null = source.kind === 'camera' ? cameraCapture.copy() : null;
  try {
    await studio.addSource(source);
    if (!open.value || context !== epoch) return;
    if (['camera', 'screen', 'microphone'].includes(source.kind)) {
      try { await studio.connectSource(source, videoDevice.value, audioDevice.value, withAudio.value, prepared ?? undefined, selectedInput()); prepared = null; }
      catch (cause) { toast.error('Source saved, but device access failed: ' + (cause as Error).message + '. Connect it again from Sources.'); }
    }
    open.value = false;
  } catch (cause) { if (open.value && context === epoch) error.value = (cause as Error).message; }
  finally { prepared?.getTracks().forEach(track => track.stop()); adding.value = false; }
}
async function chooseScreen() {
  if (screenChoosing.value || adding.value) return;
  const context = epoch; screenChoosing.value = true; error.value = '';
  try {
    const stream = await navigator.mediaDevices.getDisplayMedia({ video: { frameRate: 30 }, audio: true });
    if (!open.value || context !== epoch) { stream.getTracks().forEach(track => track.stop()); return; }
    screenReplacement.value?.getTracks().forEach(track => track.stop());
    screenReplacement.value = stream;
    for (const track of stream.getVideoTracks()) track.onended = () => {
      if (screenReplacement.value !== stream) return;
      stream.getTracks().forEach(item => item.stop()); screenReplacement.value = null;
      error.value = 'Screen selection ended. Choose a screen again.';
    };
  } catch (cause) {
    if (open.value && context === epoch) error.value = (cause as Error).name === 'NotAllowedError' ? 'Screen selection cancelled. Your current source is unchanged.' : 'This screen could not be shared. Try another screen or window.';
  } finally { if (context === epoch) screenChoosing.value = false; }
}
async function saveProperties() {
  const source = editingSource.value;
  if (!source) return;
  const context = epoch;
  adding.value = true; error.value = '';
  let prepared: MediaStream | null = null;
  try {
    const patch: Partial<StudioSource> = { name: name.value.trim() };
    if (mediaKind.value) patch.url = url.value;
    if (source.kind === 'channel') patch.channelId = channelId.value;
    if (['video', 'audio'].includes(source.kind)) {
      patch.loop = loop.value;
      patch.playback = { paused: playbackPaused.value, restart: (source.playback?.restart ?? 0) + (restartOnSave.value ? 1 : 0) };
    }
    const selection = selectedInput();
    if (source.kind === 'camera' && (selectionChanged.value || (!studio.connectedSources.includes(source.id) && cameraLive.value))) {
      prepared = cameraCapture.copy();
      if (!prepared) throw new Error('Preview the selected camera before saving.');
    } else if (source.kind === 'microphone' && selectionChanged.value) {
      prepared = await openDeviceCapture('microphone', selection);
    } else if (source.kind === 'screen' && screenReplacement.value) {
      prepared = new MediaStream(screenReplacement.value.getTracks().map(track => track.clone()));
    }
    if (!open.value || context !== epoch) return;
    await studio.saveSourceProperties(source.id, patch, prepared ? { stream: prepared, selection } : undefined);
    prepared = null;
    if (open.value && context === epoch) open.value = false;
  } catch (cause) { if (open.value && context === epoch) error.value = (cause as Error).message; }
  finally { prepared?.getTracks().forEach(track => track.stop()); adding.value = false; }
}
</script>

<template>
  <Dialog v-model:open="open">
    <DialogContent class="studio-dialog source-dialog" :show-close-button="!adding" @escape-key-down="adding && $event.preventDefault()" @interact-outside="adding && $event.preventDefault()">
      <DialogHeader class="source-header">
        <DialogTitle>{{ editing ? 'Source properties' : 'Add a source' }}</DialogTitle>
        <DialogDescription class="sr-only">{{ editing ? 'Preview changes, then save them to this source.' : 'Choose a source and preview it before adding.' }}</DialogDescription>
      </DialogHeader>
      <form class="source-form" @submit.prevent="add">
        <div class="source-body" :class="{ 'source-properties-body': editing }">
          <nav v-if="!editing" class="source-sidebar" role="group" aria-label="Source type">
            <template v-for="(item, index) in kinds" :key="item.id">
              <span v-if="index === 0 || item.group !== kinds[index - 1].group" class="source-group-label">{{ item.group }}</span>
              <button type="button" :class="{ chosen: kind === item.id }" :aria-label="item.label" :aria-pressed="kind === item.id" :title="item.hint" :disabled="adding" @click="kind = item.id">
                <component :is="item.icon" :size="16" /><span>{{ item.id === 'camera' ? 'Camera' : item.label }}</span>
              </button>
            </template>
          </nav>

          <section v-if="mediaKind" class="source-media-workspace" :class="{ 'source-media-properties': editing && !choosingMedia }" @dragenter="dragEnter" @dragleave="dragLeave" @dragover="dragOver" @drop="drop">
            <div v-if="!editing || choosingMedia" class="source-library">
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
              <div class="source-media-settings">
              <div v-if="selectedName" class="source-file-detail"><b :title="selectedName">{{ selectedName }}</b><span>{{ selectedBytes }}<template v-if="selectedBytes && selected?.modifiedAt"> · </template>{{ dateLabel(selected?.modifiedAt) }}</span><small v-if="url && url === justUploaded && !uploading"><Check :size="11" />Uploaded to library</small></div>
              <button v-if="editing" type="button" class="s-button source-change-file" :disabled="adding" @click="choosingMedia = !choosingMedia"><FolderOpen :size="13" />{{ choosingMedia ? 'Done choosing' : 'Change file' }}</button>
              <div v-if="uploading" class="source-upload-progress" role="status" aria-live="polite"><div><span>{{ progress >= 100 ? 'Finishing upload…' : 'Uploading… ' + progress + '%' }}</span><button type="button" @click="stopUpload" aria-label="Cancel upload"><X :size="13" /></button></div><progress :value="progress" max="100" aria-label="Upload progress" /><small>Your preview is ready. Add once the file is saved.</small></div>
              <label class="studio-field source-name-field">Name<input v-model="name" placeholder="Name this source" maxlength="100" required :disabled="adding" @input="nameEdited = true" /></label>
              <fieldset v-if="['video', 'audio'].includes(kind)" class="source-playback-settings" :disabled="adding">
                <legend>Playback</legend>
                <label class="studio-check"><input v-model="loop" type="checkbox" />Loop</label>
                <label class="studio-check"><input v-model="playbackPaused" type="checkbox" />Pause playback</label>
                <label v-if="editing" class="studio-check"><input v-model="restartOnSave" type="checkbox" />Restart on save</label>
              </fieldset>
              <p class="source-preview-note"><Monitor :size="13" />Local preview</p>
              </div>
            </aside>
            <div v-if="dragDepth > 0" class="source-drop-overlay"><Upload :size="28" /><b>Drop to upload</b><span>{{ mediaFormatHint[mediaKind] }} · Up to 200 MB</span></div>
          </section>

          <section v-else class="source-input-workspace" :class="{ 'source-camera-workspace': kind === 'camera' }">
            <div class="source-input-intro"><component :is="activeKind.icon" :size="21" :stroke-width="1.5" /><div><h3>{{ kind === 'camera' ? 'Camera' : activeKind.label }}</h3><p>{{ kind === 'camera' ? 'Webcams, capture cards & OBS' : activeKind.hint }}</p></div></div>
            <div :class="kind === 'camera' ? 'camera-setup-grid' : 'source-single-setup'">
              <aside v-if="kind === 'camera'" class="camera-preview-panel" aria-label="Camera preview">
                <div class="camera-preview-heading"><span>Preview</span><span v-if="cameraLive" class="camera-live-badge"><i />Live</span><VolumeX :size="14" aria-label="Preview audio muted" /></div>
                <div class="camera-preview-stage" :data-state="cameraLive ? 'live' : cameraConnecting ? 'loading' : deviceAccessError ? 'error' : 'idle'" data-testid="camera-preview-stage">
                  <video ref="cameraElement" data-testid="source-camera-preview" autoplay muted playsinline :class="{ visible: cameraLive }" @loadedmetadata="cameraPicture" @loadeddata="cameraPicture" @playing="cameraPicture" @resize="cameraPicture" @emptied="cameraPicture" />
                  <div v-if="!cameraLive" class="camera-preview-empty" role="status">
                    <LoaderCircle v-if="cameraConnecting" :size="27" class="spin" /><Camera v-else :size="30" :stroke-width="1.2" />
                    <b>{{ cameraConnecting ? 'Connecting…' : videoMissing ? 'Camera disconnected' : deviceAccessError ? 'Camera unavailable' : cameraStream ? 'Waiting for picture' : 'See your camera here' }}</b>
                    <p v-if="cameraStream && !cameraConnecting">Check the camera’s HDMI signal.</p>
                    <button v-if="!cameraConnecting" type="button" class="s-button" :disabled="adding || videoMissing || audioMissing" @click="startCameraPreview">{{ cameraWanted ? 'Try again' : 'Start preview' }}</button>
                  </div>
                </div>
                <div class="camera-preview-caption"><span>{{ cameraLive ? 'Live preview' : 'Local preview' }}</span><span>{{ cameraDimensions }}</span></div>
              </aside>
              <div class="source-input-properties">
                <div v-if="kind === 'camera'" class="camera-device-field">
                  <div class="camera-device-label"><label for="source-video-device">Video device</label><span data-testid="input-device-discovery" role="status">{{ deviceSummary }}</span><button type="button" class="source-small-icon" aria-label="Refresh devices" title="Refresh devices" :disabled="adding || refreshingDevices" @click="refreshDevices"><RefreshCw :size="13" :class="{ spin: refreshingDevices }" /></button></div>
                  <select id="source-video-device" v-model="videoDevice" aria-label="Video device" :disabled="adding"><option value="">Default camera</option><option v-if="videoDevice && !videoInputs.some(device => device.deviceId === videoDevice)" :value="videoDevice" disabled>{{ videoMissing ? 'Camera disconnected' : 'Saved camera' }}</option><option v-for="(device, i) in videoInputs" :key="device.deviceId" :value="device.deviceId">{{ device.label || 'Video input ' + (i + 1) }}</option></select>
                </div>
                <div v-if="kind === 'camera'" class="camera-format-fields">
                  <label class="studio-field">Resolution<select v-model="resolution" aria-label="Resolution" :disabled="adding"><option value="">Auto</option><option v-for="size in resolutionOptions" :key="size" :value="size">{{ size.replace('x', ' × ') }}</option></select></label>
                  <label class="studio-field">Frame rate<select v-model="frameRate" aria-label="Frame rate" :disabled="adding"><option value="">Auto</option><option v-for="rate in frameRateOptions" :key="rate" :value="String(rate)">{{ rate }} fps</option></select></label>
                </div>
                <label class="studio-field">Name<input v-model="name" :placeholder="kind === 'camera' ? 'e.g. Main camera' : kind === 'microphone' ? 'e.g. Preacher microphone' : kind === 'channel' ? 'e.g. Scripture overlay' : 'e.g. Presentation display'" maxlength="100" required :disabled="adding" @input="nameEdited = true" /></label>
                <div v-if="editing && kind === 'screen'" class="source-screen-settings">
                  <video v-if="screenReplacement || studio.sourceStream(sourceId!)" :srcObject="screenReplacement || studio.sourceStream(sourceId!)" autoplay muted playsinline aria-label="Screen preview" />
                  <p>{{ (screenReplacement || studio.sourceStream(sourceId!))?.getVideoTracks()[0]?.label || 'No screen connected' }}</p>
                  <button type="button" class="s-button" :disabled="adding || screenChoosing" @click="chooseScreen"><Monitor :size="14" />{{ screenChoosing ? 'Choosing…' : 'Choose screen or window' }}</button>
                </div>
                <label v-if="kind === 'channel'" class="studio-field">Presentation channel<select v-model="channelId" :disabled="adding"><option value="">Choose a channel…</option><option v-for="channel in content.channels" :key="channel.id" :value="channel.id">{{ channel.name }}</option></select></label>
                <label v-if="kind === 'camera'" class="studio-check camera-audio-toggle"><input v-model="withAudio" type="checkbox" :disabled="adding" /><Mic :size="14" />Include audio</label>
                <label v-if="kind === 'microphone' || (kind === 'camera' && withAudio)" class="studio-field">Audio device<select v-model="audioDevice" aria-label="Audio device" :disabled="adding || accessingDevices"><option value="">Default audio input</option><option v-if="audioDevice && !audioInputs.some(device => device.deviceId === audioDevice)" :value="audioDevice" disabled>{{ audioMissing ? 'Audio device disconnected' : 'Saved audio input' }}</option><option v-for="(device, i) in audioInputs" :key="device.deviceId" :value="device.deviceId">{{ device.label || 'Audio input ' + (i + 1) }}</option></select></label>
                <div v-if="kind === 'microphone'" class="source-device-actions"><button type="button" class="s-button" :disabled="adding || accessingDevices" @click="enableDevices"><LoaderCircle v-if="accessingDevices" :size="13" class="spin" />{{ accessingDevices ? 'Requesting access…' : 'Enable device access' }}</button><button type="button" class="source-small-icon" aria-label="Refresh devices" title="Refresh devices" :disabled="adding || accessingDevices || refreshingDevices" @click="refreshDevices"><RefreshCw :size="13" :class="{ spin: refreshingDevices }" /></button></div>
                <p v-if="videoMissing || audioMissing || deviceAccessError || deviceError" class="source-form-error" role="alert">{{ videoMissing || audioMissing ? 'Device disconnected. Reconnect it or choose another.' : deviceAccessError || deviceError }}</p>
                <details class="source-connection-help">
                  <summary><CircleHelp :size="13" />{{ kind === 'channel' ? 'About channel sources' : 'Connection help' }}</summary>
                  <div v-if="kind === 'camera'"><p>Camera HDMI → capture card → USB.</p><p>Auto prefers 1080p at 30 fps. The preview shows the delivered format; available resolution and frame-rate combinations depend on the device.</p><p>Allow camera access in browser and system settings. Install the card’s driver if it is missing.</p><p>Unexpected background on Mac? In the menu bar’s Video menu, turn off Background for your browser.</p><p>For HDMI audio, choose the card’s audio input. Keep this tab open during your production.</p></div>
                  <div v-else-if="kind === 'channel'"><p>Slide, scripture and lyric changes follow this channel automatically.</p></div>
                  <div v-else><p>Keep this tab open while using the input.</p><p v-if="kind === 'screen'">Available audio depends on the surface you share.</p><p v-else>Allow microphone access in browser and system settings.</p></div>
                </details>
              </div>
            </div>
          </section>
        </div>
        <footer class="source-footer">
          <p v-if="error" class="source-form-error" role="alert">{{ error }}</p>
          <p class="source-target-note"><span />{{ targetHint }}</p>
          <div class="dialog-actions"><button type="button" class="s-button" :disabled="adding" @click="open = false">Cancel</button><button type="submit" class="s-button primary" :disabled="!canAdd"><LoaderCircle v-if="adding" :size="14" class="spin" />{{ editing ? (adding ? 'Saving…' : 'Save changes') : (adding ? 'Adding source…' : 'Add to Studio') }}</button></div>
        </footer>
      </form>
    </DialogContent>
  </Dialog>
</template>

<style scoped>
.camera-format-fields{display:grid;grid-template-columns:minmax(0,1.35fr) minmax(0,1fr);gap:12px}.camera-format-fields .studio-field{min-width:0}.camera-format-fields select{min-width:0;width:100%}
.source-body.source-properties-body{grid-template-columns:minmax(0,1fr)}
.source-media-workspace.source-media-properties{display:block;overflow-y:auto}
.source-media-properties .source-detail{border:0;background:transparent;display:grid;grid-template-columns:minmax(0,1.4fr) minmax(260px,1fr);gap:26px;padding:26px;height:100%;align-content:start}
.source-media-settings{min-width:0}.source-media-properties .source-file-detail{padding-top:0}
.source-playback-settings{border:0;border-top:1px solid var(--border-hair);padding:16px 0 0;margin:22px 0 0;display:grid;gap:12px}
.source-playback-settings legend{font-size:11px;color:var(--text-muted);padding-right:8px}.source-playback-settings .studio-check{display:flex;gap:8px;align-items:center;font-size:11px;color:var(--text-muted)}
.source-change-file{font-size:11px}.source-screen-settings{display:grid;gap:14px;min-width:0}.source-screen-settings video{width:100%;aspect-ratio:16/9;object-fit:contain;background:#08090a;border-radius:8px}.source-screen-settings p{font-size:11px;color:var(--text-muted);overflow-wrap:anywhere}.source-screen-settings .s-button{justify-self:start}
@media(max-width:700px){.source-media-properties .source-detail{display:flex;flex-direction:column;gap:15px;padding:20px}.source-detail>.source-media-settings{grid-column:1/-1}.source-media-settings .source-playback-settings{margin-top:18px}.source-body.source-properties-body{display:flex}}
.source-camera-workspace{padding:26px!important}.source-camera-workspace .source-input-intro{padding-bottom:20px}.source-input-intro>svg{color:var(--accent);flex-shrink:0}.source-camera-workspace .source-input-intro h3{font-size:16px}.source-camera-workspace .source-input-intro p{font-size:11px;margin-top:3px}.camera-setup-grid{display:grid;grid-template-columns:minmax(0,1.45fr) minmax(245px,1fr);gap:26px;align-items:start;padding-top:24px}.camera-setup-grid .source-input-properties{padding-top:0;gap:19px}.camera-preview-panel{min-width:0}.camera-preview-heading{display:flex;align-items:center;gap:9px;font-size:11px;color:var(--text-muted);margin-bottom:10px}.camera-preview-heading>svg{margin-left:auto;color:var(--text-subtle)}.camera-live-badge{display:flex;align-items:center;gap:5px;font-size:10px;color:var(--status-ready)}.camera-live-badge i{width:5px;height:5px;background:currentColor;border-radius:50%}.camera-preview-stage{position:relative;aspect-ratio:16/9;background:#0b0d0f;border:1px solid var(--border-hair);border-radius:9px;overflow:hidden}.camera-preview-stage video{width:100%;height:100%;object-fit:contain;display:block;opacity:0}.camera-preview-stage video.visible{opacity:1}.camera-preview-empty{position:absolute;inset:0;display:flex;align-items:center;justify-content:center;flex-direction:column;gap:13px;color:var(--text-subtle);padding:14px;text-align:center}.camera-preview-empty>b{font-size:12px;font-weight:450;color:var(--text-muted)}.camera-preview-empty>p{font-size:10px;line-height:1.5}.camera-preview-empty .s-button{font-size:11px;margin-top:2px}.camera-preview-caption{display:flex;justify-content:space-between;gap:10px;font-size:10px;color:var(--text-subtle);padding-top:10px}.camera-device-field{min-width:0}.camera-device-label{display:flex;align-items:center;gap:7px;font-size:10px;color:var(--text-muted);margin-bottom:6px}.camera-device-label>label{flex:1}.camera-device-label>span{font-size:9px;white-space:nowrap;color:var(--text-subtle)}.camera-device-label .source-small-icon{margin-left:0;width:24px;height:24px}.camera-device-field>select{width:100%;min-width:0;background:var(--surface-2);border:1px solid var(--border-hair);border-radius:6px;height:34px;font-size:12px;padding:7px 9px;color:var(--text-primary)}.camera-audio-toggle{border-top:1px solid var(--border-hair);padding-top:18px}.source-connection-help{font-size:10px;color:var(--text-subtle);line-height:1.6}.source-connection-help summary{display:flex;align-items:center;gap:6px;cursor:pointer;list-style:none;width:fit-content}.source-connection-help summary::-webkit-details-marker{display:none}.source-connection-help summary:hover{color:var(--text-primary)}.source-connection-help[open] summary{color:var(--text-muted);margin-bottom:9px}.source-connection-help p+p{margin-top:7px}
.source-single-setup .source-input-properties{max-width:430px}
@media(max-width:1000px) and (min-width:701px){.camera-setup-grid{grid-template-columns:minmax(0,1fr);gap:20px}.camera-preview-panel{max-width:470px}.camera-setup-grid .source-input-properties{max-width:470px}.source-camera-workspace{padding:22px!important}}
@media(max-width:700px){.source-camera-workspace{padding:20px!important}.camera-setup-grid{display:flex;flex-direction:column;gap:23px;padding-top:18px}.camera-preview-panel,.camera-setup-grid .source-input-properties{width:100%;max-width:none}.camera-preview-empty{gap:9px}.camera-preview-empty>b{font-size:11px}.camera-preview-empty>svg{width:24px;height:24px}.camera-device-label .source-small-icon{width:30px;height:30px}.source-camera-workspace .source-input-intro{padding-bottom:16px}.source-camera-workspace .source-input-intro p{font-size:10px}.source-input-workspace:not(.source-camera-workspace) .source-input-intro h3{font-size:16px}}
.source-device-actions{display:flex;flex-wrap:wrap;gap:8px}.source-device-actions .s-button{font-size:11px;min-height:32px}
@media(min-width:701px){.source-sidebar>button>span{min-width:0;white-space:normal;line-height:1.4}}
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
