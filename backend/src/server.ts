import express from 'express';
import http from 'node:http';
import fs from 'node:fs/promises';
import path from 'node:path';
import { router } from './routes.js';
import { attachWebSocket } from './ws.js';
import { DATA_DIR, FRONTEND_DIST, MEDIA_DIR, MEDIA_KINDS } from './paths.js';

const PORT = Number(process.env.PORT ?? 3000);
const HOST = process.env.HOST ?? '127.0.0.1';

async function ensureDirs() {
  await fs.mkdir(DATA_DIR, { recursive: true });
  for (const kind of MEDIA_KINDS) {
    await fs.mkdir(path.join(MEDIA_DIR, kind), { recursive: true });
  }
}

async function main() {
  await ensureDirs();
  const app = express();
  app.use(express.json({ limit: '8mb' }));

  app.use('/api', router);

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

  const server = http.createServer(app);
  attachWebSocket(server, '/ws');

  server.listen(PORT, HOST, () => {
    console.log(`[lumen] listening on http://${HOST}:${PORT}`);
    console.log(`[lumen] websocket on ws://${HOST}:${PORT}/ws`);
    console.log(`[lumen] data dir: ${DATA_DIR}`);
  });
}

main().catch((err) => {
  console.error('[lumen] fatal:', err);
  process.exit(1);
});
