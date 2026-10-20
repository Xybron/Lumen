<script setup lang="ts">
import { computed, ref } from 'vue';
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
import { useShortcuts } from '@/lib/keyboard';

const contentStore = useContentStore();
const route = useRoute();

// This Live view mirrors exactly one channel: the :channelId route param, or the
// first channel as a fallback when opened bare at /live.
const channelId = computed(
  () => (route.params.channelId as string) || contentStore.channels[0]?.id || '',
);

const {
  state,
  remainingMs,
  connection,
  reconnecting,
  currentItem,
  currentPrayerLabel,
  settings,
  progress,
  showWarning,
  showCountdown,
  musicPlaying,
} = useChannelMirror(channelId);

const root = ref<HTMLElement | null>(null);
const { enter: enterFullscreen, exit: exitFullscreen, isFullscreen } = useFullscreen(root);
const { idle } = useIdle(2000);
useWakeLock().request('screen').catch(() => {});

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
