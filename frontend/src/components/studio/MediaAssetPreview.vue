<script setup lang="ts">
import { computed, onBeforeUnmount, ref, watch } from 'vue';
import { Film, Image as ImageIcon, LoaderCircle, Music2, RotateCw, TriangleAlert } from 'lucide-vue-next';

type AssetMetadata = { width?: number; height?: number; duration?: number };
const props = withDefaults(defineProps<{
  kind: 'image' | 'video' | 'audio';
  src: string;
  name: string;
  poster?: string;
  loading?: boolean;
}>(), { poster: undefined, loading: false });
const emit = defineEmits<{
  metadata: [metadata: AssetMetadata];
  error: [error: { message: string }];
}>();

const video = ref<HTMLVideoElement | null>(null);
const audio = ref<HTMLAudioElement | null>(null);
const generation = ref(0);
const pending = ref(false);
const failure = ref('');
const metadata = ref<AssetMetadata>({});
let disposed = false;

const mediaKey = computed(() => String(generation.value));
const state = computed(() => failure.value ? 'error' : pending.value || props.loading ? 'loading' : 'ready');
const mediaIcon = computed(() => props.kind === 'image' ? ImageIcon : props.kind === 'video' ? Film : Music2);
const typeLabel = computed(() => props.kind === 'image' ? 'Image' : props.kind === 'video' ? 'Video' : 'Audio');
const dimensions = computed(() => metadata.value.width && metadata.value.height
  ? `${metadata.value.width.toLocaleString()} × ${metadata.value.height.toLocaleString()}` : '');
const duration = computed(() => {
  const seconds = metadata.value.duration;
  if (seconds === undefined || !Number.isFinite(seconds)) return '';
  const total = Math.floor(seconds), minutes = Math.floor(total / 60), remainder = String(total % 60).padStart(2, '0');
  return minutes >= 60 ? `${Math.floor(minutes / 60)}:${String(minutes % 60).padStart(2, '0')}:${remainder}` : `${minutes}:${remainder}`;
});

function pauseMedia() {
  video.value?.pause();
  audio.value?.pause();
}
function reset() {
  pauseMedia();
  generation.value += 1;
  failure.value = '';
  metadata.value = {};
  pending.value = Boolean(props.src);
}
watch(() => [props.src, props.kind], reset, { immediate: true, flush: 'sync' });
onBeforeUnmount(() => { disposed = true; pauseMedia(); });

// A file can finish decoding after another selection has replaced it. Only the
// keyed element belonging to the current selection may update the preview.
function current(event: Event) {
  return !disposed && (event.currentTarget as HTMLElement | null)?.dataset.previewKey === mediaKey.value;
}
function imageLoaded(event: Event) {
  if (!current(event)) return;
  const image = event.currentTarget as HTMLImageElement;
  metadata.value = { width: image.naturalWidth, height: image.naturalHeight };
  pending.value = false;
  emit('metadata', { ...metadata.value });
}
function mediaLoaded(event: Event) {
  if (!current(event)) return;
  const media = event.currentTarget as HTMLMediaElement;
  metadata.value = {
    ...(media instanceof HTMLVideoElement && media.videoWidth ? { width: media.videoWidth, height: media.videoHeight } : {}),
    ...(Number.isFinite(media.duration) ? { duration: media.duration } : {}),
  };
  pending.value = false;
  emit('metadata', { ...metadata.value });
}
function failed(event: Event) {
  if (!current(event)) return;
  pauseMedia();
  pending.value = false;
  const element = event.currentTarget;
  const mediaError = element instanceof HTMLMediaElement ? element.error : null;
  failure.value = mediaError?.code === MediaError.MEDIA_ERR_NETWORK
    ? 'The file could not be loaded. Check your connection to this station and try again.'
    : props.kind === 'image'
      ? 'This image could not be opened. Try another image or upload it again.'
      : `This ${props.kind} could not be played. It may use a format this browser does not support.`;
  emit('error', { message: failure.value });
}
</script>

<template>
  <section class="asset-preview" data-testid="media-asset-preview" :data-preview-state="state" :aria-busy="state === 'loading'" :aria-label="`${typeLabel} preview`">
    <div class="preview-heading">
      <span><component :is="mediaIcon" :size="14" aria-hidden="true" /> Preview</span>
      <span v-if="loading && !failure" class="import-status"><LoaderCircle :size="12" aria-hidden="true" /> Importing…</span>
      <span v-else class="preview-type">{{ typeLabel }}</span>
    </div>

    <div class="preview-viewport" :class="{ 'image-viewport': kind === 'image' && src && !failure, 'audio-viewport': kind === 'audio', 'has-error': failure }">
      <template v-if="src && !failure">
        <img v-if="kind === 'image'" :key="`image-${mediaKey}`" :src="src" :alt="name ? `Preview of ${name}` : 'Selected image preview'" :data-preview-key="mediaKey" class="preview-image" @load="imageLoaded" @error="failed" />
        <video v-else-if="kind === 'video'" :key="`video-${mediaKey}`" ref="video" :src="src" :poster="poster" :data-preview-key="mediaKey" class="preview-video" :aria-label="name ? `Preview ${name}` : 'Preview selected video'" controls muted playsinline preload="metadata" @loadedmetadata="mediaLoaded" @error="failed">
          Your browser does not support video previews.
        </video>
        <div v-else class="audio-preview">
          <div class="audio-artwork" aria-hidden="true"><Music2 :size="34" :stroke-width="1.3" /></div>
          <span class="audio-name">{{ name || 'Audio preview' }}</span>
          <span class="audio-hint">Listen before adding it to your scene</span>
          <audio :key="`audio-${mediaKey}`" ref="audio" :src="src" :data-preview-key="mediaKey" :aria-label="name ? `Preview ${name}` : 'Preview selected audio'" controls preload="metadata" @loadedmetadata="mediaLoaded" @error="failed">
            Your browser does not support audio previews.
          </audio>
        </div>
        <div v-if="pending" class="preview-loading" role="status"><LoaderCircle :size="19" aria-hidden="true" /><span>Loading preview…</span></div>
      </template>

      <div v-else-if="failure" class="preview-message" role="alert">
        <TriangleAlert :size="25" :stroke-width="1.4" aria-hidden="true" />
        <strong>Preview unavailable</strong>
        <p>{{ failure }}</p>
        <button type="button" class="preview-retry" @click="reset"><RotateCw :size="13" aria-hidden="true" /> Try again</button>
      </div>

      <div v-else class="preview-message preview-empty">
        <component :is="mediaIcon" :size="32" :stroke-width="1.2" aria-hidden="true" />
        <strong>See it before it goes live</strong>
        <p>Select {{ kind === 'image' ? 'an image' : kind === 'video' ? 'a video' : 'an audio file' }} from your library or upload a new one.</p>
      </div>
    </div>

    <div class="preview-caption" aria-live="polite" aria-atomic="true">
      <span v-if="dimensions || duration" class="asset-details"><span v-if="dimensions">{{ dimensions }}</span><span v-if="duration">{{ duration }}</span></span>
      <span v-else>{{ failure ? 'Your file has not been added to Studio.' : src ? 'Original media' : 'No media selected' }}</span>
      <span v-if="kind === 'video' && src && !failure" class="playback-note">Muted preview</span>
      <span v-else-if="kind === 'image' && src && !failure" class="playback-note">Fit to view</span>
      <span v-else-if="kind === 'audio' && src && !failure" class="playback-note">Preview only</span>
    </div>
  </section>
</template>

<style scoped>
.asset-preview { min-width: 0; color: var(--text-primary); }
.preview-heading { display: flex; align-items: center; justify-content: space-between; gap: 12px; min-height: 20px; margin-bottom: 12px; color: var(--text-muted); font-size: 11px; }
.preview-heading > span:first-child { display: inline-flex; align-items: center; gap: 7px; font-weight: 500; }
.preview-type { font-size: 10px; color: var(--text-subtle); }
.import-status { display: inline-flex; align-items: center; gap: 5px; color: var(--accent); font-size: 10px; }
.preview-viewport { position: relative; display: grid; place-items: center; isolation: isolate; aspect-ratio: 16 / 10; min-width: 0; overflow: hidden; border: 1px solid var(--border-hair); border-radius: 8px; background: #0d0e10; }
.image-viewport { background-color: #202225; background-image: linear-gradient(45deg, #292b2e 25%, transparent 25%), linear-gradient(-45deg, #292b2e 25%, transparent 25%), linear-gradient(45deg, transparent 75%, #292b2e 75%), linear-gradient(-45deg, transparent 75%, #292b2e 75%); background-size: 20px 20px; background-position: 0 0, 0 10px, 10px -10px, -10px 0; }
.preview-image, .preview-video { display: block; position: absolute; inset: 0; width: 100%; height: 100%; object-fit: contain; }
.preview-video { color-scheme: dark; background: #08090a; }
.audio-viewport { aspect-ratio: auto; min-height: 236px; background: #121416; }
.audio-preview { display: flex; flex-direction: column; align-items: center; width: 100%; padding: 26px 22px 20px; text-align: center; }
.audio-artwork { display: grid; place-items: center; width: 74px; height: 74px; margin-bottom: 17px; border: 1px solid var(--border-glow); border-radius: 17px; color: var(--accent); background: var(--surface-2); box-shadow: 0 10px 30px #0003; }
.audio-name { display: block; max-width: 100%; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; color: var(--text-primary); font-size: 12px; font-weight: 500; }
.audio-hint { margin-top: 6px; color: var(--text-subtle); font-size: 10px; line-height: 1.5; }
.audio-preview audio { display: block; flex-shrink: 0; width: 100%; max-width: 360px; height: 36px; margin-top: 21px; color-scheme: dark; }
.preview-loading { position: absolute; inset: 0; z-index: 1; display: flex; align-items: center; justify-content: center; gap: 8px; color: var(--text-muted); background: #101113e6; font-size: 11px; pointer-events: none; }
.preview-loading svg, .import-status svg { animation: preview-spin 1s linear infinite; }
.preview-message { display: flex; flex-direction: column; align-items: center; gap: 12px; width: 100%; padding: 30px 24px; text-align: center; }
.preview-message > svg { color: var(--text-subtle); }
.preview-message strong { color: var(--text-primary); font-size: 12px; font-weight: 500; }
.preview-message p { max-width: 300px; margin: 0; color: var(--text-muted); font-size: 11px; line-height: 1.65; }
.preview-empty { gap: 13px; }
.preview-empty strong { color: var(--text-muted); }
.preview-empty p { color: var(--text-subtle); }
.preview-retry { display: inline-flex; align-items: center; justify-content: center; gap: 6px; margin-top: 3px; padding: 7px 11px; border: 1px solid var(--border-glow); border-radius: var(--radius-control); background: var(--surface-2); color: var(--text-primary); font-size: 11px; cursor: pointer; }
.preview-retry:hover { background: var(--surface-3); }
.preview-retry:focus-visible { outline: 2px solid var(--accent); outline-offset: 3px; }
.preview-caption { display: flex; align-items: flex-start; justify-content: space-between; gap: 12px; min-height: 30px; padding-top: 10px; color: var(--text-subtle); font-size: 10px; line-height: 1.5; }
.asset-details { display: inline-flex; flex-wrap: wrap; gap: 5px 10px; font-variant-numeric: tabular-nums; }
.asset-details > span + span::before { content: '·'; margin-right: 10px; color: var(--text-subtle); }
.playback-note { flex-shrink: 0; }
@keyframes preview-spin { to { transform: rotate(360deg); } }
@media (max-width: 480px) {
  .audio-preview { padding: 20px 14px 14px; }
  .audio-artwork { width: 56px; height: 56px; margin-bottom: 12px; border-radius: 13px; }
  .audio-artwork svg { width: 28px; height: 28px; }
  .audio-preview audio { margin-top: 15px; }
  .preview-message { padding: 24px 18px; }
}
@media (prefers-reduced-motion: reduce) { .preview-loading svg, .import-status svg { animation: none; } }
</style>
