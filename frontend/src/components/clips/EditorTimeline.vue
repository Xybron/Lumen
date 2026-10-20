<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, ref } from 'vue';
import EditorTimelineMedia from './EditorTimelineMedia.vue';
import { ArrowRightLeft, Copy, Eye, EyeOff, Film, LockKeyhole, Magnet, Minus, Music2, Plus, Redo2, Scissors, Trash2, Type, Undo2, UnlockKeyhole, Volume2, VolumeX } from 'lucide-vue-next';
import type { ClipTimeline, ClipTimelineItem, ClipTimelineTrack } from '../../../../shared/clips';
import { clamp, formatClipTime, snapTime } from '@/lib/clip-timeline';
import { transitionAtCut } from '@/lib/clip-transitions';

const props = defineProps<{ timeline: ClipTimeline; current: number; duration: number; selectedId: string | null; disabled: boolean; undoAvailable: boolean; redoAvailable: boolean; thumbnail: (item: ClipTimelineItem) => string; height: number }>();
const emit = defineEmits<{ seek: [ms: number]; select: [id: string]; move: [id: string, startMs: number, trackId: string, reorder: boolean]; trim: [id: string, side: 'in' | 'out', delta: number]; begin: []; end: []; track: [id: string, patch: Partial<ClipTimelineTrack>]; split: []; remove: []; duplicate: []; undo: []; redo: []; addTrack: []; height: [height: number]; transition: [id: string] }>();
const zoom = ref(1), snap = ref(true), ripple = ref(true), scroll = ref<HTMLElement | null>(null), containerWidth = ref(800);
const sheet = ref<HTMLElement | null>(null), scrubbing = ref(false);
const scrollLeft = ref(0);
const viewportWidth = computed(() => Math.max(0, containerWidth.value - 137));
const scale = computed(() => Math.max(.006, Math.min(.08, 750 / Math.max(10000, props.duration))) * zoom.value);
const extent = computed(() => Math.min(7_200_000, Math.max(15_000, props.duration + 10_000, props.current + 5000)));
const laneWidth = computed(() => Math.max(containerWidth.value - 138, extent.value * scale.value));
const tickStep = computed(() => { for (const step of [1000, 2000, 5000, 10000, 15000, 30000, 60000, 120000, 300000, 600000]) if (step * scale.value >= 70) return step; return 600000; });
const ticks = computed(() => Array.from({ length: Math.floor(laneWidth.value / scale.value / tickStep.value) + 1 }, (_, i) => i * tickStep.value));
const displayTracks = computed(() => [...props.timeline.tracks.filter(track => track.kind !== 'audio')].reverse().concat(props.timeline.tracks.filter(track => track.kind === 'audio')));
const orderedItems = (track: ClipTimelineTrack) => [...track.items].sort((a, b) => a.startMs - b.startMs);
const cutItems = (track: ClipTimelineTrack) => track.kind === 'video' ? orderedItems(track).filter(item => transitionAtCut(track, item.id).eligible).filter(item => { const x = (item.startMs + (item.transitionIn?.durationMs ?? 0) / 2) * scale.value; return x >= scrollLeft.value - 30 && x <= scrollLeft.value + viewportWidth.value + 30; }) : [];
let drag: { id: string; x: number; startMs: number; trackId: string; side: 'in' | 'out' | null; duration: number; pointerId: number; element: HTMLElement } | null = null;
let resize: { y: number; height: number } | null = null;
let scrub: { pointerId: number; element: HTMLElement } | null = null;
let seekFrame = 0, pendingSeekX: number | null = null;
let resizeObserver: ResizeObserver | null = null;

function seekAt(clientX: number) {
  if (!sheet.value) return;
  // The sheet is stationary within the scroll container. A moving playhead
  // cannot be used as the origin; its rectangle changes after every seek.
  const origin = sheet.value.getBoundingClientRect().left + 137;
  emit('seek', Math.round(clamp((clientX - origin) / scale.value, 0, Math.max(0, props.duration - 1))));
}
function flushSeek() {
  cancelAnimationFrame(seekFrame); seekFrame = 0;
  if (pendingSeekX !== null) { const x = pendingSeekX; pendingSeekX = null; seekAt(x); }
}
function startScrub(event: PointerEvent) {
  if (event.button !== 0 || !event.isPrimary || drag || scrub) return;
  const element = event.currentTarget as HTMLElement;
  // On touch screens, keep empty lanes available for native timeline panning.
  // The ruler and playhead remain dedicated touch-scrubbing targets.
  if (event.pointerType === 'touch' && element.classList.contains('nle-track-lane')) return;
  event.preventDefault(); event.stopPropagation();
  scrub = { pointerId: event.pointerId, element }; scrubbing.value = true;
  element.focus({ preventScroll: true }); element.setPointerCapture(event.pointerId);
  seekAt(event.clientX);
}
function moveScrub(event: PointerEvent) {
  if (scrub?.pointerId !== event.pointerId) return;
  pendingSeekX = event.clientX;
  if (!seekFrame) seekFrame = requestAnimationFrame(flushSeek);
}
function endScrub(event: PointerEvent) {
  if (scrub?.pointerId !== event.pointerId) return;
  if (event.type === 'pointerup') pendingSeekX = event.clientX;
  flushSeek();
  const previous = scrub; scrub = null; scrubbing.value = false;
  if (previous.element.hasPointerCapture(previous.pointerId)) previous.element.releasePointerCapture(previous.pointerId);
}
function seekKey(event: KeyboardEvent) {
  if (event.altKey || event.ctrlKey || event.metaKey || !['ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(event.key)) return;
  event.preventDefault(); event.stopPropagation();
  const last = Math.max(0, props.duration - 1);
  const value = event.key === 'Home' ? 0 : event.key === 'End' ? last : props.current + (event.key === 'ArrowLeft' ? -1 : 1) * (event.shiftKey ? 1000 : 1000 / 30);
  emit('seek', Math.round(clamp(value, 0, last)));
}
function start(event: PointerEvent, item: ClipTimelineItem, track: ClipTimelineTrack, side: 'in' | 'out' | null = null) {
  if (scrub || drag) return;
  emit('select', item.id); if (props.disabled || track.locked || event.button !== 0) return;
  event.preventDefault(); event.stopPropagation();
  // Vue moves keyed clip elements between neighbours during live reordering.
  // Capture on the stable viewport, not on a clip that may leave its DOM slot.
  const element = scroll.value ?? event.currentTarget as HTMLElement;
  drag = { id: item.id, x: event.clientX, startMs: item.startMs, trackId: track.id, side, duration: item.durationMs, pointerId: event.pointerId, element };
  emit('begin'); element.setPointerCapture(event.pointerId);
}
function move(event: PointerEvent) {
  if (!drag || event.pointerId !== drag.pointerId) return;
  const delta = Math.round((event.clientX - drag.x) / scale.value);
  if (drag.side) { emit('trim', drag.id, drag.side, delta); return; }
  let next = Math.max(0, drag.startMs + delta);
  if (snap.value && !event.altKey) { const left = snapTime(next, props.timeline, drag.id, props.current, 8 / scale.value), right = snapTime(next + drag.duration, props.timeline, drag.id, props.current, 8 / scale.value) - drag.duration; next = Math.abs(left - next) <= Math.abs(right - next) ? left : right; }
  const target = document.elementFromPoint(event.clientX, event.clientY)?.closest<HTMLElement>('[data-timeline-track]');
  emit('move', drag.id, next, target?.dataset.timelineTrack ?? drag.trackId, ripple.value && drag.trackId === props.timeline.tracks[0]?.id);
}
function end(event?: PointerEvent) { if (!drag || event && (event.pointerId !== drag.pointerId || event.type === 'lostpointercapture' && event.target !== drag.element)) return; const previous = drag; drag = null; if (previous.element.hasPointerCapture(previous.pointerId)) previous.element.releasePointerCapture(previous.pointerId); emit('end'); }
function trimKey(event: KeyboardEvent, item: ClipTimelineItem, side: 'in' | 'out') {
  if (props.disabled || !['ArrowLeft', 'ArrowRight'].includes(event.key)) return;
  event.stopPropagation(); event.preventDefault(); emit('begin'); emit('trim', item.id, side, (event.key === 'ArrowLeft' ? -1 : 1) * (event.shiftKey ? 1000 : 100)); emit('end');
}
function resizeStart(event: PointerEvent) { event.preventDefault(); resize = { y: event.clientY, height: props.height }; (event.currentTarget as HTMLElement).setPointerCapture(event.pointerId); }
function resizeMove(event: PointerEvent) { if (resize) emit('height', clamp(resize.height + resize.y - event.clientY, 180, Math.max(180, window.innerHeight - 280))); }
function resizeKey(event: KeyboardEvent) { if (!['ArrowUp', 'ArrowDown'].includes(event.key)) return; event.preventDefault(); emit('height', clamp(props.height + (event.key === 'ArrowUp' ? 30 : -30), 180, window.innerHeight - 280)); }
function updateViewport() {
  if (!scroll.value) return;
  containerWidth.value = scroll.value.clientWidth; scrollLeft.value = scroll.value.scrollLeft;
}
function labelStyle(item: ClipTimelineItem) {
  const left = Math.max(10, scrollLeft.value - item.startMs * scale.value + 10);
  const width = Math.min(220, item.durationMs * scale.value - left - 10);
  return { left: `${left}px`, maxWidth: `${Math.max(0, width)}px`, display: width < 18 ? 'none' : undefined };
}
function observe(element: unknown) {
  if (!(element instanceof HTMLElement) || scroll.value === element) return;
  resizeObserver?.disconnect(); scroll.value = element; updateViewport(); resizeObserver?.observe(element);
}
onMounted(() => {
  resizeObserver = new ResizeObserver(updateViewport);
  if (scroll.value) resizeObserver.observe(scroll.value);
  updateViewport();
});
onBeforeUnmount(() => {
  resizeObserver?.disconnect();
  end();
  cancelAnimationFrame(seekFrame); pendingSeekX = null;
  const previous = scrub; scrub = null;
  if (previous?.element.hasPointerCapture(previous.pointerId)) previous.element.releasePointerCapture(previous.pointerId);
});
</script>

<template>
  <div class="nle-resizer" role="separator" tabindex="0" aria-label="Resize timeline" aria-orientation="horizontal" :aria-valuenow="height" :aria-valuemin="180" :aria-valuemax="900" @pointerdown="resizeStart" @pointermove="resizeMove" @pointerup="resize = null" @pointercancel="resize = null" @keydown="resizeKey" />
  <section class="nle-timeline" :class="{ 'is-scrubbing': scrubbing }" :style="{ height: `${height}px` }" aria-label="Multitrack timeline" data-testid="clip-timeline">
    <div class="nle-timeline-toolbar">
      <div class="nle-timeline-tools">
        <button class="clip-icon-button" aria-label="Undo edit" title="Undo (⌘/Ctrl Z)" :disabled="disabled || !undoAvailable" @click="emit('undo')"><Undo2 :size="15" /></button><button class="clip-icon-button" aria-label="Redo edit" title="Redo (⌘/Ctrl Shift Z)" :disabled="disabled || !redoAvailable" @click="emit('redo')"><Redo2 :size="15" /></button><span />
        <button class="clip-icon-button" aria-label="Split selected clip" title="Split at playhead (S)" :disabled="disabled || !selectedId" @click="emit('split')"><Scissors :size="16" /></button><button class="clip-icon-button" aria-label="Duplicate selected clip" title="Duplicate clip (⌘/Ctrl D)" :disabled="disabled || !selectedId" @click="emit('duplicate')"><Copy :size="15" /></button><button class="clip-icon-button" aria-label="Delete selected clip" title="Delete clip" :disabled="disabled || !selectedId" @click="emit('remove')"><Trash2 :size="15" /></button><span />
        <button class="clip-icon-button" :class="{ active: snap }" :aria-pressed="snap" aria-label="Snap clips to edges" title="Snap to clip edges and playhead · Hold Alt to bypass" @click="snap = !snap"><Magnet :size="15" /></button><button class="clip-icon-button" :class="{ active: ripple }" :aria-pressed="ripple" aria-label="Reorder main video sequence" title="Reorder clips on main video track; turn off for free positioning" @click="ripple = !ripple"><Film :size="15" /></button>
      </div>
      <span class="nle-timeline-caption">{{ selectedId ? 'Drag to move · Pull edges to trim' : 'Select a clip to edit' }}</span>
      <div class="nle-timeline-zoom"><button class="clip-icon-button" aria-label="Zoom timeline out" :disabled="zoom <= .5" @click="zoom = Math.max(.5, zoom / 1.5)"><Minus :size="13" /></button><input v-model.number="zoom" type="range" min="0.5" max="12" step="0.25" aria-label="Timeline zoom" /><button class="clip-icon-button" aria-label="Zoom timeline in" :disabled="zoom >= 12" @click="zoom = Math.min(12, zoom * 1.5)"><Plus :size="13" /></button><span>{{ Math.round(zoom * 100) }}%</span></div>
    </div>
    <div :ref="observe" class="nle-timeline-scroll" @scroll.passive="updateViewport" @pointermove="move" @pointerup="end" @pointercancel="end" @lostpointercapture="end">
      <div ref="sheet" class="nle-timeline-sheet" :style="{ width: `${laneWidth + 137}px`, '--nle-grid': `${tickStep * scale}px` }">
        <div class="nle-ruler" tabindex="-1" data-testid="timeline-ruler" @pointerdown="startScrub" @pointermove="moveScrub" @pointerup="endScrub" @pointercancel="endScrub" @lostpointercapture="endScrub"><div v-for="tick in ticks" :key="tick" class="nle-ruler-tick" :style="{ left: `${tick * scale}px` }"><span>{{ formatClipTime(tick).slice(3) }}</span></div></div>
        <div v-for="track in displayTracks" :key="track.id" class="nle-track" :class="{ hidden: track.hidden, locked: track.locked }" :data-kind="track.kind" :data-timeline-track="track.id">
          <div class="nle-track-label"><Music2 v-if="track.kind === 'audio'" :size="12" /><Type v-else-if="track.kind === 'text'" :size="12" /><Film v-else :size="12" /><span :title="track.name">{{ track.name }}</span><button class="clip-icon-button" :class="{ active: track.muted || track.hidden }" :disabled="disabled" :aria-label="`${track.kind === 'audio' ? (track.muted ? 'Unmute' : 'Mute') : (track.hidden ? 'Show' : 'Hide')} track ${track.name}`" :aria-pressed="track.kind === 'audio' ? track.muted : track.hidden" @click="emit('track', track.id, track.kind === 'audio' ? { muted: !track.muted } : { hidden: !track.hidden })"><VolumeX v-if="track.kind === 'audio' && track.muted" :size="12" /><Volume2 v-else-if="track.kind === 'audio'" :size="12" /><EyeOff v-else-if="track.hidden" :size="12" /><Eye v-else :size="12" /></button><button class="clip-icon-button" :class="{ active: track.locked }" :disabled="disabled" :aria-label="`${track.locked ? 'Unlock' : 'Lock'} track ${track.name}`" :aria-pressed="track.locked" @click="emit('track', track.id, { locked: !track.locked })"><LockKeyhole v-if="track.locked" :size="11" /><UnlockKeyhole v-else :size="11" /></button></div>
          <div class="nle-track-lane" tabindex="-1" @pointerdown.self="startScrub" @pointermove="moveScrub" @pointerup="endScrub" @pointercancel="endScrub" @lostpointercapture="endScrub">
            <div v-for="item in orderedItems(track)" :key="item.id" class="nle-timeline-item" :class="{ selected: selectedId === item.id }" :data-kind="item.kind" :data-item-id="item.id" :style="{ left: `${item.startMs * scale}px`, width: `${Math.max(8, item.durationMs * scale)}px` }" role="button" tabindex="0" :aria-label="`Select clip ${item.name}`" :aria-pressed="selectedId === item.id" @click.stop="emit('select', item.id)" @keydown.enter.stop.prevent="emit('select', item.id)" @pointerdown="start($event, item, track)" @pointermove="move" @pointerup="end" @pointercancel="end" @lostpointercapture="end">
              <EditorTimelineMedia v-if="item.kind !== 'text'" :item="item" :pixels-per-ms="scale" :viewport-start="scrollLeft" :viewport-width="viewportWidth" :poster="thumbnail(item)" :muted="track.muted || item.muted || item.volume === 0" />
              <Type v-if="item.kind === 'text'" :size="13" /><span class="nle-timeline-item-name" :style="item.kind !== 'text' ? labelStyle(item) : undefined">{{ item.kind === 'text' ? item.text || item.name : item.name }}</span>
              <button class="nle-item-handle nle-handle-left" role="slider" :aria-label="selectedId === item.id ? 'Clip start handle' : `Trim start ${item.name}`" :aria-valuenow="item.inMs" :aria-valuemin="0" :aria-valuemax="item.inMs + item.durationMs" :disabled="disabled || track.locked" @pointerdown="start($event, item, track, 'in')" @pointermove="move" @pointerup="end" @pointercancel="end" @lostpointercapture="end" @keydown="trimKey($event, item, 'in')" /><button class="nle-item-handle nle-handle-right" role="slider" :aria-label="selectedId === item.id ? 'Clip end handle' : `Trim end ${item.name}`" :aria-valuenow="item.inMs + item.durationMs" :aria-valuemin="item.inMs" :aria-valuemax="7_200_000" :disabled="disabled || track.locked" @pointerdown="start($event, item, track, 'out')" @pointermove="move" @pointerup="end" @pointercancel="end" @lostpointercapture="end" @keydown="trimKey($event, item, 'out')" />
            </div>
            <button v-for="item in cutItems(track)" :key="`transition-${item.id}`" class="nle-cut-button" :class="{ active: !!item.transitionIn }" :style="{ left: `${(item.startMs + (item.transitionIn?.durationMs ?? 0) / 2) * scale}px`, width: `${Math.max(22, (item.transitionIn?.durationMs ?? 0) * scale)}px` }" :disabled="disabled || track.locked" :aria-label="`${item.transitionIn ? 'Edit' : 'Add'} transition before ${item.name}`" :title="item.transitionIn ? `${item.transitionIn.kind} · ${(item.transitionIn.durationMs / 1000).toFixed(2)}s` : 'Add transition'" :data-transition-for="item.id" @pointerdown.stop @click.stop="emit('transition', item.id)"><ArrowRightLeft :size="12" /></button>
          </div>
        </div>
        <div class="nle-track-add"><button class="clip-button clip-button-quiet" :disabled="disabled || timeline.tracks.length >= 12" @click="emit('addTrack')"><Plus :size="11" />Add video track</button></div>
        <div class="nle-playhead" :style="{ left: `${137 + current * scale}px` }"><button class="nle-playhead-handle" data-timeline-playhead type="button" role="slider" aria-label="Timeline playhead" aria-orientation="horizontal" aria-valuemin="0" :aria-valuemax="Math.max(0, duration - 1)" :aria-valuenow="Math.round(current)" :aria-valuetext="formatClipTime(current, true)" title="Drag to seek · Arrow keys to step" @pointerdown="startScrub" @pointermove="moveScrub" @pointerup="endScrub" @pointercancel="endScrub" @lostpointercapture="endScrub" @keydown="seekKey" /></div>
      </div>
    </div>
  </section>
</template>
