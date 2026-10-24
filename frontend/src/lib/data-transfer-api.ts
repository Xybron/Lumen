import type { ClearPreview, ClearResult, TransferCatalog, TransferPreview, TransferResult, TransferSelection } from '../../../shared/data-transfer';

const BASE = '/api/data-transfer';
export const TRANSFER_FILE_LIMIT = 1024 ** 4;

export class DataTransferError extends Error {
  constructor(message: string, readonly status: number) { super(message); }
}

async function response(path: string, options: RequestInit = {}) {
  const result = await fetch(`${BASE}${path}`, { credentials: 'include', ...options });
  if (!result.ok) {
    const body = await result.json().catch(() => null);
    throw new DataTransferError(typeof body?.error === 'string' ? body.error : `The transfer could not be completed (${result.status}).`, result.status);
  }
  return result;
}

function archiveName(value: unknown) {
  let name = typeof value === 'string' ? value : '';
  name = name.replace(/[\x00-\x1f\x7f/\\]/g, '_').slice(0, 180);
  return name.toLowerCase().endsWith('.lumen') ? name : `lumen-${new Date().toISOString().slice(0, 10)}.lumen`;
}

export const dataTransferApi = {
  async catalog(signal?: AbortSignal): Promise<TransferCatalog> {
    return (await response('/catalog', { signal })).json();
  },
  async export(selection: TransferSelection, signal?: AbortSignal): Promise<{ downloadUrl: string; filename: string }> {
    const result = await response('/export', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(selection), signal });
    const value = await result.json();
    if (typeof value?.downloadUrl !== 'string') throw new Error('The archive download is unavailable. Please try again.');
    const url = new URL(value.downloadUrl, window.location.origin);
    if (url.origin !== window.location.origin || !/^\/api\/data-transfer\/download\/[a-zA-Z0-9-]+$/.test(url.pathname)) throw new Error('The archive download address is invalid.');
    return { downloadUrl: url.href, filename: archiveName(value.filename) };
  },
  async preview(file: File, signal?: AbortSignal): Promise<TransferPreview> {
    if (file.size > TRANSFER_FILE_LIMIT) throw new Error('Choose a .lumen file no larger than 1 TB.');
    if (!file.name.toLowerCase().endsWith('.lumen')) throw new Error('Choose a Lumen archive ending in .lumen.');
    return (await response('/preview', {
      method: 'POST', headers: { 'Content-Type': 'application/octet-stream', 'X-Lumen-Filename': encodeURIComponent(file.name) }, body: file, signal,
    })).json();
  },
  async import(token: string, selection: TransferSelection): Promise<TransferResult> {
    return (await response('/import', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ token, selection }) })).json();
  },
  async discard(token: string) {
    const result = await fetch(`${BASE}/preview/${encodeURIComponent(token)}`, { credentials: 'include', method: 'DELETE', keepalive: true });
    if (!result.ok && result.status !== 404 && result.status !== 410) throw new DataTransferError('The temporary preview could not be removed.', result.status);
  },
  async clearCatalog(signal?: AbortSignal): Promise<TransferCatalog> {
    return (await response('/clear/catalog', { signal })).json();
  },
  async previewClear(selection: TransferSelection, signal?: AbortSignal): Promise<ClearPreview> {
    return (await response('/clear/preview', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ selection }), signal })).json();
  },
  async clear(token: string, confirmation: string): Promise<ClearResult> {
    return (await response('/clear', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ token, confirmation }) })).json();
  },
  async discardClear(token: string) {
    const result = await fetch(`${BASE}/clear/preview/${encodeURIComponent(token)}`, { credentials: 'include', method: 'DELETE', keepalive: true });
    if (!result.ok && result.status !== 404 && result.status !== 410) throw new DataTransferError('The clear preview could not be removed.', result.status);
  },
};
