import { ref, type Ref } from 'vue';
import { broadcast, subscribeTopics, unsubscribeTopics } from '@/lib/broadcast';
import { subscribeWs } from '@/lib/ws';
import { shortId } from '@/lib/ids';
import type { BroadcastMsg } from '@/types';

// Browser/phone camera + screen-share sources. Media is peer-to-peer (WebRTC);
// only the signalling (offer/answer/ICE) rides the WS relay, scoped to the topic
// `webrtc:<publisherId>`. The publisher is the offerer (it owns the media) and
// fans out to N viewers, one RTCPeerConnection each.
//
// ICE: host candidates only (LAN-direct). Works on a flat church LAN; a STUN/TURN
// entry is needed for cross-LAN / internet contribution (a later phase).
// NOTE: getUserMedia/getDisplayMedia require a secure context (HTTPS or
// localhost) — phones hitting http://<lan-ip> will be blocked by the browser.
const RTC_CONFIG: RTCConfiguration = { iceServers: [] };
const ANNOUNCE_MS = 5000;

export interface Publisher {
  publisherId: string;
  stop(): void;
}
export interface Viewer {
  stream: Ref<MediaStream | null>;
  stop(): void;
}

export async function createPublisher(opts: { via: 'camera' | 'screen'; label?: string }): Promise<Publisher> {
  const publisherId = shortId('cam');
  const topic = `webrtc:${publisherId}`;
  const label = opts.label ?? (opts.via === 'screen' ? 'Screen' : 'Camera');
  const stream =
    opts.via === 'screen'
      ? await navigator.mediaDevices.getDisplayMedia({ video: true, audio: true })
      : await navigator.mediaDevices.getUserMedia({ video: true, audio: true });

  const peers = new Map<string, RTCPeerConnection>(); // viewerId → pc
  subscribeTopics([topic]);

  const announce = () => broadcast({ t: 'rtc-announce', channel: topic, publisherId, label, via: opts.via });

  const unsub = subscribeWs(async (msg: BroadcastMsg) => {
    if (!('publisherId' in msg) || msg.publisherId !== publisherId) return;
    if (msg.t === 'rtc-want') {
      const pc = new RTCPeerConnection(RTC_CONFIG);
      peers.set(msg.viewerId, pc);
      stream.getTracks().forEach((tr) => pc.addTrack(tr, stream));
      pc.onicecandidate = (e) => {
        if (e.candidate)
          broadcast({ t: 'rtc-ice', channel: topic, publisherId, viewerId: msg.viewerId, role: 'pub', candidate: e.candidate.toJSON() });
      };
      const offer = await pc.createOffer();
      await pc.setLocalDescription(offer);
      broadcast({ t: 'rtc-offer', channel: topic, publisherId, viewerId: msg.viewerId, sdp: offer.sdp ?? '' });
    } else if (msg.t === 'rtc-answer') {
      await peers.get(msg.viewerId)?.setRemoteDescription({ type: 'answer', sdp: msg.sdp });
    } else if (msg.t === 'rtc-ice' && msg.role === 'sub') {
      await peers.get(msg.viewerId)?.addIceCandidate(msg.candidate).catch(() => {});
    }
  });

  announce();
  const announceTimer = window.setInterval(announce, ANNOUNCE_MS);

  function stop() {
    clearInterval(announceTimer);
    broadcast({ t: 'rtc-bye', channel: topic, publisherId });
    unsub();
    unsubscribeTopics([topic]);
    peers.forEach((pc) => pc.close());
    peers.clear();
    stream.getTracks().forEach((t) => t.stop());
  }

  return { publisherId, stop };
}

export function createViewer(publisherId: string): Viewer {
  const topic = `webrtc:${publisherId}`;
  const viewerId = shortId('vwr');
  const stream = ref<MediaStream | null>(null);
  let pc: RTCPeerConnection | null = null;

  subscribeTopics([topic]);

  const unsub = subscribeWs(async (msg: BroadcastMsg) => {
    if (!('publisherId' in msg) || msg.publisherId !== publisherId) return;
    if ('viewerId' in msg && msg.viewerId !== viewerId) return; // addressed to another viewer
    if (msg.t === 'rtc-offer') {
      pc?.close();
      pc = new RTCPeerConnection(RTC_CONFIG);
      pc.ontrack = (e) => {
        stream.value = e.streams[0] ?? null;
      };
      pc.onicecandidate = (e) => {
        if (e.candidate)
          broadcast({ t: 'rtc-ice', channel: topic, publisherId, viewerId, role: 'sub', candidate: e.candidate.toJSON() });
      };
      await pc.setRemoteDescription({ type: 'offer', sdp: msg.sdp });
      const answer = await pc.createAnswer();
      await pc.setLocalDescription(answer);
      broadcast({ t: 'rtc-answer', channel: topic, publisherId, viewerId, sdp: answer.sdp ?? '' });
    } else if (msg.t === 'rtc-ice' && msg.role === 'pub') {
      await pc?.addIceCandidate(msg.candidate).catch(() => {});
    } else if (msg.t === 'rtc-bye') {
      stream.value = null;
      pc?.close();
      pc = null;
    }
  });

  broadcast({ t: 'rtc-want', channel: topic, publisherId, viewerId });

  function stop() {
    unsub();
    unsubscribeTopics([topic]);
    pc?.close();
    pc = null;
    stream.value = null;
  }

  return { stream, stop };
}
