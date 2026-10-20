<script setup lang="ts">
import { computed } from 'vue';
import {
  ChevronLeft,
  ChevronRight,
  Play,
  Pause,
  Monitor,
  MonitorOff,
  Menu,
  PanelRightOpen,
  Lock,
} from 'lucide-vue-next';
import { Button } from '@/components/ui/button';
import ModeToggle from './ModeToggle.vue';
import MusicMiniPlayer from './MusicMiniPlayer.vue';
import ChannelOutputControls from '@/components/channel/ChannelOutputControls.vue';
import { usePlaybackStore } from '@/stores/playback';
import { usePresenceStore } from '@/stores/presence';
import { useEnginesStore } from '@/stores/engines';
import type { Mode } from '@/types';

const playback = usePlaybackStore();
const presence = usePresenceStore();
const engines = useEnginesStore();

// Who controls the focused channel, when it isn't us (drives the read-only badge).
const controllerName = computed(() => {
  const id = engines.focusedChannelId;
  if (!id || !playback.readOnly) return null;
  return presence.userName(presence.controllerOf(id));
});

const emit = defineEmits<{
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
// strip above the playlist (rendered by ChannelView), so the top bar stays
// uncluttered. At md+ the transport sits inline alongside everything else.
const transportClass = 'hidden md:flex';
const counterClass = 'hidden md:block';
// ModeToggle is inline at every size — there's room for it once the transport
// has moved out of the way on mobile.
const inlineModeClass = 'inline-flex';
</script>

<template>
  <div class="panel presentation-controls">
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
         dedicated section below, rendered by ChannelView. Disabled when another
         operator controls the focused channel (read-only). -->
    <div :class="['items-center gap-1 md:gap-1.5 shrink-0', transportClass]">
      <Button variant="ghost" size="icon" title="Previous slide (←)" aria-label="Previous slide" @click="playback.goPrev" :disabled="playback.index === 0 || playback.readOnly">
        <ChevronLeft :size="18" />
      </Button>
      <Button
        :variant="playback.playing ? 'accent' : 'default'"
        size="icon"
        :disabled="playback.mode !== 'auto' || !playback.current || playback.readOnly"
        :title="playback.playing ? 'Pause presentation (Space)' : 'Play presentation (Space)'"
        :aria-label="playback.playing ? 'Pause presentation' : 'Play presentation'"
        @click="playback.toggle"
      >
        <Pause v-if="playback.playing" :size="16" />
        <Play v-else :size="16" />
      </Button>
      <Button variant="ghost" size="icon" title="Next slide (→)" aria-label="Next slide" @click="playback.goNext" :disabled="!playback.current || playback.readOnly">
        <ChevronRight :size="18" />
      </Button>
    </div>

    <!-- read-only badge when another operator is driving this channel -->
    <div
      v-if="playback.readOnly"
      class="hidden md:flex items-center gap-1.5 shrink-0 px-2 h-7 rounded-lg bg-amber-400/10 text-amber-300/90 text-xs font-medium"
      :title="controllerName ? `Controlled by ${controllerName}` : 'Controlled by another operator'"
    >
      <Lock :size="12" />
      <span class="hidden lg:inline">{{ controllerName ?? 'Read-only' }}</span>
    </div>

    <div
      :class="[
        'text-xs sm:text-sm font-medium text-white/75 tnum tracking-display shrink-0 px-0.5',
        counterClass,
      ]"
    >
      <span class="text-white/40 mr-1.5 hidden xl:inline">Slide</span>{{ slideLabel }}
    </div>

    <!-- Inline ModeToggle: visible on mobile when auto (transport is gone),
         and always at md+. -->
    <ModeToggle
      :class="['shrink-0', inlineModeClass, playback.readOnly ? 'opacity-40 pointer-events-none' : '']"
      :mode="playback.mode"
      @update:mode="setMode"
    />

    <div class="hidden md:block h-6 w-px bg-hair shrink-0" />
    <MusicMiniPlayer class="hidden md:flex presentation-music" />

    <div class="flex-1" />

    <ChannelOutputControls />

    <Button
      variant="ghost"
      size="md"
      class="hidden md:inline-flex !text-xs shrink-0"
      :class="{ 'text-amber-300 bg-amber-400/10': playback.blanked }"
      :disabled="playback.readOnly || !playback.current"
      :aria-pressed="playback.blanked"
      :title="playback.blanked ? 'Resume projection (B)' : 'Blank screen (B)'"
      @click="playback.toggleBlank"
    >
      <MonitorOff v-if="playback.blanked" :size="14" />
      <Monitor v-else :size="14" />
      {{ playback.blanked ? 'Resume' : 'Blank' }}
      <kbd class="transport-key hidden xl:inline-flex">B</kbd>
    </Button>

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

  </div>
</template>

<style scoped>
.presentation-controls { min-height: 46px; display: flex; align-items: center; gap: 10px; padding: 6px 10px; }
.presentation-music { max-width: 330px; flex: 1 1 220px; }
.transport-key { align-items: center; justify-content: center; width: 17px; height: 18px; margin-left: 4px; border: 1px solid var(--border-hair); border-radius: 4px; font-size: 9px; color: var(--text-muted); }
@media (max-width: 1100px) { .presentation-controls { flex-wrap: wrap; gap: 6px; padding: 6px; } .presentation-music { min-width: 180px; } }
@media (max-width: 460px) { .presentation-controls { gap: 4px; } }
</style>
