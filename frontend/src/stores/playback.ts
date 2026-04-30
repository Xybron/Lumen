import { defineStore } from 'pinia';
import { computed, ref, watch } from 'vue';
import { createTimer } from '@/lib/timer';
import { preload } from '@/lib/preload';
import { computePrayerLabels, type PrayerLabel } from '@/lib/prayers';
import type { Item, Mode } from '@/types';
import { useContentStore } from './content';

export const usePlaybackStore = defineStore('playback', () => {
  const content = useContentStore();
  const mode = ref<Mode>('auto');
  const index = ref(0);
  const playing = ref(false);
  const blanked = ref(false);

  const timer = createTimer(8);

  const items = computed<Item[]>(() => content.activePlaylist?.items ?? []);
  const current = computed<Item | undefined>(() => items.value[index.value]);

  const prayerLabels = computed<Record<string, PrayerLabel>>(() =>
    computePrayerLabels(items.value),
  );
  function prayerLabelFor(id: string): PrayerLabel | undefined {
    return prayerLabels.value[id];
  }

  function nextPlayableIndex(from: number, dir: 1 | -1): number | null {
    let i = from + dir;
    while (i >= 0 && i < items.value.length) {
      if (items.value[i].type !== 'section') return i;
      i += dir;
    }
    return null;
  }

  const next = computed<Item | undefined>(() => {
    const ni = nextPlayableIndex(index.value, 1);
    return ni == null ? undefined : items.value[ni];
  });

  const totalMs = computed(() => current.value?.durationMs ?? 0);
  const remainingMs = computed(() => timer.remaining.value);
  const elapsedMs = computed(() => timer.elapsed.value);
  const progress = computed(() =>
    totalMs.value > 0 ? Math.min(1, elapsedMs.value / totalMs.value) : 0,
  );

  timer.onComplete(() => {
    if (mode.value === 'auto') goNext();
  });

  function play() {
    if (mode.value !== 'auto') return;
    if (!current.value) return;
    if (timer.running.value) return;
    if (timer.remaining.value > 0) {
      timer.resume();
    } else {
      timer.start(current.value.durationMs);
    }
    playing.value = true;
  }

  function pause() {
    timer.pause();
    playing.value = false;
  }

  function toggle() {
    if (playing.value) pause();
    else play();
  }

  function goNext() {
    const ni = nextPlayableIndex(index.value, 1);
    if (ni != null) {
      index.value = ni;
      onSlideChange();
    } else {
      pause();
    }
  }

  function goPrev() {
    const pi = nextPlayableIndex(index.value, -1);
    if (pi != null) {
      index.value = pi;
      onSlideChange();
    }
  }

  function jumpTo(i: number) {
    if (i < 0 || i >= items.value.length) return;
    // 1-9 keyboard / UpNext clicks should skip past sections to the nearest playable.
    if (items.value[i]?.type === 'section') {
      const fwd = nextPlayableIndex(i - 1, 1);
      if (fwd == null) return;
      index.value = fwd;
    } else {
      index.value = i;
    }
    onSlideChange();
  }

  function setMode(m: Mode) {
    mode.value = m;
    if (m === 'manual') {
      timer.stop();
      playing.value = false;
    } else if (current.value) {
      // Auto: re-arm with the full duration of whatever's on screen.
      timer.start(current.value.durationMs);
      playing.value = true;
    }
  }

  function toggleMode() {
    setMode(mode.value === 'auto' ? 'manual' : 'auto');
  }

  function toggleBlank() {
    blanked.value = !blanked.value;
  }

  function onSlideChange() {
    preload(next.value);
    if (mode.value === 'auto' && current.value) {
      timer.start(current.value.durationMs);
      playing.value = true;
    } else {
      timer.stop();
      playing.value = false;
    }
  }

  // Reset to slide 0 when the active playlist changes.
  watch(
    () => content.activePlaylist?.id,
    () => {
      index.value = 0;
      onSlideChange();
    },
  );

  return {
    mode,
    index,
    playing,
    blanked,
    items,
    current,
    next,
    prayerLabels,
    prayerLabelFor,
    totalMs,
    remainingMs,
    elapsedMs,
    progress,
    play,
    pause,
    toggle,
    goNext,
    goPrev,
    jumpTo,
    setMode,
    toggleMode,
    toggleBlank,
  };
});
