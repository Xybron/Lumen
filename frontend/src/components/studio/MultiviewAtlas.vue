<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, ref, watch } from 'vue';
import StudioMonitor from './StudioMonitor.vue';
import { MULTIVIEW_OUTPUT_ID, multiviewCanvasSize } from '../../../../shared/multiview-layout';
import { multiviewAtlasCells, multiviewDisplaySize } from '@/lib/studio/multiview-atlas';

const props = defineProps<{ sceneCount: number; columns: number }>();
const emit = defineEmits<{ ready: [value: boolean] }>();
const monitor = ref<{ video: HTMLVideoElement | null } | null>(null);
const canvas = ref<HTMLCanvasElement | null>(null);
const sourceReady = ref(false), ready = ref(false);
const layout = computed(() => multiviewDisplaySize(props.sceneCount, props.columns));
const crops = computed(() => multiviewAtlasCells(props.sceneCount, props.columns));
let frame: number | undefined;
let paintedAt = -Infinity;

function setReady(value: boolean) {
  if (ready.value !== value) { ready.value = value; emit('ready', value); }
}
function stop() {
  if (frame !== undefined) cancelAnimationFrame(frame);
  frame = undefined;
}
function render(now: number) {
  frame = undefined;
  if (layout.value.columns !== 4 || !sourceReady.value) return;
  frame = requestAnimationFrame(render);
  if (now - paintedAt < 1000 / 7.5) return;
  const video = monitor.value?.video, output = canvas.value;
  if (!video || !output || video.readyState < 2 || !video.videoWidth || !video.videoHeight || video.ended) {
    setReady(false); return;
  }
  // A scene-count edit resizes the existing sender's canvas. Wait for that
  // decoded resolution rather than briefly cropping the previous row layout.
  const sourceSize = multiviewCanvasSize(props.sceneCount);
  const scale = video.videoWidth / sourceSize.width;
  if (Math.abs(video.videoHeight - sourceSize.height * scale) > 2) { setReady(false); return; }
  const { width, height } = layout.value;
  if (output.width !== width || output.height !== height) { output.width = width; output.height = height; }
  const context = output.getContext('2d', { alpha: false });
  if (!context) { setReady(false); return; }
  try {
    context.fillStyle = '#080a0d';
    context.fillRect(0, 0, width, height);
    for (const cell of crops.value) context.drawImage(video,
      cell.sourceX * scale, cell.sourceY * scale, cell.width * scale, cell.height * scale,
      cell.targetX, cell.targetY, cell.width, cell.height);
    paintedAt = now;
    setReady(true);
  } catch {
    // Engine/track replacements can invalidate a decoded frame mid-paint.
    // Keep the design posters visible and recover on the next decoded frame.
    setReady(false);
  }
}
watch([sourceReady, () => props.sceneCount, () => layout.value.columns], () => {
  stop(); paintedAt = -Infinity;
  setReady(layout.value.columns === 2 && sourceReady.value);
  if (layout.value.columns === 4 && sourceReady.value) frame = requestAnimationFrame(render);
}, { flush: 'post' });
onMounted(() => emit('ready', false));
onBeforeUnmount(() => {
  stop();
  emit('ready', false);
  if (canvas.value) canvas.value.width = canvas.value.height = 0;
});
</script>

<template>
  <!-- One silent decoded track in either mode; fullscreen only rearranges its
       pixels locally, never adds a peer, source player, or audio path. -->
  <StudioMonitor ref="monitor" :output-id="MULTIVIEW_OUTPUT_ID" :audible="false"
    :style="layout.columns === 4 ? { opacity: 0 } : undefined" @ready="sourceReady = $event" />
  <canvas v-if="layout.columns === 4" ref="canvas" data-testid="multiview-scene-canvas" aria-hidden="true"
    :width="layout.width" :height="layout.height"
    :style="{ position: 'absolute', inset: '0', width: '100%', height: '100%', pointerEvents: 'none', opacity: ready ? 1 : 0 }" />
</template>
