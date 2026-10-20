import type { StudioRecording } from './production';

export type ClipFormat = '16:9' | '9:16' | '1:1';
export interface ClipExportOptions {
  container: 'mp4' | 'webm' | 'mov' | 'mp3' | 'wav';
  resolution: '1080p' | '720p';
}
export interface ClipSourceRef { kind: 'recording' | 'asset'; id: string }
export interface ClipTransition {
  kind: 'dissolve' | 'wipe-left' | 'wipe-right' | 'slide-left' | 'slide-right';
  durationMs: number;
}
export interface ClipTimelineItem {
  id: string;
  name: string;
  kind: 'video' | 'image' | 'audio' | 'text';
  source?: ClipSourceRef;
  startMs: number;
  inMs: number;
  durationMs: number;
  // Fractions of the output frame; tracks are composited bottom to top.
  x: number;
  y: number;
  width: number;
  height: number;
  fit: 'cover' | 'contain';
  positionX: number;
  positionY: number;
  opacity: number;
  volume: number;
  muted: boolean;
  text: string;
  fontSize: number;
  fontWeight: number;
  color: string;
  background: string;
  align: 'left' | 'center' | 'right';
  // Owned by the incoming visual item; its first frames truly overlap its
  // previous neighbour without changing either source trim or duration.
  transitionIn?: ClipTransition;
  audioFadeInMs?: number;
  audioFadeOutMs?: number;
}
export interface ClipTimelineTrack {
  id: string;
  name: string;
  kind: 'video' | 'audio' | 'text';
  muted: boolean;
  hidden: boolean;
  locked: boolean;
  items: ClipTimelineItem[];
}
export interface ClipTimeline {
  version: 1;
  background: string;
  tracks: ClipTimelineTrack[];
}
export interface ClipAsset {
  id: string;
  name: string;
  kind: 'video' | 'image' | 'audio';
  mime: string;
  bytes: number;
  durationMs: number;
  width: number;
  height: number;
  ownerId: string;
  ownerName: string;
  createdAt: string;
}
export interface ClipSettings {
  inMs: number;
  outMs: number;
  format: ClipFormat;
  fit: 'cover' | 'contain';
  // Normalised position within the available crop; .5 centres the source.
  positionX: number;
  positionY: number;
  // Absent in legacy single-range drafts. Saving a multi-track project keeps
  // its immutable timeline alongside the original trim for compatibility.
  timeline?: ClipTimeline;
}
export interface ClipRecording extends StudioRecording {
  width?: number;
  height?: number;
  posterReady: boolean;
}
export interface ClipDraft extends ClipSettings {
  id: string;
  recordingId: string;
  name: string;
  revision: number;
  ownerId: string;
  ownerName: string;
  createdAt: string;
  updatedAt: string;
  canEdit: boolean;
}
export type ClipDraftInput = ClipSettings & { name: string };
export interface ClipExport {
  id: string;
  draftId: string;
  draftRevision: number;
  recordingId: string;
  name: string;
  ownerId: string;
  status: 'queued' | 'waiting-live' | 'exporting' | 'complete' | 'cancelled' | 'error' | 'interrupted';
  progress: number;
  createdAt: string;
  completedAt?: string;
  bytes: number;
  error?: string;
  settings: ClipSettings;
  // Absent on legacy exports: MP4 / 1080p. Kept on the immutable job, not the draft.
  options?: ClipExportOptions;
  // Destination-first exports are scratch files, not permanent library copies.
  temporary?: boolean;
  expiresAt?: string;
  deliveredAt?: string;
  expiredAt?: string;
  posterReady?: boolean;
  canCancel: boolean;
}
export interface ClipWorkspace {
  recordings: ClipRecording[];
  drafts: ClipDraft[];
  exports: ClipExport[];
  liveProtected: boolean;
  blockReason: string | null;
  assets?: ClipAsset[];
}
