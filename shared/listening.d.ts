import type { ListeningResult } from './worship.js';

/** One active audio producer, independent of the workspaces consuming it. */
export interface SharedListeningSession {
  id: string;
  channelId: string;
  source: 'scripture' | 'notes';
  ownerId: string;
  provider: 'assemblyai';
  mode?: 'assisted' | 'automatic';
  startedAt: number;
  state: 'starting' | 'listening' | 'finishing';
  linkedNotes: number;
}

/** Latest transient update only; linking Notes never replays earlier speech. */
export interface SharedListeningSnapshot {
  session: SharedListeningSession | null;
  result: ListeningResult | null;
  final: boolean;
  turn: number;
}
