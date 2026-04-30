export type ItemType =
  | 'scripture'
  | 'text'
  | 'image'
  | 'video'
  | 'section'
  | 'prayer'
  | 'prayer-sub';
export type BackgroundKind = 'image' | 'video' | 'color' | 'gradient';
export type Mode = 'auto' | 'manual';
export type MusicMode = 'loop' | 'playlist' | 'off';

export interface Background {
  kind: BackgroundKind;
  src?: string;
  color?: string;
  gradient?: string;
  fit?: 'cover' | 'contain' | 'fill';
  overlayOpacity?: number;
}

export interface Typography {
  size?: 'sm' | 'md' | 'lg' | 'xl' | '2xl';
  align?: 'left' | 'center' | 'right';
  weight?: number;
}

export interface Item {
  id: string;
  type: ItemType;
  title?: string;
  body?: string;
  reference?: string;
  durationMs: number;
  background?: Background;
  typography?: Typography;
  color?: string;
}

export interface Playlist {
  id: string;
  name: string;
  items: Item[];
}

export interface Settings {
  defaultDurationMs: number;
  warningAtMs: number;
  countdownAtMs: number;
  transitionMs: number;
  fontFamily: string;
  globalFontScale: number;
}

export interface Music {
  mode: MusicMode;
  volume: number;
  fadeInMs: number;
  fadeOutMs: number;
  current?: string;
  queue: string[];
}

export interface Content {
  version: 1;
  updatedAt: string;
  settings: Settings;
  playlists: Playlist[];
  music: Music;
}

export interface ProjectionState {
  playlistId: string | null;
  index: number;
  mode: Mode;
  playing: boolean;
  blanked: boolean;
  startedAt: number | null;
  durationMs: number;
}

export type BroadcastMsg =
  | { t: 'hello' }
  | { t: 'state'; payload: ProjectionState }
  | { t: 'tick'; remainingMs: number; elapsedMs: number }
  | { t: 'cmd'; cmd: 'next' | 'prev' | 'pause' | 'play' | 'jump' | 'blank' | 'mode'; index?: number }
  | { t: 'config'; settings: Settings }
  | { t: 'music'; current: string | null; playing: boolean }
  | { t: 'content-updated'; updatedAt: string };
