import type { ClipAsset, ClipDraft, ClipDraftInput, ClipExport, ClipExportOptions, ClipSourceRef, ClipWorkspace } from '../../../shared/clips';

export class ClipsRequestError extends Error {
  constructor(message: string, public status: number) { super(message); }
}
async function request<T>(path = '', method = 'GET', body?: unknown): Promise<T> {
  const response = await fetch(`/api/clips${path}`, {
    method, credentials: 'include',
    ...(body === undefined ? {} : { headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) }),
  });
  if (!response.ok) {
    const error = await response.json().catch(() => ({}));
    throw new ClipsRequestError(error.error || 'Could not reach the Clips workspace.', response.status);
  }
  return response.json();
}
export const clipsApi = {
  workspace: () => request<ClipWorkspace>(),
  create: (recordingId: string, input: ClipDraftInput) => request<ClipDraft>('/drafts', 'POST', { recordingId, ...input }),
  save: (id: string, revision: number, input: ClipDraftInput) => request<ClipDraft>(`/drafts/${encodeURIComponent(id)}`, 'PUT', { revision, ...input }),
  export: (id: string, revision: number, options?: ClipExportOptions, temporary = false) => request<ClipExport>(`/drafts/${encodeURIComponent(id)}/exports`, 'POST', { revision, ...(options ? { options } : {}), ...(temporary ? { temporary: true } : {}) }),
  cancel: (id: string) => request<ClipExport>(`/exports/${encodeURIComponent(id)}/cancel`, 'POST'),
  release: (id: string) => request<ClipExport>(`/exports/${encodeURIComponent(id)}/release`, 'POST'),
  exportPoster: (id: string) => `/api/clips/exports/${encodeURIComponent(id)}/thumbnail`,
  media: (id: string) => `/api/clips/recordings/${encodeURIComponent(id)}/media`,
  poster: (id: string) => `/api/clips/recordings/${encodeURIComponent(id)}/thumbnail`,
  download: (id: string) => `/api/clips/exports/${encodeURIComponent(id)}/download`,
  original: (id: string) => `/api/studio/recordings/${encodeURIComponent(id)}/download`,
  asset: (id: string) => `/api/clips/assets/${encodeURIComponent(id)}/media`,
  timelinePreview: (source: ClipSourceRef, type: 'frame' | 'waveform', atMs: number) => `/api/clips/timeline/${source.kind}/${encodeURIComponent(source.id)}/${type}?atMs=${Math.max(0, Math.round(atMs))}`,
  upload: async (file: File, metadata: { durationMs: number; width: number; height: number }, onProgress?: (progress: number) => void, signal?: AbortSignal): Promise<ClipAsset> => {
    if (file.size > 512 * 1024 * 1024) throw new ClipsRequestError('Choose media smaller than 512 MB.', 413);
    if (signal?.aborted) throw new ClipsRequestError('Media upload cancelled.', 0);
    const form = new FormData(); form.append('file', file);
    form.append('durationMs', String(Math.round(metadata.durationMs)));
    form.append('width', String(Math.round(metadata.width))); form.append('height', String(Math.round(metadata.height)));
    return new Promise((resolve, reject) => {
      const xhr = new XMLHttpRequest(); xhr.open('POST', '/api/clips/assets'); xhr.withCredentials = true;
      const abort = () => xhr.abort(); signal?.addEventListener('abort', abort, { once: true });
      xhr.timeout = 10 * 60 * 1000;
      xhr.onloadend = () => signal?.removeEventListener('abort', abort);
      xhr.ontimeout = () => reject(new ClipsRequestError('The upload timed out. Check the connection and try again.', 0));
      xhr.upload.onprogress = event => { if (event.lengthComputable) onProgress?.(event.loaded / event.total); };
      xhr.onerror = () => reject(new ClipsRequestError('Media upload failed. Check the station connection.', 0));
      xhr.onabort = () => reject(new ClipsRequestError('Media upload cancelled.', 0));
      xhr.onload = () => {
        let response; try { response = JSON.parse(xhr.responseText); } catch { reject(new ClipsRequestError('The station returned an invalid upload response.', xhr.status)); return; }
        if (xhr.status >= 200 && xhr.status < 300) resolve(response);
        else reject(new ClipsRequestError(response.error || 'Could not import this media file.', xhr.status));
      };
      xhr.send(form);
    });
  },
};
