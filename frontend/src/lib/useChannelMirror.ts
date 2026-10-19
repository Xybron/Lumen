import { computed, onBeforeUnmount, onMounted, ref, watch, type Ref } from 'vue';
import { useContentStore } from '@/stores/content';
import { useBroadcast, subscribeTopics, unsubscribeTopics } from '@/lib/broadcast';
import { useConnection } from '@/lib/ws';
import { computePrayerLabels } from '@/lib/prayers';
import type { BroadcastMsg, Item, ProjectionState } from '@/types';

// Mirrors ONE channel's projection state for a read-only output surface (the Live
// view and the destination Output view). Subscribes to the channel topic,
// applies state/tick with rAF extrapolation, and follows a reactive channelId so
// a destination can re-point when the Program bus cuts.
export function useChannelMirror(channelId: Ref<string>) {
  const contentStore = useContentStore();

  const state = ref<ProjectionState>({
    channelId: '',
    playlistId: null,
    index: 0,
    mode: 'auto',
    playing: false,
    blanked: false,
    startedAt: null,
    durationMs: 0,
  });
  const remainingMs = ref(0);
  const elapsedMs = ref(0);
  const musicPlaying = ref(false);

  const connection = useConnection();
  const reconnecting = computed(() => connection.value !== 'online');

  // rAF-extrapolated progress between 8 Hz ticks.
  const syncedElapsedMs = ref(0);
  const syncedAt = ref(performance.now());
  const smoothElapsedMs = ref(0);
  function recordSync(e: number) {
    syncedElapsedMs.value = e;
    syncedAt.value = performance.now();
    smoothElapsedMs.value = e;
  }
  let rafHandle: number | null = null;
  function runRaf() {
    if (state.value.playing && state.value.durationMs > 0) {
      const local = syncedElapsedMs.value + (performance.now() - syncedAt.value);
      smoothElapsedMs.value = Math.max(0, Math.min(state.value.durationMs, local));
    }
    rafHandle = requestAnimationFrame(runRaf);
  }
  watch(
    () => state.value.playing,
    (playing) => {
      if (!playing) smoothElapsedMs.value = elapsedMs.value;
    },
  );

  const currentItem = computed<Item | undefined>(() => {
    if ('cue' in state.value) return state.value.cue ?? undefined;
    if (['scripture','lyrics'].includes(contentStore.channels.find(c=>c.id===channelId.value)?.kind??'')) return undefined;
    const pl = contentStore.playlists.find((p) => p.id === state.value.playlistId);
    return pl?.items[state.value.index];
  });
  const currentPlaylistItems = computed<Item[]>(() => {
    const pl = contentStore.playlists.find((p) => p.id === state.value.playlistId);
    return pl?.items ?? [];
  });
  const livePrayerLabels = computed(() => computePrayerLabels(currentPlaylistItems.value));
  const currentPrayerLabel = computed(() =>
    currentItem.value ? livePrayerLabels.value[currentItem.value.id]?.display : undefined,
  );
  const settings = computed(() => contentStore.content.settings);
  const progress = computed(() =>
    state.value.durationMs > 0 ? Math.min(1, smoothElapsedMs.value / state.value.durationMs) : 0,
  );
  const showWarning = computed(
    () =>
      !state.value.blanked &&
      state.value.playing &&
      remainingMs.value > 0 &&
      remainingMs.value <= settings.value.warningAtMs &&
      remainingMs.value > settings.value.countdownAtMs,
  );
  const showCountdown = computed(
    () =>
      !state.value.blanked &&
      state.value.playing &&
      remainingMs.value > 0 &&
      remainingMs.value <= settings.value.countdownAtMs,
  );

  function resetState() {
    state.value = {
      channelId: '',
      playlistId: null,
      index: 0,
      mode: 'auto',
      playing: false,
      blanked: false,
      startedAt: null,
      durationMs: 0,
    };
    remainingMs.value = 0;
    elapsedMs.value = 0;
    smoothElapsedMs.value = 0;
  }

  const { send } = useBroadcast((msg: BroadcastMsg) => {
    // Apply state/tick ONLY for our exact channel — a channel-less frame (which
    // would route to the global topic) must never hijack this output.
    if ((msg.t === 'state' || msg.t === 'tick') && msg.channel !== channelId.value) return;
    if (msg.t === 'state') {
      state.value = msg.payload;
      if (!msg.payload.playing) {
        remainingMs.value = msg.payload.durationMs;
        elapsedMs.value = 0;
        recordSync(0);
      } else {
        recordSync(elapsedMs.value);
      }
    } else if (msg.t === 'tick') {
      remainingMs.value = msg.remainingMs;
      elapsedMs.value = msg.elapsedMs;
      recordSync(msg.elapsedMs);
    } else if (msg.t === 'content-updated') {
      void contentStore.load();
    } else if (msg.t === 'music') {
      musicPlaying.value = msg.playing;
    }
  });

  function subscribeChannel(id: string) {
    if (id) {
      subscribeTopics([id]);
      send({ t: 'hello', channel: id });
    }
  }

  watch(channelId, (id, prev) => {
    if (prev) unsubscribeTopics([prev]);
    // Clear the old slide immediately on a cut so no stale frame flashes until
    // the new channel's state arrives.
    resetState();
    subscribeChannel(id);
  });

  onMounted(async () => {
    rafHandle = requestAnimationFrame(runRaf);
    await contentStore.load();
    subscribeChannel(channelId.value);
  });
  onBeforeUnmount(() => {
    if (rafHandle != null) cancelAnimationFrame(rafHandle);
    if (channelId.value) unsubscribeTopics([channelId.value]);
  });

  return {
    state,
    remainingMs,
    elapsedMs,
    smoothElapsedMs,
    connection,
    reconnecting,
    currentItem,
    currentPrayerLabel,
    settings,
    progress,
    showWarning,
    showCountdown,
    musicPlaying,
  };
}
