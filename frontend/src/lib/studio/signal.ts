import type { StudioSignalMessage } from '../../../../shared/production';

// Each surface has its own connection. Input publishers are held by the Pinia
// store, not a route component, so navigation doesn't release devices.
export class StudioSignal {
  private socket: WebSocket | null = null;
  private retry: number | undefined;
  private stopped = false;
  private backoff = 500;
  private listeners = new Set<(message: StudioSignalMessage) => void>();
  onConnected: () => void = () => {};
  onDisconnected: () => void = () => {};
  constructor() { this.connect(); }
  private connect() {
    this.socket = new WebSocket(`${location.protocol === 'https:' ? 'wss:' : 'ws:'}//${location.host}/studio/ws`);
    this.socket.onmessage = e => {
      try {
        const message = JSON.parse(e.data) as StudioSignalMessage;
        if (message.t === 'connected') { this.backoff = 500; this.onConnected(); }
        for (const listener of this.listeners) listener(message);
      } catch (error) { console.warn('Studio signaling:', error); }
    };
    this.socket.onclose = () => {
      this.onDisconnected();
      if (!this.stopped) {
        this.retry = window.setTimeout(() => this.connect(), this.backoff);
        this.backoff = Math.min(this.backoff * 2, 5000);
      }
    };
    this.socket.onerror = () => this.socket?.close();
  }
  send(message: StudioSignalMessage) { if (this.socket?.readyState === WebSocket.OPEN) this.socket.send(JSON.stringify(message)); }
  subscribe(listener: (message: StudioSignalMessage) => void) { this.listeners.add(listener); return () => this.listeners.delete(listener); }
  reconnect() { this.socket?.close(); }
  close() { this.stopped = true; clearTimeout(this.retry); this.socket?.close(); this.listeners.clear(); }
}

export class StudioPeer {
  readonly pc = new RTCPeerConnection({ iceServers: [] });
  private pending: RTCIceCandidateInit[] = [];
  private closed = false;
  constructor(private signal: StudioSignal, readonly peerId: string, readonly key: string) {
    this.pc.onicecandidate = e => {
      if (e.candidate) signal.send({ t: 'signal', peerId, key, candidate: e.candidate.toJSON() });
    };
  }
  async offer(stream: MediaStream) {
    for (const track of stream.getTracks()) this.pc.addTrack(track, stream);
    await this.pc.setLocalDescription(await this.pc.createOffer());
    this.signal.send({ t: 'signal', peerId: this.peerId, key: this.key, description: this.pc.localDescription!.toJSON() });
  }
  async receive(message: StudioSignalMessage) {
    if (this.closed) return;
    if (message.description) {
      await this.pc.setRemoteDescription(message.description);
      for (const candidate of this.pending.splice(0)) await this.pc.addIceCandidate(candidate).catch(() => {});
      if (message.description.type === 'offer') {
        await this.pc.setLocalDescription(await this.pc.createAnswer());
        this.signal.send({ t: 'signal', peerId: this.peerId, key: this.key, description: this.pc.localDescription!.toJSON() });
      }
    } else if (message.candidate) {
      if (this.pc.remoteDescription) await this.pc.addIceCandidate(message.candidate).catch(() => {});
      else this.pending.push(message.candidate);
    }
  }
  close() { this.closed = true; this.pc.close(); this.pending = []; }
}
