<script setup lang="ts">
import { computed } from 'vue';
import { Clock, ArrowRight, Monitor } from 'lucide-vue-next';
import { usePlaybackStore } from '@/stores/playback';
import PreviewSurface from './PreviewSurface.vue';

const playback = usePlaybackStore();

const upcoming = computed(() => playback.items
  .map((item, index) => ({ item, index }))
  .filter(({ item, index }) => index > playback.index && item.type !== 'section')
  .slice(0, 4));
const currentPrayerLabel = computed(() =>
  playback.current ? playback.prayerLabelFor(playback.current.id)?.display : undefined,
);

// Cumulative time until each upcoming slide shows, given the remaining time on
// the current slide plus the durations of every slide between now and that one.
const offsets = computed(() => {
  const out: number[] = [];
  let acc = playback.remainingMs;
  for (const { item } of upcoming.value) {
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

function duration(ms: number) { return fmt(ms).replace(/^in /, ''); }
</script>

<template>
  <aside class="panel presentation-cues" aria-label="Current and upcoming slides">
    <header class="cue-heading">
      <Monitor :size="14" class="text-white/55" />
      <h2>Channel output</h2>
      <span class="cue-output-state" :class="{ blanked: playback.blanked }"><i />{{ playback.blanked ? 'Blanked' : playback.current ? 'Active' : 'Ready' }}</span>
    </header>

    <div v-if="playback.current" class="cue-current">
      <PreviewSurface
        :item="playback.current"
        :blanked="playback.blanked"
        :prayer-label="currentPrayerLabel"
        expandable
        navigable
      />

      <div>
        <div class="text-[12px] font-medium text-white truncate">
          {{ playback.current.title || playback.current.body || 'Untitled' }}
        </div>
        <div v-if="playback.current.reference" class="text-xs text-white/55 truncate mt-0.5">
          {{ playback.current.reference }}
        </div>
      </div>

      <div class="cue-timing"><span>{{ playback.mode === 'manual' ? 'Manual control' : playback.playing ? 'Auto advancing' : 'Auto paused' }}</span><span class="tnum">{{ duration(playback.remainingMs) }} / {{ duration(playback.totalMs) }}</span></div>
      <div class="h-0.5 rounded-full bg-white/[0.07] overflow-hidden">
        <div
          class="h-full bg-accent transition-[width] duration-200 ease-out-cubic"
          :style="{ width: `${playback.progress * 100}%` }"
        />
      </div>
    </div>
    <div v-else class="cue-idle"><Monitor :size="25" /><p>No slide is showing</p><span>Select a slide to begin.</span></div>

    <div class="cue-next-heading"><Clock :size="13" /><h3>Up next</h3><span>{{ playback.mode === 'auto' ? 'Scheduled' : 'Slide order' }}</span></div>
    <ul class="cue-queue">
      <li
        v-for="({ item, index }, i) in upcoming"
        :key="item.id"
        class="cue-queue-item"
      >
        <button type="button" class="cue-jump" :disabled="playback.readOnly" :title="`Show ${item.title || item.body || 'slide'} now`" @click="playback.jumpTo(index)">
          <div class="w-[72px] shrink-0">
            <PreviewSurface :item="item" :prayer-label="playback.prayerLabelFor(item.id)?.display" />
          </div>
          <div class="flex-1 min-w-0">
            <div class="text-[11px] font-medium text-white truncate">
              {{ item.title || item.body || 'Untitled' }}
            </div>
            <div class="text-[10px] text-white/45 tnum mt-1">
              {{ playback.mode === 'auto' ? fmt(offsets[i]) : `Slide ${index + 1}` }}
            </div>
          </div>
          <ArrowRight :size="13" class="cue-jump-arrow" />
        </button>
      </li>
      <li v-if="upcoming.length === 0" class="cue-end">
        {{ playback.current ? 'End of playlist' : 'Your upcoming slides will appear here.' }}
      </li>
    </ul>
  </aside>
</template>

<style scoped>
.presentation-cues { display: flex; flex-direction: column; height: 100%; min-height: 0; overflow: hidden; }
.cue-heading { display: flex; align-items: center; gap: 7px; min-height: 46px; padding: 10px 13px; border-bottom: 1px solid var(--border-hair); flex-shrink: 0; }
.cue-heading h2 { font-size: 12px; font-weight: 600; }
.cue-output-state { margin-left: auto; display: inline-flex; gap: 5px; align-items: center; color: #95cbb0; font-size: 9px; }
.cue-output-state i { width: 4px; height: 4px; border-radius: 50%; background: currentColor; }
.cue-output-state.blanked { color: #dfbf83; }
.cue-current { display: flex; flex-direction: column; gap: 11px; padding: 12px; flex-shrink: 0; }
.cue-timing { display: flex; align-items: center; justify-content: space-between; gap: 5px; color: var(--text-muted); font-size: 9px; }
.cue-idle { min-height: 170px; display: flex; flex-direction: column; align-items: center; justify-content: center; gap: 7px; color: var(--text-muted); font-size: 11px; }
.cue-idle>svg { margin-bottom: 4px; opacity: .55; }
.cue-idle>span { font-size: 10px; opacity: .7; }
.cue-next-heading { display: flex; align-items: center; gap: 6px; color: var(--text-muted); padding: 13px 13px 8px; border-top: 1px solid var(--border-hair); flex-shrink: 0; }
.cue-next-heading h3 { color: var(--text-primary); font-size: 11px; font-weight: 500; }
.cue-next-heading>span { margin-left: auto; font-size: 9px; }
.cue-queue { flex: 1; min-height: 0; overflow-y: auto; padding: 0 6px 100px; }
.cue-queue-item { border-bottom: 1px solid #ffffff05; }
.cue-jump { display: flex; align-items: center; width: 100%; gap: 9px; text-align: left; padding: 8px 6px; border-radius: var(--radius-control, 7px); transition: background .12s; }
.cue-jump:hover:not(:disabled) { background: #ffffff06; }
.cue-jump:focus-visible { outline: 2px solid var(--accent); outline-offset: -2px; }
.cue-jump-arrow { color: var(--accent); opacity: 0; flex-shrink: 0; }
.cue-jump:hover .cue-jump-arrow, .cue-jump:focus-visible .cue-jump-arrow { opacity: 1; }
.cue-jump:disabled { cursor: default; }
.cue-end { padding: 16px 8px; font-size: 11px; color: var(--text-muted); line-height: 1.5; }
@media (max-width: 767px) { .cue-queue { padding-bottom: 24px; } }
</style>
