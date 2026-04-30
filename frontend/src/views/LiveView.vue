<script setup lang="ts">
import { computed, onMounted, onBeforeUnmount, ref, watch } from 'vue';
import { useFullscreen, useIdle, useWakeLock, useEventListener } from '@vueuse/core';
import { Music2 } from 'lucide-vue-next';
import BackgroundLayer from '@/components/live/BackgroundLayer.vue';
import ContentLayer from '@/components/live/ContentLayer.vue';
import ProgressBar from '@/components/live/ProgressBar.vue';
import WarningPill from '@/components/live/WarningPill.vue';
import CountdownChip from '@/components/live/CountdownChip.vue';
import { useContentStore } from '@/stores/content';
import { useBroadcast } from '@/lib/broadcast';
import { useConnection } from '@/lib/ws';
import { useShortcuts } from '@/lib/keyboard';
import { computePrayerLabels } from '@/lib/prayers';
import type { BroadcastMsg, Item, ProjectionState } from '@/types';

const contentStore = useContentStore();

// Mirrored state from the dashboard. Live View never originates anything.
const state = ref<ProjectionState>({
  playlistId: null,
  index: 0,
  mode: 'auto',
  playing: false,
  blanked: false,
  startedAt: null,
  durationMs: 0,
});
const remainingMs = ref(0);
const elapsedMs = ref(0);

// Drives the on-screen badge. The WS connection is authoritative; we don't
// fall back to tick-gap detection because cross-device sync may be quiet for
// long stretches (e.g. between slide changes in manual mode).
const connection = useConnection();
const reconnecting = computed(() => connection.value !== 'online');

// rAF-driven progress. Each tick from the dashboard is a sync point — between
// ticks we extrapolate from the local clock so the firey bar moves at 60fps
// instead of stepping at 8Hz.
const syncedElapsedMs = ref(0);
const syncedAt = ref(performance.now());
const smoothElapsedMs = ref(0);

function recordSync(elapsed: number) {
  syncedElapsedMs.value = elapsed;
  syncedAt.value = performance.now();
  smoothElapsedMs.value = elapsed;
}

let rafHandle: number | null = null;
function runRaf() {
  if (state.value.playing && state.value.durationMs > 0) {
    const local = syncedElapsedMs.value + (performance.now() - syncedAt.value);
    smoothElapsedMs.value = Math.max(0, Math.min(state.value.durationMs, local));
  }
  rafHandle = requestAnimationFrame(runRaf);
}

onMounted(() => {
  rafHandle = requestAnimationFrame(runRaf);
});

onBeforeUnmount(() => {
  if (rafHandle != null) cancelAnimationFrame(rafHandle);
});

// Snap the smooth value when playback halts so the bar matches the authoritative
// frozen elapsed instead of drifting from the last extrapolation.
watch(
  () => state.value.playing,
  (playing) => {
    if (!playing) smoothElapsedMs.value = elapsedMs.value;
  },
);

const currentItem = computed<Item | undefined>(() => {
  const pl = contentStore.playlists.find((p) => p.id === state.value.playlistId);
  return pl?.items[state.value.index];
});

const currentPlaylistItems = computed<Item[]>(() => {
  const pl = contentStore.playlists.find((p) => p.id === state.value.playlistId);
  return pl?.items ?? [];
});

const livePrayerLabels = computed(() => computePrayerLabels(currentPlaylistItems.value));
const currentPrayerLabel = computed(() =>
  currentItem.value ? livePrayerLabels.value[currentItem.value.id]?.display : undefined,
);

const settings = computed(() => contentStore.content.settings);
const progress = computed(() =>
  state.value.durationMs > 0
    ? Math.min(1, smoothElapsedMs.value / state.value.durationMs)
    : 0,
);

const showWarning = computed(
  () =>
    !state.value.blanked &&
    state.value.playing &&
    remainingMs.value > 0 &&
    remainingMs.value <= settings.value.warningAtMs &&
    remainingMs.value > settings.value.countdownAtMs,
);
const showCountdown = computed(
  () =>
    !state.value.blanked &&
    state.value.playing &&
    remainingMs.value > 0 &&
    remainingMs.value <= settings.value.countdownAtMs,
);

const root = ref<HTMLElement | null>(null);
const { enter: enterFullscreen, exit: exitFullscreen, isFullscreen } = useFullscreen(root);
const { idle } = useIdle(2000);
useWakeLock().request('screen').catch(() => {});

const musicPlaying = ref(false);

const { send } = useBroadcast((msg: BroadcastMsg) => {
  if (msg.t === 'state') {
    state.value = msg.payload;
    if (!msg.payload.playing) {
      remainingMs.value = msg.payload.durationMs;
      elapsedMs.value = 0;
      recordSync(0);
    } else {
      // A fresh state burst implies a slide change / restart — resync to 0
      // until the next tick supplies the real elapsed.
      recordSync(elapsedMs.value);
    }
  } else if (msg.t === 'tick') {
    remainingMs.value = msg.remainingMs;
    elapsedMs.value = msg.elapsedMs;
    recordSync(msg.elapsedMs);
  } else if (msg.t === 'content-updated') {
    void contentStore.load();
  } else if (msg.t === 'music') {
    musicPlaying.value = msg.playing;
  }
});

onMounted(async () => {
  await contentStore.load();
  send({ t: 'hello' });
});

useShortcuts({
  F: () => (isFullscreen.value ? exitFullscreen() : enterFullscreen()),
  Escape: () => exitFullscreen(),
});

// Allow the operator to click into the Live tab and immediately request fullscreen.
useEventListener(document, 'dblclick', () => {
  if (!isFullscreen.value) enterFullscreen();
});
</script>

<template>
  <div
    ref="root"
    class="relative h-screen w-screen bg-black overflow-hidden"
    :class="{ 'cursor-hidden': idle }"
  >
    <Transition
      enter-active-class="transition duration-[600ms] ease-out-quart"
      enter-from-class="opacity-0 scale-[1.02]"
      enter-to-class="opacity-100 scale-100"
      leave-active-class="transition duration-[600ms] ease-out-quart"
      leave-from-class="opacity-100 scale-100"
      leave-to-class="opacity-0 scale-[0.99]"
      mode="out-in"
    >
      <div :key="currentItem?.id ?? 'empty'" class="absolute inset-0">
        <BackgroundLayer :background="currentItem?.background" />
        <ContentLayer :item="currentItem" :prayer-label="currentPrayerLabel" />
      </div>
    </Transition>

    <ProgressBar :progress="progress" :manual="state.mode === 'manual'" />

    <WarningPill :visible="showWarning" :remaining-ms="remainingMs" />
    <CountdownChip
      :visible="showCountdown"
      :remaining-ms="remainingMs"
      :threshold-ms="settings.countdownAtMs"
    />

    <Transition
      enter-active-class="transition duration-200 ease-out-cubic"
      enter-from-class="opacity-0"
      enter-to-class="opacity-100"
      leave-active-class="transition duration-200 ease-out-cubic"
      leave-from-class="opacity-100"
      leave-to-class="opacity-0"
    >
      <div v-if="state.blanked" class="absolute inset-0 bg-black z-40" />
    </Transition>

    <Transition
      enter-active-class="transition duration-200 ease-out-cubic"
      enter-from-class="opacity-0 translate-y-1"
      enter-to-class="opacity-100 translate-y-0"
      leave-active-class="transition duration-150 ease-out-cubic"
      leave-from-class="opacity-100"
      leave-to-class="opacity-0"
    >
      <div
        v-if="reconnecting"
        class="absolute bottom-6 left-6 z-30 panel px-3 py-1.5 flex items-center gap-2 text-xs text-white/70"
      >
        <span
          class="h-1.5 w-1.5 rounded-full animate-pulse"
          :class="connection === 'offline' ? 'bg-red-400' : 'bg-amber-400'"
        />
        {{ connection === 'offline' ? 'offline' : 'reconnecting…' }}
      </div>
    </Transition>

    <Transition
      enter-active-class="transition duration-200 ease-out-cubic"
      enter-from-class="opacity-0 translate-y-1"
      enter-to-class="opacity-100 translate-y-0"
      leave-active-class="transition duration-150 ease-out-cubic"
      leave-from-class="opacity-100"
      leave-to-class="opacity-0"
    >
      <div
        v-if="musicPlaying && !state.blanked"
        class="absolute bottom-6 right-6 z-30 panel px-2.5 py-1.5 flex items-center gap-1.5 text-xs text-white/70"
      >
        <Music2 :size="12" class="text-accent" />
        <span class="h-1 w-1 rounded-full bg-accent animate-pulse" />
      </div>
    </Transition>

    <div
      v-if="!currentItem"
      class="absolute inset-0 flex items-center justify-center text-white/40 text-2xl tracking-display"
    >
      Lumen — waiting for the operator
    </div>
  </div>
</template>
