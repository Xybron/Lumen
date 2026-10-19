import { getDb } from './db.js';

// Stream egress targets. The stream_key is a SECRET — `listTargets()` and any
// client-reachable read MUST NOT include it. `getTargetSecret()` is the only
// path that returns the key, used server-side when starting an egress.

export interface StreamTargetPublic {
  destinationId: string;
  platform: string;
  rtmpUrl: string;
  hasKey: boolean;
}

interface TargetRow {
  destination_id: string;
  platform: string;
  rtmp_url: string;
  stream_key: string;
}

export function upsertTarget(destinationId: string, platform: string, rtmpUrl: string, streamKey: string) {
  const now = new Date().toISOString();
  getDb()
    .prepare(
      `INSERT INTO stream_targets (destination_id, platform, rtmp_url, stream_key, created_at, updated_at)
       VALUES (?,?,?,?,?,?)
       ON CONFLICT(destination_id) DO UPDATE SET platform=excluded.platform, rtmp_url=excluded.rtmp_url, stream_key=excluded.stream_key, updated_at=excluded.updated_at`,
    )
    .run(destinationId, platform, rtmpUrl, streamKey, now, now);
}

// Public list — NEVER includes the stream key.
export function listTargets(): StreamTargetPublic[] {
  const rows = getDb()
    .prepare('SELECT destination_id, platform, rtmp_url, stream_key FROM stream_targets')
    .all() as TargetRow[];
  return rows.map((r) => ({
    destinationId: r.destination_id,
    platform: r.platform,
    rtmpUrl: r.rtmp_url,
    hasKey: !!r.stream_key,
  }));
}

// Server-side only — returns the full secret for starting an egress.
export function getTargetSecret(destinationId: string): { rtmpUrl: string; streamKey: string; platform: string } | null {
  const r = getDb()
    .prepare('SELECT platform, rtmp_url, stream_key FROM stream_targets WHERE destination_id = ?')
    .get(destinationId) as { platform: string; rtmp_url: string; stream_key: string } | undefined;
  return r ? { rtmpUrl: r.rtmp_url, streamKey: r.stream_key, platform: r.platform } : null;
}

export function deleteTarget(destinationId: string) {
  getDb().prepare('DELETE FROM stream_targets WHERE destination_id = ?').run(destinationId);
}

// Drop secret keys for stream destinations that no longer exist (called after a
// content.json write so removing a destination doesn't orphan its secret).
export function pruneOrphanTargets(validDestinationIds: string[]) {
  const valid = new Set(validDestinationIds);
  const db = getDb();
  const rows = db.prepare('SELECT destination_id FROM stream_targets').all() as Array<{ destination_id: string }>;
  const del = db.prepare('DELETE FROM stream_targets WHERE destination_id = ?');
  for (const r of rows) if (!valid.has(r.destination_id)) del.run(r.destination_id);
}
