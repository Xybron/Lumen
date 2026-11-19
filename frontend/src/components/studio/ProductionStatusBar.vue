<script setup lang="ts">
import { computed, onActivated, onBeforeUnmount, onDeactivated, onMounted, ref, watch } from 'vue';
import { Check, CircleAlert, EthernetPort, LoaderCircle, MemoryStick } from 'lucide-vue-next';
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover';
import ProgramHealth from './ProgramHealth.vue';
import { useStudioStore } from '@/stores/studio';
import { useBroadcastStore } from '@/stores/broadcast';
import { useIdentityStore } from '@/stores/identity';
import { useConnection } from '@/lib/ws';
import { desktopProduction, liveStatus, memoryLabel, recordingStatus, type DesktopMemoryReading } from '@/lib/studio/production-status';

const studio = useStudioStore(), broadcast = useBroadcastStore(), identity = useIdentityStore();
const connection = useConnection(), now = ref(Date.now());
const active = ref(false), visible = ref(!document.hidden), memory = ref<DesktopMemoryReading | null>(null);
const networkOpen = ref(false), memoryOpen = ref(false);
const canRead = computed(() => identity.ready && identity.isAuthenticated && identity.can('*', 'author'));
const monitoring = computed(() => active.value && visible.value && canRead.value);
const native = desktopProduction();
const engineRunning = computed(() => studio.status.state === 'running');
const engineLabel = computed(() => connection.value !== 'online' ? 'Engine status unknown' : studio.loading ? 'Checking engine'
  : engineRunning.value ? 'Engine running' : studio.status.state === 'starting' ? 'Engine starting'
  : studio.status.state === 'error' ? 'Engine unavailable' : 'Engine stopped');
const fps = computed(() => connection.value === 'online' && engineRunning.value && Number.isFinite(studio.status.fps)
  ? `${Math.max(0, Math.round(studio.status.fps * 10) / 10)} fps` : '— fps');
const saved = computed(() => studio.saving ? 'Saving…' : connection.value !== 'online' ? 'Waiting for station'
  : studio.loading || !studio.state ? 'Loading…' : 'All changes saved');
const recording = computed(() => recordingStatus(studio.status.recording, now.value));
const live = computed(() => liveStatus(broadcast.snapshot?.session, now.value, broadcast.busy === 'start'));
const liveText = computed(() => !broadcast.snapshot && (broadcast.loading || studio.status.broadcast?.state === 'live') ? 'Checking' : live.value.text);
const memoryText = computed(() => memoryLabel(memory.value));
const destinations = computed(() => {
  const session = broadcast.snapshot?.session;
  return session ? [...session.destinations, session.watch].filter(sink => !['disabled', 'unconfigured'].includes(sink.state)) : [];
});
const destinationNames = { youtube: 'YouTube', facebook: 'Facebook', instagram: 'Instagram', watch: 'Lumen Watch' };
const destinationStates = { live: 'Sending', connecting: 'Connecting', retrying: 'Reconnecting', stopped: 'Stopped', error: 'Interrupted', disabled: 'Off', unconfigured: 'Off' };
const stationLabel = computed(() => connection.value === 'online' ? 'Connected' : connection.value === 'connecting' ? 'Connecting' : 'Offline');
const streamUnknown = computed(() => broadcast.notice?.key.endsWith('/unreachable') === true);
const networkLabel = computed(() => connection.value !== 'online' ? stationLabel.value
  : streamUnknown.value ? 'Unknown' : broadcast.notice?.tone === 'danger' ? 'Attention' : broadcast.active && destinations.value.some(sink => sink.state === 'error') ? 'Attention'
  : broadcast.active && destinations.value.some(sink => sink.state === 'retrying') ? 'Reconnecting' : 'Connected');
const networkWarning = computed(() => connection.value !== 'online' || ['Unknown', 'Attention', 'Reconnecting'].includes(networkLabel.value));

let generation = 0, clock: ReturnType<typeof setInterval> | undefined, poll: ReturnType<typeof setTimeout> | undefined;
let detachBroadcast: (() => void) | undefined;
function stop() {
  generation++; clearInterval(clock); clearTimeout(poll); clock = poll = undefined;
  detachBroadcast?.(); detachBroadcast = undefined;
  networkOpen.value = memoryOpen.value = false;
}
async function readMemory(token: number) {
  if (!native || !monitoring.value || token !== generation) return;
  try {
    const reading = await native.memory();
    if (token === generation && monitoring.value) memory.value = reading;
  } catch { if (token === generation) memory.value = null; }
  finally { if (token === generation && monitoring.value) poll = setTimeout(() => { void readMemory(token); }, 5000); }
}
watch([monitoring, () => identity.me?.id], ([enabled]) => {
  stop(); memory.value = null;
  if (!enabled) return;
  now.value = Date.now(); clock = setInterval(() => { now.value = Date.now(); }, 1000);
  detachBroadcast = broadcast.attach();
  void readMemory(generation);
}, { immediate: true });
function visibility() { visible.value = !document.hidden; }
onMounted(() => { active.value = true; document.addEventListener('visibilitychange', visibility); });
onActivated(() => { active.value = true; visible.value = !document.hidden; });
onDeactivated(() => { active.value = false; });
onBeforeUnmount(() => { stop(); document.removeEventListener('visibilitychange', visibility); });
</script>

<template>
  <footer class="production-statusbar" aria-label="Production status" data-testid="production-statusbar">
    <span class="production-save-status"><LoaderCircle v-if="studio.saving || studio.loading" :size="12" class="status-loading" /><Check v-else-if="connection === 'online'" :size="12" /><CircleAlert v-else :size="12" />{{ saved }}</span>
    <div class="production-health-status">
      <ProgramHealth><template #trigger><button type="button" class="production-status-item" aria-label="Program health" data-testid="program-engine-status"><span class="production-dot" :class="{ running: engineRunning && connection === 'online', fault: studio.status.state === 'error' }" /><span>{{ engineLabel }}</span><span class="production-metric" data-testid="program-fps">{{ fps }}</span></button></template></ProgramHealth>
      <Popover v-model:open="networkOpen"><PopoverTrigger as-child><button type="button" class="production-status-item" aria-label="Network connection status" :class="{ warning: networkWarning }"><EthernetPort :size="13" /><span>Network</span><span class="production-metric">{{ networkLabel }}</span></button></PopoverTrigger><PopoverContent side="top" align="center" class="production-status-popover">
        <h3>Connection health</h3><dl><div><dt>Local station</dt><dd>{{ stationLabel }}</dd></div><div v-for="sink in destinations" :key="sink.id"><dt>{{ destinationNames[sink.id] }}</dt><dd>{{ streamUnknown ? 'Status unknown' : destinationStates[sink.state] }}<small v-if="sink.retries && !streamUnknown"> · {{ sink.retries }} retries</small></dd></div></dl><p>Reports the station connection and stream destinations. Wi-Fi signal strength is not measured.</p>
      </PopoverContent></Popover>
      <Popover v-model:open="memoryOpen"><PopoverTrigger as-child><button type="button" class="production-status-item" aria-label="Lumen memory usage"><MemoryStick :size="13" /><span>Lumen RAM</span><span class="production-metric" data-testid="memory-usage">{{ memoryText }}</span></button></PopoverTrigger><PopoverContent side="top" align="center" class="production-status-popover">
        <h3>Lumen memory</h3><dl><div><dt>Desktop memory</dt><dd>{{ memoryText }}</dd></div><div v-if="memory?.available"><dt>Desktop processes</dt><dd>{{ memory.processes }}</dd></div></dl><p v-if="native">Resident memory reported for Lumen’s desktop processes. Shared pages may be counted more than once. Separate production and backend services are excluded.</p><p v-else>Desktop memory readings are available in the Lumen desktop app. This browser does not expose Lumen’s process memory.</p>
      </PopoverContent></Popover>
    </div>
    <div class="production-session-status">
      <span class="production-session" :class="{ recording: recording.active && connection === 'online', warning: recording.warning }" aria-label="Recording status"><span class="production-dot" /><span class="production-session-label">REC</span><time data-testid="recording-elapsed">{{ connection === 'online' ? recording.text : 'Unknown' }}</time></span>
      <span class="production-session" :class="{ live: live.active && !streamUnknown, warning: live.warning || streamUnknown }" aria-label="Live status"><span class="production-dot" /><span class="production-session-label">LIVE</span><time data-testid="live-elapsed">{{ streamUnknown ? 'Unknown' : liveText }}</time></span>
    </div>
  </footer>
</template>

<style scoped>
.production-statusbar{grid-column:1/-1;grid-row:3;display:grid;grid-template-columns:auto minmax(0,1fr) auto;align-items:center;gap:18px;min-height:42px;padding:9px 17px;border-top:1px solid var(--border-hair);background:var(--surface-1);color:var(--text-muted);font-size:11px;flex-shrink:0;min-width:0}
.production-save-status,.production-health-status,.production-status-item,.production-session-status,.production-session{display:flex;align-items:center;gap:6px;min-width:0}.production-save-status{white-space:nowrap}.production-save-status>svg{color:#a3ceb7;flex-shrink:0}.production-health-status{justify-content:center;gap:18px}.production-status-item{border:0;background:transparent;padding:3px 0;font-size:11px;color:var(--text-muted);white-space:nowrap}.production-status-item:hover{color:var(--text-primary)}.production-status-item:focus-visible{outline:2px solid var(--accent);outline-offset:4px;border-radius:3px}.production-status-item>svg{flex-shrink:0}.production-metric{color:var(--text-primary);font-variant-numeric:tabular-nums}.production-dot{width:5px;height:5px;border-radius:50%;flex-shrink:0;background:var(--text-muted);opacity:.65}.production-dot.running,.production-session.live .production-dot{background:#a3ceb7;opacity:1}.production-dot.fault,.production-session.warning .production-dot{background:#e5a598;opacity:1}.production-session.recording .production-dot{background:#f0989c;opacity:1}.production-session-status{gap:16px;white-space:nowrap}.production-session-label{font-size:10px;letter-spacing:.5px}.production-session time{color:var(--text-primary);font-variant-numeric:tabular-nums;min-width:18px}.production-session.recording .production-session-label{color:#f0989c}.production-session.live .production-session-label{color:#a3ceb7}.warning .production-metric,.production-session.warning .production-session-label{color:#e5a598}.status-loading{animation:production-status-spin 1s linear infinite}.production-status-popover{background:var(--surface-2);border:1px solid var(--border-hair);color:var(--text-primary);width:310px;max-width:calc(100vw - 24px)}.production-status-popover h3{font-size:13px;font-weight:500}.production-status-popover dl{display:grid;gap:10px;font-size:12px}.production-status-popover dl>div{display:flex;justify-content:space-between;gap:15px}.production-status-popover dt{color:var(--text-muted)}.production-status-popover dd{text-align:right;font-variant-numeric:tabular-nums}.production-status-popover p{font-size:11px;line-height:1.6;color:var(--text-muted);border-top:1px solid var(--border-hair);padding-top:10px}.production-status-popover small{font-size:11px;color:var(--text-muted)}
@keyframes production-status-spin{to{transform:rotate(360deg)}}@media(prefers-reduced-motion:reduce){.status-loading{animation:none}}
@media(max-width:1150px){.production-statusbar{grid-template-columns:1fr auto;gap:8px 16px}.production-health-status{grid-column:1/-1;grid-row:2;justify-content:flex-start;gap:20px;padding-top:7px;border-top:1px solid var(--border-hair)}.production-session-status{grid-column:2;grid-row:1}}
@media(max-width:550px){.production-statusbar{grid-template-columns:1fr;padding:10px 12px;gap:9px}.production-health-status{flex-wrap:wrap;gap:6px 16px}.production-session-status{grid-column:1;grid-row:3;gap:20px}.production-status-item{min-height:28px}.production-save-status{font-size:11px}}
</style>
