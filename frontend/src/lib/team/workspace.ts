/** The selected cloud workspace is never station authority. Only this read-only,
 * server-issued identity may say which workspace a provisioned station belongs to. */
import type { StationWorkspace } from '../../../../shared/workspace';
export type { StationWorkspace } from '../../../../shared/workspace';

const canonicalId = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const unavailable = 'The station workspace could not be verified. Reconnect to this station and try again; no draft was transferred.';
const changed = 'The active account or workspace changed. Select the workspace again before copying drafts to or from this station.';

export function parseStationWorkspace(value: unknown): StationWorkspace {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error(unavailable);
  const row = value as Record<string, unknown>;
  if (typeof row.id !== 'string' || !canonicalId.test(row.id)
    || typeof row.createdAt !== 'string' || row.createdAt.length > 40 || !Number.isFinite(Date.parse(row.createdAt))
    || typeof row.mode !== 'string' || !['local', 'provisioned'].includes(row.mode) || typeof row.configured !== 'boolean'
    || row.configured !== (row.mode === 'provisioned')
    || typeof row.message !== 'string' || row.message.length > 500) throw new Error(unavailable);
  return { id: row.id, createdAt: row.createdAt, mode: row.mode as StationWorkspace['mode'], configured: row.configured, message: row.message };
}

export async function loadStationWorkspace(fetcher: typeof fetch = fetch): Promise<StationWorkspace> {
  try {
    const response = await fetcher('/api/workspace', { credentials: 'include', cache: 'no-store', signal: AbortSignal.timeout(8000) });
    if (!response.ok) throw new Error(unavailable);
    return parseStationWorkspace(await response.json());
  } catch { throw new Error(unavailable); }
}

export function assertStationWorkspaceAllowsImport(value: unknown, teamId: string): StationWorkspace {
  if (!canonicalId.test(teamId)) throw new Error(changed);
  const station = parseStationWorkspace(value);
  if (station.configured && station.id !== teamId) {
    throw new Error('This station belongs to a different workspace. Switch to its provisioned workspace before copying drafts to or from it. Your cloud drafts and this station were not changed.');
  }
  return station;
}

/** Check fresh station metadata for transfers in either direction, not a UI cache
 * or browser ID. A late response cannot transfer drafts for an old team. */
export async function checkStationWorkspaceImport(teamId: string, isCurrent: () => boolean, fetcher: typeof fetch = fetch): Promise<StationWorkspace> {
  if (!isCurrent()) throw new Error(changed);
  const station = await loadStationWorkspace(fetcher);
  if (!isCurrent()) throw new Error(changed);
  return assertStationWorkspaceAllowsImport(station, teamId);
}
