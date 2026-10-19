import { computed, effectScope, ref, watch, type ComputedRef, type Ref } from 'vue';
import { createTimer } from '@/lib/timer';
import { preload } from '@/lib/preload';
import { broadcast } from '@/lib/broadcast';
import { computePrayerLabels, type PrayerLabel } from '@/lib/prayers';
import { useContentStore } from '@/stores/content';
import type { Item, Mode, ProjectionState } from '@/types';

// A self-contained playback engine for ONE channel. This is the body of the
// former singleton playback store, lifted into a factory so the registry can run
// N of them at once — each bound to its channel's own playlist and broadcasting
// its own channel-scoped state. Unfocused engines keep running (there is NO
// reset-on-focus watch), which is what lets a channel auto-advance off-screen.
export interface PlaybackEngine {
  channelId: string;
  mode: Ref<Mode>;
  index: Ref<number>;
  playing: Ref<boolean>;
  blanked: Ref<boolean>;
  items: ComputedRef<Item[]>;
  current: ComputedRef<Item | undefined>;
  next: ComputedRef<Item | undefined>;
  prayerLabels: ComputedRef<Record<string, PrayerLabel>>;
  prayerLabelFor(id: string): PrayerLabel | undefined;
  totalMs: ComputedRef<number>;
  remainingMs: ComputedRef<number>;
  elapsedMs: ComputedRef<number>;
  progress: ComputedRef<number>;
  projectionState: ComputedRef<ProjectionState>;
  play(): void;
  pause(): void;
  toggle(): void;
  goNext(): void;
  goPrev(): void;
  jumpTo(i: number): void;
  setMode(m: Mode): void;
  toggleMode(): void;
  toggleBlank(): void;
  sendState(): void;
  applyExternal(state: ProjectionState): void;
  dispose(): void;
}

export function createPlaybackEngine(channelId: string, opts?: { defaultMode?: Mode; external?: boolean }): PlaybackEngine {
  const content = useContentStore();
  // Detached scope owns every watcher/computed below so dispose() tears them all
  // down when the channel is removed.
  const scope = effectScope(true);

  return scope.run(() => {
    const mode = ref<Mode>(opts?.defaultMode ?? 'auto');
    const index = ref(0);
    const playing = ref(false);
    const blanked = ref(false);
    const timer = createTimer(8);

    const items = computed<Item[]>(() => content.playlistForChannel(channelId)?.items ?? []);
    const externalCue = ref<Item | null>(null);
    const current = computed<Item | undefined>(() => opts?.external ? externalCue.value ?? undefined : items.value[index.value]);

    const prayerLabels = computed<Record<string, PrayerLabel>>(() => computePrayerLabels(items.value));
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
      if (opts?.external) return undefined;
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
      if (opts?.external) return;
      if (mode.value !== 'auto') return;
      if (!current.value) return;
      if (timer.running.value) return;
      if (timer.remaining.value > 0) timer.resume();
      else timer.start(current.value.durationMs);
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
      if (opts?.external) return;
      const ni = nextPlayableIndex(index.value, 1);
      if (ni != null) {
        index.value = ni;
        onSlideChange();
      } else {
        pause();
      }
    }

    function goPrev() {
      if (opts?.external) return;
      const pi = nextPlayableIndex(index.value, -1);
      if (pi != null) {
        index.value = pi;
        onSlideChange();
      }
    }

    function jumpTo(i: number) {
      if (opts?.external) return;
      if (i < 0 || i >= items.value.length) return;
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
      if (opts?.external) return;
      mode.value = m;
      if (m === 'manual') {
        timer.stop();
        playing.value = false;
      } else if (current.value) {
        timer.start(current.value.durationMs);
        playing.value = true;
      }
    }

    function toggleMode() {
      setMode(mode.value === 'auto' ? 'manual' : 'auto');
    }

    function toggleBlank() {
      if (opts?.external) return;
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

    const projectionState = computed<ProjectionState>(() => ({
      channelId,
      playlistId: content.playlistForChannel(channelId)?.id ?? null,
      index: index.value,
      mode: mode.value,
      playing: playing.value,
      blanked: blanked.value,
      startedAt: playing.value ? performance.now() : null,
      durationMs: totalMs.value,
    }));

    function sendState() {
      if (opts?.external) return;
      broadcast({ t: 'state', channel: channelId, payload: projectionState.value });
    }
    function applyExternal(state: ProjectionState) { if (opts?.external) { externalCue.value=state.cue??null;blanked.value=state.blanked;mode.value='manual';playing.value=false; } }

    // Broadcast this channel's state on any meaningful change — runs whether or
    // not the channel is the focused one in the operator UI.
    watch(projectionState, () => sendState(), { deep: true });

    // 8 Hz tick while playing; one final tick on stop so the Live progress bar
    // snaps to the frozen value instead of drifting.
    let tickHandle: number | null = null;
    watch(playing, (isPlaying) => {
      if (tickHandle !== null) {
        clearInterval(tickHandle);
        tickHandle = null;
      }
      const tick = () =>
        broadcast({
          t: 'tick',
          channel: channelId,
          remainingMs: remainingMs.value,
          elapsedMs: elapsedMs.value,
        });
      if (isPlaying) tickHandle = window.setInterval(tick, 125);
      else tick();
    });

    // Arm on creation, mirroring the previous single-session auto-start behavior.
    if (!opts?.external) onSlideChange();

    function dispose() {
      if (tickHandle !== null) clearInterval(tickHandle);
      timer.stop();
      scope.stop();
    }

    return {
      channelId,
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
      projectionState,
      play,
      pause,
      toggle,
      goNext,
      goPrev,
      jumpTo,
      setMode,
      toggleMode,
      toggleBlank,
      sendState,
      applyExternal,
      dispose,
    };
  })!;
}
