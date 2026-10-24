import { WebSocketServer, WebSocket } from 'ws';
import type { IncomingMessage } from 'node:http';
import { userFromCookieHeader, userCan, type SessionUser } from './auth.js';
import { loadOwners, saveOwner } from './presence.js';

// Stateless relay + presence hub. Messages route by TOPIC (a message's `channel`,
// or "__global__" for music/content-updated/config/presence and channel-less
// frames). Clients declare interest with subscribe/unsubscribe; a client that
// never subscribes is treated as legacy and receives everything.
//
// Sockets are AUTHENTICATED from their upgrade request's cookie (the httpOnly
// session rides along automatically — JS never reads it). Authed users appear in
// presence; they can claim/takeover channels (soft ownership, persisted to
// SQLite for crash recovery). Live outputs connect unauthenticated and simply
// don't appear in presence.

type Json = Record<string, unknown>;

const HEARTBEAT_MS = 20_000;
const GLOBAL = '__global__';
const GLOBAL_TYPES = new Set([
  'music',
  'content-updated',
  'library-updated',
  'data-cleared',
  'config',
  'presence',
  'media-added',
  'program',
  'mediastatus',
  'agents',
  // WebRTC source discovery is operator-wide; the per-peer offer/answer/ice
  // frames stay topic-scoped (webrtc:<publisherId>).
  'rtc-announce',
  'rtc-bye',
]);
// Inbound frames that DRIVE a channel — gated by the socket's authenticated user
// + per-channel role. claim/takeover are gated separately (they already require
// an authed user). Live outputs (unauth sockets) can never author.
const AUTHORING_TYPES = new Set(['state', 'tick', 'cmd']);

interface SocketMeta {
  topics: Set<string>;
  explicitSubs: boolean;
  alive: boolean;
  user: SessionUser | null;
}

function topicOf(msg: Json): string {
  if (typeof msg.t === 'string' && GLOBAL_TYPES.has(msg.t)) return GLOBAL;
  return typeof msg.channel === 'string' && msg.channel ? msg.channel : GLOBAL;
}

function resolveUser(request: IncomingMessage): SessionUser | null {
  try {
    return userFromCookieHeader(request.headers.cookie);
  } catch {
    return null;
  }
}

// Whether a socket may author (drive playback for) a given channel. Role is the
// HARD boundary; presence ownership is a separate, softer/cooperative layer.
function canAuthor(m: SocketMeta, channel: string): boolean {
  return m.user ? userCan(m.user, channel, 'author') : false;
}

// Uses noServer so multiple WebSocketServers (e.g. /ws + /agent) can share one
// HTTP server without colliding on the 'upgrade' event — server.ts routes
// upgrades to the right wss by path.
export function attachWebSocket() {
  const wss = new WebSocketServer({ noServer: true });
  const meta = new WeakMap<WebSocket, SocketMeta>();

  // Replay caches.
  const stateByTopic = new Map<string, Json>();
  const authoritative = new Set<string>();
  let lastMusic: Json | undefined;
  let lastContentUpdated: Json | undefined;
  let lastProgram: Json | undefined; // Program/Preview bus state for late joiners
  let lastAgents: Json | undefined; // capture-agent roster for late joiners
  let lastMediaStatus: Json | undefined; // stream engine status for late joiners

  // In-memory ownership, rehydrated from SQLite so it survives restarts.
  let owners: Record<string, string> = {};
  try {
    owners = loadOwners();
  } catch {
    owners = {};
  }

  // ── Optional VPS bridge hook (Step 7) ──────────────────────────────────────
  // When a bridge is attached, local control-plane messages are mirrored out to
  // it and remote messages can be injected in. With no bridge (the default),
  // forwardListeners is empty and this is a pure no-op — the station is wholly
  // local and never depends on a VPS.
  const forwardListeners = new Set<(msg: Json) => void>();
  const FORWARD_TYPES = new Set([
    'state',
    'tick',
    'cmd',
    'music',
    'content-updated',
    'claim',
    'takeover',
    'hello',
    'media-added',
  ]);

  function deliverToLocal(msg: Json, exclude?: WebSocket) {
    const topic = topicOf(msg);
    const payload = JSON.stringify(msg);
    for (const client of wss.clients) {
      if (client === exclude) continue;
      if (client.readyState !== WebSocket.OPEN) continue;
      const m = meta.get(client);
      if (!m) continue;
      if (topic === GLOBAL || !m.explicitSubs || m.topics.has(topic)) client.send(payload);
    }
  }

  function forwardLocal(msg: Json) {
    if (forwardListeners.size === 0) return;
    if (typeof msg.t === 'string' && FORWARD_TYPES.has(msg.t)) {
      for (const cb of forwardListeners) cb(msg);
    }
  }

  // VPS → local: deliver an inbound remote message to local clients + cache it.
  function injectRemote(msg: Json) {
    const t = msg.t;
    if (t === 'state') stateByTopic.set(topicOf(msg), msg);
    else if (t === 'music') lastMusic = msg;
    else if (t === 'content-updated') lastContentUpdated = msg;
    else if (t === 'program') lastProgram = msg;
    else if (t === 'agents') lastAgents = msg;
    else if (t === 'mediastatus') lastMediaStatus = msg;
    deliverToLocal(msg);
  }

  function presencePayload(): Json {
    const byUser = new Map<string, { userId: string; displayName: string; channels: Set<string> }>();
    for (const client of wss.clients) {
      if (client.readyState !== WebSocket.OPEN) continue;
      const m = meta.get(client);
      if (!m || !m.user) continue;
      let entry = byUser.get(m.user.id);
      if (!entry) {
        entry = { userId: m.user.id, displayName: m.user.displayName, channels: new Set() };
        byUser.set(m.user.id, entry);
      }
      for (const t of m.topics) if (t !== GLOBAL) entry.channels.add(t);
    }
    const online = [...byUser.values()].map((u) => ({
      userId: u.userId,
      displayName: u.displayName,
      channels: [...u.channels],
    }));
    return { t: 'presence', online, owners };
  }

  function broadcastPresence() {
    const payload = JSON.stringify(presencePayload());
    for (const client of wss.clients) {
      if (client.readyState === WebSocket.OPEN) client.send(payload);
    }
  }

  wss.on('connection', (ws, request: IncomingMessage) => {
    const m: SocketMeta = {
      topics: new Set([GLOBAL]),
      explicitSubs: false,
      alive: true,
      user: resolveUser(request),
    };
    meta.set(ws, m);

    ws.on('pong', () => {
      m.alive = true;
    });

    // Replay caches, then hand the joiner the current presence snapshot.
    if (lastMusic) sendJson(ws, lastMusic);
    if (lastContentUpdated) sendJson(ws, lastContentUpdated);
    if (lastProgram) sendJson(ws, lastProgram);
    if (lastAgents) sendJson(ws, lastAgents);
    if (lastMediaStatus) sendJson(ws, lastMediaStatus);
    for (const state of stateByTopic.values()) sendJson(ws, state);
    sendJson(ws, presencePayload());
    if (m.user) broadcastPresence(); // let peers see the new arrival

    ws.on('message', (raw) => {
      let msg: Json;
      try {
        msg = JSON.parse(raw.toString());
      } catch {
        return;
      }
      const t = msg.t;

      if (t === 'ping') {
        sendJson(ws, { t: 'pong' });
        return;
      }
      if (t === 'auth') return; // cookie-based; the frame is a no-op at the relay
      // Only the dedicated authenticated mobile command service may originate
      // this desktop engine synchronization frame.
      if (t === 'mobile-channel-state') return;

      if (t === 'subscribe' || t === 'unsubscribe') {
        const chans = Array.isArray(msg.channels)
          ? (msg.channels as unknown[]).filter((c): c is string => typeof c === 'string')
          : [];
        m.explicitSubs = true;
        if (t === 'subscribe') {
          for (const c of chans) {
            m.topics.add(c);
            const cached = stateByTopic.get(c);
            if (cached) sendJson(ws, cached);
          }
        } else {
          for (const c of chans) m.topics.delete(c);
        }
        broadcastPresence(); // viewed-channel set changed
        return;
      }

      // Soft ownership. claim only succeeds if the channel is free or self-held;
      // takeover always wins. The relay uses the socket's AUTHED user (not any
      // client-supplied id) as the controller.
      if (t === 'claim' || t === 'takeover') {
        if (m.user && typeof msg.channel === 'string' && canAuthor(m,msg.channel)) {
          const ch = msg.channel;
          const cur = owners[ch];
          if (t === 'takeover' || !cur || cur === m.user.id) {
            owners[ch] = m.user.id;
            try {
              saveOwner(ch, m.user.id);
            } catch {
              /* persistence is best-effort */
            }
            broadcastPresence();
          }
        }
        return;
      }

      // Authority gate: a socket may only ORIGINATE authoring frames for a
      // channel it has the 'author' role on. Denied frames are silently dropped
      // (the client already self-guards read-only via the playback shim; this is
      // defense-in-depth). Live/unauth sockets still RECEIVE state/tick — only
      // inbound authoring is gated. injectRemote (VPS) bypasses this entirely.
      // Authoring frames require an authed user with the 'author' role on a REAL
      // channel. Channel-less authoring frames are DROPPED — they'd route to the
      // global topic and an applied-everywhere mirror could hijack every output.
      if (typeof t === 'string' && AUTHORING_TYPES.has(t)) {
        const ch = typeof msg.channel === 'string' && msg.channel ? msg.channel : null;
        if (!ch || !canAuthor(m, ch)) return;
        if (authoritative.has(ch) || (t==='state' && msg.payload && typeof msg.payload==='object' && 'cue' in msg.payload)) return;
      }
      if (t === 'worship-state' || t === 'library-updated' || t === 'data-cleared') return;
      // The Program/Preview bus is an authoritative switcher action — require an
      // authenticated operator (unauth Live/Output sockets must never cut air).
      if (t === 'program' && !m.user) return;

      if (t === 'state') stateByTopic.set(topicOf(msg), msg);
      else if (t === 'music') lastMusic = msg;
      else if (t === 'content-updated') lastContentUpdated = msg;
      else if (t === 'program') lastProgram = msg;
      else if (t === 'mediastatus') lastMediaStatus = msg;

      deliverToLocal(msg, ws); // local fan-out (by topic)
      forwardLocal(msg); // mirror to the VPS bridge if one is attached
    });

    const interval = setInterval(() => {
      if (!m.alive) {
        ws.terminate();
        return;
      }
      m.alive = false;
      try {
        ws.ping();
      } catch {
        ws.terminate();
      }
    }, HEARTBEAT_MS);

    ws.on('close', () => {
      clearInterval(interval);
      if (m.user) broadcastPresence(); // reflect the departure
    });
    ws.on('error', () => clearInterval(interval));
  });

  // Handle for the optional VPS bridge to integrate at the relay boundary.
  const handle: RelayHandle = {
    wss,
    injectRemote,
    getChannelSnapshot(channel) { const message = stateByTopic.get(channel); return message?.payload && typeof message.payload === 'object' ? structuredClone(message.payload as Json) : null; },
    setAuthoritativeChannel(channel,payload) { authoritative.add(channel); const msg={t:'state',channel,payload}; injectRemote(msg); forwardLocal(msg); },
    onLocalMessage(cb) {
      forwardListeners.add(cb);
      return () => forwardListeners.delete(cb);
    },
  };
  return handle;
}

// What attachWebSocket exposes so a VPS bridge can mirror the control plane.
export interface RelayHandle {
  wss: WebSocketServer;
  setAuthoritativeChannel(channel: string, payload: Record<string, unknown>): void;
  injectRemote(msg: Record<string, unknown>): void;
  getChannelSnapshot?(channel: string): Record<string, unknown> | null;
  onLocalMessage(cb: (msg: Record<string, unknown>) => void): () => void;
}

function sendJson(ws: WebSocket, msg: Json) {
  if (ws.readyState !== WebSocket.OPEN) return;
  ws.send(JSON.stringify(msg));
}
