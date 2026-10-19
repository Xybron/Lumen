<script setup lang="ts">
import { ChevronLeft, ChevronRight, Play, Pause, Lock } from 'lucide-vue-next';
import { Button } from '@/components/ui/button';
import { usePlaybackStore } from '@/stores/playback';

// The md:hidden transport strip that sits above the slide list on phones.
// Disables when another operator controls the focused channel (read-only).
const playback = usePlaybackStore();
</script>

<template>
  <div class="md:hidden panel flex items-center justify-between px-2 min-h-11 shrink-0">
    <div class="flex items-center gap-1.5">
      <Button variant="ghost" size="icon" aria-label="Previous slide" title="Previous slide" :disabled="playback.index === 0 || playback.readOnly" @click="playback.goPrev">
        <ChevronLeft :size="18" />
      </Button>
      <Button
        :variant="playback.playing ? 'accent' : 'default'"
        size="icon"
        :disabled="playback.mode !== 'auto' || !playback.current || playback.readOnly"
        :aria-label="playback.playing ? 'Pause presentation' : 'Play presentation'"
        @click="playback.toggle"
      >
        <Pause v-if="playback.playing" :size="16" />
        <Play v-else :size="16" />
      </Button>
      <Button variant="ghost" size="icon" aria-label="Next slide" title="Next slide" :disabled="!playback.current || playback.readOnly" @click="playback.goNext">
        <ChevronRight :size="18" />
      </Button>
    </div>
    <div class="text-xs font-medium text-white/75 tnum flex items-center gap-1.5 pr-1">
      <Lock v-if="playback.readOnly" :size="12" class="text-amber-300/80" />
      {{ playback.items.length === 0 ? '—' : `${playback.index + 1} / ${playback.items.length}` }}
    </div>
  </div>
</template>
