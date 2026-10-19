import type { ProductionState, StudioCommand, StudioRecording, StudioStatus } from '../../../../shared/production';

export async function studioRequest<T>(path: string, init?: RequestInit): Promise<T> {
  const response = await fetch(`/api/studio${path}`, { credentials: 'include', ...init,
    headers: { ...(typeof init?.body === 'string' ? { 'Content-Type': 'application/json' } : {}), ...init?.headers },
  });
  if (!response.ok) {
    const data = await response.json().catch(() => ({ error: response.statusText }));
    throw new Error(data.error || `${response.status} ${response.statusText}`);
  }
  return response.json();
}
export const studioApi = {
  get: () => studioRequest<ProductionState>(''),
  status: () => studioRequest<StudioStatus>('/status'),
  diagnostics: () => studioRequest<unknown>('/diagnostics'),
  save: (state: ProductionState) => studioRequest<ProductionState>('', { method: 'PUT', body: JSON.stringify(state) }),
  command: (revision: number, command: StudioCommand) => studioRequest<ProductionState>('/command', { method: 'POST', body: JSON.stringify({ revision, command }) }),
  start: () => studioRequest<StudioStatus>('/engine/start', { method: 'POST' }),
  stop: () => studioRequest<StudioStatus>('/engine/stop', { method: 'POST' }),
  recordings: () => studioRequest<StudioRecording[]>('/recordings'),
  record: (name: string) => studioRequest<StudioRecording>('/recordings', { method: 'POST', body: JSON.stringify({ name }) }),
  stopRecording: (id: string) => studioRequest(`/recordings/${id}/stop`, { method: 'POST' }),
  recover: (id: string) => studioRequest(`/recordings/${id}/recover`, { method: 'POST' }),
};
