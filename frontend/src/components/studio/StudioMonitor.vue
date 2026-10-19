<script setup lang="ts">
import { onMounted, onBeforeUnmount, ref, watch } from 'vue';
import { StudioSignal, StudioPeer } from '@/lib/studio/signal';
import { MULTIVIEW_OUTPUT_ID } from '../../../../shared/multiview-layout';
import { PROGRAM_MONITOR_OUTPUT_ID } from '../../../../shared/program-monitor.js';
const props = withDefaults(defineProps<{ outputId: string; audible?: boolean }>(), { audible: false });
const emit = defineEmits<{ ready: [value: boolean]; blocked: [] }>();
const video = ref<HTMLVideoElement | null>(null);
const ready = ref(false);
let signal: StudioSignal | null = null, peer: StudioPeer | null = null;
let retry: number | undefined;
function reset() { peer?.close(); peer = null; ready.value = false; emit('ready', false); if (video.value) video.value.srcObject = null; }
function request() { signal?.send({ t: 'watch', outputId: props.outputId }); }
onMounted(() => {
  signal = new StudioSignal();
  signal.onConnected = request;
  signal.onDisconnected = reset;
  signal.subscribe(m => {
    if (m.state && !['program', 'preview', MULTIVIEW_OUTPUT_ID, PROGRAM_MONITOR_OUTPUT_ID].includes(props.outputId) && !m.state.outputs.some(o => o.id === props.outputId)) reset();
    if (m.status && m.status.state !== 'running' && m.status.state !== 'starting') reset();
    if (m.t !== 'signal' || m.key !== `out:${props.outputId}` || !m.peerId || !signal) return;
    if (m.description?.type === 'offer') {
      reset(); peer = new StudioPeer(signal, m.peerId, m.key);
      peer.pc.ontrack = e => {
        if (video.value) { video.value.srcObject = e.streams[0] ?? new MediaStream([e.track]); void video.value.play().catch(() => emit('blocked')); }
      };
      peer.pc.onconnectionstatechange = () => { if (peer?.pc.connectionState === 'failed') reset(); };
    }
    void peer?.receive(m).catch(() => reset());
  });
  // Re-request a missing stream after an engine restart or a failed ICE exchange.
  retry = window.setInterval(() => { if (!ready.value && (!peer || ['failed', 'closed', 'disconnected'].includes(peer.pc.connectionState))) request(); }, 3000);
});
watch(() => props.outputId, (id, old) => { signal?.send({ t: 'unwatch', outputId: old }); reset(); signal?.send({ t: 'watch', outputId: id }); });
watch(() => props.audible, async value => { if (video.value) { video.value.muted = !value; try { await video.value.play(); } catch { emit('blocked'); } } });
onBeforeUnmount(() => { clearInterval(retry); reset(); signal?.close(); });
function playing() { ready.value = true; emit('ready', true); }
defineExpose({ video });
</script>
<template><video ref="video" :muted="!audible" autoplay playsinline class="studio-video" :class="{ 'is-ready': ready }" @playing="playing" @stalled="ready = false" /></template>
<style scoped>
.studio-video { position: absolute; inset: 0; width: 100%; height: 100%; object-fit: contain; background: #080a0d; opacity: 0; }
.studio-video.is-ready { opacity: 1; }
</style>
