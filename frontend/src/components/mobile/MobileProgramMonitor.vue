<script setup lang="ts">
import { onBeforeUnmount, onMounted, ref } from 'vue';
const emit = defineEmits<{ ready: [value: boolean] }>();
const video = ref<HTMLVideoElement | null>(null), ready = ref(false);
let socket: WebSocket | null = null, peer: RTCPeerConnection | null = null, peerId = '', stopped = false;
let pending: RTCIceCandidateInit[] = [], retry: ReturnType<typeof setTimeout> | undefined, timeout: ReturnType<typeof setTimeout> | undefined;
let messages: Promise<void> = Promise.resolve();
const outputId = 'program-monitor';
function status(value: boolean) { ready.value = value; emit('ready', value); }
function resetPeer() {
  clearTimeout(timeout); peer?.close(); peer = null; peerId = ''; pending = []; status(false);
  if (video.value) { video.value.pause(); video.value.srcObject = null; }
}
function send(message: unknown) { if (socket?.readyState === WebSocket.OPEN) socket.send(JSON.stringify(message)); }
function request() { if (!document.hidden) send({ t: 'watch', outputId }); }
function close() { clearTimeout(retry); resetPeer(); const previous = socket; socket = null; previous?.close(); }
function connect() {
  if (stopped || document.hidden || socket) return;
  const current = new WebSocket(`${location.protocol === 'https:' ? 'wss:' : 'ws:'}//${location.host}/mobile/signal`); socket = current;
  current.onmessage = event => {
    messages = messages.then(async () => {
      if (current !== socket || stopped) return;
      let message: { t?: string; key?: string; peerId?: string; description?: RTCSessionDescriptionInit; candidate?: RTCIceCandidateInit };
      try { message = JSON.parse(event.data); } catch { return; }
      if (message.t === 'connected') { request(); return; }
      if (message.t !== 'signal' || message.key !== `out:${outputId}` || !message.peerId) return;
      if (message.description?.type === 'offer') {
        resetPeer(); peerId = message.peerId;
        const connection = new RTCPeerConnection({ iceServers: [] }); peer = connection;
        connection.onicecandidate = event => { if (event.candidate) send({ t: 'signal', peerId, key: `out:${outputId}`, candidate: event.candidate.toJSON() }); };
        connection.ontrack = event => {
          if (!video.value || peer !== connection) return;
          video.value.muted = true; video.value.srcObject = event.streams[0] ?? new MediaStream([event.track]);
          void video.value.play().catch(() => status(false));
        };
        connection.onconnectionstatechange = () => {
          if (peer !== connection) return;
          if (['failed', 'disconnected', 'closed'].includes(connection.connectionState)) { resetPeer(); clearTimeout(retry); retry = setTimeout(request, 3000); }
        };
        await connection.setRemoteDescription(message.description);
        for (const candidate of pending.splice(0)) await connection.addIceCandidate(candidate).catch(() => {});
        await connection.setLocalDescription(await connection.createAnswer());
        if (peer === connection) send({ t: 'signal', peerId, key: `out:${outputId}`, description: connection.localDescription?.toJSON() });
        timeout = setTimeout(() => { if (!ready.value) { resetPeer(); request(); } }, 10000);
      } else if (message.candidate && message.peerId === peerId) {
        if (peer?.remoteDescription) await peer.addIceCandidate(message.candidate).catch(() => {});
        else pending.push(message.candidate);
      }
    }).catch(() => { resetPeer(); clearTimeout(retry); retry = setTimeout(request, 3000); });
  };
  current.onclose = () => { if (current !== socket) return; socket = null; resetPeer(); if (!stopped && !document.hidden) retry = setTimeout(connect, 3000); };
  current.onerror = () => current.close();
}
function visibility() { if (document.hidden) close(); else connect(); }
onMounted(() => { connect(); document.addEventListener('visibilitychange', visibility); });
onBeforeUnmount(() => { stopped = true; close(); document.removeEventListener('visibilitychange', visibility); });
</script>
<template><video ref="video" class="mobile-program-video" :class="{ ready }" autoplay muted playsinline disablepictureinpicture aria-label="Muted live Program monitor" @playing="status(true)" @stalled="status(false)" @waiting="status(false)" /></template>
<style scoped>.mobile-program-video { position: absolute; inset: 0; width: 100%; height: 100%; object-fit: contain; background: #090b0e; opacity: 0; pointer-events: none; }.mobile-program-video.ready { opacity: 1; }</style>
