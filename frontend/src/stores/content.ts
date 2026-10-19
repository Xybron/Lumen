import { defineStore } from 'pinia';
import { computed, ref } from 'vue';
import { toast } from 'vue-sonner';
import { api } from '@/lib/api';
import { broadcast } from '@/lib/broadcast';
import { subscribeWs } from '@/lib/ws';
import { shortId } from '@/lib/ids';
import type { BroadcastMsg, Channel, ChannelKind, Content, Item, Playlist } from '@/types';

// Content is plain JSON by schema, but reactivity wraps it in Proxies that
// structuredClone can refuse to traverse. JSON round-trip is the simplest
// reliable deep-copy here.
function snapshotContent(c: Content): Content {
  return JSON.parse(JSON.stringify(c)) as Content;
}

const blank: Content = {
  version: 2,
  updatedAt: new Date().toISOString(),
  settings: {
    defaultDurationMs: 30000,
    warningAtMs: 300000,
    countdownAtMs: 10000,
    transitionMs: 600,
    fontFamily: 'Inter',
    globalFontScale: 1,
  },
  playlists: [],
  music: { mode: 'off', volume: 0.6, fadeInMs: 1500, fadeOutMs: 1500, queue: [] },
  channels: [],
  sources: [],
  destinations: [],
  routes: [],
  program: { programSourceId: null, previewSourceId: null },
};

export const useContentStore = defineStore('content', () => {
  const content = ref<Content>(snapshotContent(blank));
  const loading = ref(false);
  const activePlaylistId = ref<string | null>(null);
  const saving = ref(false);

  const playlists = computed(() => content.value.playlists);
  const channels = computed<Channel[]>(() => content.value.channels);
  const activePlaylist = computed<Playlist | null>(
    () => playlists.value.find((p) => p.id === activePlaylistId.value) ?? null,
  );

  // Resolve a channel's backing playlist. Channels reference playlists by id, so
  // this is the join the per-channel engines read their items through.
  function playlistForChannel(channelId: string): Playlist | null {
    const ch = channels.value.find((c) => c.id === channelId);
    if (!ch) return null;
    return playlists.value.find((p) => p.id === ch.playlistId) ?? null;
  }

  async function load() {
    loading.value = true;
    try {
      content.value = await api.getContent();
      if (!activePlaylistId.value && playlists.value.length > 0) {
        activePlaylistId.value = playlists.value[0].id;
      }
    } catch (e) {
      toast.error(`Couldn't load content: ${(e as Error).message}`);
    } finally {
      loading.value = false;
    }
  }

  // Optimistic save: mutate locally, then PUT. On failure, restore the snapshot.
  // Returns true on success so callers can branch (e.g. defer side effects).
  async function save(mutator: (draft: Content) => void): Promise<boolean> {
    const snapshot = snapshotContent(content.value);
    mutator(content.value);
    saving.value = true;
    try {
      content.value = await api.putContent(content.value);
      broadcast({ t: 'content-updated', updatedAt: content.value.updatedAt });
      return true;
    } catch (e) {
      content.value = snapshot;
      toast.error(`Save failed: ${(e as Error).message}`);
      return false;
    } finally {
      saving.value = false;
    }
  }

  function setActive(id: string) {
    if (playlists.value.find((p) => p.id === id)) activePlaylistId.value = id;
  }

  // Reload when the manifest changed elsewhere (a capture agent projecting
  // sources, or another operator/device) so the next optimistic save doesn't
  // clobber those writes. Our own save's content-updated is excluded by the
  // updatedAt match (and the relay never echoes a sender its own frame).
  subscribeWs((msg: BroadcastMsg) => {
    if (msg.t === 'content-updated' && !saving.value && msg.updatedAt !== content.value.updatedAt) {
      void load();
    }
  });

  async function addPlaylist(name: string) {
    const p: Playlist = { id: shortId('plst'), name, items: [] };
    await save((d) => {
      d.playlists.push(p);
    });
    activePlaylistId.value = p.id;
  }

  async function renamePlaylist(id: string, name: string) {
    await save((d) => {
      const p = d.playlists.find((x) => x.id === id);
      if (p) p.name = name;
    });
  }

  async function removePlaylist(id: string) {
    await save((d) => {
      d.playlists = d.playlists.filter((p) => p.id !== id);
    });
    if (activePlaylistId.value === id) {
      activePlaylistId.value = playlists.value[0]?.id ?? null;
    }
  }

  // ── Channels ────────────────────────────────────────────────────────────
  // A channel is a presentation lane backed by its own playlist. Creating one
  // adds the playlist, the channel, and its routing-matrix source together.
  async function addChannel(name: string, kind: ChannelKind = 'presentation') {
    const playlistId = shortId('plst');
    const channelId = shortId('chnl');
    const saved = await save((d) => {
      d.playlists.push({ id: playlistId, name, items: [] });
      d.channels.push({ id: channelId, name, kind, playlistId, defaultMode: ['scripture','lyrics'].includes(kind)?'manual':'auto' });
      d.sources.push({ id: shortId('src'), kind: 'channel', ref: channelId });
    });
    if (!saved) throw new Error('Channel could not be saved.');
    activePlaylistId.value = playlistId;
    return { channelId, playlistId };
  }

  // An explicit operator action upgrades a legacy playlist into a presentation
  // channel without copying/removing any slides or starting automatic playback.
  async function createChannelForPlaylist(playlistId: string) {
    const existing = channels.value.find(channel => channel.playlistId === playlistId);
    if (existing) return { channelId: existing.id, playlistId };
    const playlist = playlists.value.find(item => item.id === playlistId);
    if (!playlist) throw new Error('This playlist is no longer available.');
    const channelId = shortId('chnl');
    const saved = await save(draft => {
      draft.channels.push({ id: channelId, name: playlist.name, kind: 'presentation', playlistId, defaultMode: 'manual' });
      draft.sources.push({ id: shortId('src'), kind: 'channel', ref: channelId });
    });
    if (!saved) throw new Error('Presentation channel could not be created.');
    activePlaylistId.value = playlistId;
    return { channelId, playlistId };
  }

  async function renameChannel(channelId: string, name: string) {
    await save((d) => {
      const ch = d.channels.find((c) => c.id === channelId);
      if (!ch) return;
      ch.name = name;
      // Keep the backing playlist's name in step so the editor header matches.
      const pl = d.playlists.find((p) => p.id === ch.playlistId);
      if (pl) pl.name = name;
    });
  }

  async function removeChannel(channelId: string) {
    const ch = channels.value.find((c) => c.id === channelId);
    if (!ch) return;
    const playlistId = ch.playlistId;
    await save((d) => {
      d.channels = d.channels.filter((c) => c.id !== channelId);
      d.playlists = d.playlists.filter((p) => p.id !== playlistId);
      d.sources = d.sources.filter((s) => !(s.kind === 'channel' && s.ref === channelId));
      const srcIds = new Set(d.sources.map((s) => s.id));
      d.routes = d.routes.filter((r) => srcIds.has(r.sourceId));
      // Clear a Program/Preview selection that pointed at a removed source.
      if (d.program.programSourceId && !srcIds.has(d.program.programSourceId)) d.program.programSourceId = null;
      if (d.program.previewSourceId && !srcIds.has(d.program.previewSourceId)) d.program.previewSourceId = null;
    });
    if (activePlaylistId.value === playlistId) {
      activePlaylistId.value = playlists.value[0]?.id ?? null;
    }
  }

  async function addItem(playlistId: string, item: Partial<Item>) {
    const next: Item = {
      id: shortId('itm'),
      type: 'scripture',
      title: '',
      body: '',
      reference: '',
      durationMs: content.value.settings.defaultDurationMs,
      typography: { size: 'lg', align: 'center', weight: 500 },
      ...item,
    };
    await save((d) => {
      d.playlists.find((p) => p.id === playlistId)?.items.push(next);
    });
  }

  async function updateItem(playlistId: string, itemId: string, patch: Partial<Item>) {
    await save((d) => {
      const p = d.playlists.find((x) => x.id === playlistId);
      if (!p) return;
      const i = p.items.findIndex((x) => x.id === itemId);
      if (i >= 0) p.items[i] = { ...p.items[i], ...patch };
    });
  }

  async function removeItem(playlistId: string, itemId: string) {
    await save((d) => {
      const p = d.playlists.find((x) => x.id === playlistId);
      if (!p) return;
      p.items = p.items.filter((x) => x.id !== itemId);
    });
  }

  async function duplicateItem(playlistId: string, itemId: string) {
    await save((d) => {
      const p = d.playlists.find((x) => x.id === playlistId);
      if (!p) return;
      const i = p.items.findIndex((x) => x.id === itemId);
      if (i < 0) return;
      const copy: Item = { ...JSON.parse(JSON.stringify(p.items[i])) as Item, id: shortId('itm') };
      p.items.splice(i + 1, 0, copy);
    });
  }

  async function reorderItems(playlistId: string, fromIdx: number, toIdx: number) {
    return await save((d) => {
      const p = d.playlists.find((x) => x.id === playlistId);
      if (!p) return;
      const [moved] = p.items.splice(fromIdx, 1);
      if (moved) p.items.splice(toIdx, 0, moved);
    });
  }

  async function updateMusic(patch: Partial<Content['music']>) {
    await save((d) => {
      d.music = { ...d.music, ...patch };
    });
  }

  async function updateSettings(patch: Partial<Content['settings']>) {
    await save((d) => {
      d.settings = { ...d.settings, ...patch };
    });
  }

  return {
    content,
    loading,
    saving,
    playlists,
    channels,
    activePlaylist,
    activePlaylistId,
    playlistForChannel,
    load,
    save,
    setActive,
    addPlaylist,
    renamePlaylist,
    removePlaylist,
    addChannel,
    createChannelForPlaylist,
    renameChannel,
    removeChannel,
    addItem,
    updateItem,
    removeItem,
    duplicateItem,
    reorderItems,
    updateMusic,
    updateSettings,
  };
});
