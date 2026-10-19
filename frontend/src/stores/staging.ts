import { defineStore } from 'pinia';
import { computed, ref } from 'vue';
import { toast } from 'vue-sonner';
import { subscribeWs } from '@/lib/ws';
import { mediaApi, type StagingItem } from '@/lib/api';
import type { BroadcastMsg } from '@/types';
import { useIdentityStore } from './identity';

// Tracks pending phone/contributor uploads. The `media-added` relay frame
// notifies operators in real time; the authoritative list comes from
// GET /api/staging (fetched on the signal and when the approval dialog opens).
export const useStagingStore = defineStore('staging', () => {
  const identity = useIdentityStore();
  const pending = ref<StagingItem[]>([]);

  async function refresh() {
    if (!identity.isAuthenticated) return;
    try {
      pending.value = (await mediaApi.listStaging()).pending;
    } catch {
      /* not signed in / offline — leave as-is */
    }
  }

  subscribeWs((msg: BroadcastMsg) => {
    if (msg.t === 'media-added') {
      toast(`New media from ${msg.contributor ?? 'a contributor'} awaiting approval`);
      void refresh();
    }
  });

  async function approve(id: string) {
    await mediaApi.approveStaging(id);
    pending.value = pending.value.filter((p) => p.id !== id);
  }
  async function reject(id: string) {
    await mediaApi.rejectStaging(id);
    pending.value = pending.value.filter((p) => p.id !== id);
  }

  const count = computed(() => pending.value.length);
  return { pending, count, refresh, approve, reject };
});
