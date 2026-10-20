import { getDb } from './db.js';

// Data access for the media_staging table — pending phone/contributor uploads.

export interface StagingRow {
  id: string;
  filename: string;
  orig_name: string;
  mime: string | null;
  size: number | null;
  target_kind: string;
  contributor: string | null;
  thumbnail: string | null;
  status: string;
  created_at: string;
  decided_at: string | null;
  decided_by: string | null;
}

export function addPending(row: {
  id: string;
  filename: string;
  origName: string;
  mime: string | null;
  size: number | null;
  targetKind: string;
  contributor: string | null;
  thumbnail: string | null;
}) {
  getDb()
    .prepare(
      `INSERT INTO media_staging (id, filename, orig_name, mime, size, target_kind, contributor, thumbnail, status, created_at)
       VALUES (?,?,?,?,?,?,?,?,'pending',?)`,
    )
    .run(
      row.id,
      row.filename,
      row.origName,
      row.mime,
      row.size,
      row.targetKind,
      row.contributor,
      row.thumbnail,
      new Date().toISOString(),
    );
}

export function listPending(): StagingRow[] {
  return getDb()
    .prepare("SELECT * FROM media_staging WHERE status = 'pending' ORDER BY created_at DESC")
    .all() as StagingRow[];
}

export function getPending(id: string): StagingRow | undefined {
  return getDb().prepare('SELECT * FROM media_staging WHERE id = ?').get(id) as StagingRow | undefined;
}

export function markDecided(id: string, status: 'approved' | 'rejected', userId: string) {
  getDb()
    .prepare('UPDATE media_staging SET status = ?, decided_at = ?, decided_by = ? WHERE id = ?')
    .run(status, new Date().toISOString(), userId, id);
}
