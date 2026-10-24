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
import { createTeamConfigRouter } from './team-config.js';
import { resolveStationWorkspace } from './workspace.js';
import { createMobileController, mobileGatewayFromEnv } from './mobile-controller.js';
import { ContentSchema, type Content } from './schema.js';
import { ensureChannels } from './migrate-content.js';
import { CONTENT_FILE } from './paths.js';

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
  // Refuse a tenant mismatch before opening any auth, content or live stores.
  // The station lease supplies the canonical directory and startup authority.
  const workspace = await resolveStationWorkspace(lease.canonical);
  const mobileGateway = await mobileGatewayFromEnv();
  await ensureDirs();
  initDb(); // identity/ops store (SQLite at DATA_DIR/lumen.db) + seed admin
  const app = express();
  app.use(express.json({ limit: '20mb' }));
  app.use('/api', createTeamConfigRouter());
  app.get('/api/workspace', (_req, res) => res.set('Cache-Control', 'private, no-store').json(workspace));

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
  const localOrigins = [`http://${localHost}:${PORT}`, `http://127.0.0.1:5173`, `http://localhost:5173`];
  const configuredRenderer = options.rendererUrl ?? process.env.LUMEN_RENDERER_URL;
  if (configuredRenderer) {
    const origin = new URL(configuredRenderer);
    if (['localhost', '127.0.0.1', '[::1]'].includes(origin.hostname)) localOrigins.push(origin.origin);
  }
  let mobileContentCache: { stamp: string; content: Content } | undefined;
  const contentStamp = async () => { const stat = await fs.stat(CONTENT_FILE, { bigint: true }); return `${stat.dev}:${stat.ino}:${stat.mtimeNs}:${stat.size}`; };
  async function mobileContent() {
    // Atomic content saves change the inode, while in-place edits change the
    // high-resolution mtime/size. A fresh stat still runs for every operation;
    // unchanged polls reuse the validated immutable object and its full digest.
    for (let attempt = 0; attempt < 2; attempt++) {
      const before = await contentStamp();
      if (mobileContentCache?.stamp === before) return mobileContentCache.content;
      const content = ContentSchema.parse(ensureChannels(JSON.parse(await fs.readFile(CONTENT_FILE, 'utf8'))));
      if (before !== await contentStamp()) continue;
      mobileContentCache = { stamp: before, content }; return content;
    }
    throw new Error('Station content changed while loading. Refresh the phone view.');
  }
  const mobile = await createMobileController({
    workspaceId: workspace.id, production: production.mobile, worship: worship.mobile, relay,
    content: mobileContent,
    frontendDir: FRONTEND_DIST, allowedLocalOrigins: localOrigins, gateway: mobileGateway,
    attachProgramViewer: production.mobile.attachProgramViewer,
  });
  cleanup.push(() => mobile.close());
  app.use('/api', mobile.router);

  // Route WebSocket upgrades by path to the right server (both use noServer).
  server.on('upgrade', (req, socket, head) => {
    const pathname = (req.url ?? '').split('?')[0];
    if (pathname === '/ws') {
      relay.wss.handleUpgrade(req, socket, head, (ws) => relay.wss.emit('connection', ws, req));
    } else if (pathname === '/agent') {
      agentWss.handleUpgrade(req, socket, head, (ws) => agentWss.emit('connection', ws, req));
    } else if (pathname === '/studio/ws') {
      production.wss.handleUpgrade(req, socket, head, (ws) => production.wss.emit('connection', ws, req));
    } else if (pathname === '/mobile/signal') {
      mobile.handleUpgrade(req, socket, head);
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
  return { server, close, workspace };
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
