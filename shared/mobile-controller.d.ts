import type { CueSelection } from './worship';

export interface MobilePermissions { studio: boolean; channels: boolean; audio: boolean }
export interface MobileDevice { id: string; name: string; permissions: MobilePermissions; expiresAt: number }
export interface MobileLease { id: string; deviceId: string; name: string; expiresAt: number }
export interface MobileScene {
  id: string; name: string; background: string;
  layers: { id: string; text: string; x: number; y: number; width: number; height: number; color: string; background: string; fontSize: number; align: 'left' | 'center' | 'right'; opacity: number }[];
}
export type MobileSelection = CueSelection | { kind: 'presentation'; index: number };
export interface MobileChannel {
  id: string; name: string; kind: string; revision: string;
  live: { title: string; text: string; reference: string } | null; blanked: boolean;
  items: { id: string; title: string; text: string; index: number }[]; versionId?: string;
  itemsTruncated?: boolean;
}
export interface MobileSnapshot {
  workspaceId: string; serverTime: number; ticket: string; ticketExpiresAt: number;
  device: MobileDevice; lease: MobileLease | null;
  production: { revision: number; previewSceneId: string | null; programId: string | null; scenes: MobileScene[]; program: MobileScene | null };
  engine: { state: 'offline' | 'starting' | 'running' | 'error'; fps: number; recording: boolean; streaming: boolean };
  mainAudio: { sourceId: string; name: string; volume: number; muted: boolean; masterMuted: boolean; status: string; level: number } | null;
  channels: MobileChannel[];
}
export type MobileAction =
  | { type: 'preview'; sceneId: string }
  | { type: 'take'; transition: 'cut' | 'fade'; durationMs?: number }
  | { type: 'main-audio'; muted?: boolean; volume?: number }
  | { type: 'channel-take'; channelId: string; selection: MobileSelection }
  | { type: 'channel-step'; channelId: string; direction: 1 | -1 }
  | { type: 'channel-blank'; channelId: string; blanked: boolean };
export interface MobileSessionStatus { paired: boolean; workspaceId: string; device?: MobileDevice }
export interface MobileManagement { enabled: boolean; workspaceId: string; url?: string; devices: MobileDevice[]; lease: MobileLease | null }
export interface MobilePairing { code: string; expiresAt: number; url?: string }
export interface MobileSearchResults { results: { title: string; text: string; selection: MobileSelection }[] }
