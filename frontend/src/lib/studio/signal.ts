import type { StudioSignalMessage } from '../../../../shared/production';

function preferVideoCodec(transceiver: RTCRtpTransceiver, mimeType?: string) {
  if (!mimeType || typeof transceiver.setCodecPreferences !== 'function') return false;
  try {
    const codecs = RTCRtpSender.getCapabilities('video')?.codecs ?? [];
    const preferred = codecs.filter(codec => codec.mimeType.toLowerCase() === mimeType.toLowerCase());
    if (!preferred.length) return false;
    // Keep the browser's other codecs, retransmission and error correction.
    // A receiver without this preference still negotiates a common fallback.
    transceiver.setCodecPreferences([...preferred, ...codecs.filter(codec => !preferred.includes(codec))]);
    return true;
  } catch { return false; /* Unsupported preference APIs retain normal negotiation. */ }
}

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
  private preferredVideo: { sender: RTCRtpSender; mimeType: string; maxBitrate: number } | null = null;
  private encodingRetry: ReturnType<typeof setTimeout> | undefined;
  private encodingDeadline: ReturnType<typeof setTimeout> | undefined;
  private probingEncoding = false;
  private encodingStartedAt: number | undefined;
  private encodingDiagnostics = { state: 'not-requested', reason: undefined as string | undefined, attempts: 0, elapsedMs: 0 };
  private encodingStatsPending = false;
  private encodingStatsFailed = false;
  private connectedZeroFrameSamples = 0;
  private latestZeroFrameSample = false;
  private encodedVideo = false;
  onPreferredVideoStartupFailed: () => void = () => {};
  get preferredVideoStartupFailed() {
    return !this.closed && this.probingEncoding && this.pc.connectionState === 'connected'
      && (this.encodingDiagnostics.state === 'probing' || this.encodingDiagnostics.reason === 'zero-encoded-frames')
      && !this.encodingStatsPending && !this.encodingStatsFailed && this.latestZeroFrameSample && !this.encodedVideo && this.connectedZeroFrameSamples >= 2;
  }
  get videoEncodingDiagnostic() { return { ...this.encodingDiagnostics, connectedZeroFrameSamples: this.connectedZeroFrameSamples }; }
  private startPreferredEncoding = () => {
    if (this.closed || !this.preferredVideo || this.probingEncoding || this.pc.connectionState !== 'connected') return;
    this.probingEncoding = true;
    this.encodingStartedAt = performance.now();
    this.encodingDiagnostics.state = 'probing';
    this.pc.removeEventListener('connectionstatechange', this.startPreferredEncoding);
    // Wait for an established connection before spending the probe budget.
    // One deadline also bounds a stalled getStats call; late results are ignored.
    this.encodingDeadline = setTimeout(() => {
      const startupFailed = this.preferredVideoStartupFailed;
      this.stopPreferredEncoding('fallback', startupFailed ? 'zero-encoded-frames' : 'deadline');
      if (startupFailed) this.onPreferredVideoStartupFailed();
    }, 15_000);
    void this.applyPreferredEncoding();
  };
  constructor(private signal: StudioSignal, readonly peerId: string, readonly key: string) {
    this.pc.onicecandidate = e => {
      if (e.candidate) signal.send({ t: 'signal', peerId, key, candidate: e.candidate.toJSON() });
    };
  }
  async offer(stream: MediaStream, videoEncoding?: RTCRtpEncodingParameters, preferredVideoCodec?: string) {
    for (const track of stream.getTracks()) {
      if (track.kind === 'video' && videoEncoding) {
        // Declare the limit before negotiating. Some browsers don't expose
        // sender encodings through getParameters() until after the offer.
        try {
          // A larger ceiling is conditional on the preferred encoder. Start
          // with the browser's usual bitrate until actual RTP confirms it;
          // a codec/API fallback must not inherit an expensive HD budget.
          const initialEncoding = { ...videoEncoding };
          if (preferredVideoCodec) delete initialEncoding.maxBitrate;
          const transceiver = this.pc.addTransceiver(track, { direction: 'sendonly', streams: [stream], sendEncodings: [initialEncoding] });
          if (preferVideoCodec(transceiver, preferredVideoCodec) && videoEncoding.maxBitrate !== undefined) {
            this.preferredVideo = { sender: transceiver.sender, mimeType: preferredVideoCodec!, maxBitrate: videoEncoding.maxBitrate };
            this.encodingDiagnostics.state = 'waiting-connection';
          } else if (preferredVideoCodec) {
            this.encodingDiagnostics = { ...this.encodingDiagnostics, state: 'fallback', reason: 'codec-preference-unavailable' };
          }
          continue;
        } catch {
          if (preferredVideoCodec) this.encodingDiagnostics = { ...this.encodingDiagnostics, state: 'fallback', reason: 'encoding-api-error' };
          // Older senders can still offer their native track.
        }
      }
      this.pc.addTrack(track, stream);
    }
    await this.pc.setLocalDescription(await this.pc.createOffer());
    this.signal.send({ t: 'signal', peerId: this.peerId, key: this.key, description: this.pc.localDescription!.toJSON() });
  }
  private stopPreferredEncoding(state?: string, reason?: string) {
    clearTimeout(this.encodingRetry);
    clearTimeout(this.encodingDeadline);
    this.pc.removeEventListener('connectionstatechange', this.startPreferredEncoding);
    this.preferredVideo = null;
    if (state) this.encodingDiagnostics.state = state;
    this.encodingDiagnostics.reason = reason;
    if (this.encodingStartedAt !== undefined) this.encodingDiagnostics.elapsedMs = performance.now() - this.encodingStartedAt;
  }
  private async applyPreferredEncoding(attempt = 0) {
    this.encodingRetry = undefined;
    const pending = this.preferredVideo;
    if (this.closed || !pending) return;
    let stage = 'stats';
    try {
      this.encodingDiagnostics.attempts++;
      this.encodingStatsPending = true;
      const report = await pending.sender.getStats();
      this.encodingStatsPending = false;
      if (this.closed || this.preferredVideo !== pending) return;
      let codec: { mimeType: string } | undefined;
      let zeroFrames = false;
      report.forEach(stat => {
        if (stat.type !== 'outbound-rtp' || stat.kind !== 'video') return;
        if (stat.framesEncoded > 0) { this.encodedVideo = true; if (stat.codecId) codec = report.get(stat.codecId); }
        else if (stat.framesEncoded === 0) zeroFrames = true;
      });
      this.latestZeroFrameSample = zeroFrames;
      if (zeroFrames && this.pc.connectionState === 'connected') this.connectedZeroFrameSamples++;
      if (codec) {
        // Capabilities only describe possibilities. The receiver can prefer a
        // different codec, so its negotiated, running stream decides this.
        if (codec.mimeType.toLowerCase() !== pending.mimeType.toLowerCase()) {
          this.stopPreferredEncoding('fallback', `negotiated-${codec.mimeType}`);
          return;
        }
        stage = 'parameters';
        this.stopPreferredEncoding('updating');
        const parameters = pending.sender.getParameters();
        if (parameters.encodings.length !== 1) { this.stopPreferredEncoding('fallback', 'encoding-count'); return; }
        parameters.encodings[0].maxBitrate = pending.maxBitrate;
        await pending.sender.setParameters(parameters);
        if (!this.closed) this.stopPreferredEncoding('applied');
        return;
      }
    } catch {
      this.encodingStatsPending = false;
      if (stage === 'stats') this.encodingStatsFailed = true;
      if (this.closed || stage === 'stats' && this.preferredVideo !== pending) return;
      this.stopPreferredEncoding('fallback', `${stage}-error`);
      return; // Unavailable stats/settings keep the default bitrate.
    }
    // Keep the deadline alive after the last read so non-retrying viewers also
    // receive one default-codec offer when a connected encoder produced nothing.
    if (attempt >= 59) return;
    this.encodingRetry = setTimeout(() => { void this.applyPreferredEncoding(attempt + 1); }, 250);
  }
  async receive(message: StudioSignalMessage) {
    if (this.closed) return;
    if (message.description) {
      await this.pc.setRemoteDescription(message.description);
      for (const candidate of this.pending.splice(0)) await this.pc.addIceCandidate(candidate).catch(() => {});
      if (message.description.type === 'offer') {
        await this.pc.setLocalDescription(await this.pc.createAnswer());
        this.signal.send({ t: 'signal', peerId: this.peerId, key: this.key, description: this.pc.localDescription!.toJSON() });
      } else if (message.description.type === 'answer' && this.preferredVideo && !this.probingEncoding) {
        this.pc.addEventListener('connectionstatechange', this.startPreferredEncoding);
        this.startPreferredEncoding();
      }
    } else if (message.candidate) {
      if (this.pc.remoteDescription) await this.pc.addIceCandidate(message.candidate).catch(() => {});
      else this.pending.push(message.candidate);
    }
  }
  close() { this.closed = true; this.stopPreferredEncoding('closed'); this.pc.close(); this.pending = []; }
}
