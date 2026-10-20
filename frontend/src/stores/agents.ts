import { defineStore } from 'pinia';
import { computed, ref } from 'vue';
import { subscribeWs } from '@/lib/ws';
import { api } from '@/lib/api';
import type { AgentSnapshot, BroadcastMsg } from '@/types';

// Live capture-agent roster. The station broadcasts a distilled `{t:'agents'}`
// snapshot (replay-cached) on every register/heartbeat/leave, so health flaps in
// real time without touching content.json.
export const useAgentsStore = defineStore('agents', () => {
  const agents = ref<AgentSnapshot[]>([]);

  subscribeWs((msg: BroadcastMsg) => {
    if (msg.t === 'agents') agents.value = msg.agents;
  });

  const onlineCount = computed(() => agents.value.filter((a) => a.status !== 'offline').length);

  async function refresh() {
    try {
      agents.value = (await api.listAgents()).agents;
    } catch {
      /* not admin / offline */
    }
  }
  async function create(name: string) {
    return api.createAgent(name);
  }
  async function remove(id: string) {
    await api.deleteAgent(id);
    agents.value = agents.value.filter((a) => a.agentId !== id);
  }

  return { agents, onlineCount, refresh, create, remove };
});
