import type { PresentationDocumentImport, PresentationDocumentJob } from '../../../shared/presentation-documents';
export type { PresentationDocumentImport, PresentationDocumentJob, PresentationDocumentKind } from '../../../shared/presentation-documents';

const base = '/api/presentation-documents';
async function json<T>(response: Response): Promise<T> {
  const value = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(value.error || 'Document import could not reach this station.');
  return value as T;
}
export const presentationDocuments = {
  capabilities: () => fetch(`${base}/capabilities`, { credentials: 'include' }).then(response => json<{ pdf: boolean; powerpoint: boolean; maxBytes: number; maxPages: number }>(response)),
  async start(file: File, channelId: string, signal?: AbortSignal) {
    const body = new FormData(); body.append('file', file);
    return json<PresentationDocumentJob>(await fetch(`${base}?channelId=${encodeURIComponent(channelId)}`, { method: 'POST', credentials: 'include', body, signal }));
  },
  get: (id: string, signal?: AbortSignal) => fetch(`${base}/${encodeURIComponent(id)}`, { credentials: 'include', signal }).then(response => json<PresentationDocumentJob>(response)),
  commit: (id: string, pages: number[]) => fetch(`${base}/${encodeURIComponent(id)}/commit`, { method: 'POST', credentials: 'include', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ pages }) }).then(response => json<PresentationDocumentImport>(response)),
  async remove(id: string) { await fetch(`${base}/${encodeURIComponent(id)}`, { method: 'DELETE', credentials: 'include' }); },
};
