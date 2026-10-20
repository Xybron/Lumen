import type { BroadcastConfigInput, BroadcastDestinationId, BroadcastPreflight, BroadcastSnapshot } from '../../../shared/broadcast';

const BASE = '/api/studio/broadcast';
async function request<T>(path: string, signal?: AbortSignal, method = 'GET', body?: unknown, timeoutMs = 15000): Promise<T> {
  const controller = new AbortController(); let timedOut = false;
  const abort = () => controller.abort();
  if (signal?.aborted) controller.abort(); else signal?.addEventListener('abort', abort, { once: true });
  const timeout = setTimeout(() => { timedOut = true; controller.abort(); }, timeoutMs);
  try {
    const response = await fetch(`${BASE}${path}`, { method, credentials: 'include', signal: controller.signal, ...(body === undefined ? {} : { headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) }) });
    if (!response.ok) { const result = await response.json().catch(() => null); throw new Error(typeof result?.error === 'string' ? result.error : `Stream request failed (${response.status}).`); }
    return await response.json();
  } catch (cause) { if (timedOut) throw new Error('The station took too long to respond. Check Go Live for the current stream status before trying again.'); throw cause; }
  finally { clearTimeout(timeout); signal?.removeEventListener('abort', abort); }
}
export const broadcastApi = {
  snapshot: (signal?: AbortSignal) => request<BroadcastSnapshot>('', signal),
  preflight: (signal?: AbortSignal) => request<BroadcastPreflight>('/preflight', signal),
  configure: (config: BroadcastConfigInput, signal?: AbortSignal) => request<BroadcastSnapshot>('/config', signal, 'PUT', config),
  start: (record: boolean, title?: string, signal?: AbortSignal) => request<BroadcastSnapshot>('/start', signal, 'POST', { record, ...(title?.trim() ? { title: title.trim().slice(0, 100) } : {}) }, 75000),
  stop: (stopRecording: boolean, signal?: AbortSignal) => request<BroadcastSnapshot>('/stop', signal, 'POST', { stopRecording }, 20000),
  retry: (id: BroadcastDestinationId | 'watch', signal?: AbortSignal) => request<BroadcastSnapshot>(`/destinations/${id}/retry`, signal, 'POST', {}),
  stopDestination: (id: BroadcastDestinationId | 'watch', signal?: AbortSignal) => request<BroadcastSnapshot>(`/destinations/${id}/stop`, signal, 'POST', {}),
};
