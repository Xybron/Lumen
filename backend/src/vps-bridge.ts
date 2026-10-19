import { WebSocket } from 'ws';
import type { RelayHandle } from './ws.js';

// Optional outbound bridge from the local station to a thin, always-on VPS, so
// remote clients (off-LAN phones/laptops) can reach the station without NAT/port
// config. The station stays AUTHORITATIVE and fully functional whether or not
// the VPS is reachable — this is best-effort and degrades to local-only. Auth
// and playback NEVER depend on it (offline-tolerance invariant).
//
// Config (all optional; absence = disabled, the default):
//   LUMEN_VPS_URL     wss:// URL of the VPS relay endpoint for this station
//   LUMEN_STATION_ID  identifier the VPS uses to route this station's room
//   LUMEN_VPS_TOKEN   shared secret presented to the VPS on connect
//
// Contract: the VPS forwards remote-client control-plane frames to the station
// over this socket, and the station mirrors its local control plane outward. The
// VPS MUST NOT echo a station's own frames back to it (loop avoidance).

const RECONNECT_DELAYS_MS = [1000, 2000, 5000, 10000, 20000];
const HEARTBEAT_MS = 20_000;

export function startVpsBridge(relay: RelayHandle): void {
  const url = process.env.LUMEN_VPS_URL;
  if (!url) {
    console.log('[lumen] VPS bridge: disabled (local-only)');
    return;
  }
  const stationId = process.env.LUMEN_STATION_ID ?? 'station';
  const token = process.env.LUMEN_VPS_TOKEN;
  console.log(`[lumen] VPS bridge: enabled → ${url} (station ${stationId})`);

  let attempt = 0;
  let unsubscribe: (() => void) | null = null;
  let heartbeat: ReturnType<typeof setInterval> | null = null;
  let reconnectTimer: ReturnType<typeof setTimeout> | null = null;

  function scheduleReconnect() {
    if (reconnectTimer) return;
    const delay = RECONNECT_DELAYS_MS[Math.min(attempt, RECONNECT_DELAYS_MS.length - 1)];
    attempt += 1;
    reconnectTimer = setTimeout(() => {
      reconnectTimer = null;
      connect();
    }, delay);
  }

  function teardown() {
    if (unsubscribe) {
      unsubscribe();
      unsubscribe = null;
    }
    if (heartbeat) {
      clearInterval(heartbeat);
      heartbeat = null;
    }
  }

  function connect() {
    let ws: WebSocket;
    try {
      const headers: Record<string, string> = { 'x-lumen-station': stationId };
      if (token) headers['x-lumen-token'] = token;
      ws = new WebSocket(url as string, { headers });
    } catch {
      scheduleReconnect();
      return;
    }

    ws.on('open', () => {
      attempt = 0;
      console.log('[lumen] VPS bridge: connected');
      // Mirror local control-plane messages out to the VPS.
      unsubscribe = relay.onLocalMessage((msg) => {
        if (ws.readyState === WebSocket.OPEN) {
          try {
            ws.send(JSON.stringify(msg));
          } catch {
            /* dropped frame; reconnect logic will recover */
          }
        }
      });
      heartbeat = setInterval(() => {
        if (ws.readyState === WebSocket.OPEN) {
          try {
            ws.ping();
          } catch {
            /* ignore */
          }
        }
      }, HEARTBEAT_MS);
    });

    // Inbound remote frame → inject into the local relay.
    ws.on('message', (raw) => {
      try {
        relay.injectRemote(JSON.parse(raw.toString()));
      } catch {
        /* ignore malformed */
      }
    });

    ws.on('close', () => {
      teardown();
      scheduleReconnect();
    });
    ws.on('error', () => {
      /* 'close' always follows; let it drive reconnect */
    });
  }

  connect();
}
