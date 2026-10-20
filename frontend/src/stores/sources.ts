import { defineStore } from 'pinia';
import { computed, ref } from 'vue';
import { subscribeWs } from '@/lib/ws';
import type { BroadcastMsg } from '@/types';

// Runtime registry of live WebRTC sources (announced cameras/screens). These are
// EPHEMERAL — a phone that walks away shouldn't leave a dead source in
// content.json. The switcher merges these with the persisted channel sources.
export interface LiveWebrtcSource {
  publisherId: string;
  label: string;
  via: 'camera' | 'screen';
}

export const useSourcesStore = defineStore('sources', () => {
  const map = new Map<string, LiveWebrtcSource>();
  const version = ref(0);

  subscribeWs((msg: BroadcastMsg) => {
    if (msg.t === 'rtc-announce') {
      map.set(msg.publisherId, { publisherId: msg.publisherId, label: msg.label, via: msg.via });
      version.value++;
    } else if (msg.t === 'rtc-bye') {
      if (map.delete(msg.publisherId)) version.value++;
    }
  });

  const webrtcSources = computed<LiveWebrtcSource[]>(() => {
    version.value;
    return [...map.values()];
  });

  return { webrtcSources };
});
