export type ItemType =
  | 'scripture'
  | 'text'
  | 'image'
  | 'video'
  | 'section'
  | 'prayer'
  | 'prayer-sub'
  | 'lyrics'
  | 'announcement';

// A lyrics slide groups one or more stanzas (verse/chorus/bridge). `lines` is a
// single newline-delimited string so the editor stays a plain textarea.
export interface Stanza {
  id: string;
  label?: string; // "Verse 1", "Chorus", "Bridge"
  lines: string;
}
export type BackgroundKind = 'image' | 'video' | 'color' | 'gradient';
export type Mode = 'auto' | 'manual';
export type MusicMode = 'loop' | 'playlist' | 'off';

// A channel is a runtime presentation "lane": it has a kind, its own playback
// engine + projection output (`/live/:channelId`), an owner, and a route. It
// *references* a playlist for its content rather than owning items directly, so
// the deck content (playlists[]) stays the unit of record and the same playlist
// can back more than one channel.
export type ChannelKind = 'presentation' | 'prayer' | 'lyrics' | 'scripture' | 'announcement';

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
  stanzas?: Stanza[]; // lyrics
  subtitle?: string; // announcement secondary line (lower-third)
}

export interface Playlist {
  id: string;
  name: string;
  items: Item[];
}

export interface Channel {
  id: string; // chnl_xxxxxx
  name: string;
  kind: ChannelKind;
  playlistId: string; // -> Playlist.id
  defaultMode?: Mode;
}

// ── Routing-matrix seam ──────────────────────────────────────────────────────
// Every channel/mode is a Source; every screen/stream is a Destination; Routes
// connect them (directly, or via the Program/Preview bus). The switcher UI lands
// in a later phase — these IDs/shapes exist now so that phase needs no migration.
export type SourceKind = 'channel' | 'music' | 'media' | 'webrtc' | 'capture';

export interface Source {
  id: string; // src_xxxxxx
  kind: SourceKind;
  ref: string; // channelId | publisherId | agentInputId (agt:in) for capture
  label?: string; // for non-channel sources ("Stage Cam")
  // capture-only descriptor (authored/normalized — NOT live health, which is WS-only)
  capture?: {
    agentId: string;
    inputId: string;
    transport: 'ndi' | 'srt' | 'rtmp';
    signal: 'sdi' | 'hdmi' | 'ndi' | 'test' | 'file';
    label?: string;
  };
}

// ── Capture agent (Phase 5) ──────────────────────────────────────────────────
export interface AgentInput {
  inputId: string;
  label: string;
  signal: 'sdi' | 'hdmi' | 'ndi' | 'test' | 'file';
  transport: 'ndi' | 'srt' | 'rtmp';
}
export interface AgentInputHealth {
  inputId: string;
  state: 'idle' | 'streaming' | 'error' | 'no-signal';
}
export interface AgentSnapshot {
  agentId: string;
  name: string;
  status: 'online' | 'degraded' | 'offline';
  inputs: Array<AgentInput & { state?: AgentInputHealth['state'] }>;
}

export interface Destination {
  id: string; // dst_xxxxxx
  kind: 'screen' | 'stream' | 'preview';
  label: string;
  platform?: 'youtube' | 'facebook' | 'custom'; // stream-only (non-secret)
  enabled?: boolean; // operator toggle
}

// Live status of the media engine (egress/ingest), pushed by Express after
// polling the media sidecar. The stream key itself is NEVER here (SQLite only).
export interface EgressStatus {
  destinationId: string;
  state: 'idle' | 'connecting' | 'live' | 'error';
  uptimeSec: number;
  lastError?: string;
}

export interface Route {
  id: string; // route_xxxxxx
  sourceId: string;
  destinationId: string;
  via?: 'program' | 'preview' | 'direct';
}

export interface Program {
  programSourceId: string | null;
  previewSourceId: string | null;
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
  version: 1 | 2;
  updatedAt: string;
  settings: Settings;
  playlists: Playlist[];
  music: Music;
  // Populated by the backend's ensureChannels() normalizer on every read, so
  // these are always present at runtime even when loading a legacy v1 file.
  channels: Channel[];
  sources: Source[];
  destinations: Destination[];
  routes: Route[];
  program: Program;
}

export interface ProjectionState {
  cue?: Item | null;
  // Present only on server-authoritative Scripture/Lyrics projection states.
  // Used to hand off a Program route and its separately delivered cue safely.
  channelRevision?: number;
  channelId: string;
  playlistId: string | null;
  index: number;
  mode: Mode;
  playing: boolean;
  blanked: boolean;
  startedAt: number | null;
  durationMs: number;
}

export interface User {
  id: string;
  username: string;
  displayName: string;
  isAdmin: boolean;
}

export type Role = 'owner' | 'author' | 'viewer';

export interface RoleGrant {
  channelId: string; // '*' = all channels
  role: Role;
}

export interface PresenceEntry {
  userId: string;
  displayName: string;
  channels: string[]; // channels this client is viewing/controlling
}

// `channel` scopes a message to one channel's topic; messages without it (and
// the always-global music/content-updated/config/presence frames) route to the
// "__global__" topic so legacy clients keep working through the transition.
export type BroadcastMsg =
  | { t: 'mobile-channel-state'; channel: string; payload: ProjectionState }
  | { t: 'worship-state'; channel: string; workspace: import('../../shared/worship').WorshipWorkspace }
  | { t: 'hello'; channel?: string }
  | { t: 'state'; channel?: string; payload: ProjectionState }
  | { t: 'tick'; channel?: string; remainingMs: number; elapsedMs: number }
  | { t: 'cmd'; channel?: string; cmd: 'next' | 'prev' | 'pause' | 'play' | 'jump' | 'blank' | 'mode'; index?: number }
  | { t: 'config'; settings: Settings }
  | { t: 'music'; current: string | null; playing: boolean }
  | { t: 'content-updated'; updatedAt: string }
  | { t: 'media-added'; kind: 'backgrounds' | 'music'; pendingId: string; contributor?: string }
  | { t: 'mediastatus'; egress: EgressStatus[]; ingest: Array<{ sourceId: string; connected: boolean }> }
  | { t: 'agents'; agents: AgentSnapshot[] }
  | { t: 'subscribe'; channels: string[] }
  | { t: 'unsubscribe'; channels: string[] }
  | { t: 'auth'; session: string }
  | { t: 'presence'; online: PresenceEntry[]; owners: Record<string, string> }
  | { t: 'claim'; channel: string; userId: string }
  | { t: 'takeover'; channel: string; userId: string }
  // ── Program/Preview bus (global topic) ──
  | { t: 'program'; programSourceId: string | null; previewSourceId: string | null }
  // ── WebRTC signaling (topic = `webrtc:<publisherId>`) ──
  | { t: 'rtc-announce'; channel: string; publisherId: string; label: string; via: 'camera' | 'screen' }
  | { t: 'rtc-bye'; channel: string; publisherId: string }
  | { t: 'rtc-want'; channel: string; publisherId: string; viewerId: string }
  | { t: 'rtc-offer'; channel: string; publisherId: string; viewerId: string; sdp: string }
  | { t: 'rtc-answer'; channel: string; publisherId: string; viewerId: string; sdp: string }
  | {
      t: 'rtc-ice';
      channel: string;
      publisherId: string;
      viewerId: string;
      role: 'pub' | 'sub';
      candidate: RTCIceCandidateInit;
    };
