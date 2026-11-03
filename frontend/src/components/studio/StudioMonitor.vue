<script setup lang="ts">
import { onMounted, onBeforeUnmount, ref, watch } from 'vue';
import { StudioSignal, StudioPeer } from '@/lib/studio/signal';
import { MULTIVIEW_OUTPUT_ID } from '../../../../shared/multiview-layout';
import { PROGRAM_MONITOR_OUTPUT_ID } from '../../../../shared/program-monitor.js';
const props = withDefaults(defineProps<{ outputId: string; audible?: boolean; compactProgram?: boolean }>(), { audible: false });
const emit = defineEmits<{ ready: [value: boolean]; 'audio-ready': [value: boolean]; blocked: [] }>();
const video = ref<HTMLVideoElement | null>(null);
const ready = ref(false);
let signal: StudioSignal | null = null, peer: StudioPeer | null = null;
let retry: number | undefined;
let requestedAt = 0, disconnectedAt = 0, observedAudio: MediaStreamTrack | null = null, audioReady = false;
function updateAudioReady() {
  const stream = video.value?.srcObject as MediaStream | null;
  const track = stream?.getAudioTracks().find(item => item.readyState === 'live') ?? null;
  if (track !== observedAudio) {
    observedAudio?.removeEventListener('mute', updateAudioReady);
    observedAudio?.removeEventListener('unmute', updateAudioReady);
    observedAudio?.removeEventListener('ended', updateAudioReady);
    observedAudio = track;
    track?.addEventListener('mute', updateAudioReady);
    track?.addEventListener('unmute', updateAudioReady);
    track?.addEventListener('ended', updateAudioReady);
  }
  const available = !!track && !track.muted;
  if (audioReady !== available) { audioReady = available; emit('audio-ready', available); }
}
function reset() {
  peer?.close(); peer = null; disconnectedAt = 0;
  ready.value = false; emit('ready', false);
  if (video.value) video.value.srcObject = null;
  updateAudioReady();
}
function request() { requestedAt = performance.now(); signal?.send({ t: 'watch', outputId: props.outputId, compactProgram: props.compactProgram, monitorOnly: true }); }
function playMonitor(element: HTMLVideoElement) {
  void element.play().catch(error => {
    // Replacing a peer can interrupt an old play() promise. That is not an
    // autoplay denial and must not silently turn headphone monitoring off.
    if (video.value === element && (error as DOMException)?.name === 'NotAllowedError') emit('blocked');
  });
}
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
      const current = peer;
      current.pc.ontrack = e => {
        if (peer !== current || !video.value) return;
        video.value.srcObject = e.streams[0] ?? new MediaStream([e.track]);
        updateAudioReady();
        playMonitor(video.value);
      };
      current.pc.onconnectionstatechange = () => {
        if (peer !== current) return;
        if (['failed', 'closed'].includes(current.pc.connectionState)) { reset(); request(); }
        else if (current.pc.connectionState === 'disconnected') disconnectedAt ||= performance.now();
        else disconnectedAt = 0;
      };
    }
    void peer?.receive(m).catch(() => reset());
  });
  // Re-request a missing stream after an engine restart or a failed ICE exchange.
  retry = window.setInterval(() => {
    updateAudioReady();
    const staleOffer = !ready.value && requestedAt > 0 && performance.now() - requestedAt > 9000;
    const lostConnection = disconnectedAt > 0 && performance.now() - disconnectedAt > 6000;
    if (staleOffer || lostConnection || (!ready.value && !peer)) { reset(); request(); }
  }, 3000);
});
watch(() => props.outputId, (_id, old) => { signal?.send({ t: 'unwatch', outputId: old }); reset(); request(); });
watch(() => props.audible, value => { if (video.value) { video.value.muted = !value; playMonitor(video.value); } });
onBeforeUnmount(() => { clearInterval(retry); reset(); signal?.close(); });
function playing() { ready.value = true; emit('ready', true); updateAudioReady(); }
defineExpose({ video });
</script>
<template><video ref="video" :muted="!audible" autoplay playsinline class="studio-video" :class="{ 'is-ready': ready }" @playing="playing" /></template>
<style scoped>
.studio-video { position: absolute; inset: 0; width: 100%; height: 100%; object-fit: contain; background: #080a0d; opacity: 0; }
.studio-video.is-ready { opacity: 1; }
</style>
