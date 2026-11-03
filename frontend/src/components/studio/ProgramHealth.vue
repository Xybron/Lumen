<script setup lang="ts">
import { computed, onBeforeUnmount, ref, shallowRef, watch } from 'vue';
import { Activity, RefreshCw } from 'lucide-vue-next';
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle, DialogTrigger } from '@/components/ui/dialog';
import { studioApi, type RendererDiagnostics } from '@/lib/studio/api';
import { useStudioStore } from '@/stores/studio';
import { useBroadcastStore } from '@/stores/broadcast';

const studio = useStudioStore(), broadcast = useBroadcastStore();
const open = ref(false), loading = ref(false), updated = ref(''), error = ref('');
const renderer = shallowRef<RendererDiagnostics | null>(null);
const timing = computed(() => renderer.value?.timing);
const cameras = computed(() => (studio.state?.sources ?? []).filter(source => source.kind === 'camera').map(source => {
  const peer = renderer.value?.peers.find(peer => peer.key === 'in:' + source.id);
  const video = peer?.stats.find(stat => stat.type === 'inbound-rtp' && stat.kind === 'video');
  return { id: source.id, name: source.name, label: video?.framesPerSecond !== undefined ? Math.round(video.framesPerSecond) + ' fps received'
    : peer?.state === 'connected' ? 'Frame rate unavailable' : 'No connected feed', freezes: video?.freezeCount };
}));
const destinations = computed(() => {
  const session = broadcast.snapshot?.session;
  return session ? [...session.destinations, session.watch].filter(sink => !['disabled', 'unconfigured'].includes(sink.state)) : [];
});
const sinkLabels = { youtube: 'YouTube', facebook: 'Facebook', watch: 'Lumen Watch' };
const sinkStates = { live: 'Sending', retrying: 'Reconnecting', connecting: 'Connecting', stopped: 'Stopped', error: 'Interrupted', disabled: 'Off', unconfigured: 'Off' };
let request: AbortController | undefined;
async function refresh() {
  request?.abort();
  const controller = new AbortController();
  request = controller; error.value = ''; loading.value = true;
  try {
    const data = await studioApi.diagnostics(controller.signal);
    if (controller.signal.aborted) return;
    renderer.value = data.renderer;
    updated.value = new Date().toLocaleTimeString();
    if (!data.renderer?.timing) error.value = 'Program timing is unavailable. Check that the engine is running.';
  } catch {
    if (!controller.signal.aborted) error.value = 'Could not read the engine. Try refreshing.';
  } finally { if (!controller.signal.aborted) loading.value = false; }
}
watch(open, value => { if (value) void refresh(); else { request?.abort(); renderer.value = null; updated.value = ''; } });
onBeforeUnmount(() => request?.abort());
</script>

<template>
  <Dialog v-model:open="open">
    <DialogTrigger as-child><button type="button"><Activity :size="12" />Program health</button></DialogTrigger>
    <DialogContent class="studio-dialog sm:max-w-[440px]">
      <DialogHeader><DialogTitle>Program health</DialogTitle><DialogDescription>Compare the camera input, Program picture and stream connection.</DialogDescription></DialogHeader>
      <p v-if="error" role="alert">{{ error }}</p>
      <div v-if="timing" class="health-readings">
        <section><h3>Program rendering</h3>
          <p>{{ timing.fps }} fps <small>Target 30 fps</small></p>
          <p>{{ timing.pauses }} {{ timing.pauses === 1 ? 'pause' : 'pauses' }} of 100 ms or more since engine start</p>
          <small v-if="timing.lastPauseAt">Last at {{ new Date(timing.lastPauseAt).toLocaleTimeString() }} · Longest {{ timing.longestPauseMs }} ms</small>
        </section>
        <section v-if="cameras.length"><h3>Camera inputs</h3>
          <p v-for="camera in cameras" :key="camera.id"><b>{{ camera.name }}</b> · {{ camera.label }}<small v-if="camera.freezes !== undefined"> · {{ camera.freezes }} freezes on this connection</small></p>
        </section>
        <section v-if="destinations.length"><h3>Stream connections</h3>
          <p v-for="sink in destinations" :key="sink.id"><b>{{ sinkLabels[sink.id] }}</b> · {{ sinkStates[sink.state] }}<small> · {{ sink.retries }} retries</small></p>
        </section>
      </div>
      <div class="health-footer"><small>{{ loading ? 'Reading engine…' : updated ? 'Engine checked at ' + updated : '' }}</small>
        <button type="button" class="s-button" :disabled="loading" @click="refresh"><RefreshCw :size="13" />Refresh</button>
      </div>
    </DialogContent>
  </Dialog>
</template>

<style scoped>
.health-readings { display: grid; gap: 14px; font-size: 13px; max-height: 55dvh; overflow-y: auto; }
.health-readings section { border-top: 1px solid #ffffff18; padding-top: 10px; }
.health-readings h3 { font-weight: 600; margin-bottom: 4px; }
.health-readings p { margin-top: 3px; overflow-wrap: anywhere; }
.health-readings small, .health-footer small { color: var(--text-muted); }
.health-footer { display: flex; align-items: center; justify-content: space-between; gap: 10px; }
</style>
