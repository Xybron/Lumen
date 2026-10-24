export interface BibleVersion {
  id: string; name: string; language: string; attribution: string; verseCount: number; installed: boolean;
}
export interface Verse { versionId: string; book: number; bookName: string; chapter: number; verse: number; endVerse?: number; text: string }
export interface ScriptureSearchReference { book: number; chapter?: number; verse?: number; endVerse?: number; complete: boolean }
export interface ScriptureSearchChoice { reference: ScriptureSearchReference; label: string; match: 'exact' | 'prefix' | 'corrected' }
export interface ScriptureSearchResult {
  verses: Verse[];
  reference: ScriptureSearchReference | null;
  resolution: {
    kind: 'reference' | 'ambiguous' | 'text' | 'invalid';
    label: string | null;
    match: 'exact' | 'prefix' | 'corrected' | 'ambiguous' | null;
    suggestions: ScriptureSearchChoice[];
  };
  keywordMode: 'keywords' | 'relaxed' | null;
  ignoredWords: string[];
}
export interface ScriptureSelection { kind: 'scripture'; versionId: string; book: number; chapter: number; verse: number; endVerse?: number }
export interface LyricSelection { kind: 'lyrics'; songId: string; sectionId: string }
export type CueSelection = ScriptureSelection | LyricSelection;
export interface SongSection { id: string; label: string; text: string }
export interface Song { id: string; revision: number; title: string; author: string; copyright: string; sections: SongSection[]; updatedAt: string }
export interface LyricsSearchHit {
  song: Song;
  match: { kind: 'title' | 'lyrics'; sectionId: string | null; excerpt: string; corrected: boolean };
}
export interface LiveCue { selection: CueSelection; title: string; text: string; reference: string; attribution: string; takenAt: string }
export interface WorshipTheme { background: string; color: string; size: 'sm' | 'md' | 'lg' | 'xl' | '2xl'; align: 'left' | 'center' | 'right' }
export interface WorshipWorkspace {
  channelId: string; revision: number; versionId: string; setlist: string[]; recent: CueSelection[];
  live: LiveCue | null; blanked: boolean; theme: WorshipTheme;
}
export type WorshipCommand =
  | { type: 'take'; selection: CueSelection }
  | { type: 'step'; direction: 1 | -1 }
  | { type: 'blank'; value: boolean }
  | { type: 'version'; versionId: string }
  | { type: 'setlist'; songIds: string[] }
  | { type: 'theme'; theme: WorshipTheme };
export interface ListeningModelProfile {
  id: string; label: string; description: string; installed: boolean; downloadMiB: number; multilingual: boolean;
}
export interface ListeningStatus {
  state: 'unavailable' | 'stopped' | 'starting' | 'ready' | 'error'; model: string; error?: string; local: true;
  modelId: string; profiles: ListeningModelProfile[]; decoding: 'beam-search';
}
export interface ListeningSession {
  id: string; channelId: string; mode: 'assisted' | 'automatic'; language: string; commands: boolean; expiresAt: number;
}
export type ListeningDecision = 'listening' | 'prepared' | 'sent-live' | 'already-live' | 'partial' | 'review' | 'conflict' | 'unavailable' | 'cooldown' | 'stale';
export interface ListeningResult {
  transcript: string; elapsedMs: number; candidate: LiveCue | null; match: 'reference' | 'phrase' | 'lyrics' | 'command' | 'none';
  score: number; switched: boolean; reason: string; workspace: WorshipWorkspace;
  decision: ListeningDecision;
  suggestedQuery?: string;
}
