import { defineStore } from 'pinia';
import { computed, ref } from 'vue';
import { sendWs, subscribeWs } from '@/lib/ws';
import type { BroadcastMsg, PresenceEntry } from '@/types';
import { useIdentityStore } from './identity';

// Tracks who's online and who controls each channel. The station relay is the
// source of truth (it broadcasts presence on every join/leave/claim/takeover);
// this store just mirrors it and sends claim/takeover intents.
export const usePresenceStore = defineStore('presence', () => {
  const identity = useIdentityStore();

  const online = ref<PresenceEntry[]>([]);
  const owners = ref<Record<string, string>>({});

  subscribeWs((msg: BroadcastMsg) => {
    if (msg.t === 'presence') {
      online.value = msg.online;
      owners.value = msg.owners;
    }
  });

  function controllerOf(channelId: string): string | null {
    return owners.value[channelId] ?? null;
  }

  function userName(userId: string | null): string | null {
    if (!userId) return null;
    if (userId === identity.me?.id) return identity.me.displayName;
    return online.value.find((u) => u.userId === userId)?.displayName ?? null;
  }

  // A channel is mine to drive if it's unowned or I'm the owner.
  function isMine(channelId: string): boolean {
    const c = controllerOf(channelId);
    return c == null || c === identity.me?.id;
  }

  function controlledByOther(channelId: string): boolean {
    const c = controllerOf(channelId);
    return c != null && c !== identity.me?.id;
  }

  function claim(channelId: string) {
    if (channelId) sendWs({ t: 'claim', channel: channelId, userId: identity.me?.id ?? '' });
  }
  function takeover(channelId: string) {
    if (channelId) sendWs({ t: 'takeover', channel: channelId, userId: identity.me?.id ?? '' });
  }

  const onlineCount = computed(() => online.value.length);

  return {
    online,
    owners,
    onlineCount,
    controllerOf,
    userName,
    isMine,
    controlledByOther,
    claim,
    takeover,
  };
});
