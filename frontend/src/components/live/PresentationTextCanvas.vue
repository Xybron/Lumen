<script setup lang="ts">
import { computed, onMounted, onBeforeUnmount, ref, watch } from 'vue';
import type { Item } from '@/types';
import { clearPresentationTextLayouts, drawPresentationText } from '@/lib/presentation-slide';
const props = defineProps<{ item: Item; prayerLabel?: string }>();
const canvas = ref<HTMLCanvasElement>();
const description = computed(() => [props.prayerLabel && `Prayer ${props.prayerLabel}`, props.item.title, props.item.body, props.item.reference].filter(Boolean).join('\n'));
let disposed = false;
function paint() {
  const ctx = canvas.value?.getContext('2d');
  if (!ctx) return;
  ctx.clearRect(0, 0, 1920, 1080);
  drawPresentationText(ctx, props.item, { prayerLabel: props.prayerLabel });
}
function fontsReady() { if (!disposed) { clearPresentationTextLayouts(); paint(); } }
watch(() => [props.item, props.prayerLabel], paint, { deep: true, flush: 'post' });
onMounted(() => { paint(); void document.fonts?.ready.then(fontsReady); document.fonts?.addEventListener('loadingdone', fontsReady); });
onBeforeUnmount(() => { disposed = true; document.fonts?.removeEventListener('loadingdone', fontsReady); });
</script>
<template><canvas ref="canvas" width="1920" height="1080" class="presentation-text-canvas" role="img" :aria-label="description" /></template>
<style scoped>.presentation-text-canvas{position:absolute;inset:0;width:100%;height:100%;pointer-events:none}</style>
