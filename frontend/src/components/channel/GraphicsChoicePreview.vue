<script setup lang="ts">
import { onMounted, ref, watch } from 'vue';
import { drawPresentationGraphics, presentationGraphics } from '@/lib/presentation-graphics';
import type { PresentationGraphics } from '@/types';

const props = defineProps<{ graphics: Partial<PresentationGraphics>; kind: 'template' | 'tip' | 'icon'; value: string }>();
const canvas = ref<HTMLCanvasElement>();
function paint() {
  const el = canvas.value, ctx = el?.getContext('2d');
  if (!el || !ctx) return;
  ctx.clearRect(0, 0, el.width, el.height);
  const closeup = props.kind !== 'template';
  const graphics = presentationGraphics({ ...props.graphics, progress: true, timer: false, caption: false,
    countdown: false, warning: false, size: 'medium', position: 'top' });
  // Tip samples use a neutral line so the actual Program glyph is easy to compare.
  // Style samples enlarge thin strokes; the full audience preview retains exact sizing.
  if (closeup) { graphics.template = 'minimal'; graphics.thickness = 4; }
  else graphics.thickness = Math.max(12, graphics.thickness);
  if (!closeup && graphics.template === 'broadcast') {
    graphics.timer = true; graphics.caption = true; graphics.size = 'large';
  }
  const scale = closeup ? 2.6 : (el.width - 32) / 1920;
  const size = graphics.size === 'large' ? 1.35 : 1;
  const barY = graphics.template === 'flame' ? 0 : 46 + (graphics.timer ? 62 : 17) * size;
  const tipX = 46 + (1920 - 92) * .65;
  ctx.save();
  ctx.translate(closeup ? el.width / 2 - tipX * scale : 16, el.height / 2 - (barY + graphics.thickness * size / 2) * scale);
  ctx.scale(scale, scale);
  drawPresentationGraphics(ctx, { graphics, durationMs: 100000, elapsedMs: 65000, countdownAtMs: 0, warningAtMs: 0, title: 'Your presentation' }, 1920, 1080);
  ctx.restore();
}
onMounted(paint);
watch(() => props.graphics, paint, { deep: true, flush: 'post' });
</script>
<template><canvas ref="canvas" :width="kind === 'template' ? 560 : 180" :height="kind === 'template' ? 124 : 100" class="graphics-choice-preview" :data-preview-kind="kind" :data-preview-value="value" aria-hidden="true" /></template>
<style scoped>
.graphics-choice-preview{display:block;width:100%;height:100%;pointer-events:none}
.graphics-choice-preview[data-preview-kind=tip],.graphics-choice-preview[data-preview-kind=icon]{object-fit:contain}
</style>
