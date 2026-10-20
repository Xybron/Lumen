<script setup lang="ts">
import { onMounted, onBeforeUnmount, ref } from 'vue';
import { StudioCompositor } from '@/lib/studio/compositor';
import { StudioSignal, StudioPeer } from '@/lib/studio/signal';
import { studioRequest } from '@/lib/studio/api';
import type { ProductionState, StudioSignalMessage, StudioRecording } from '../../../shared/production';
import { MULTIVIEW_OUTPUT_ID } from '../../../shared/multiview-layout';
import { ProgramBroadcastCapture } from '@/lib/studio/broadcast-capture';
import { PROGRAM_MONITOR_OUTPUT_ID } from '../../../shared/program-monitor.js';

const message = ref('Starting production renderer…');
let compositor: StudioCompositor | null = null;
let signal: StudioSignal | null = null;
let heartbeat: number | undefined;
const peers = new Map<string, StudioPeer>();
const inputOwners = new Map<string, StudioPeer>();
let recorder: MediaRecorder | null = null;
let currentRecording: StudioRecording | null = null;
const broadcast = new ProgramBroadcastCapture({
  upload: (id, sequence, data, abort) => studioRequest(`/engine/broadcast/${id}/chunks/${sequence}`, {
    method: 'PUT', headers: { 'Content-Type': 'application/octet-stream' }, body: data, signal: abort,
  }),
  onFailure: (id, error) => studioRequest(`/engine/broadcast/${id}/error`, {
    method: 'POST', body: JSON.stringify({ error }), signal: AbortSignal.timeout(8000),
  }),
});

function closePeer(key: string) {
  const peer = peers.get(key);
  if (!peer) return;
  peers.delete(key);
  peer.pc.ontrack = null; peer.pc.onconnectionstatechange = null;
  const sourceId = peer.key.startsWith('in:') ? peer.key.slice(3) : null;
  if (sourceId && inputOwners.get(sourceId) === peer) {
    inputOwners.delete(sourceId); compositor?.bank.setStream(sourceId, null);
  }
  peer.close();
  if (peer.key === `out:${MULTIVIEW_OUTPUT_ID}` && ![...peers.values()].some(p => p.key === peer.key)) compositor?.releaseMultiview();
  if (peer.key === `out:${PROGRAM_MONITOR_OUTPUT_ID}` && ![...peers.values()].some(p => p.key === peer.key)) compositor?.releaseProgramMonitor();
}

async function receive(m: StudioSignalMessage) {
  if (!compositor || !signal) return;
  if (m.state) compositor.update(m.state);
  if (m.t === 'connected') {
    (window as unknown as { __lumenRendererReady: boolean }).__lumenRendererReady = true;
  }
  const key = `${m.peerId}:${m.key}`;
  if (m.t === 'watch' && m.peerId && m.key && m.outputId) {
    closePeer(key);
    const peer = new StudioPeer(signal, m.peerId, m.key); peers.set(key, peer);
    try { await peer.offer(compositor.stream(m.outputId)); }
    catch (error) { if (peers.get(key) === peer) closePeer(key); throw error; }
  } else if (m.t === 'publish' && m.peerId && m.key && m.sourceId) {
    closePeer(key);
    const peer = new StudioPeer(signal, m.peerId, m.key); peers.set(key, peer);
    const sourceId = m.sourceId, stream = new MediaStream();
    inputOwners.set(sourceId, peer);
    const current = () => peers.get(key) === peer && inputOwners.get(sourceId) === peer;
    peer.pc.ontrack = e => {
      if (!current()) return;
      // Retain a single stream for the lifetime of this peer, including senders
      // that omit stream IDs. Audio and video must not replace each other.
      if (!stream.getTracks().includes(e.track)) stream.addTrack(e.track);
      compositor?.bank.setStream(sourceId, stream);
    };
    peer.pc.onconnectionstatechange = () => {
      if (!current()) return;
      if (['failed', 'closed', 'disconnected'].includes(peer.pc.connectionState)) compositor?.bank.setStream(sourceId, null);
      else if (peer.pc.connectionState === 'connected' && stream.getTracks().length) compositor?.bank.setStream(sourceId, stream);
    };
  } else if (m.t === 'signal') await peers.get(key)?.receive(m);
  else if (m.t === 'unwatch' || m.t === 'unpublish') closePeer(key);
  else if (m.t === 'peer-left') for (const [id, peer] of peers) { if (peer.peerId === m.peerId) closePeer(id); }
  else if (m.t === 'record-start' && m.recording) startRecording(m.recording);
  else if (m.t === 'record-stop' && m.recording?.id === currentRecording?.id && recorder?.state !== 'inactive') recorder?.stop();
  else if (m.t === 'broadcast-start' && m.broadcast) {
    const profile = m.broadcast.profile;
    broadcast.start(m.broadcast.id, () => compositor!.broadcastStream(profile), profile);
  }
  else if (m.t === 'broadcast-stop') broadcast.stop(m.broadcast?.id);
}

function startRecording(recording: StudioRecording) {
  if (recorder || !compositor) return;
  currentRecording = recording;
  let sequence = 0, queuedBytes = 0, failed = '', chain = Promise.resolve();
  const started = performance.now();
  try {
    const mimeType = ['video/webm;codecs=vp8,opus', 'video/webm;codecs=vp9,opus', 'video/webm'].find(t => MediaRecorder.isTypeSupported(t));
    if (!mimeType) throw new Error('This renderer does not support WebM recording.');
    recorder = new MediaRecorder(compositor.stream('program'), { mimeType, videoBitsPerSecond: 6_000_000, audioBitsPerSecond: 192_000 });
    const active = recorder;
    active.ondataavailable = e => {
      if (!e.data.size) return;
      const index = sequence++;
      queuedBytes += e.data.size;
      if (queuedBytes > 128 * 1024 * 1024) {
        failed = 'Recording storage is too slow. Saved chunks can be recovered.';
        if (active.state !== 'inactive') active.stop();
      }
      chain = chain.then(async () => {
        if (failed) return;
        for (let attempt = 0; ; attempt++) {
          try {
            await studioRequest(`/engine/recordings/${recording.id}/chunks/${index}`, {
              method: 'PUT', headers: { 'Content-Type': 'application/octet-stream' }, body: e.data,
            });
            queuedBytes -= e.data.size; break;
          } catch (error) {
            if (attempt >= 4) throw error;
            await new Promise(resolve => setTimeout(resolve, 500 * 2 ** attempt));
          }
        }
      }).catch(error => {
        failed = `Recording upload failed: ${(error as Error).message}`;
        if (active.state !== 'inactive') active.stop();
      });
    };
    active.onerror = () => { failed = 'The video encoder failed. Recover the saved recording chunks.'; if (active.state !== 'inactive') active.stop(); };
    active.onstop = () => {
      const durationMs = performance.now() - started;
      void chain.then(async () => {
        if (failed) await studioRequest(`/engine/recordings/${recording.id}/error`, { method: 'POST', body: JSON.stringify({ error: failed.slice(0, 500) }) });
        else await studioRequest(`/engine/recordings/${recording.id}/finish`, { method: 'POST', body: JSON.stringify({ durationMs }) });
      }).catch(async error => {
        await studioRequest(`/engine/recordings/${recording.id}/error`, { method: 'POST', body: JSON.stringify({ error: String(error).slice(0, 500) }) }).catch(() => {});
      }).finally(() => { recorder = null; currentRecording = null; });
    };
    active.start(2000);
  } catch (error) {
    recorder = null; currentRecording = null;
    void studioRequest(`/engine/recordings/${recording.id}/error`, { method: 'POST', body: JSON.stringify({ error: String(error).slice(0, 500) }) });
  }
}

onMounted(async () => {
  try {
    const state = await studioRequest<ProductionState>('/engine/bootstrap');
    await document.fonts.ready;
    compositor = new StudioCompositor(state);
    (window as unknown as { __lumenDiagnostics: () => Promise<unknown> }).__lumenDiagnostics = async () => ({
      audioState: compositor?.audio.state, audioTime: compositor?.audio.currentTime,
      broadcast: { id: broadcast.activeId, queuedBytes: broadcast.queuedBytes, capture: broadcast.settings },
      inputs: [...(compositor?.bank.inputs.values() ?? [])].map(input => ({
        id: input.source.id, kind: input.source.kind, gain: input.gain.gain.value,
        tracks: input.stream?.getTracks().map(t => ({ kind: t.kind, enabled: t.enabled, muted: t.muted, state: t.readyState })),
      })),
      peers: await Promise.all([...peers.values()].map(async peer => {
        const stats: unknown[] = []; (await peer.pc.getStats()).forEach(s => { if (s.type === 'inbound-rtp' || s.type === 'outbound-rtp') stats.push(s); });
        return { key: peer.key, state: peer.pc.connectionState, stats };
      })),
    });
    signal = new StudioSignal();
    signal.subscribe(m => { void receive(m).catch(e => console.error('Renderer signaling:', e)); });
    signal.onDisconnected = () => { broadcast.stop(); for (const id of peers.keys()) closePeer(id); };
    let reporting = false;
    heartbeat = window.setInterval(() => {
      if (!compositor || reporting) return;
      reporting = true;
      void studioRequest('/engine/heartbeat', { method: 'POST', body: JSON.stringify(compositor.status()) })
        .catch(e => console.warn('Renderer heartbeat:', e)).finally(() => { reporting = false; });
    }, 1000);
    message.value = 'Lumen production renderer is running.';
  } catch { message.value = 'This renderer is managed by the station. Open Studio to start it.'; }
});
onBeforeUnmount(() => { clearInterval(heartbeat); broadcast.stop(); signal?.close(); for (const id of peers.keys()) closePeer(id); compositor?.close(); });
</script>

<template><div class="h-screen bg-black text-white/40 grid place-items-center text-sm">{{ message }}</div></template>
