// The control contract between the Lumen Express backend (the only client) and
// the media sidecar. The sidecar is ingest/encoder-agnostic by design: today a
// STUB, later MediaMTX + ffmpeg (or LiveKit). Express never exposes the sidecar
// port — it proxies/translates under /api/media/stream/*, gated by auth.

export interface SidecarHealth {
  ok: boolean;
  ffmpeg: boolean;
  mediamtx: boolean;
  version: string;
  stub: boolean;
}

export type EgressState = 'idle' | 'connecting' | 'live' | 'error';

export interface EgressStatus {
  destinationId: string;
  state: EgressState;
  uptimeSec: number;
  lastError?: string;
}

export interface IngestStatus {
  sourceId: string;
  connected: boolean;
}

export interface SidecarStatus {
  egress: EgressStatus[];
  ingest: IngestStatus[];
  programSourceUrl: string | null;
}

export interface StartEgressBody {
  destinationId: string;
  rtmpUrl: string;
  streamKey: string;
  programSourceUrl: string; // e.g. http://127.0.0.1:3000/out/<destinationId>
  bitrateKbps?: number;
  fps?: number;
}
