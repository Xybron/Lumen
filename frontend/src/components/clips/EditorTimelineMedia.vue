<script setup lang="ts">
import { computed, onBeforeUnmount, reactive, ref, watch } from 'vue';
import type { ClipTimelineItem } from '../../../../shared/clips';
import { useIdentityStore } from '@/stores/identity';
import { clipsApi } from '@/lib/clips';
import { acquireTimelinePreview, frameTiles, onTimelinePreviewRefresh, setTimelinePreviewSession, timelinePreviewKey, visibleMediaWindow, waveformTiles, type TimelinePreviewKind, type TimelinePreviewResult, type TimelinePreviewState } from '@/lib/timeline-previews';
import '@/styles/timeline-previews.css';

const props = defineProps<{ item: ClipTimelineItem; pixelsPerMs: number; viewportStart: number; viewportWidth: number; poster?: string; muted?: boolean }>();
const identity = useIdentityStore();
const host = ref<HTMLElement | null>(null), verticallyVisible = ref(false), stillReady = ref(false), stillFailed = ref(false);
const visibleWindow = computed(() => visibleMediaWindow(props.item, props.pixelsPerMs, props.viewportStart, props.viewportWidth));
const frames = computed(() => identity.isAuthenticated && visibleWindow.value && verticallyVisible.value && (props.item.kind === 'video' || props.item.kind === 'image') ? frameTiles(props.item, props.pixelsPerMs, visibleWindow.value) : []);
const waves = computed(() => identity.isAuthenticated && visibleWindow.value && verticallyVisible.value && (props.item.kind === 'video' || props.item.kind === 'audio') ? waveformTiles(props.item, props.pixelsPerMs, visibleWindow.value) : { tiles: [], limited: false });
interface Resource extends TimelinePreviewResult { controller: AbortController; release?: () => void }
const resources = reactive(new Map<string, Resource>());
const still = computed(() => props.item.kind === 'image' ? props.poster || (props.item.source?.kind === 'asset' ? clipsApi.asset(props.item.source.id) : '') : '');
let updateFrame = 0, disposed = false, observer: IntersectionObserver | null = null;
function key(kind: TimelinePreviewKind, atMs: number) { return props.item.source ? timelinePreviewKey(props.item.source, kind, atMs) : ''; }
function resource(kind: TimelinePreviewKind, atMs: number) { return resources.get(key(kind, atMs)); }
function state(kind: TimelinePreviewKind, atMs: number): TimelinePreviewState { return resource(kind, atMs)?.state ?? 'loading'; }
function imageError(kind: TimelinePreviewKind, atMs: number) { const item = resource(kind, atMs); if (item) { item.state = 'unavailable'; item.reason = 'decode'; item.url = undefined; } }
function disposeResource(id: string) { const item = resources.get(id); if (!item) return; item.controller.abort(); item.release?.(); resources.delete(id); }
function disposeAll() { for (const id of [...resources.keys()]) disposeResource(id); }
function synchronize() {
  updateFrame = 0;
  const desired = new Map<string, { kind: TimelinePreviewKind; atMs: number }>();
  if (identity.isAuthenticated && props.item.source && visibleWindow.value && verticallyVisible.value && props.item.kind !== 'text') {
    if (props.item.kind === 'video') for (const tile of frames.value) desired.set(key('frame', tile.atMs), { kind: 'frame', atMs: tile.atMs });
    for (const tile of waves.value.tiles) desired.set(key('waveform', tile.atMs), { kind: 'waveform', atMs: tile.atMs });
  }
  for (const id of [...resources.keys()]) if (!desired.has(id)) disposeResource(id);
  for (const [id, request] of desired) {
    if (resources.has(id) || !props.item.source) continue;
    const controller = new AbortController(), item: Resource = { state: 'loading', controller };
    resources.set(id, item);
    const update = (value: TimelinePreviewResult) => { const current = resources.get(id); if (current?.controller === controller && !controller.signal.aborted) Object.assign(current, value); };
    void acquireTimelinePreview(props.item.source, request.kind, request.atMs, controller.signal, update).then(lease => {
      const current = resources.get(id);
      if (!current || current.controller !== controller || controller.signal.aborted) { lease.release(); return; }
      current.release = lease.release; Object.assign(current, { state: lease.state, url: lease.url, reason: lease.reason });
    }).catch(error => { if (controller.signal.aborted || disposed) return; update({ state: 'unavailable', reason: (error as Error).name === 'AbortError' ? 'cancelled' : 'connection' }); });
  }
}
function schedule() { if (!updateFrame && !disposed) updateFrame = requestAnimationFrame(synchronize); }
const statuses = computed(() => [...resources.values()]);
const noAudio = computed(() => waves.value.tiles.length > 0 && waves.value.tiles.every(tile => resource('waveform', tile.atMs)?.reason === 'no-audio'));
const summary = computed(() => {
  if (!visibleWindow.value || props.item.kind === 'text') return '';
  if (props.item.kind === 'image') return stillFailed.value ? 'Image preview unavailable' : stillReady.value ? '' : 'Loading image';
  if (statuses.value.some(value => value.state === 'waiting-live')) return 'Previews wait until production is idle';
  if (waves.value.limited) return 'Zoom in for more waveform detail';
  if (statuses.value.some(value => value.reason === 'memory-limit')) return 'Zoom in to load more preview detail';
  const pending = statuses.value.some(value => ['loading', 'queued', 'processing'].includes(value.state));
  if (pending) return props.item.kind === 'audio' ? 'Preparing waveform' : 'Preparing previews';
  if (statuses.value.some(value => value.state === 'unavailable' && value.reason !== 'no-audio')) return 'Some previews unavailable';
  if (props.item.kind === 'audio' && noAudio.value) return 'No audio waveform available';
  return '';
});
const aria = computed(() => props.item.kind === 'image' ? `Image strip for ${props.item.name}` : `${props.item.kind === 'audio' ? 'Audio waveform' : 'Video frames and audio waveform'} for ${props.item.name}${noAudio.value ? '. This source has no audio.' : ''}${props.muted ? '. Audio muted.' : ''}${summary.value ? `. ${summary.value}.` : ''}`);
watch(() => [props.item.source?.kind, props.item.source?.id, props.item.kind, props.item.startMs, props.item.inMs, props.item.durationMs, props.pixelsPerMs, props.viewportStart, props.viewportWidth, verticallyVisible.value], schedule, { immediate: true, flush: 'post' });
watch(still, () => { stillReady.value = false; stillFailed.value = false; });
watch(host, element => {
  observer?.disconnect(); observer = null; verticallyVisible.value = false;
  if (!element || disposed) return;
  if (typeof IntersectionObserver === 'undefined') { verticallyVisible.value = true; return; }
  observer = new IntersectionObserver(entries => { verticallyVisible.value = entries.some(entry => entry.isIntersecting); }, { root: element.closest('.nle-timeline-scroll'), rootMargin: '64px 0px 64px 0px' });
  observer.observe(element);
}, { flush: 'post' });
watch(() => identity.isAuthenticated ? identity.me?.id ?? null : null, id => { disposeAll(); setTimelinePreviewSession(id); schedule(); }, { immediate: true });
const stopRefresh = onTimelinePreviewRefresh(() => { disposeAll(); schedule(); });
onBeforeUnmount(() => { disposed = true; observer?.disconnect(); cancelAnimationFrame(updateFrame); stopRefresh(); disposeAll(); });
</script>

<template>
  <div v-if="visibleWindow && item.kind !== 'text'" ref="host" class="nle-timeline-media" :class="{ 'is-audio': item.kind === 'audio', 'has-no-audio': noAudio, 'is-muted': muted }" :style="{ left: `${visibleWindow.leftPx}px`, width: `${visibleWindow.widthPx}px` }" role="img" :aria-label="aria" data-timeline-media :data-kind="item.kind" :data-source-kind="item.source?.kind" :data-source-id="item.source?.id" :data-local-start-ms="visibleWindow.localStartMs" :data-local-end-ms="visibleWindow.localEndMs" :data-window-left="visibleWindow.leftPx" :data-window-width="visibleWindow.widthPx" :data-vertically-visible="verticallyVisible">
    <div v-if="item.kind === 'video' || item.kind === 'image'" class="nle-real-filmstrip" aria-hidden="true">
      <div v-for="(tile, index) in frames" :key="`${tile.leftPx}:${tile.atMs}`" class="nle-real-frame" :class="{ 'is-pending': item.kind === 'video' && state('frame', tile.atMs) !== 'ready' }" :style="{ left: `${tile.leftPx - visibleWindow.leftPx}px`, width: `${tile.widthPx}px` }" data-preview-kind="frame" :data-at-ms="item.kind === 'image' ? 0 : tile.atMs" :data-source-id="item.source?.id" :data-source-kind="item.source?.kind" :data-state="item.kind === 'image' ? stillFailed ? 'unavailable' : stillReady ? 'ready' : 'loading' : state('frame', tile.atMs)" :data-tile-index="index">
        <img v-if="item.kind === 'image' && still && !stillFailed" :src="still" alt="" draggable="false" loading="lazy" @load="stillReady = true" @error="stillFailed = true" />
        <img v-else-if="resource('frame', tile.atMs)?.url" :src="resource('frame', tile.atMs)?.url" alt="" draggable="false" @error="imageError('frame', tile.atMs)" />
      </div>
    </div>
    <div v-if="(item.kind === 'video' || item.kind === 'audio') && !noAudio" class="nle-real-waveform" aria-hidden="true">
      <div v-for="tile in waves.tiles" :key="tile.atMs" class="nle-real-wave-chunk" :style="{ left: `${tile.leftPx - visibleWindow.leftPx}px`, width: `${tile.widthPx}px` }" data-preview-kind="waveform" :data-at-ms="tile.atMs" :data-source-id="item.source?.id" :data-source-kind="item.source?.kind" :data-state="state('waveform', tile.atMs)">
        <img v-if="resource('waveform', tile.atMs)?.url" :src="resource('waveform', tile.atMs)?.url" alt="" draggable="false" @error="imageError('waveform', tile.atMs)" />
      </div>
    </div>
    <span v-if="summary && verticallyVisible" class="nle-media-preview-state" :class="{ 'is-waiting': statuses.some(value => value.state === 'waiting-live') }" data-preview-state>{{ summary }}</span>
  </div>
</template>
