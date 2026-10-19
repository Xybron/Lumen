<script setup lang="ts">
import { ref, watch } from 'vue';
import { Cpu, Plus, Trash2, Copy, Check } from 'lucide-vue-next';
import { toast } from 'vue-sonner';
import { Dialog, DialogContent, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { Button } from '@/components/ui/button';
import { useAgentsStore } from '@/stores/agents';
import { useIdentityStore } from '@/stores/identity';
import { useConfirmation } from '@/composables/useConfirmation';

const props = defineProps<{ open: boolean }>();
const emit = defineEmits<{ (e: 'update:open', v: boolean): void }>();

const agentsStore = useAgentsStore();
const identity = useIdentityStore();
const { confirmAction } = useConfirmation();

watch(() => props.open, (open) => { if (open) void agentsStore.refresh(); });

// new-agent flow: name → token shown once
const newName = ref('');
const created = ref<{ agentId: string; token: string } | null>(null);
const copied = ref(false);

async function addAgent() {
  const name = newName.value.trim() || 'Capture Agent';
  try {
    created.value = await agentsStore.create(name);
    newName.value = '';
    await agentsStore.refresh();
  } catch (e) {
    toast.error(`Create failed: ${(e as Error).message}`);
  }
}
async function copyConfig() {
  if (!created.value) return;
  const cfg = `LUMEN_AGENT_ID=${created.value.agentId}\nLUMEN_AGENT_TOKEN=${created.value.token}`;
  try {
    await navigator.clipboard.writeText(cfg);
    copied.value = true;
    setTimeout(() => (copied.value = false), 1500);
  } catch {
    /* clipboard blocked */
  }
}
async function removeAgent(id: string) {
  const agent = agentsStore.agents.find(item => item.agentId === id);
  if (!agent || !identity.me?.isAdmin) return;
  const name = agent.name;
  if (!await confirmAction({
    title: 'Remove capture agent?',
    description: `“${name}” and its capture sources will be removed from this station.`,
    confirmLabel: 'Remove agent',
    tone: 'danger',
  })) return;
  if (!props.open || !identity.me?.isAdmin || !agentsStore.agents.some(item => item.agentId === id)) return;
  try {
    await agentsStore.remove(id);
  } catch (e) {
    toast.error(`Remove failed: ${(e as Error).message}`);
  }
}

function dot(status: string) {
  return status === 'online' ? 'bg-emerald-400' : status === 'degraded' ? 'bg-amber-400' : 'bg-white/25';
}
function inputDot(state?: string) {
  return state === 'streaming' ? 'bg-emerald-400' : state === 'no-signal' ? 'bg-amber-400/80' : state === 'error' ? 'bg-red-400' : 'bg-white/25';
}
</script>

<template>
  <Dialog :open="open" @update:open="emit('update:open', $event)">
    <DialogContent class="sm:max-w-lg">
      <DialogHeader>
        <DialogTitle class="flex items-center gap-2">
          <Cpu :size="16" class="text-accent" /> Capture agents
          <span v-if="agentsStore.onlineCount" class="text-xs text-emerald-400">{{ agentsStore.onlineCount }} online</span>
        </DialogTitle>
      </DialogHeader>

      <div class="flex flex-col gap-3 max-h-[60vh] overflow-y-auto -mx-1 px-1">
        <!-- new agent token reveal -->
        <div v-if="created" class="panel-soft p-3 border border-accent/30">
          <div class="text-xs text-accent font-medium mb-1">Agent created — copy this config now (shown once)</div>
          <pre class="text-[11px] text-white/80 bg-black/40 rounded-lg p-2 overflow-x-auto">LUMEN_AGENT_ID={{ created.agentId }}
LUMEN_AGENT_TOKEN={{ created.token }}</pre>
          <div class="flex gap-2 mt-2">
            <Button variant="accent" size="md" @click="copyConfig">
              <component :is="copied ? Check : Copy" :size="13" /> {{ copied ? 'Copied' : 'Copy' }}
            </Button>
            <Button variant="ghost" size="md" @click="created = null">Done</Button>
          </div>
        </div>

        <!-- create form -->
        <form class="flex items-center gap-2" @submit.prevent="addAgent">
          <input
            v-model="newName"
            placeholder="Agent name (e.g. Stage Rack)"
            class="flex-1 h-9 rounded-lg bg-white/[0.05] border border-hair px-2.5 text-sm text-white outline-none focus:border-accent/60"
          />
          <Button type="submit" variant="default" size="md"><Plus :size="13" /> Add agent</Button>
        </form>

        <!-- roster -->
        <ul class="flex flex-col gap-2">
          <li v-for="a in agentsStore.agents" :key="a.agentId" class="panel-soft p-3 flex flex-col gap-2">
            <div class="flex items-center gap-2">
              <span class="h-2 w-2 rounded-full" :class="dot(a.status)" />
              <div class="flex-1 min-w-0">
                <div class="text-sm font-medium text-white truncate">{{ a.name }}</div>
                <div class="text-[11px] text-white/40">{{ a.status }} · {{ a.inputs.length }} input(s)</div>
              </div>
              <button :aria-label="`Remove ${a.name}`" class="h-7 w-7 rounded-lg flex items-center justify-center text-white/45 hover:text-red-300 hover:bg-red-500/15" @click="removeAgent(a.agentId)">
                <Trash2 :size="13" />
              </button>
            </div>
            <div v-if="a.inputs.length" class="flex flex-wrap gap-1.5 pl-4">
              <span v-for="i in a.inputs" :key="i.inputId" class="text-[11px] px-2 py-0.5 rounded-full bg-white/[0.06] border border-hair flex items-center gap-1.5">
                <span class="h-1.5 w-1.5 rounded-full" :class="inputDot(i.state)" />
                {{ i.label }} <span class="text-white/35 uppercase">{{ i.signal }}</span>
              </span>
            </div>
          </li>
          <li v-if="agentsStore.agents.length === 0" class="text-sm text-white/40 py-4 text-center">
            No agents yet. Add one, then run the agent process with the shown credentials.
          </li>
        </ul>
      </div>
    </DialogContent>
  </Dialog>
</template>
