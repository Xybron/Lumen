export type BroadcastProfile = '720p' | '1080p';
export type BroadcastMode = 'local-watch';
export type BroadcastDestinationId = 'youtube' | 'facebook' | 'instagram';
export type BroadcastSinkState = 'disabled' | 'unconfigured' | 'connecting' | 'live' | 'retrying' | 'stopped' | 'error';
export interface BroadcastIncident {
  at: string;
  reason: 'input-stalled' | 'input-backlog' | 'encoder-exit' | 'source-stalled' | 'destinations-failed';
  encoder: 'worker-h264' | 'videotoolbox' | 'mediafoundation' | 'software' | null;
  encoderFailure: 'protocol' | 'certificate' | 'publish-rejected' | 'network' | 'encoder' | 'input' | 'storage' | 'backpressure' | 'unknown';
  profile: BroadcastProfile;
  destinations: number;
  queuedBytes: number;
  pendingInputBytes: number;
  maxInputWaitMs: number;
  inputAgeMs: number | null;
  outputAgeMs: number | null;
}
export interface BroadcastConfig {
  profile: BroadcastProfile;
  recordOnStart: boolean;
  /** Instagram exposes its non-secret server URL and whether a separate key is saved. */
  destinations: Array<{ id: BroadcastDestinationId; enabled: boolean; configured: boolean; streamUrl?: string; hasKey?: boolean }>;
  watch: { enabled: boolean; configured: boolean; publicUrl?: string };
}
export interface BroadcastConfigInput {
  profile?: BroadcastProfile;
  recordOnStart?: boolean;
  destinations?: Array<{ id: BroadcastDestinationId; enabled: boolean; streamUrl?: string; streamKey?: string; clearKey?: boolean }>;
  watch?: { enabled: boolean };
}
export interface BroadcastSinkStatus {
  id: BroadcastDestinationId | 'watch';
  state: BroadcastSinkState;
  retries: number;
  bytes: number;
  error?: string;
}
export interface BroadcastSession {
  id: string;
  profile: BroadcastProfile;
  state: 'starting' | 'live' | 'stopping' | 'stopped' | 'error';
  startedAt: string;
  stoppedAt?: string;
  chunks: number;
  bytes: number;
  lastChunkAt?: string;
  destinations: BroadcastSinkStatus[];
  watch: BroadcastSinkStatus & { publicUrl?: string };
  error?: string;
}
export interface BroadcastPreflight {
  ready: boolean;
  checks: Array<{ id: string; ok: boolean; message: string; severity?: 'warning' | 'error' | 'info' }>;
  estimatedUploadKbps: number;
}
export interface BroadcastSnapshot {
  /** Marks a local Watch relay, without restricting public streaming destinations. Never a saved setting. */
  mode?: BroadcastMode;
  config: BroadcastConfig;
  session: BroadcastSession | null;
  preflight: BroadcastPreflight;
  production?: {
    engineState: 'offline' | 'starting' | 'running' | 'error';
    programName?: string;
    mainAudioName?: string;
    masterMuted: boolean;
    recording: import('./production.js').StudioRecording | null;
  };
}
