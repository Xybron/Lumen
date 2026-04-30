<script setup lang="ts">
import { computed } from 'vue';
import { Clock } from 'lucide-vue-next';
import { usePlaybackStore } from '@/stores/playback';
import PreviewSurface from './PreviewSurface.vue';

const playback = usePlaybackStore();

const upcoming = computed(() => playback.items.slice(playback.index + 1, playback.index + 5));
const currentPrayerLabel = computed(() =>
  playback.current ? playback.prayerLabelFor(playback.current.id)?.display : undefined,
);

// Cumulative time until each upcoming slide shows, given the remaining time on
// the current slide plus the durations of every slide between now and that one.
const offsets = computed(() => {
  const out: number[] = [];
  let acc = playback.remainingMs;
  for (const item of upcoming.value) {
    out.push(acc);
    acc += item.durationMs;
  }
  return out;
});

function fmt(ms: number) {
  const s = Math.max(0, Math.round(ms / 1000));
  if (s < 60) return `in ${s}s`;
  const m = Math.floor(s / 60);
  const r = s % 60;
  return r === 0 ? `in ${m}m` : `in ${m}m ${r}s`;
}
</script>

<template>
  <aside class="panel flex flex-col h-full p-4 gap-3 overflow-hidden">
    <header class="flex items-center gap-2 px-1 pt-1">
      <Clock :size="14" class="text-white/55" />
      <span class="text-sm font-semibold tracking-display text-white">Up Next</span>
    </header>

    <div v-if="playback.current" class="panel-soft p-3 flex flex-col gap-2.5">
      <div class="flex items-center justify-between">
        <span class="text-[10px] font-semibold tracking-[0.1em] uppercase text-accent">
          Now showing
        </span>
        <span
          v-if="playback.blanked"
          class="text-[10px] font-semibold tracking-[0.1em] uppercase text-amber-300"
        >
          Blanked
        </span>
      </div>

      <PreviewSurface
        :item="playback.current"
        :blanked="playback.blanked"
        :prayer-label="currentPrayerLabel"
        expandable
        navigable
      />

      <div>
        <div class="text-sm font-medium text-white truncate">
          {{ playback.current.title || playback.current.body || 'Untitled' }}
        </div>
        <div v-if="playback.current.reference" class="text-xs text-white/55 truncate mt-0.5">
          {{ playback.current.reference }}
        </div>
      </div>

      <div class="h-1 rounded-full bg-white/10 overflow-hidden">
        <div
          class="h-full bg-accent transition-all duration-200 ease-out-cubic"
          :style="{ width: `${playback.progress * 100}%` }"
        />
      </div>
    </div>

    <ul class="flex flex-col gap-2 overflow-y-auto flex-1 -mx-1 px-1">
      <li
        v-for="(item, i) in upcoming"
        :key="item.id"
        class="flex items-center gap-3 panel-soft px-2.5 py-2.5 hover:bg-white/[0.04] transition-colors"
      >
        <div class="w-20 shrink-0">
          <PreviewSurface :item="item" :prayer-label="playback.prayerLabelFor(item.id)?.display" />
        </div>
        <div class="flex-1 min-w-0">
          <div class="text-xs font-medium text-white truncate">
            {{ item.title || item.body || 'Untitled' }}
          </div>
          <div class="text-[11px] text-white/45 tnum mt-0.5">
            {{ fmt(offsets[i]) }}
          </div>
        </div>
      </li>
      <li v-if="upcoming.length === 0" class="text-xs text-white/40 px-2 py-3">
        Nothing queued up.
      </li>
    </ul>
  </aside>
</template>
