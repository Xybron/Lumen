import { defineStore } from 'pinia';
import { computed } from 'vue';
import type { Item, Mode } from '@/types';
import type { PrayerLabel } from '@/lib/prayers';
import { useEnginesStore } from './engines';
import { usePresenceStore } from './presence';

// DEPRECATED compatibility shim. The single-session playback store now proxies
// the FOCUSED channel's engine in the registry, so existing components keep
// working unchanged during the channel cutover. Remove once they consume the
// engines store (or a per-channel engine prop) directly.
export const usePlaybackStore = defineStore('playback', () => {
  const engines = useEnginesStore();
  const presence = usePresenceStore();
  const e = () => engines.focused;

  // True when another operator currently controls the focused channel — the UI
  // goes read-only (controls no-op) until you take it over. Defense-in-depth: the
  // server is the authority, this just keeps the UI honest.
  const readOnly = computed(() => {
    const id = engines.focusedChannelId;
    return id ? presence.controlledByOther(id) : false;
  });
  function guard(fn: () => void) {
    if (readOnly.value) return;
    fn();
  }

  const mode = computed<Mode>(() => e()?.mode.value ?? 'auto');
  // Writable so callers that still assign playback.index (e.g. drag-reorder index
  // correction) drive the focused engine.
  const index = computed<number>({
    get: () => e()?.index.value ?? 0,
    set: (v) => {
      const eng = e();
      if (eng) eng.index.value = v;
    },
  });
  const playing = computed(() => e()?.playing.value ?? false);
  const blanked = computed(() => e()?.blanked.value ?? false);
  const items = computed<Item[]>(() => e()?.items.value ?? []);
  const current = computed<Item | undefined>(() => e()?.current.value);
  const next = computed<Item | undefined>(() => e()?.next.value);
  const prayerLabels = computed<Record<string, PrayerLabel>>(() => e()?.prayerLabels.value ?? {});
  function prayerLabelFor(id: string): PrayerLabel | undefined {
    return e()?.prayerLabelFor(id);
  }
  const totalMs = computed(() => e()?.totalMs.value ?? 0);
  const remainingMs = computed(() => e()?.remainingMs.value ?? 0);
  const elapsedMs = computed(() => e()?.elapsedMs.value ?? 0);
  const progress = computed(() => e()?.progress.value ?? 0);

  function play() {
    guard(() => e()?.play());
  }
  function pause() {
    guard(() => e()?.pause());
  }
  function toggle() {
    guard(() => e()?.toggle());
  }
  function goNext() {
    guard(() => e()?.goNext());
  }
  function goPrev() {
    guard(() => e()?.goPrev());
  }
  function jumpTo(i: number) {
    guard(() => e()?.jumpTo(i));
  }
  function setMode(m: Mode) {
    guard(() => e()?.setMode(m));
  }
  function toggleMode() {
    guard(() => e()?.toggleMode());
  }
  function toggleBlank() {
    guard(() => e()?.toggleBlank());
  }

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
    readOnly,
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
