import { defineStore } from 'pinia';
import { computed, ref, watch } from 'vue';
import { broadcast } from '@/lib/broadcast';
import { subscribeWs } from '@/lib/ws';
import { createPlaybackEngine, type PlaybackEngine } from '@/lib/engine';
import type { BroadcastMsg } from '@/types';
import { useContentStore } from './content';
import { useMusicStore } from './music';

// The registry owns one always-running PlaybackEngine per channel and tracks
// which one the operator is focused on. Engines broadcast their own state; this
// store only orchestrates the cross-cutting concerns: keeping the engine set in
// sync with content.channels, answering `hello` from freshly-joined Live views,
// and mirroring the (global) music state.
export const useEnginesStore = defineStore('engines', () => {
  const content = useContentStore();

  // Plain Map (not reactive) so engine objects aren't deep-proxied — their own
  // refs drive template reactivity. `version` bumps when the engine SET changes.
  const registry = new Map<string, PlaybackEngine>();
  const version = ref(0);
  const focusedChannelId = ref<string | null>(null);

  function engineFor(id: string): PlaybackEngine | null {
    version.value; // track the set so computeds calling this re-run on add/remove
    return registry.get(id) ?? null;
  }

  const focused = computed<PlaybackEngine | null>(() => {
    version.value; // re-evaluate when the set changes
    return focusedChannelId.value ? registry.get(focusedChannelId.value) ?? null : null;
  });

  const allEngines = computed<PlaybackEngine[]>(() => {
    version.value;
    return [...registry.values()];
  });

  // Set focus by channel id. Tolerates an engine that hasn't been created yet
  // (e.g. a channel added moments ago) — the `focused` computed resolves once
  // the registry watch instantiates it.
  function setFocus(id: string) {
    if (id) focusedChannelId.value = id;
  }

  // Focus a channel AND point the editor's active playlist at it, so the
  // authoring surface (which reads content.activePlaylist) follows the operator.
  function focusChannel(id: string) {
    const ch = content.channels.find((c) => c.id === id);
    if (!ch) return;
    setFocus(id);
    content.setActive(ch.playlistId);
  }

  function syncEngines() {
    const channels = content.channels;
    const ids = new Set(channels.map((c) => c.id));
    let changed = false;

    for (const c of channels) {
      if (!registry.has(c.id)) {
        registry.set(c.id, createPlaybackEngine(c.id, { defaultMode: ['scripture','lyrics'].includes(c.kind)?'manual':c.defaultMode, external:['scripture','lyrics'].includes(c.kind) }));
        changed = true;
      }
    }
    for (const id of [...registry.keys()]) {
      if (!ids.has(id)) {
        registry.get(id)!.dispose();
        registry.delete(id);
        changed = true;
      }
    }
    if (!focusedChannelId.value || !ids.has(focusedChannelId.value)) {
      focusedChannelId.value = channels[0]?.id ?? null;
      changed = true;
    }
    if (changed) version.value++;
  }

  // Track the channel id LIST (not deep content) so engines are added/removed
  // only when channels appear/disappear — not on every slide edit.
  watch(() => content.channels.map((c) => c.id).join('|'), syncEngines, { immediate: true });

  // Answer hello with the relevant engine's current state so a joining Live view
  // syncs immediately (the WS relay also caches state per channel as a fallback).
  function handleIncoming(msg: BroadcastMsg) {
    if (msg.t==='state' && msg.channel && 'cue' in msg.payload) engineFor(msg.channel)?.applyExternal(msg.payload);
    if (msg.t !== 'hello') return;
    if (msg.channel) engineFor(msg.channel)?.sendState();
    else for (const e of registry.values()) e.sendState();
  }
  const bcSupported = typeof BroadcastChannel !== 'undefined';
  const bc = bcSupported ? new BroadcastChannel('lumen-state') : null;
  if (bc) bc.onmessage = (e: MessageEvent<BroadcastMsg>) => handleIncoming(e.data);
  subscribeWs(handleIncoming);

  // Music is global (one station, one audio bed) — mirror it to every Live view.
  const music = useMusicStore();
  watch(
    () => [music.playing, music.currentTrack] as const,
    ([playing, track]) => broadcast({ t: 'music', current: track ?? null, playing }),
    { immediate: true },
  );

  return { focusedChannelId, focused, allEngines, engineFor, setFocus, focusChannel };
});
