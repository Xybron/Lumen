import express from 'express';
import http from 'node:http';
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { router } from './routes.js';
import { identityRouter } from './identity-routes.js';
import { createMediaRouter } from './media-routes.js';
import { initDb } from './db.js';
import { attachWebSocket } from './ws.js';
import { attachAgentSocket, createAgentRouter } from './agent-ws.js';
import { startVpsBridge } from './vps-bridge.js';
import { startMediaStatusPoller } from './media-engine.js';
import { createProduction } from './production.js';
import { createWorship } from './worship.js';
import { DATA_DIR, FRONTEND_DIST, INCOMING_DIR, MEDIA_DIR, MEDIA_KINDS } from './paths.js';
import { acquireStationLock } from './station-lock.js';

async function ensureDirs() {
  await fs.mkdir(DATA_DIR, { recursive: true });
  for (const kind of MEDIA_KINDS) {
    await fs.mkdir(path.join(MEDIA_DIR, kind), { recursive: true });
  }
  await fs.mkdir(INCOMING_DIR, { recursive: true });
}

export interface LumenServerOptions {
  port?: number;
  host?: string;
  rendererUrl?: string;
  development?: boolean;
  productionDependencies?: Parameters<typeof createProduction>[2];
}

export async function startLumenServer(options: LumenServerOptions = {}) {
  const PORT = options.port ?? Number(process.env.PORT ?? 3000), HOST = options.host ?? process.env.HOST ?? '127.0.0.1';
  if (!Number.isInteger(PORT) || PORT < 1 || PORT > 65535) throw new Error('Choose a valid backend port.');
  const lease = await acquireStationLock(DATA_DIR);
  const cleanup: Array<() => unknown | Promise<unknown>> = []; let closing: Promise<void> | null = null;
  const close = () => closing ??= (async () => {
    let failure: unknown;
    try { for (const stop of cleanup.reverse()) try { await stop(); } catch (error) { failure ??= error; } }
    finally { await lease.release(); }
    if (failure) throw failure;
  })();
  try {
  await ensureDirs();
  initDb(); // identity/ops store (SQLite at DATA_DIR/lumen.db) + seed admin
  const app = express();
  app.use(express.json({ limit: '20mb' }));

  // The WS relay/handle is created up front so the media router can emit the
  // `media-added` signal through it. Adding routes after server creation is fine
  // — Express dispatches at request time.
  const server = http.createServer(app);
  cleanup.push(() => new Promise<void>(resolve => { if (!server.listening) { resolve(); return; } server.close(() => resolve()); server.closeAllConnections(); }));
  const relay = attachWebSocket();
  cleanup.push(() => { for (const client of relay.wss.clients) client.terminate(); relay.wss.close(); });
  const worship = await createWorship(relay);
  cleanup.push(() => worship.close());
  const agentWss = attachAgentSocket(relay); // capture agents (header-token auth)
  cleanup.push(() => { for (const client of agentWss.clients) client.terminate(); agentWss.close(); });
  const localHost = ['0.0.0.0', '::'].includes(HOST) ? '127.0.0.1' : HOST.includes(':') ? `[${HOST}]` : HOST;
  const production = await createProduction({
    backendUrl: `http://${localHost}:${PORT}`,
    configuredUrl: options.rendererUrl ?? process.env.LUMEN_RENDERER_URL,
    development: options.development ?? (process.argv[1]?.endsWith('.ts') ?? false),
  }, worship.sceneCueGates, options.productionDependencies);
  cleanup.push(() => production.close());

  // Route WebSocket upgrades by path to the right server (both use noServer).
  server.on('upgrade', (req, socket, head) => {
    const pathname = (req.url ?? '').split('?')[0];
    if (pathname === '/ws') {
      relay.wss.handleUpgrade(req, socket, head, (ws) => relay.wss.emit('connection', ws, req));
    } else if (pathname === '/agent') {
      agentWss.handleUpgrade(req, socket, head, (ws) => agentWss.emit('connection', ws, req));
    } else if (pathname === '/studio/ws') {
      production.wss.handleUpgrade(req, socket, head, (ws) => production.wss.emit('connection', ws, req));
    } else {
      socket.destroy();
    }
  });

  startVpsBridge(relay); // no-op unless LUMEN_VPS_URL is configured
  startMediaStatusPoller(relay); // no-op unless LUMEN_MEDIA_CTRL is configured

  app.use('/api', identityRouter);
  app.use('/api', production.router);
  app.use('/api', worship.router);
  app.use('/api', router);
  app.use('/api', createMediaRouter(relay));
  app.use('/api', createAgentRouter(relay));

  // Quarantine: never serve un-approved staging uploads via the public /media
  // mount (they're reachable only through authenticated /api/staging endpoints).
  app.use('/media/incoming', (_req, res) => res.status(404).end());

  // Static media — served with long-lived cache; filenames are timestamped on upload.
  app.use(
    '/media',
    express.static(MEDIA_DIR, {
      maxAge: '7d',
      fallthrough: false,
    }),
  );

  // Serve built SPA in production.
  try {
    await fs.access(FRONTEND_DIST);
    app.use(express.static(FRONTEND_DIST));
    app.get('*', (_req, res) => res.sendFile(path.join(FRONTEND_DIST, 'index.html')));
  } catch {
    // dev mode — Vite handles the SPA on its own port
  }

  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(PORT, HOST, () => { server.off('error', reject); resolve(); });
  });
    console.log(`[lumen] listening on http://${HOST}:${PORT}`);
    console.log(`[lumen] websocket on ws://${HOST}:${PORT}/ws`);
    console.log(`[lumen] data dir: ${DATA_DIR}`);
  return { server, close };
  } catch (error) { await close().catch(() => {}); throw error; }
}

async function main() {
  let startup: ReturnType<typeof startLumenServer>;
  let shuttingDown = false;
  const shutdown = () => {
    if (shuttingDown) return;
    shuttingDown = true;
    void startup.then(server => server.close()).catch(error => console.error('[studio] Shutdown:', error)).finally(() => process.exit(0));
    setTimeout(() => process.exit(0), 5000).unref();
  };
  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);
  startup = startLumenServer();
  await startup;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) void main().catch((err) => {
  console.error('[lumen] fatal:', err);
  process.exit(1);
});
