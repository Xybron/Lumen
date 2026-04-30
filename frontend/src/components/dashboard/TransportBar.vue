<script setup lang="ts">
import { computed } from 'vue';
import {
  ChevronLeft,
  ChevronRight,
  Play,
  Pause,
  ExternalLink,
  Monitor,
  MonitorOff,
  Menu,
  PanelRightOpen,
} from 'lucide-vue-next';
import { Button } from '@/components/ui/button';
import ModeToggle from './ModeToggle.vue';
import MusicMiniPlayer from './MusicMiniPlayer.vue';
import { usePlaybackStore } from '@/stores/playback';

const playback = usePlaybackStore();

const emit = defineEmits<{
  (e: 'open-live'): void;
  (e: 'open-playlists'): void;
  (e: 'open-upnext'): void;
}>();

const slideLabel = computed(() => {
  const total = playback.items.length;
  if (total === 0) return '—';
  return `${playback.index + 1} / ${total}`;
});
</script>

<template>
  <div class="panel flex items-center gap-1.5 sm:gap-3 px-2 sm:px-3 h-14">
    <!-- Mobile: hamburger that opens the playlist sheet (lg+: rail is in grid). -->
    <Button
      variant="ghost"
      size="icon"
      class="lg:hidden shrink-0"
      title="Playlists"
      @click="emit('open-playlists')"
    >
      <Menu :size="18" />
    </Button>

    <div class="flex items-center gap-1 sm:gap-1.5 shrink-0">
      <Button variant="ghost" size="icon" @click="playback.goPrev" :disabled="playback.index === 0">
        <ChevronLeft :size="18" />
      </Button>
      <Button
        :variant="playback.playing ? 'accent' : 'default'"
        size="icon"
        :disabled="playback.mode !== 'auto' || !playback.current"
        @click="playback.toggle"
      >
        <Pause v-if="playback.playing" :size="16" />
        <Play v-else :size="16" />
      </Button>
      <Button variant="ghost" size="icon" @click="playback.goNext" :disabled="!playback.current">
        <ChevronRight :size="18" />
      </Button>
    </div>

    <div class="text-xs sm:text-sm font-medium text-white/75 tnum tracking-display shrink-0 px-1">
      {{ slideLabel }}
    </div>

    <div class="hidden sm:block h-6 w-px bg-hair shrink-0" />

    <ModeToggle
      :mode="playback.mode"
      :compact="true"
      class="hidden xs:inline-flex sm:inline-flex"
      @update:mode="playback.setMode"
    />

    <div class="hidden md:block h-6 w-px bg-hair shrink-0" />

    <!-- Desktop inline mini player. The mobile dock lives at the bottom. -->
    <MusicMiniPlayer class="hidden md:flex" />

    <div class="flex-1" />

    <!-- Tablet/mobile: button to open the up-next sheet. -->
    <Button
      variant="ghost"
      size="icon"
      class="md:hidden shrink-0"
      title="Up Next"
      @click="emit('open-upnext')"
    >
      <PanelRightOpen :size="18" />
    </Button>

    <Button
      variant="ghost"
      :size="'md'"
      :class="['shrink-0', { 'text-amber-300': playback.blanked }]"
      :title="playback.blanked ? 'Resume projection' : 'Blank screen'"
      @click="playback.toggleBlank"
    >
      <MonitorOff v-if="playback.blanked" :size="16" />
      <Monitor v-else :size="16" />
      <span class="hidden md:inline">{{ playback.blanked ? 'Blanked' : 'Blank' }}</span>
    </Button>

    <Button
      variant="accent"
      :size="'md'"
      class="shrink-0"
      :title="'Open Live View'"
      @click="emit('open-live')"
    >
      <ExternalLink :size="16" />
      <span class="hidden md:inline">Open Live View</span>
    </Button>
  </div>
</template>
