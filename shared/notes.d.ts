export type NotesLayout = 'general' | 'statement' | 'quote' | 'key-points';
export interface NotesBackground {
  kind: 'image' | 'video' | 'color' | 'gradient'; src?: string; color?: string; gradient?: string;
  fit?: 'cover' | 'contain' | 'fill'; overlayOpacity?: number; loop?: boolean; muted?: boolean; volume?: number;
}
export interface NotesTypography { size?: 'sm' | 'md' | 'lg' | 'xl' | '2xl'; align?: 'left' | 'center' | 'right'; weight?: number }
export interface NotesDraft {
  title: string; body: string; reference: string; layout: NotesLayout;
  /** Optional for documents saved before the live Notes editor. */
  grouping?: 'single' | 'pointers'; background?: NotesBackground; typography?: NotesTypography;
}
export interface NotesSegment { id: number; sessionId: string; sequence: number; text: string; receivedAt: string; uncertain: boolean }
export interface NotesDocument { channelId: string; itemId: string; revision: number; updatedAt: string; draft: NotesDraft; segments: NotesSegment[] }
export interface NotesListeningSession { id: string; channelId: string; itemId: string; expiresAt: number; provider?: 'local' | 'assemblyai' }
export interface NotesListeningLink { sessionId: string | null; linked: boolean; afterTurn: number; segments: NotesSegment[] }
