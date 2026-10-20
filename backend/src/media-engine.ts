import type { RelayHandle } from './ws.js';

// Express-side client for the media sidecar. Config-gated by LUMEN_MEDIA_CTRL
// (e.g. "127.0.0.1:7401"); with it unset the media engine is OFFLINE and every
// stream control returns 503 — the station stays fully functional, mirroring the
// vps-bridge offline-tolerance ethos. Express is the ONLY client of the sidecar.

const CTRL = process.env.LUMEN_MEDIA_CTRL;
const PORT = process.env.PORT ?? '3000';

export interface SidecarEgress {
  destinationId: string;
  state: 'idle' | 'connecting' | 'live' | 'error';
  uptimeSec: number;
  lastError?: string;
}
export interface SidecarStatus {
  egress: SidecarEgress[];
  ingest: Array<{ sourceId: string; connected: boolean }>;
  programSourceUrl: string | null;
}

export function mediaEngineEnabled(): boolean {
  return !!CTRL;
}

async function call(path: string, init?: RequestInit): Promise<Response | null> {
  if (!CTRL) return null;
  try {
    return await fetch(`http://${CTRL}${path}`, init);
  } catch {
    return null;
  }
}

export async function getStatus(): Promise<SidecarStatus | null> {
  const r = await call('/status');
  if (!r || !r.ok) return null;
  return (await r.json()) as SidecarStatus;
}

export async function startEgress(body: {
  destinationId: string;
  rtmpUrl: string;
  streamKey: string;
  programSourceUrl: string;
}): Promise<boolean> {
  const r = await call('/egress', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  return !!r && r.ok;
}

export async function stopEgress(destinationId: string): Promise<boolean> {
  const r = await call(`/egress/${encodeURIComponent(destinationId)}`, { method: 'DELETE' });
  return !!r && r.ok;
}

export async function registerWhip(sourceId: string): Promise<{ whipUrl: string } | null> {
  const r = await call('/ingest/whip', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ sourceId }),
  });
  if (!r || !r.ok) return null;
  return (await r.json()) as { whipUrl: string };
}

// The program-capture source URL the sidecar pulls (Lumen's own destination
// output, rendered headlessly by the real engine).
export function programSourceUrl(destinationId: string): string {
  return `http://127.0.0.1:${PORT}/out/${destinationId}`;
}

// Poll the sidecar and republish `mediastatus` to all clients via the relay, so
// the dashboard ON-AIR pill is live. No-op when the engine is disabled.
export function startMediaStatusPoller(relay: RelayHandle): void {
  if (!CTRL) {
    console.log('[lumen] media engine: disabled (LUMEN_MEDIA_CTRL unset)');
    return;
  }
  console.log(`[lumen] media engine: enabled → ${CTRL}`);
  setInterval(async () => {
    const s = await getStatus();
    if (s) relay.injectRemote({ t: 'mediastatus', egress: s.egress, ingest: s.ingest });
  }, 2000);
}
