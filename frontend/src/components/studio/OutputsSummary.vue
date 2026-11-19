<script setup lang="ts">
import { computed, onActivated, onBeforeUnmount, onDeactivated, onMounted, ref, watch } from 'vue';
import { Monitor, Link2, Volume2, VolumeX } from 'lucide-vue-next';
import { useOutputsStore } from '@/stores/outputs';
import { useIdentityStore } from '@/stores/identity';
import { studioRequest } from '@/lib/studio/api';
import type { StudioOutput } from '../../../../shared/production';
withDefaults(defineProps<{ outputs: StudioOutput[]; engineRunning?: boolean; programSelected?: boolean }>(), { programSelected: false });
const ui = useOutputsStore(), identity = useIdentityStore(), viewers = ref<Record<string, number>>({});
let timer: ReturnType<typeof setInterval> | undefined, active = false, generation = 0;
let request: AbortController | null = null;
const allowed = computed(() => identity.isAuthenticated && identity.can('*', 'author'));
function canRead() { return active && document.visibilityState === 'visible' && allowed.value; }
const displayNames = computed<Record<string, string>>(() => {
  void ui.revision;
  try {
    const values = JSON.parse(localStorage.getItem('lumen.output.displays') || '{}');
    return Object.fromEntries(Object.entries(values).filter((entry): entry is [string, { label: string }] => !!entry[1] && typeof entry[1] === 'object' && typeof (entry[1] as { label?: unknown }).label === 'string').map(([id, value]) => [id, value.label]));
  } catch { return {}; }
});
async function refresh() {
  if (!canRead() || request) return;
  const controller = new AbortController(), current = generation, operator = identity.me?.id;
  request = controller;
  const valid = () => canRead() && current === generation && operator === identity.me?.id && !controller.signal.aborted;
  try {
    const status = await studioRequest<{ links: { outputId: string; viewers: number }[] }>('/output-delivery', { signal: controller.signal });
    if (valid()) viewers.value = Object.fromEntries(status.links.filter(link => Number.isFinite(link.viewers)).map(link => [link.outputId, Math.max(0, link.viewers)]));
  } catch { if (valid()) viewers.value = {}; }
  finally { if (request === controller) request = null; }
}
function suspend() { generation++; clearInterval(timer); request?.abort(); request = null; viewers.value = {}; }
function synchronize() { suspend(); if (canRead()) { void refresh(); timer = setInterval(() => void refresh(), 5000); } }
function start() { active = true; synchronize(); }
function stop() { active = false; suspend(); }
onMounted(() => { document.addEventListener('visibilitychange', synchronize); start(); });
onActivated(start); onDeactivated(stop);
onBeforeUnmount(() => { document.removeEventListener('visibilitychange', synchronize); stop(); });
watch([() => identity.me?.id, allowed], synchronize);
watch(() => ui.revision, () => void refresh());
</script>

<template>
  <section class="outputs-summary" aria-label="Output destinations" data-testid="outputs-summary">
    <div class="outputs-summary-heading"><h2><Monitor :size="14" />Destinations</h2><span>Configure in Outputs</span></div>
    <div class="outputs-summary-list">
      <div class="destination-status"><Monitor :size="14" /><div><b>Program</b><span>{{ displayNames.program || 'Screen / Lumen Share' }}</span></div><span class="destination-route">{{ !programSelected ? 'No Program selected' : engineRunning ? 'Program running' : 'Program stopped' }}</span><span class="destination-viewers" v-if="viewers.program"><Link2 :size="12" />{{ viewers.program }} viewing</span></div>
      <div v-for="output in outputs" :key="output.id" class="destination-status"><Monitor :size="14" /><div><b>{{ output.name }}</b><span>{{ displayNames[output.id] || 'No display assigned' }}</span></div><span class="destination-route">{{ output.blanked ? 'Picture blanked' : output.mode === 'program' ? 'Follows Program' : 'Pinned · ' + (output.scene?.name || 'Scene') }}</span><span class="destination-viewers" v-if="viewers[output.id]"><Link2 :size="12" />{{ viewers[output.id] }} viewing</span><span class="destination-audio"><Volume2 v-if="output.audioEnabled" :size="12" /><VolumeX v-else :size="12" />{{ output.audioEnabled ? 'Audio on' : 'Muted' }}</span></div>
    </div>
  </section>
</template>

<style scoped>
.outputs-summary{margin-top:18px;padding-top:16px;border-top:1px solid var(--border-hair)}
.outputs-summary-heading{display:flex;align-items:center;justify-content:space-between;gap:12px;margin-bottom:8px}.outputs-summary-heading h2{display:flex;align-items:center;gap:7px;font-size:12px;font-weight:500;color:var(--text-primary)}.outputs-summary-heading>span{font-size:11px;color:var(--text-muted)}
.outputs-summary-list{display:grid;gap:0}.destination-status{display:flex;align-items:center;gap:10px;padding:10px 0;border-bottom:1px solid var(--border-hair);color:var(--text-muted);font-size:11px;min-width:0}.destination-status:last-child{border-bottom:0}.destination-status>svg{flex-shrink:0}.destination-status>div{display:grid;gap:3px;min-width:90px;flex:1}.destination-status b{color:var(--text-primary);font-size:12px;font-weight:500;overflow-wrap:anywhere}.destination-status>div>span{overflow-wrap:anywhere}.destination-route{max-width:40%;overflow-wrap:anywhere}.destination-viewers,.destination-audio{display:inline-flex;align-items:center;gap:5px;white-space:nowrap}.destination-viewers{color:var(--text-primary)}
@media(max-width:600px){.destination-status{flex-wrap:wrap;gap:8px}.destination-route{max-width:55%;text-align:right}.destination-audio,.destination-viewers{font-size:10px}.outputs-summary-heading>span{font-size:10px}}
</style>
