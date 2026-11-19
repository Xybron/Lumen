<script setup lang="ts">
import { onMounted, onBeforeUnmount, ref } from 'vue';
import type { PresentationGraphics } from '@/types';
import { drawPresentationGraphics, presentationElapsed, presentationGraphics } from '@/lib/presentation-graphics';
const props = defineProps<{ graphics?: PresentationGraphics; clock: { elapsedMs: number; receivedAt: number }; durationMs: number;
  playing: boolean; countdownAtMs: number; warningAtMs: number; title?: string }>();
const canvas = ref<HTMLCanvasElement | null>(null);
let raf = 0;
function paint() {
  const ctx = canvas.value?.getContext('2d');
  if (ctx) {
    ctx.clearRect(0, 0, 1920, 1080);
    drawPresentationGraphics(ctx, { graphics: presentationGraphics(props.graphics),
      elapsedMs: presentationElapsed(props.clock, props.durationMs, props.playing, performance.now()),
      durationMs: props.durationMs, countdownAtMs: props.countdownAtMs, warningAtMs: props.warningAtMs, title: props.title }, 1920, 1080);
  }
  raf = requestAnimationFrame(paint);
}
onMounted(paint); onBeforeUnmount(() => cancelAnimationFrame(raf));
</script>
<template><canvas ref="canvas" width="1920" height="1080" class="presentation-graphics" aria-label="Presentation timing graphics" /></template>
<style scoped>.presentation-graphics{position:absolute;inset:0;width:100%;height:100%;pointer-events:none;z-index:30}</style>
