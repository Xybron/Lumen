<script setup lang="ts">
import { onBeforeUnmount, ref, watch } from 'vue';
import { Film, Image, Music2 } from 'lucide-vue-next';
const props = defineProps<{ url: string; kind: 'video' | 'image' | 'audio'; poster?: string }>();
const image = ref(props.poster || ''), failed = ref(false);
let pending: HTMLVideoElement | null = null, generation = 0;
function cleanup() { if (pending) { pending.pause(); pending.removeAttribute('src'); pending.load(); pending = null; } }
async function generate() {
  const run = ++generation; cleanup(); image.value = props.poster || ''; failed.value = false;
  if (props.kind !== 'video' || props.poster || !props.url) return;
  const video = document.createElement('video'); pending = video; video.preload = 'metadata'; video.muted = true; video.playsInline = true;
  const stop = () => { if (run === generation) cleanup(); };
  video.addEventListener('loadedmetadata', () => { if (run !== generation) return; video.currentTime = Math.min(1, Math.max(0, video.duration / 10)); }, { once: true });
  video.addEventListener('seeked', () => {
    if (run !== generation) return;
    try { const canvas = document.createElement('canvas'); canvas.width = 320; canvas.height = Math.max(1, Math.round(320 * video.videoHeight / video.videoWidth)); canvas.getContext('2d')?.drawImage(video, 0, 0, canvas.width, canvas.height); image.value = canvas.toDataURL('image/jpeg', .7); } catch { /* Source is still importable without a poster. */ }
    stop();
  }, { once: true });
  video.addEventListener('error', stop, { once: true }); video.src = props.url;
}
watch(() => [props.url, props.poster, props.kind], () => { void generate(); }, { immediate: true });
onBeforeUnmount(() => { generation++; cleanup(); });
</script>
<template><img v-if="(image || kind === 'image') && !failed" :src="image || url" alt="" draggable="false" @error="failed = true" /><Music2 v-else-if="kind === 'audio'" :size="22" /><Image v-else-if="kind === 'image'" :size="22" /><Film v-else :size="22" /></template>
