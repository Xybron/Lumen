<script setup lang="ts">
import { computed, nextTick, onBeforeUnmount, reactive, ref, watch } from 'vue';
import { useResizeObserver } from '@vueuse/core';
import { Film, PanelRightClose, PanelRightOpen, Pause, Play, SkipBack, SkipForward, Volume2, VolumeX } from 'lucide-vue-next';
import type { ClipFormat, ClipTimeline, ClipTimelineItem } from '../../../../shared/clips';
import { clamp, formatClipTime } from '@/lib/clip-timeline';
import { audioFadeGain, orderedTransitionItems, transitionVisual } from '@/lib/clip-transitions';

const props = defineProps<{ timeline: ClipTimeline; format: ClipFormat; current: number; duration: number; playing: boolean; muted: boolean; selectedId: string | null; disabled: boolean; inspectorOpen: boolean; sourceUrl: (item: ClipTimelineItem) => string }>();
const emit = defineEmits<{ play: []; pause: []; seek: [ms: number]; mute: []; select: [id: string | null]; begin: []; end: []; patch: [id: string, patch: Partial<ClipTimelineItem>]; inspector: []; error: [message: string] }>();
const stage = ref<HTMLElement | null>(null), frame = ref<HTMLElement | null>(null), size = reactive({ width: 640, height: 360 });
const media = new Map<string, HTMLMediaElement>();
const mediaCallbacks = new Map<string, (element: unknown) => void>();
useResizeObserver(stage, entries => { const rect = entries[0]?.contentRect; if (rect) { size.width = Math.max(0, rect.width); size.height = Math.max(0, rect.height); } });
const frameSize = computed(() => { const [w, h] = props.format.split(':').map(Number), aspect = w! / h!, width = Math.min(size.width, size.height * aspect); return { width: `${width}px`, height: `${width / aspect}px` }; });
const active = computed(() => props.timeline.tracks.flatMap(track => orderedTransitionItems(track).filter(item => props.current >= item.startMs && props.current < item.startMs + item.durationMs).map(item => ({ item, track }))));
// Warm the next source before its cut. It stays paused, hidden and silent.
const rendered = computed(() => {
  const rows = props.timeline.tracks.map(track => ({ track, items: orderedTransitionItems(track) }));
  const next = rows.flatMap(({ track, items }) => { const item = items.find(value => value.kind !== 'text' && value.startMs > props.current && value.startMs <= props.current + 2000); return item ? [{ item, track }] : []; }).sort((a, b) => a.item.startMs - b.item.startMs).slice(0, 4);
  const warm = new Set(next.map(value => value.item.id));
  return rows.flatMap(({ track, items }) => items.filter(item => warm.has(item.id) || props.current >= item.startMs && props.current < item.startMs + item.durationMs).map(item => ({ item, track })));
});
const frameHeight = computed(() => Number.parseFloat(frameSize.value.height));
let drag: { id: string; pointerX: number; pointerY: number; item: ClipTimelineItem; width: number; height: number; resize: boolean; overflowX: number; overflowY: number; crop: boolean; element: HTMLElement } | null = null;

function style(item: ClipTimelineItem) { const effect = transitionVisual(item, props.current); return { left: `${item.x * 100}%`, top: `${item.y * 100}%`, width: `${item.width * 100}%`, height: `${item.height * 100}%`, opacity: item.opacity * effect.opacityMultiplier, transform: effect.translateXFraction ? `translateX(${effect.translateXFraction * 100}%)` : undefined, clipPath: effect.clipInsetLeft || effect.clipInsetRight ? `inset(0 ${effect.clipInsetRight * 100}% 0 ${effect.clipInsetLeft * 100}%)` : undefined }; }
function textStyle(item: ClipTimelineItem) { return { color: item.color, background: item.background, fontFamily: 'Arial, sans-serif', fontSize: `${item.fontSize * frameHeight.value / 1080}px`, fontWeight: item.fontWeight, textAlign: item.align, justifyContent: item.align === 'left' ? 'flex-start' : item.align === 'right' ? 'flex-end' : 'center' }; }
function setMedia(id: string, element: unknown) { if (element instanceof HTMLMediaElement) { media.set(id, element); void nextTick(() => sync()); } else { media.get(id)?.pause(); media.delete(id); } }
function mediaRef(id: string) { let callback = mediaCallbacks.get(id); if (!callback) { callback = element => setMedia(id, element); mediaCallbacks.set(id, callback); } return callback; }
function sync() {
  for (const { item, track } of rendered.value) {
    const element = media.get(item.id); if (!element) continue;
    const showing = props.current >= item.startMs;
    element.muted = props.muted || track.muted || item.muted; element.volume = clamp(item.volume * audioFadeGain(item, props.current), 0, 1);
    const time = (item.inMs + Math.max(0, props.current - item.startMs)) / 1000;
    if (element.readyState > 0 && (!props.playing || Math.abs(element.currentTime - time) > .14)) {
      try { element.currentTime = time; } catch { /* Metadata is still loading. */ }
    }
    if (props.playing && showing && element.paused) void element.play().catch(() => {}); else if ((!props.playing || !showing) && !element.paused) element.pause();
  }
}
watch(() => [props.current, props.playing, props.muted, props.timeline], () => { void nextTick(sync); }, { deep: true });
watch(() => props.timeline.tracks.flatMap(track => track.items.map(item => item.id)), ids => { const available = new Set(ids); for (const id of mediaCallbacks.keys()) if (!available.has(id)) mediaCallbacks.delete(id); });
function begin(event: PointerEvent, item: ClipTimelineItem, resize = false) {
  event.stopPropagation(); emit('select', item.id);
  const track = props.timeline.tracks.find(value => value.items.some(i => i.id === item.id));
  if (props.disabled || track?.locked || !frame.value || event.button !== 0) return;
  event.preventDefault(); const rect = frame.value.getBoundingClientRect();
  const video = media.get(item.id), image = (event.currentTarget as HTMLElement).querySelector('img'), sourceWidth = video instanceof HTMLVideoElement ? video.videoWidth : image?.naturalWidth ?? 0, sourceHeight = video instanceof HTMLVideoElement ? video.videoHeight : image?.naturalHeight ?? 0;
  const scale = sourceWidth && sourceHeight ? Math.max(rect.width / sourceWidth, rect.height / sourceHeight) : 1;
  const overflowX = Math.max(0, sourceWidth * scale - rect.width), overflowY = Math.max(0, sourceHeight * scale - rect.height);
  const crop = !resize && item.fit === 'cover' && item.kind !== 'text' && item.width === 1 && item.height === 1 && (overflowX > 1 || overflowY > 1);
  drag = { id: item.id, pointerX: event.clientX, pointerY: event.clientY, item: { ...item }, width: rect.width, height: rect.height, resize, overflowX, overflowY, crop, element: event.currentTarget as HTMLElement };
  emit('begin'); drag.element.setPointerCapture(event.pointerId);
}
function move(event: PointerEvent) {
  if (!drag) return;
  const dx = (event.clientX - drag.pointerX) / drag.width, dy = (event.clientY - drag.pointerY) / drag.height;
  if (drag.crop) emit('patch', drag.id, { positionX: drag.overflowX > 1 ? Math.round(clamp(drag.item.positionX - (event.clientX - drag.pointerX) / drag.overflowX, 0, 1) * 1000) / 1000 : drag.item.positionX, positionY: drag.overflowY > 1 ? Math.round(clamp(drag.item.positionY - (event.clientY - drag.pointerY) / drag.overflowY, 0, 1) * 1000) / 1000 : drag.item.positionY });
  else if (drag.resize) emit('patch', drag.id, { width: Math.round(clamp(drag.item.width + dx, .02, 1 - drag.item.x) * 1000) / 1000, height: Math.round(clamp(drag.item.height + dy, .02, 1 - drag.item.y) * 1000) / 1000 });
  else emit('patch', drag.id, { x: Math.round(clamp(drag.item.x + dx, 0, 1 - drag.item.width) * 1000) / 1000, y: Math.round(clamp(drag.item.y + dy, 0, 1 - drag.item.height) * 1000) / 1000 });
}
function end() { if (drag) { drag = null; emit('end'); } }
onBeforeUnmount(() => { for (const element of media.values()) element.pause(); media.clear(); });
</script>

<template>
  <section class="nle-preview-area" aria-label="Video preview">
    <div class="nle-preview-toolbar"><span><i class="clips-preview-indicator" />Player <span class="clips-subtle">{{ format }} · {{ timeline.tracks.filter(track => !track.hidden).length }} tracks</span></span><div><span class="clips-subtle">Fit</span><button class="clip-icon-button" :aria-label="inspectorOpen ? 'Collapse clip inspector' : 'Open clip inspector'" :title="inspectorOpen ? 'Hide inspector' : 'Show inspector'" @click="emit('inspector')"><PanelRightClose v-if="inspectorOpen" :size="15" /><PanelRightOpen v-else :size="15" /></button></div></div>
    <div ref="stage" class="nle-preview-stage">
      <div ref="frame" class="nle-preview-frame" :style="{ ...frameSize, background: timeline.background }" data-testid="clip-preview" @pointerdown.self="emit('select', null)">
        <template v-for="{ item, track } in rendered" :key="item.id">
          <audio v-if="item.kind === 'audio'" :ref="mediaRef(item.id)" :src="sourceUrl(item)" :muted="muted || item.muted || track.muted" preload="auto" @loadedmetadata="sync" @error="emit('error', `Could not play ${item.name}. The original media is unchanged.`)" />
          <div v-else class="nle-visual-item" :class="{ 'nle-text-item': item.kind === 'text' }" :style="{ ...style(item), ...(item.kind === 'text' ? textStyle(item) : {}), visibility: track.hidden || current < item.startMs ? 'hidden' : 'visible', cursor: disabled || track.locked ? 'default' : 'move' }" :data-preview-item="item.id" @pointerdown="begin($event, item)" @pointermove="move" @pointerup="end" @pointercancel="end" @lostpointercapture="end">
            <video v-if="item.kind === 'video'" :ref="mediaRef(item.id)" :src="sourceUrl(item)" :muted="muted || item.muted || track.muted" playsinline preload="auto" :style="{ objectFit: item.fit, objectPosition: item.fit === 'contain' ? '50% 50%' : `${item.positionX * 100}% ${item.positionY * 100}%` }" @loadedmetadata="sync" @error="emit('error', `Could not play ${item.name}. Try a Chromium browser or download the original.`)" />
            <img v-else-if="item.kind === 'image'" :src="sourceUrl(item)" alt="" draggable="false" :style="{ objectFit: item.fit, objectPosition: item.fit === 'contain' ? '50% 50%' : `${item.positionX * 100}% ${item.positionY * 100}%` }" />
            <span v-else style="width: 100%; overflow-wrap: break-word">{{ item.text }}</span>
            <div v-if="selectedId === item.id && !disabled && !track.locked" class="nle-selection"><button aria-label="Resize selected element" @pointerdown="begin($event, item, true)" @pointermove="move" @pointerup="end" @pointercancel="end" @lostpointercapture="end" /></div>
          </div>
        </template>
        <span v-if="!active.length" class="nle-blank-frame" aria-label="No clip at playhead"><Film :size="22" /></span>
      </div>
    </div>
    <div class="nle-player"><div class="nle-player-time">{{ formatClipTime(current, true) }}<span>/ {{ formatClipTime(duration) }}</span></div><div class="nle-player-transport"><button class="clip-icon-button" aria-label="Go to clip start" @click="emit('pause'); emit('seek', 0)"><SkipBack :size="15" /></button><button class="clips-play-button" :aria-label="playing ? 'Pause preview' : 'Play preview'" @click="emit('play')"><Pause v-if="playing" :size="15" fill="currentColor" /><Play v-else :size="15" fill="currentColor" /></button><button class="clip-icon-button" aria-label="Go to clip end" @click="emit('pause'); emit('seek', Math.max(0, duration - 1))"><SkipForward :size="15" /></button></div><button class="clip-button clip-button-quiet clips-preview-audio" :aria-label="muted ? 'Unmute preview audio' : 'Mute preview audio'" :aria-pressed="!muted" @click="emit('mute')"><VolumeX v-if="muted" :size="14" /><Volume2 v-else :size="14" /><span>{{ muted ? 'Preview muted' : 'Preview audio' }}</span></button></div>
  </section>
</template>
