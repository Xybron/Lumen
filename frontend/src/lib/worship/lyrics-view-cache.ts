import type { LyricsSearchHit, Song } from '../../../../shared/worship';

export interface LyricsViewState {
  query: string;
  songs: Song[];
  allSongs: Song[];
  songMatches: Record<string, LyricsSearchHit['match']>;
  selectedSongId: string;
  selectedSongSnapshot: Song | null;
  rememberedSongs: Record<string, Song>;
  completedSearch: string;
  scroll: { library: number; setlist: number; results: number; cues: number };
}

// Route changes recreate the lyrics component. Keep its operator workspace in
// memory until a full page reload, while the channel's live state stays in its
// authoritative store.
export const lyricsViews = new Map<string, LyricsViewState>();
window.addEventListener('lumen:data-cleared', () => lyricsViews.clear());
