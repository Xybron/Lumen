<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, ref, watch } from 'vue';
import { Film, LoaderCircle, Play } from 'lucide-vue-next';
import type { ClipRecording } from '../../../../shared/clips';
import { clipsApi } from '@/lib/clips';

const props = defineProps<{ recording: ClipRecording; playable?: boolean }>();
const element = ref<HTMLElement | null>(null), image = ref(''), failed = ref(false), loading = ref(false);
let observer: IntersectionObserver | undefined, video: HTMLVideoElement | undefined, generation = 0;
const ready = computed(() => props.recording.status === 'complete');
function release() { if (video) { video.pause(); video.removeAttribute('src'); video.load(); video = undefined; } }
async function load(forceClient = false) {
  if (!ready.value || image.value || loading.value) return;
  const run = ++generation;
  if (props.recording.posterReady && !forceClient) { image.value = clipsApi.poster(props.recording.id); return; }
  // Decode just one visible thumbnail on the editor's device; no render work on
  // the production engine and no hidden, continuously playing video elements.
  loading.value = true;
  const source = document.createElement('video'); video = source;
  source.preload = 'metadata'; source.muted = true; source.playsInline = true;
  let timeout: ReturnType<typeof setTimeout> | undefined;
  try {
    await new Promise<void>((resolve, reject) => {
      timeout = setTimeout(() => reject(new Error('Thumbnail unavailable')), 12000);
      source.onerror = () => reject(new Error('Thumbnail unavailable'));
      source.onloadeddata = () => resolve();
      source.src = clipsApi.media(props.recording.id); source.load();
    });
    if (run !== generation || !source.videoWidth) return;
    const canvas = document.createElement('canvas'); canvas.width = 480;
    canvas.height = Math.max(1, Math.round(480 * source.videoHeight / source.videoWidth));
    canvas.getContext('2d')?.drawImage(source, 0, 0, canvas.width, canvas.height);
    image.value = canvas.toDataURL('image/jpeg', .78);
  } catch { if (run === generation) failed.value = true; }
  finally { if (timeout) clearTimeout(timeout); if (run === generation) { loading.value = false; release(); } }
}
function imageFailed() { if (image.value.startsWith('data:')) { failed.value = true; return; } image.value = ''; failed.value = false; void load(true); }
watch(() => props.recording.posterReady, value => { if (value) { generation++; release(); loading.value = false; failed.value = false; image.value = clipsApi.poster(props.recording.id); } });
watch(ready, value => { const rect = element.value?.getBoundingClientRect(); if (value && rect && rect.top < window.innerHeight + 80 && rect.bottom > -80) { observer?.disconnect(); void load(); } });
onMounted(() => {
  observer = new IntersectionObserver(entries => { if (ready.value && entries.some(entry => entry.isIntersecting)) { observer?.disconnect(); void load(); } }, { rootMargin: '80px' });
  if (element.value) observer.observe(element.value);
});
onBeforeUnmount(() => { generation++; observer?.disconnect(); release(); });
</script>

<template>
  <span ref="element" class="clip-thumbnail" :class="{ 'clip-thumbnail-ready': ready }">
    <img v-if="image && !failed" :src="image" alt="" loading="lazy" @error="imageFailed" />
    <span v-else class="clip-thumbnail-empty"><LoaderCircle v-if="loading" :size="24" class="clip-spin" /><Film v-else :size="30" :stroke-width="1.3" /><small>{{ loading ? 'Loading preview' : ready ? 'Recording preview' : recording.status === 'recording' ? 'Recording in progress' : 'Preview not yet available' }}</small></span>
    <span v-if="ready && playable" class="clip-thumbnail-play"><Play :size="19" fill="currentColor" /></span>
    <span class="clip-thumbnail-duration">{{ Math.floor(recording.durationMs / 3600000) ? Math.floor(recording.durationMs / 3600000) + ':' : '' }}{{ String(Math.floor(recording.durationMs / 60000) % 60).padStart(2, '0') }}:{{ String(Math.floor(recording.durationMs / 1000) % 60).padStart(2, '0') }}</span>
  </span>
</template>
