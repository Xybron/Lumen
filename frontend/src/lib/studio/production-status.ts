import type { StudioRecording } from '../../../../shared/production';
import type { BroadcastSession } from '../../../../shared/broadcast';

export interface DesktopMemoryReading {
  available: boolean;
  bytes: number | null;
  processes: number;
  sampledAt: number;
  scope: 'desktop-processes';
  metric: 'working-set';
}
export interface DesktopProduction { memory(): Promise<DesktopMemoryReading> }
export function desktopProduction(): DesktopProduction | undefined {
  return typeof window === 'undefined' ? undefined : (window as Window & { lumenProduction?: DesktopProduction }).lumenProduction;
}
export function elapsedProductionTime(startedAt: string | undefined, now: number): string {
  const start = startedAt ? Date.parse(startedAt) : NaN;
  if (!Number.isFinite(start) || !Number.isFinite(now)) return '—';
  const seconds = Math.floor(Math.max(0, now - start) / 1000);
  return `${String(Math.floor(seconds / 3600)).padStart(2, '0')}:${String(Math.floor(seconds / 60) % 60).padStart(2, '0')}:${String(seconds % 60).padStart(2, '0')}`;
}
export function recordingStatus(recording: StudioRecording | null, now: number) {
  const state = recording?.status;
  return { active: state === 'recording', warning: state === 'error' || state === 'interrupted',
    text: state === 'recording' ? elapsedProductionTime(recording?.createdAt, now)
      : state === 'starting' ? 'Starting' : state === 'stopping' || state === 'finalizing' ? 'Finishing'
      : state === 'error' ? 'Error' : state === 'interrupted' ? 'Interrupted' : 'Off' };
}
export function liveStatus(session: BroadcastSession | null | undefined, now: number, starting = false) {
  const state = session?.state;
  return { active: state === 'live', warning: state === 'error',
    text: starting || state === 'starting' ? 'Connecting' : state === 'live' ? elapsedProductionTime(session?.startedAt, now)
      : state === 'stopping' ? 'Ending' : state === 'error' ? 'Interrupted' : 'Off air' };
}
export function memoryLabel(reading: DesktopMemoryReading | null): string {
  if (!reading?.available || !Number.isFinite(reading.bytes) || !reading.bytes || reading.bytes < 0 || reading.scope !== 'desktop-processes' || reading.metric !== 'working-set') return 'Unavailable';
  return reading.bytes >= 1024 ** 3 ? `${(reading.bytes / 1024 ** 3).toFixed(1)} GB` : `${Math.max(1, Math.round(reading.bytes / 1024 ** 2))} MB`;
}
