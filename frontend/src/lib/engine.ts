import { computed, effectScope, ref, watch, type ComputedRef, type Ref } from 'vue';
import { createTimer } from '@/lib/timer';
import { preload, releasePreload } from '@/lib/preload';
import { broadcast } from '@/lib/broadcast';
import { computePrayerLabels, type PrayerLabel } from '@/lib/prayers';
import { presentationItem } from '@/lib/presentation-state';
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
  applyRemotePresentation(state: ProjectionState): void;
  dispose(): void;
}

export function createPlaybackEngine(channelId: string, opts?: { defaultMode?: Mode; external?: boolean }): PlaybackEngine {
  const content = useContentStore();
  // Detached scope owns every watcher/computed below so dispose() tears them all
  // down when the channel is removed.
  const scope = effectScope(true);

  return scope.run(() => {
    // Auto is a deliberate session choice, including for legacy saved channels.
    const mode = ref<Mode>('manual');
    const index = ref(0);
    const playing = ref(false);
    const blanked = ref(false);
    const timer = createTimer(8);

    const items = computed<Item[]>(() => content.playlistForChannel(channelId)?.items ?? []);
    const externalCue = ref<Item | null>(null);
    const current = computed<Item | undefined>(() => opts?.external ? externalCue.value ?? undefined : items.value[index.value]);

    // Keep the on-air cue anchored by ID when groups or slide order are edited.
    // Moving a slide must not silently replace it with its new neighbour.
    watch(() => items.value.map(item => item.id), (ids, previous) => {
      if (opts?.external || !previous.length) return;
      const nextIndex = ids.indexOf(previous[index.value] ?? '');
      if (nextIndex >= 0) index.value = nextIndex;
      else { index.value = Math.max(0, Math.min(index.value, ids.length - 1)); playing.value = false; onSlideChange(); }
    });

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
      else playing.value = false;
    });

    function play() {
      if (opts?.external) return;
      if (!current.value || current.value.type === 'section' || current.value.durationMs <= 0) return;
      if (timer.running.value) return;
      if (timer.remaining.value > 0) timer.resume();
      else timer.start(current.value.durationMs);
      playing.value = timer.running.value;
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
      // Switching to Manual only disables advancement; keep the prayer clock.
      if (m === 'auto') play();
    }

    function toggleMode() {
      setMode(mode.value === 'auto' ? 'manual' : 'auto');
    }

    function toggleBlank() {
      if (opts?.external) return;
      blanked.value = !blanked.value;
    }

    function onSlideChange() {
      if (playing.value && current.value) {
        timer.start(current.value.durationMs);
        playing.value = timer.running.value;
      } else {
        timer.reset(current.value?.durationMs ?? 0);
        playing.value = false;
      }
    }

    const projectionState = computed<ProjectionState>(() => ({
      channelId,
      playlistId: content.playlistForChannel(channelId)?.id ?? null,
      index: index.value,
      itemId: current.value?.id,
      mode: mode.value,
      playing: playing.value,
      blanked: blanked.value,
      startedAt: playing.value ? performance.now() : null,
      durationMs: totalMs.value,
    }));

    function sendState() {
      if (opts?.external) return;
      broadcast({ t: 'state', channel: channelId, payload: { ...projectionState.value, elapsedMs: elapsedMs.value } });
      broadcast({ t: 'tick', channel: channelId, elapsedMs: elapsedMs.value, remainingMs: remainingMs.value });
    }
    function applyExternal(state: ProjectionState) { if (opts?.external) { externalCue.value=state.cue??null;blanked.value=state.blanked;mode.value='manual';playing.value=false; } }
    function applyRemotePresentation(state: ProjectionState) {
      if (opts?.external || state.channelId !== channelId || state.playlistId !== content.playlistForChannel(channelId)?.id) return;
      const requested = presentationItem(items.value, state);
      if (state.itemId && !requested) return;
      timer.stop(); mode.value = 'manual'; playing.value = false;
      index.value = requested ? items.value.indexOf(requested) : Math.max(0, Math.min(items.value.length - 1, Number.isInteger(state.index) ? state.index : 0));
      blanked.value = state.blanked;
      timer.reset(current.value?.durationMs ?? 0);
    }

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

    // Also refresh after playlist edits and remote selection, and release when
    // there is no next slide. External scripture/lyrics cues never warm media.
    if (!opts?.external) watch(() => [next.value?.background?.kind, next.value?.background?.src],
      () => preload(channelId, next.value), { immediate: true });

    // Prepare the current cue without starting its timer or advancing slides.
    if (!opts?.external) onSlideChange();

    function dispose() {
      releasePreload(channelId);
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
      applyRemotePresentation,
      dispose,
    };
  })!;
}
