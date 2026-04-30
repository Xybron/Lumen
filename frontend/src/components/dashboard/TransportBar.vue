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
  MoreHorizontal,
} from 'lucide-vue-next';
import { Button } from '@/components/ui/button';
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover';
import ModeToggle from './ModeToggle.vue';
import MusicMiniPlayer from './MusicMiniPlayer.vue';
import { usePlaybackStore } from '@/stores/playback';
import type { Mode } from '@/types';

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

function setMode(m: Mode) {
  playback.setMode(m);
}

// On mobile the transport (prev/play/next + counter) lives in a dedicated
// strip above the playlist (rendered by DashboardView), so the top bar stays
// uncluttered. At md+ the transport sits inline alongside everything else.
const transportClass = 'hidden md:flex';
const counterClass = 'hidden md:block';
// ModeToggle is inline at every size — there's room for it once the transport
// has moved out of the way on mobile.
const inlineModeClass = 'inline-flex';
</script>

<template>
  <div class="panel flex items-center gap-1.5 md:gap-3 px-2 sm:px-3 h-14">
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

    <!-- Transport: only in bar on manual or md+. Auto-mode mobile gets a
         dedicated section below, rendered by DashboardView. -->
    <div :class="['items-center gap-1 md:gap-1.5 shrink-0', transportClass]">
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

    <div
      :class="[
        'text-xs sm:text-sm font-medium text-white/75 tnum tracking-display shrink-0 px-0.5',
        counterClass,
      ]"
    >
      {{ slideLabel }}
    </div>

    <!-- Inline ModeToggle: visible on mobile when auto (transport is gone),
         and always at md+. -->
    <ModeToggle
      :class="['shrink-0', inlineModeClass]"
      :mode="playback.mode"
      @update:mode="setMode"
    />

    <div class="hidden md:block h-6 w-px bg-hair shrink-0" />
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

    <!-- Mobile-only "more" popover. In auto mode it just has Blank;
         in manual mode it adds Mode toggle since that's not inline. -->
    <Popover>
      <PopoverTrigger as-child>
        <Button
          variant="ghost"
          size="icon"
          class="md:hidden shrink-0"
          :class="{ 'text-amber-300': playback.blanked }"
          title="More"
        >
          <MoreHorizontal :size="18" />
        </Button>
      </PopoverTrigger>
      <PopoverContent
        align="end"
        :side-offset="8"
        class="w-56 !p-2 md:hidden"
      >
        <button
          class="flex items-center gap-3 w-full px-3 h-10 rounded-lg text-sm transition-colors"
          :class="
            playback.blanked
              ? 'text-amber-300 hover:bg-amber-500/10'
              : 'text-white hover:bg-white/[0.06]'
          "
          @click="playback.toggleBlank"
        >
          <MonitorOff v-if="playback.blanked" :size="16" />
          <Monitor v-else :size="16" />
          {{ playback.blanked ? 'Resume projection' : 'Blank screen' }}
        </button>
      </PopoverContent>
    </Popover>

    <!-- Open Live View — icon-only on phones, labeled at md+. -->
    <Button
      variant="accent"
      size="icon"
      class="md:hidden shrink-0"
      title="Open Live View"
      @click="emit('open-live')"
    >
      <ExternalLink :size="16" />
    </Button>
    <Button
      variant="accent"
      size="md"
      class="hidden md:inline-flex shrink-0"
      title="Open Live View"
      @click="emit('open-live')"
    >
      <ExternalLink :size="16" />
      Open Live View
    </Button>
  </div>
</template>
