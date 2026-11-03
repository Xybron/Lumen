import { computed, onBeforeUnmount, onMounted, ref, watch, type Ref } from 'vue';
import { useContentStore } from '@/stores/content';
import { useBroadcast, subscribeTopics, unsubscribeTopics } from '@/lib/broadcast';
import { useConnection } from '@/lib/ws';
import { computePrayerLabels } from '@/lib/prayers';
import type { BroadcastMsg, Item, ProjectionState } from '@/types';

// Mirrors ONE channel's projection state for a read-only output surface (the Live
// view and the destination Output view). Subscribes to the channel topic,
// applies station timing samples, and follows a reactive channelId so
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
  // Local receipt time aligns the progress animation with the sender without
  // assuming the two browsing contexts share a performance.now() origin.
  const clock = ref({ elapsedMs: 0, receivedAt: performance.now() });
  const musicPlaying = ref(false);

  const connection = useConnection();
  const reconnecting = computed(() => connection.value !== 'online');

  function recordSync(elapsedMs: number) {
    clock.value = { elapsedMs, receivedAt: performance.now() };
  }

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
    recordSync(0);
  }

  const { send } = useBroadcast((msg: BroadcastMsg) => {
    // Apply state/tick ONLY for our exact channel — a channel-less frame (which
    // would route to the global topic) must never hijack this output.
    if ((msg.t === 'state' || msg.t === 'tick') && msg.channel !== channelId.value) return;
    if (msg.t === 'state') {
      const previous = state.value;
      const sameItem = previous.index === msg.payload.index && previous.playlistId === msg.payload.playlistId;
      const elapsed = sameItem && msg.payload.mode === 'auto' ? clock.value.elapsedMs : 0;
      state.value = msg.payload;
      if (!msg.payload.playing) {
        remainingMs.value = Math.max(0, msg.payload.durationMs - elapsed);
        recordSync(elapsed);
      } else if (!previous.playing || !sameItem) {
        recordSync(elapsed);
      }
    } else if (msg.t === 'tick') {
      remainingMs.value = msg.remainingMs;
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
  }, { immediate: true });

  // Topic ownership is synchronous, independently of when the playlist load
  // finishes. Navigating away during that load cannot leave a stale subscription.
  onMounted(() => { void contentStore.load(); });
  onBeforeUnmount(() => {
    if (channelId.value) unsubscribeTopics([channelId.value]);
  });

  return {
    state,
    remainingMs,
    clock,
    connection,
    reconnecting,
    currentItem,
    currentPrayerLabel,
    settings,
    showWarning,
    showCountdown,
    musicPlaying,
  };
}
