import type { ListeningResult } from '../../shared/worship.js';
import type { WorshipLibrary } from './worship-library.js';

/** Read-only suggestions from an existing transcript; never takes a cue live. */
export function suggestSharedLyrics(library: WorshipLibrary, channelId: string, transcript: string, final: boolean): ListeningResult {
  const workspace = library.workspace(channelId);
  const matches = library.matchLyricsLibrary(transcript, workspace.setlist);
  const best = matches[0];
  const candidate = best && best.score >= .6 ? library.cue(best.selection) : null;
  const distinct = !!candidate && best.score >= .9 && (!matches[1] || best.score - matches[1].score >= .15);
  return {
    transcript, elapsedMs: 0, workspace, candidate,
    match: candidate ? 'lyrics' : 'none', score: candidate ? best.score : 0, switched: false,
    decision: candidate ? final && distinct ? 'prepared' : 'review' : 'listening',
    reason: candidate ? 'Possible song and section. Prepare it to review; nothing has changed live.'
      : 'No match yet. Listening for recognizable sung words from songs saved in your library.',
  };
}
