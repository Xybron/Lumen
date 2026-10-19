import http from 'node:http';
import type { EgressStatus, SidecarStatus, IngestStatus } from './contract.js';

// ── Lumen media sidecar — STUB ──────────────────────────────────────────────
// Implements the full control contract with coherent fake state so the entire
// control path (Vue → Express → sidecar → status → dashboard ON-AIR pill) is
// exercisable with no ffmpeg/MediaMTX/RTMP CDN. The real implementation replaces
// the bodies of start/stopEgress, registerIngest, and setProgram — the HTTP
// surface stays identical, so Express never changes.

const PORT = Number(process.env.LUMEN_MEDIA_PORT ?? 7401);
const HOST = '127.0.0.1';

interface Egress {
  destinationId: string;
  state: EgressStatus['state'];
  startedAt: number;
  rtmpUrl: string;
}

const egress = new Map<string, Egress>();
const ingest = new Map<string, IngestStatus>();
let programSourceUrl: string | null = null;

function status(): SidecarStatus {
  const now = Date.now();
  return {
    egress: [...egress.values()].map((e) => ({
      destinationId: e.destinationId,
      state: e.state,
      uptimeSec: e.state === 'live' ? Math.round((now - e.startedAt) / 1000) : 0,
    })),
    ingest: [...ingest.values()],
    programSourceUrl,
  };
}

function readJson(req: http.IncomingMessage): Promise<Record<string, unknown>> {
  return new Promise((resolve) => {
    let body = '';
    req.on('data', (c) => (body += c));
    req.on('end', () => {
      try {
        resolve(body ? JSON.parse(body) : {});
      } catch {
        resolve({});
      }
    });
  });
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url ?? '/', `http://${HOST}:${PORT}`);
  const send = (code: number, obj: unknown) => {
    res.writeHead(code, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify(obj));
  };

  try {
    if (url.pathname === '/healthz') {
      return send(200, { ok: true, ffmpeg: false, mediamtx: false, version: 'stub-0.1', stub: true });
    }
    if (url.pathname === '/status' && req.method === 'GET') {
      return send(200, status());
    }
    if (url.pathname === '/program' && req.method === 'POST') {
      const b = await readJson(req);
      programSourceUrl = typeof b.programSourceUrl === 'string' ? b.programSourceUrl : null;
      return send(200, { ok: true });
    }
    if (url.pathname === '/egress' && req.method === 'POST') {
      const b = await readJson(req);
      const destinationId = String(b.destinationId);
      const e: Egress = { destinationId, state: 'connecting', startedAt: Date.now(), rtmpUrl: String(b.rtmpUrl ?? '') };
      egress.set(destinationId, e);
      // Simulate the connect → live transition a real encoder would go through.
      setTimeout(() => {
        const cur = egress.get(destinationId);
        if (cur && cur.state === 'connecting') {
          cur.state = 'live';
          cur.startedAt = Date.now();
        }
      }, 1500);
      console.log(`[lumen-media-stub] egress start ${destinationId} → ${e.rtmpUrl} (faked)`);
      return send(200, { ok: true, destinationId });
    }
    const egDel = url.pathname.match(/^\/egress\/(.+)$/);
    if (egDel && req.method === 'DELETE') {
      egress.delete(decodeURIComponent(egDel[1]));
      return send(200, { ok: true });
    }
    if (url.pathname === '/ingest/whip' && req.method === 'POST') {
      const b = await readJson(req);
      const sourceId = String(b.sourceId);
      ingest.set(sourceId, { sourceId, connected: true });
      return send(200, { whipUrl: `http://${HOST}:${PORT}/whip/${sourceId}` });
    }
    const inDel = url.pathname.match(/^\/ingest\/(.+)$/);
    if (inDel && req.method === 'DELETE') {
      ingest.delete(decodeURIComponent(inDel[1]));
      return send(200, { ok: true });
    }
    send(404, { error: 'not found' });
  } catch (e) {
    send(500, { error: String(e) });
  }
});

server.listen(PORT, HOST, () => {
  console.log(`[lumen-media-stub] control API on http://${HOST}:${PORT} — STUB (no real ffmpeg / MediaMTX / RTMP)`);
});
