import { randomUUID } from 'node:crypto';
import type { IncomingMessage } from 'node:http';
import { WebSocket, WebSocketServer } from 'ws';
import { userFromCookieHeader, userCan } from './auth.js';
import type { ProductionState, StudioStatus } from '../../shared/production.js';
import { PROGRAM_MONITOR_OUTPUT_ID } from '../../shared/program-monitor.js';

interface Peer {
  id: string; ws: WebSocket; engine: boolean; operator: boolean; signedIn: boolean;
  watching: Set<string>; publishing: Set<string>; alive: boolean;
  outputScope?: string;
  outputAudioEnabled?: boolean;
  mobileProgram?: boolean;
}

// Dedicated signaling channel. Only the renderer can offer an output; only
// authorized operators can publish inputs. Other peers cannot address each other.
export class ProductionHub {
  readonly wss = new WebSocketServer({ noServer: true, maxPayload: 128 * 1024 });
  private peers = new Map<string, Peer>();
  private engine: Peer | null = null;
  private heartbeat: ReturnType<typeof setInterval>;
  onEngineGone: () => void = () => {};
  constructor(
    private isEngine: (req: IncomingMessage) => boolean,
    private state: () => ProductionState,
    private status: () => StudioStatus,
  ) {
    this.wss.on('connection', (ws, req) => this.connect(ws, req));
    this.heartbeat = setInterval(() => {
      for (const peer of this.peers.values()) {
        if (!peer.alive) peer.ws.terminate();
        else { peer.alive = false; peer.ws.ping(); }
      }
    }, 15000);
    this.heartbeat.unref();
  }
  send(peer: Peer, message: unknown) {
    if (peer.ws.readyState !== WebSocket.OPEN) return;
    if (peer.outputScope) {
      const value = message as Record<string, unknown>;
      const snapshot = value.state as ProductionState | undefined;
      if (snapshot) {
        const output = snapshot.outputs.find(item => item.id === peer.outputScope);
        if (peer.outputScope !== 'program' && !peer.mobileProgram && !output) { peer.ws.close(1008, 'Output is no longer available'); peer.ws.terminate(); return; }
        peer.outputAudioEnabled = !peer.mobileProgram && (peer.outputScope === 'program' || output?.audioEnabled === true);
      }
      if (value.t === 'connected' || value.t === 'status' || value.t === 'state') {
        const status = value.status as StudioStatus | undefined;
        peer.ws.send(JSON.stringify({ t: value.t === 'connected' ? 'connected' : 'output-status',
          ...(value.t === 'connected' ? { peerId: peer.id } : {}), outputId: peer.outputScope,
          engineState: status?.state ?? this.status().state, audioEnabled: peer.outputAudioEnabled === true }));
      } else if (value.t === 'signal' && value.key === `out:${peer.outputScope}`) {
        peer.ws.send(JSON.stringify({ t: 'signal', peerId: value.peerId, key: value.key, description: value.description, candidate: value.candidate }));
      }
      return;
    }
    peer.ws.send(JSON.stringify(message));
  }
  engineSend(message: unknown) { if (this.engine) this.send(this.engine, message); }
  hasEngine() { return this.engine?.ws.readyState === WebSocket.OPEN; }
  broadcast(message: unknown) { for (const peer of this.peers.values()) this.send(peer, message); }
  /** An already capability-authenticated gateway viewer. Never infer operator
   * authority from cookies/headers on the separate viewer listener. */
  attachOutputViewer(ws: WebSocket, outputId: string) {
    if (outputId !== 'program' && !this.state().outputs.some(item => item.id === outputId)) { ws.close(1008, 'Output is no longer available'); return; }
    if (['preview', 'multiview', PROGRAM_MONITOR_OUTPUT_ID, 'recording'].includes(outputId)) { ws.close(1008, 'Output is not shareable'); return; }
    this.connect(ws, { headers: {} } as IncomingMessage, outputId);
  }
  /** Already-authenticated, scoped phone confidence monitor, deliberately not
   * reachable through public output capabilities. Silent, 640 × 360 at 15 fps. */
  attachMobileProgramViewer(ws: WebSocket) {
    this.connect(ws, { headers: {} } as IncomingMessage, PROGRAM_MONITOR_OUTPUT_ID, true);
  }
  private connect(ws: WebSocket, req: IncomingMessage, outputScope?: string, mobileProgram = false) {
    let frameWindow = Date.now(), frameCount = 0;
    let operator = false;
    let signedIn = false;
    try { if (!outputScope) { const user = userFromCookieHeader(req.headers.cookie); signedIn = !!user; operator = !!user && userCan(user, '*', 'author'); } } catch { /* anonymous output */ }
    const peer: Peer = { id: randomUUID(), ws, engine: !outputScope && this.isEngine(req), operator, signedIn,
      watching: new Set(outputScope ? [outputScope] : []), publishing: new Set(), alive: true, ...(outputScope ? { outputScope } : {}), ...(mobileProgram ? { mobileProgram: true } : {}) };
    if (peer.engine && this.engine) { ws.close(1008, 'Renderer already connected'); return; }
    this.peers.set(peer.id, peer);
    this.send(peer, { t: 'connected', peerId: peer.id, state: this.state(), status: this.status() });
    if (peer.engine) {
      this.engine = peer;
      for (const p of this.peers.values()) {
        for (const outputId of p.watching) this.send(peer, { t: 'watch', peerId: p.id, key: `out:${outputId}`, outputId });
        for (const sourceId of p.publishing) {
          this.send(peer, { t: 'publish', peerId: p.id, key: `in:${sourceId}`, sourceId });
          this.send(p, { t: 'publish-ready', peerId: peer.id, key: `in:${sourceId}`, sourceId });
        }
      }
    }
    ws.on('pong', () => { peer.alive = true; });
    ws.on('message', raw => {
      try {
        const m = JSON.parse(raw.toString());
        if (!m || typeof m !== 'object') return;
        if (peer.outputScope) {
          if (Date.now() - frameWindow > 10000) { frameWindow = Date.now(); frameCount = 0; }
          if (++frameCount > 120) { ws.close(1008, 'Output signaling rate exceeded'); return; }
          if ((m.t === 'watch' || m.t === 'unwatch') && m.outputId !== peer.outputScope) return;
          if (!['watch', 'unwatch', 'signal'].includes(m.t)) return;
          if (m.t === 'signal' && (m.key !== `out:${peer.outputScope}`
            || m.description && (m.description.type !== 'answer' || typeof m.description.sdp !== 'string' || m.description.sdp.length > 65536)
            || m.candidate && (typeof m.candidate !== 'object' || JSON.stringify(m.candidate).length > 8192))) return;
        }
        if (m.t === 'watch' && !peer.engine && typeof m.outputId === 'string') {
          // Private operator feeds cannot become public through a malformed
          // legacy named-output entry using the same reserved identifier.
          const allowed = peer.outputScope ? m.outputId === peer.outputScope : ['preview', 'multiview', PROGRAM_MONITOR_OUTPUT_ID].includes(m.outputId) ? peer.operator :
            m.outputId === 'program' ? peer.signedIn : this.state().outputs.some(o => o.id === m.outputId);
          if (!allowed) return;
          peer.watching.add(m.outputId);
          this.engineSend({ t: 'watch', peerId: peer.id, outputId: m.outputId, key: `out:${m.outputId}` });
        } else if (m.t === 'unwatch' && typeof m.outputId === 'string') {
          peer.watching.delete(m.outputId);
          this.engineSend({ t: 'unwatch', peerId: peer.id, key: `out:${m.outputId}` });
        } else if (m.t === 'publish' && peer.operator && typeof m.sourceId === 'string') {
          if (!this.state().sources.some(s => s.id === m.sourceId && ['camera', 'screen', 'microphone'].includes(s.kind))) return;
          if ([...this.peers.values()].some(p => p.id !== peer.id && p.publishing.has(m.sourceId))) {
            this.send(peer, { t: 'error', error: 'That input is connected from another device.' }); return;
          }
          peer.publishing.add(m.sourceId);
          this.engineSend({ t: 'publish', peerId: peer.id, sourceId: m.sourceId, key: `in:${m.sourceId}` });
          if (this.engine) this.send(peer, { t: 'publish-ready', peerId: this.engine.id, sourceId: m.sourceId, key: `in:${m.sourceId}` });
        } else if (m.t === 'unpublish' && typeof m.sourceId === 'string') {
          if (peer.publishing.delete(m.sourceId)) this.engineSend({ t: 'unpublish', peerId: peer.id, key: `in:${m.sourceId}`, sourceId: m.sourceId });
        } else if (m.t === 'signal' && typeof m.peerId === 'string' && typeof m.key === 'string') {
          const target = this.peers.get(m.peerId);
          if (!target || peer.engine === target.engine) return;
          const other = peer.engine ? target : peer;
          const valid = (m.key.startsWith('out:') && other.watching.has(m.key.slice(4))) ||
            (m.key.startsWith('in:') && other.publishing.has(m.key.slice(3)));
          if (valid) this.send(target, { t: 'signal', peerId: peer.id, key: m.key, description: m.description, candidate: m.candidate });
        }
      } catch { /* malformed frames have no effects */ }
    });
    ws.on('close', () => {
      this.peers.delete(peer.id);
      if (peer.engine) { this.engine = null; this.onEngineGone(); }
      else this.engineSend({ t: 'peer-left', peerId: peer.id });
    });
    ws.on('error', () => ws.terminate());
    if (outputScope) this.engineSend({ t: 'watch', peerId: peer.id, outputId: outputScope, key: `out:${outputScope}` });
  }
  close() { clearInterval(this.heartbeat); for (const peer of this.peers.values()) peer.ws.close(); this.wss.close(); }
}
