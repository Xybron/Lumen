<script setup lang="ts">
import { computed, ref } from 'vue';
const props = defineProps<{ duration: number; inMs: number; outMs: number; current: number; disabled?: boolean }>();
const emit = defineEmits<{ seek: [ms: number]; trim: [input: number, output: number] }>();
const track = ref<HTMLElement | null>(null), dragging = ref<'in' | 'out' | null>(null);
const percentage = (value: number) => `${Math.max(0, Math.min(100, value / Math.max(1, props.duration) * 100))}%`;
const ticks = computed(() => Array.from({ length: 7 }, (_, index) => Math.round(props.duration * index / 6)));
function label(ms: number) { const seconds = Math.floor(ms / 1000); return `${Math.floor(seconds / 60)}:${String(seconds % 60).padStart(2, '0')}`; }
function position(event: PointerEvent) { const rect = track.value!.getBoundingClientRect(); return Math.round(Math.max(0, Math.min(1, (event.clientX - rect.left) / rect.width)) * props.duration); }
function trimAt(event: PointerEvent) {
  const ms = position(event), minimum = Math.min(250, props.duration);
  if (dragging.value === 'in') emit('trim', Math.min(ms, props.outMs - minimum), props.outMs);
  else if (dragging.value === 'out') emit('trim', props.inMs, Math.max(ms, props.inMs + minimum));
}
function start(event: PointerEvent, which: 'in' | 'out') { if (props.disabled) return; event.preventDefault(); event.stopPropagation(); dragging.value = which; (event.currentTarget as HTMLElement).setPointerCapture(event.pointerId); trimAt(event); }
function move(event: PointerEvent) { if (dragging.value) trimAt(event); }
function end() { dragging.value = null; }
function keyboard(event: KeyboardEvent, which: 'in' | 'out') {
  if (props.disabled || !['ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(event.key)) return;
  event.preventDefault(); event.stopPropagation();
  const step = event.shiftKey ? 1000 : 100, direction = event.key === 'ArrowLeft' ? -1 : 1;
  const current = which === 'in' ? props.inMs : props.outMs;
  const next = event.key === 'Home' ? 0 : event.key === 'End' ? props.duration : current + step * direction;
  if (which === 'in') emit('trim', Math.max(0, Math.min(props.outMs - Math.min(250, props.duration), next)), props.outMs);
  else emit('trim', props.inMs, Math.min(props.duration, Math.max(props.inMs + Math.min(250, props.duration), next)));
}
</script>

<template>
  <div class="clip-timeline" data-testid="clip-timeline">
    <div class="clip-timeline-ruler" aria-hidden="true"><span v-for="tick in ticks" :key="tick">{{ label(tick) }}</span></div>
    <div ref="track" class="clip-timeline-track" @pointerdown="emit('seek', position($event))">
      <div class="clip-timeline-texture" aria-hidden="true" />
      <div class="clip-timeline-outside" :style="{ width: percentage(inMs) }" />
      <div class="clip-timeline-outside clip-timeline-after" :style="{ width: percentage(duration - outMs) }" />
      <div class="clip-timeline-selection" :style="{ left: percentage(inMs), width: percentage(outMs - inMs) }"><span>{{ label(outMs - inMs) }} selected</span></div>
      <button type="button" role="slider" class="clip-trim-handle" :style="{ left: percentage(inMs) }" aria-label="Clip start handle" :aria-valuemin="0" :aria-valuemax="outMs" :aria-valuenow="inMs" :aria-valuetext="label(inMs)" :disabled="disabled" @pointerdown="start($event, 'in')" @pointermove="move" @pointerup="end" @pointercancel="end" @lostpointercapture="end" @keydown="keyboard($event, 'in')"><i /></button>
      <button type="button" role="slider" class="clip-trim-handle clip-trim-end" :style="{ left: percentage(outMs) }" aria-label="Clip end handle" :aria-valuemin="inMs" :aria-valuemax="duration" :aria-valuenow="outMs" :aria-valuetext="label(outMs)" :disabled="disabled" @pointerdown="start($event, 'out')" @pointermove="move" @pointerup="end" @pointercancel="end" @lostpointercapture="end" @keydown="keyboard($event, 'out')"><i /></button>
      <div class="clip-timeline-playhead" :style="{ left: percentage(current) }" aria-hidden="true"><i /></div>
    </div>
    <input class="clip-scrubber" type="range" min="0" :max="duration" step="33" :value="current" aria-label="Seek recording" @input="emit('seek', Number(($event.target as HTMLInputElement).value))" />
  </div>
</template>
