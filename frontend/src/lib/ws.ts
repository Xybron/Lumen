import { ref, readonly } from 'vue';
import type { BroadcastMsg } from '@/types';

export type ConnectionState = 'connecting' | 'online' | 'offline';

const RECONNECT_DELAYS_MS = [500, 1000, 2000, 5000, 10000];
const HEARTBEAT_MS = 20_000;
const HEARTBEAT_TIMEOUT_MS = 25_000;

const status = ref<ConnectionState>('connecting');
const subscribers = new Set<(msg: BroadcastMsg) => void>();

let socket: WebSocket | null = null;
let reconnectAttempt = 0;
let reconnectTimer: number | null = null;
let pingTimer: number | null = null;
let pongTimer: number | null = null;
let started = false;

// Topics (channel ids) this client wants the relay to forward. Re-sent on every
// (re)connect so scoped subscriptions survive a dropped socket.
const desiredTopics = new Set<string>();

function wsUrl(): string {
  const proto = location.protocol === 'https:' ? 'wss:' : 'ws:';
  return `${proto}//${location.host}/ws`;
}

function setStatus(next: ConnectionState) {
  if (status.value !== next) status.value = next;
}

function clearTimers() {
  if (pingTimer != null) {
    clearInterval(pingTimer);
    pingTimer = null;
  }
  if (pongTimer != null) {
    clearTimeout(pongTimer);
    pongTimer = null;
  }
}

function scheduleReconnect() {
  if (reconnectTimer != null) return;
  const delay = RECONNECT_DELAYS_MS[Math.min(reconnectAttempt, RECONNECT_DELAYS_MS.length - 1)];
  reconnectAttempt += 1;
  reconnectTimer = window.setTimeout(() => {
    reconnectTimer = null;
    open();
  }, delay);
}

function open() {
  if (socket && (socket.readyState === WebSocket.OPEN || socket.readyState === WebSocket.CONNECTING)) {
    return;
  }
  setStatus('connecting');
  let ws: WebSocket;
  try {
    ws = new WebSocket(wsUrl());
  } catch {
    scheduleReconnect();
    return;
  }
  socket = ws;

  ws.addEventListener('open', () => {
    reconnectAttempt = 0;
    setStatus('online');

    // Re-declare topic interest to the (possibly fresh) relay.
    if (desiredTopics.size > 0) {
      try {
        ws.send(JSON.stringify({ t: 'subscribe', channels: [...desiredTopics] }));
      } catch {
        /* will re-send on next open */
      }
    }

    pingTimer = window.setInterval(() => {
      if (ws.readyState !== WebSocket.OPEN) return;
      ws.send(JSON.stringify({ t: 'ping' }));
      // If we don't see any message (pong or otherwise) within the window,
      // assume the socket is a zombie and force a reconnect.
      if (pongTimer != null) clearTimeout(pongTimer);
      pongTimer = window.setTimeout(() => {
        try {
          ws.close();
        } catch {
          /* fall through to onclose */
        }
      }, HEARTBEAT_TIMEOUT_MS);
    }, HEARTBEAT_MS);
  });

  ws.addEventListener('message', (e) => {
    // Any inbound traffic resets the liveness timer.
    if (pongTimer != null) {
      clearTimeout(pongTimer);
      pongTimer = null;
    }

    let msg: unknown;
    try {
      msg = JSON.parse(e.data);
    } catch {
      return;
    }
    if (!isObj(msg) || typeof msg.t !== 'string') return;
    if (msg.t === 'pong') return;
    for (const fn of subscribers) fn(msg as BroadcastMsg);
  });

  ws.addEventListener('close', () => {
    clearTimers();
    socket = null;
    setStatus('offline');
    scheduleReconnect();
  });

  ws.addEventListener('error', () => {
    // 'error' is always followed by 'close'; let close handle reconnect.
  });
}

function isObj(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null;
}

export function startWs() {
  if (started) return;
  started = true;

  open();

  window.addEventListener('online', () => {
    // Browser thinks the network is back — abort any backoff and try now.
    if (reconnectTimer != null) {
      clearTimeout(reconnectTimer);
      reconnectTimer = null;
    }
    reconnectAttempt = 0;
    open();
  });
  window.addEventListener('offline', () => {
    setStatus('offline');
  });
}

export function sendWs(msg: BroadcastMsg) {
  if (!socket || socket.readyState !== WebSocket.OPEN) return;
  try {
    socket.send(JSON.stringify(msg));
  } catch {
    /* socket closed mid-send; reconnect will handle it */
  }
}

export function subscribeWs(fn: (msg: BroadcastMsg) => void): () => void {
  subscribers.add(fn);
  return () => subscribers.delete(fn);
}

// Tell the relay which channel topics this client wants forwarded. Idempotent;
// safe to call before the socket is open (re-sent on connect).
export function subscribeTopics(channels: string[]) {
  const added: string[] = [];
  for (const c of channels) {
    if (!desiredTopics.has(c)) {
      desiredTopics.add(c);
      added.push(c);
    }
  }
  if (added.length && socket?.readyState === WebSocket.OPEN) {
    try {
      socket.send(JSON.stringify({ t: 'subscribe', channels: added }));
    } catch {
      /* re-sent on next open */
    }
  }
}

export function unsubscribeTopics(channels: string[]) {
  const removed: string[] = [];
  for (const c of channels) {
    if (desiredTopics.delete(c)) removed.push(c);
  }
  if (removed.length && socket?.readyState === WebSocket.OPEN) {
    try {
      socket.send(JSON.stringify({ t: 'unsubscribe', channels: removed }));
    } catch {
      /* topic interest already dropped locally */
    }
  }
}

export function useConnection() {
  return readonly(status);
}
