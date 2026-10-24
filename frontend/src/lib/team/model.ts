export type ResourceKind = 'scene' | 'presentation' | 'scripture' | 'lyrics';
export type TeamRole = 'owner' | 'editor' | 'viewer';
export interface TeamResource { id: string; team_id: string; kind: ResourceKind; name: string; document: Record<string, unknown>; revision: number; updated_at: string; updated_by?: string }
export interface Team { id: string; name: string }
export interface TeamConflict { id: string; resource_id: string; team_id: string; kind: ResourceKind; name: string; document: Record<string, unknown>; serverDocument: Record<string, unknown> | null; revision: number; message: string }
export interface TeamPeer { sessionId: string; userId: string; name: string; surface: string; x: number; y: number; color: string; updatedAt: number }
export interface TeamConfig { enabled: boolean; supabaseUrl?: string; publishableKey?: string; powerSyncUrl?: string; projectRef?: string; isolated?: boolean }

// A draft cannot contain runtime state, credentials, device bindings or commands.
// This is defense in depth; the database independently validates every write.
const forbidden = /^(?:__proto__|prototype|constructor|program|previewSceneId|programSceneId|mainAudioSourceId|masterMuted|masterVolume|sources|routes|destinations|audio|streamKey|stream_key|password|token|secret|deviceId|device_id|command|credentials|session|key|src|url|sourceId)$/i;
export function validateDraft(document: unknown): asserts document is Record<string, unknown> {
  if (!document || typeof document !== 'object' || Array.isArray(document)) throw new Error('A shared draft must be an object.');
  if ((document as Record<string, unknown>).schemaVersion !== 1) throw new Error('This draft needs schemaVersion 1.');
  if (JSON.stringify(document).length > 250_000) throw new Error('Keep shared text and design drafts below 250 KB. Media stays on its station.');
  const visit = (value: unknown, depth: number) => {
    if (depth > 12) throw new Error('This draft is too deeply nested.');
    if (!value || typeof value !== 'object') return;
    for (const [name, child] of Object.entries(value)) {
      if (forbidden.test(name)) throw new Error(`“${name}” is station-only and cannot be shared.`);
      visit(child, depth + 1);
    }
  };
  visit(document, 0);
}

export function overlayPending(remote: TeamResource[], pending: Array<{ resource_id: string; value: string }>): TeamResource[] {
  const values = new Map(remote.map(row => [row.id, row]));
  for (const operation of pending) values.set(operation.resource_id, JSON.parse(operation.value) as TeamResource);
  return [...values.values()].sort((a, b) => a.name.localeCompare(b.name));
}
