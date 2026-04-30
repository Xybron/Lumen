import { WebSocketServer, WebSocket } from 'ws';
import type { Server } from 'node:http';

// The server is a stateless relay: any message a client sends is forwarded
// to every other connected client. To smooth over reconnects, we cache the
// most recent state/music/content-updated messages and replay them to a
// joining peer so it doesn't have to wait for the dashboard to broadcast.

type Json = Record<string, unknown>;

interface Cache {
  state?: Json;
  music?: Json;
  contentUpdated?: Json;
}

const HEARTBEAT_MS = 20_000;

export function attachWebSocket(server: Server, path = '/ws') {
  const wss = new WebSocketServer({ server, path });
  const cache: Cache = {};

  wss.on('connection', (ws) => {
    let alive = true;
    ws.on('pong', () => {
      alive = true;
    });

    // Replay the latest known state to a freshly-joined client. Order matters
    // for the Live view: state first (sets the slide + duration), then music.
    if (cache.state) sendJson(ws, cache.state);
    if (cache.music) sendJson(ws, cache.music);
    if (cache.contentUpdated) sendJson(ws, cache.contentUpdated);

    ws.on('message', (raw) => {
      let msg: Json;
      try {
        msg = JSON.parse(raw.toString());
      } catch {
        return;
      }

      // Client-level keepalive: ignore at the relay layer.
      if (msg.t === 'ping') {
        sendJson(ws, { t: 'pong' });
        return;
      }

      // Cache snapshots that a reconnecting peer needs to catch up.
      if (msg.t === 'state') cache.state = msg;
      else if (msg.t === 'music') cache.music = msg;
      else if (msg.t === 'content-updated') cache.contentUpdated = msg;

      relay(wss, ws, msg);
    });

    const interval = setInterval(() => {
      if (!alive) {
        ws.terminate();
        return;
      }
      alive = false;
      try {
        ws.ping();
      } catch {
        ws.terminate();
      }
    }, HEARTBEAT_MS);

    ws.on('close', () => clearInterval(interval));
    ws.on('error', () => clearInterval(interval));
  });

  return wss;
}

function relay(wss: WebSocketServer, sender: WebSocket, msg: Json) {
  const payload = JSON.stringify(msg);
  for (const client of wss.clients) {
    if (client === sender) continue;
    if (client.readyState !== WebSocket.OPEN) continue;
    client.send(payload);
  }
}

function sendJson(ws: WebSocket, msg: Json) {
  if (ws.readyState !== WebSocket.OPEN) return;
  ws.send(JSON.stringify(msg));
}
