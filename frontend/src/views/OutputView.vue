<script setup lang="ts">
import { computed, onBeforeUnmount, ref, watch } from 'vue';
import { useRoute } from 'vue-router';
import { useFullscreen, useIdle, useWakeLock, useEventListener } from '@vueuse/core';
import { Music2 } from 'lucide-vue-next';
import BackgroundLayer from '@/components/live/BackgroundLayer.vue';
import ContentLayer from '@/components/live/ContentLayer.vue';
import ProgressBar from '@/components/live/ProgressBar.vue';
import WarningPill from '@/components/live/WarningPill.vue';
import CountdownChip from '@/components/live/CountdownChip.vue';
import { useContentStore } from '@/stores/content';
import { useChannelMirror } from '@/lib/useChannelMirror';
import { useBroadcast } from '@/lib/broadcast';
import { useShortcuts } from '@/lib/keyboard';
import { sourceForDestination } from '@/lib/routing';
import { createViewer, type Viewer } from '@/lib/webrtc';
import type { BroadcastMsg } from '@/types';

// A destination output: renders whatever SOURCE is routed to it — its pinned
// direct route, else the Program bus. Cuts live when Program changes.
const route = useRoute();
const content = useContentStore();
const destinationId = computed(() => (route.params.destinationId as string) || '');

// Track Program bus changes via the low-latency `program` frame (falls back to
// the persisted content.program until the first frame arrives).
const programSourceId = ref<string | null>(null);
useBroadcast((msg: BroadcastMsg) => {
  if (msg.t === 'program') programSourceId.value = msg.programSourceId;
});

const effectiveSource = computed(() =>
  sourceForDestination(content.content, destinationId.value, programSourceId.value ?? undefined),
);
const channelId = computed(() => (effectiveSource.value?.kind === 'channel' ? effectiveSource.value.ref : ''));
const webrtcPublisherId = computed(() =>
  effectiveSource.value?.kind === 'webrtc' ? effectiveSource.value.ref : null,
);
// Capture sources (SDI/HDMI/NDI) are fed to the media engine out-of-band — the
// browser output can't render them directly.
const captureSource = computed(() => (effectiveSource.value?.kind === 'capture' ? effectiveSource.value : null));

const mirror = useChannelMirror(channelId);

// WebRTC viewer for camera/screen sources on Program.
const videoEl = ref<HTMLVideoElement | null>(null);
let viewer: Viewer | null = null;
let stopStreamWatch: (() => void) | null = null;
function teardownViewer() {
  stopStreamWatch?.();
  stopStreamWatch = null;
  viewer?.stop();
  viewer = null;
  if (videoEl.value) videoEl.value.srcObject = null;
}
watch(
  webrtcPublisherId,
  (pid) => {
    teardownViewer();
    if (pid) {
      viewer = createViewer(pid);
      stopStreamWatch = watch(
        viewer.stream,
        (s) => {
          if (videoEl.value) videoEl.value.srcObject = s;
        },
        { immediate: true },
      );
    }
  },
  { immediate: true },
);
onBeforeUnmount(teardownViewer);

const root = ref<HTMLElement | null>(null);
const { enter: enterFullscreen, exit: exitFullscreen, isFullscreen } = useFullscreen(root);
const { idle } = useIdle(2000);
useWakeLock().request('screen').catch(() => {});

useShortcuts({
  F: () => (isFullscreen.value ? exitFullscreen() : enterFullscreen()),
  Escape: () => exitFullscreen(),
});
useEventListener(document, 'dblclick', () => {
  if (!isFullscreen.value) enterFullscreen();
});
</script>

<template>
  <div ref="root" class="relative h-screen w-screen bg-black overflow-hidden" :class="{ 'cursor-hidden': idle }">
    <!-- WebRTC camera/screen source -->
    <video
      v-show="webrtcPublisherId"
      ref="videoEl"
      class="absolute inset-0 h-full w-full object-contain bg-black"
      autoplay
      playsinline
    />

    <!-- Capture source — handled by the media engine, not viewable in-browser -->
    <div
      v-if="captureSource"
      class="absolute inset-0 flex flex-col items-center justify-center gap-2 text-white/40"
    >
      <div class="text-xl tracking-display">{{ captureSource.label ?? 'Capture source' }}</div>
      <div class="text-sm text-white/30">Rendered by the media engine</div>
    </div>

    <!-- Channel (slide) source -->
    <template v-else-if="!webrtcPublisherId">
      <Transition
        enter-active-class="transition duration-[600ms] ease-out-quart"
        enter-from-class="opacity-0 scale-[1.02]"
        enter-to-class="opacity-100 scale-100"
        leave-active-class="transition duration-[600ms] ease-out-quart"
        leave-from-class="opacity-100 scale-100"
        leave-to-class="opacity-0 scale-[0.99]"
        mode="out-in"
      >
        <div :key="mirror.currentItem.value?.id ?? 'empty'" class="absolute inset-0">
          <BackgroundLayer :background="mirror.currentItem.value?.background" />
          <ContentLayer :item="mirror.currentItem.value" :prayer-label="mirror.currentPrayerLabel.value" />
        </div>
      </Transition>

      <ProgressBar :progress="mirror.progress.value" :manual="mirror.state.value.mode === 'manual'" />
      <WarningPill :visible="mirror.showWarning.value" :remaining-ms="mirror.remainingMs.value" />
      <CountdownChip
        :visible="mirror.showCountdown.value"
        :remaining-ms="mirror.remainingMs.value"
        :threshold-ms="mirror.settings.value.countdownAtMs"
      />

      <div v-if="mirror.state.value.blanked" class="absolute inset-0 bg-black z-40" />
    </template>

    <Transition
      enter-active-class="transition duration-200 ease-out-cubic"
      enter-from-class="opacity-0 translate-y-1"
      enter-to-class="opacity-100 translate-y-0"
      leave-active-class="transition duration-150 ease-out-cubic"
    >
      <div
        v-if="mirror.reconnecting.value"
        class="absolute bottom-6 left-6 z-30 panel px-3 py-1.5 flex items-center gap-2 text-xs text-white/70"
      >
        <span class="h-1.5 w-1.5 rounded-full animate-pulse" :class="mirror.connection.value === 'offline' ? 'bg-red-400' : 'bg-amber-400'" />
        {{ mirror.connection.value === 'offline' ? 'offline' : 'reconnecting…' }}
      </div>
    </Transition>

    <div
      v-if="mirror.musicPlaying.value && !mirror.state.value.blanked && !webrtcPublisherId"
      class="absolute bottom-6 right-6 z-30 panel px-2.5 py-1.5 flex items-center gap-1.5 text-xs text-white/70"
    >
      <Music2 :size="12" class="text-accent" />
      <span class="h-1 w-1 rounded-full bg-accent animate-pulse" />
    </div>

    <div
      v-if="!effectiveSource"
      class="absolute inset-0 flex items-center justify-center text-white/40 text-2xl tracking-display"
    >
      Lumen — no source on Program
    </div>
  </div>
</template>
