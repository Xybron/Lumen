<script setup lang="ts">
import { computed, ref, watch } from 'vue';
import { Film, ImageOff, Music2, Play } from 'lucide-vue-next';
import { mediaAssetKind, mediaDuration, type MediaLibraryAsset } from '@/lib/media-library';

const props = withDefaults(defineProps<{ asset: MediaLibraryAsset; original?: boolean; alt?: string }>(), { original: false, alt: '' });
const emit = defineEmits<{ dimensions: [value: { id: string; width: number; height: number }] }>();
const failed = ref(false), fallback = ref(false);
const kind = computed(() => mediaAssetKind(props.asset));
const source = computed(() => kind.value === 'audio' ? null : kind.value === 'video' ? props.asset.thumbnail : props.original || fallback.value ? props.asset.url : props.asset.thumbnail || props.asset.url);
watch(() => [props.asset.id, props.asset.url, props.asset.thumbnail, props.original], () => { failed.value = false; fallback.value = false; });
function onError() { if (kind.value === 'image' && !props.original && props.asset.thumbnail && !fallback.value) fallback.value = true; else failed.value = true; }
function onLoad(event: Event) {
  const image = event.target as HTMLImageElement;
  if (props.original && image.naturalWidth > 0 && image.naturalHeight > 0) emit('dimensions', { id: props.asset.id, width: image.naturalWidth, height: image.naturalHeight });
}
</script>

<template>
  <span class="media-thumbnail" :class="{ 'media-thumbnail-missing': failed }">
    <img v-if="source && !failed" :src="source" :alt="alt" loading="lazy" decoding="async" @error="onError" @load="onLoad" />
    <span v-else-if="kind !== 'image'" class="media-thumbnail-fallback media-thumbnail-kind" role="img" :aria-label="kind === 'audio' ? 'Audio file' : 'Video file'"><Music2 v-if="kind === 'audio'" :size="30" :stroke-width="1.3" /><Film v-else :size="30" :stroke-width="1.3" /><span>{{ kind === 'audio' ? 'Audio' : 'Video' }}</span></span>
    <span v-else class="media-thumbnail-fallback" role="img" :aria-label="alt ? `${alt}: preview unavailable` : 'Image preview unavailable'"><ImageOff :size="24" /><span>Preview unavailable</span></span>
    <span v-if="kind === 'video'" class="media-thumbnail-kind-badge"><Play :size="10" fill="currentColor" /><span v-if="asset.durationMs !== undefined">{{ mediaDuration(asset.durationMs) }}</span><span v-else>Video</span></span>
  </span>
</template>
