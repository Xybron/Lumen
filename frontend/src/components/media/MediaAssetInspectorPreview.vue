<script setup lang="ts">
import { computed, onBeforeUnmount, ref, watch } from 'vue';
import { Film, LoaderCircle, Music2, RefreshCw, TriangleAlert } from 'lucide-vue-next';
import { mediaAssetKind, mediaImageName, type MediaLibraryAsset } from '@/lib/media-library';
import MediaAssetThumbnail from './MediaAssetThumbnail.vue';

const props = withDefaults(defineProps<{ asset: MediaLibraryAsset; preparing?: boolean; preparationError?: string }>(), { preparing: false, preparationError: '' });
const emit = defineEmits<{ metadata: [value: { id: string; width?: number; height?: number; durationMs?: number }]; retry: [] }>();
const player = ref<HTMLMediaElement>(), failure = ref('');
const kind = computed(() => mediaAssetKind(props.asset));
const source = computed(() => props.asset.playbackUrl || props.asset.url);
const key = computed(() => `${props.asset.id}:${source.value}`);
let currentKey = key.value;
function pause() { player.value?.pause(); }
watch(key, () => { pause(); currentKey = key.value; failure.value = ''; }, { flush: 'sync' });
watch(() => props.preparing, value => { if (value) pause(); });
onBeforeUnmount(() => { pause(); player.value?.removeAttribute('src'); player.value?.load(); });
function metadata(event: Event) {
  const media = event.currentTarget as HTMLMediaElement;
  if (media.dataset.mediaKey !== currentKey) return;
  emit('metadata', { id: props.asset.id, ...(media instanceof HTMLVideoElement && media.videoWidth ? { width: media.videoWidth, height: media.videoHeight } : {}), ...(Number.isFinite(media.duration) ? { durationMs: Math.round(media.duration * 1000) } : {}) });
}
function failed(event: Event) {
  if ((event.currentTarget as HTMLElement).dataset.mediaKey !== currentKey) return;
  pause(); failure.value = `This ${kind.value === 'audio' ? 'audio file' : 'video'} could not be played. It may use an unsupported format, or the file may be unavailable.`;
}
function retry() { failure.value = ''; emit('retry'); }
</script>

<template>
  <MediaAssetThumbnail v-if="kind === 'image'" :key="asset.id" :asset="asset" original :alt="mediaImageName(asset)" @dimensions="emit('metadata', $event)" />
  <div v-else class="media-inspector-player" :data-media-kind="kind">
    <div v-if="preparing" class="media-player-message" role="status"><LoaderCircle :size="26" class="media-spin" /><strong>Preparing video for playback…</strong><span>You can use it when preparation finishes.</span></div>
    <div v-else-if="preparationError || failure" class="media-player-message media-player-error" role="status"><TriangleAlert :size="25" /><strong>Preview unavailable</strong><span>{{ preparationError || failure }}</span><button type="button" class="media-button" @click="retry"><RefreshCw :size="13" />Try again</button></div>
    <template v-else-if="kind === 'video'"><video :key="key" ref="player" :src="source" :poster="asset.thumbnail || undefined" :data-media-key="key" :aria-label="`Preview ${mediaImageName(asset)}`" controls muted playsinline preload="metadata" @loadedmetadata="metadata" @error="failed"><Film :size="30" />Your browser does not support video previews.</video><p>Muted preview · Press play to preview</p></template>
    <template v-else><div class="media-audio-artwork"><Music2 :size="36" :stroke-width="1.3" /><span>Audio preview</span></div><audio :key="key" ref="player" :src="source" :data-media-key="key" :aria-label="`Preview ${mediaImageName(asset)}`" controls preload="metadata" @loadedmetadata="metadata" @error="failed">Your browser does not support audio previews.</audio><p>Press play to listen</p></template>
  </div>
</template>
