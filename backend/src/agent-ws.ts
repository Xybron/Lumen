import { WebSocketServer, WebSocket } from 'ws';
import { Router } from 'express';
import type { IncomingMessage } from 'node:http';
import {
  verifyAgentToken,
  setAgentMeta,
  upsertInputs,
  touchHeartbeat,
  markOffline,
  listAgents,
  createAgent,
  removeAgent,
} from './agents.js';
import { projectAgentSources, pruneAgentSources } from './agent-sources.js';
import { AgentRegisterSchema, AgentHeartbeatSchema } from './agent-schema.js';
import { requireAdmin } from './auth.js';
import type { RelayHandle } from './ws.js';

// A SEPARATE WebSocketServer for capture agents (`/agent`), so agent frames never
// fan out to browser clients. Auth is header-token (x-lumen-agent + x-lumen-token),
// mirroring the VPS bridge's trust model. The station re-emits a distilled
// `{t:'agents'}` roster onto the browser `/ws` global topic (one-way).

const HEARTBEAT_TIMEOUT_MS = 50_000; // 2.5 × the 20s heartbeat
const LIVENESS_TICK_MS = 20_000;

type Json = Record<string, unknown>;

// noServer — server.ts routes /agent upgrades here (see attachWebSocket note).
export function attachAgentSocket(relay: RelayHandle) {
  const wss = new WebSocketServer({ noServer: true });

  const broadcastRoster = () => relay.injectRemote({ t: 'agents', agents: listAgents() });

  wss.on('connection', (ws, request: IncomingMessage) => {
    const agentId = String(request.headers['x-lumen-agent'] ?? '');
    const token = String(request.headers['x-lumen-token'] ?? '');
    if (!agentId || !verifyAgentToken(agentId, token)) {
      ws.close(4001, 'unauthorized');
      return;
    }

    let lastSeen = Date.now();
    const liveness = setInterval(() => {
      if (Date.now() - lastSeen > HEARTBEAT_TIMEOUT_MS) {
        markOffline(agentId);
        broadcastRoster();
        ws.terminate();
      }
    }, LIVENESS_TICK_MS);

    ws.on('message', async (raw) => {
      let msg: Json;
      try {
        msg = JSON.parse(raw.toString());
      } catch {
        return;
      }
      lastSeen = Date.now();

      if (msg.t === 'agent-register') {
        const p = AgentRegisterSchema.safeParse(msg);
        if (!p.success) return;
        setAgentMeta(agentId, p.data.platform, p.data.version);
        upsertInputs(agentId, p.data.inputs);
        touchHeartbeat(agentId, 'online', []);
        await projectAgentSources(agentId, p.data.inputs, relay);
        broadcastRoster();
        // hand the agent the full roster (so it can confirm registration)
        ws.send(JSON.stringify({ t: 'agents', agents: listAgents() }));
      } else if (msg.t === 'agent-heartbeat') {
        const p = AgentHeartbeatSchema.safeParse(msg);
        if (!p.success) return;
        touchHeartbeat(agentId, p.data.status, p.data.inputs);
        broadcastRoster();
      } else if (msg.t === 'agent-bye') {
        markOffline(agentId);
        broadcastRoster();
      }
    });

    ws.on('close', () => {
      clearInterval(liveness);
      // Mark offline but KEEP the projected sources (routes referencing them
      // survive a transient agent restart). An admin "remove agent" prunes them.
      markOffline(agentId);
      broadcastRoster();
    });
    ws.on('error', () => clearInterval(liveness));
  });

  return wss;
}

// Admin REST for provisioning agents (mounted under /api). create returns the
// token ONCE; it's hashed at rest.
export function createAgentRouter(relay: RelayHandle): Router {
  const router = Router();

  router.get('/agents', requireAdmin, (_req, res) => {
    res.json({ agents: listAgents() });
  });

  router.post('/agents', requireAdmin, (req, res) => {
    const name =
      typeof req.body?.name === 'string' && req.body.name.trim() ? req.body.name.trim() : 'Capture Agent';
    const { id, token } = createAgent(name);
    res.json({ agentId: id, token, name }); // token shown once
  });

  router.delete('/agents/:id', requireAdmin, async (req, res) => {
    const id = String(req.params.id);
    removeAgent(id);
    await pruneAgentSources(id, relay);
    relay.injectRemote({ t: 'agents', agents: listAgents() });
    res.json({ ok: true });
  });

  return router;
}
