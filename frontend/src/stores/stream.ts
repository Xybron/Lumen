import { defineStore } from 'pinia';
import { computed, ref } from 'vue';
import { subscribeWs } from '@/lib/ws';
import type { BroadcastMsg, EgressStatus } from '@/types';

// Live media-engine status, pushed as `mediastatus` frames (Express republishes
// the sidecar's state every 2s). Drives the dashboard ON-AIR indicator.
export const useStreamStore = defineStore('stream', () => {
  const egress = ref<EgressStatus[]>([]);
  const ingest = ref<Array<{ sourceId: string; connected: boolean }>>([]);

  subscribeWs((msg: BroadcastMsg) => {
    if (msg.t === 'mediastatus') {
      egress.value = msg.egress;
      ingest.value = msg.ingest;
    }
  });

  function stateFor(destinationId: string): EgressStatus['state'] {
    return egress.value.find((e) => e.destinationId === destinationId)?.state ?? 'idle';
  }
  function uptimeFor(destinationId: string): number {
    return egress.value.find((e) => e.destinationId === destinationId)?.uptimeSec ?? 0;
  }
  const anyLive = computed(() => egress.value.some((e) => e.state === 'live'));

  return { egress, ingest, stateFor, uptimeFor, anyLive };
});
