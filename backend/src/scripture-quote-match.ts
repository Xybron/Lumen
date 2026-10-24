import type Database from 'better-sqlite3';
import type { ScriptureSelection } from '../../shared/worship.js';

export interface ScriptureQuoteMatch {
  selection: ScriptureSelection | null;
  /** Strength of the library-text match, not speech-recognition confidence. */
  score: number;
  eligible: boolean;
  reason: string;
}

interface Row { id: number; versionId: string; book: number; chapter: number; verse: number; endVerse?: number | null; text: string }
interface Run { length: number; heard: number; verse: number }
interface Alignment { matches: number; meaningful: number; edits: number; negationMismatch: boolean; start: number; end: number }
interface Candidate { row: Row; tokens: string[]; run: Run; alignment: Alignment; score: number }

const CONNECTORS = new Set([
  'a','an','the','and','or','but','to','of','in','on','at','for','from','by','with','as',
  'is','are','was','were','be','been','being','it','its','that','this','these','those',
  'which','who','whom','whose','i','me','my','we','our','us','you','your','he','him',
  'his','she','her','they','them','their','thy','thou','thine','thee','so','shall',
  'have','has','had','do','does','did','will','would','should','could','can','may',
  'might','must','unto','there','then','when','where','also','all','every','any',
]);
const NEGATIONS = new Set(['no','not','nor','never','neither','without','cannot','cant','dont','doesnt','didnt','wont','wouldnt','shouldnt','couldnt','isnt','wasnt','werent','arent','hasnt','hadnt','havent',
  // The FTS unicode tokenizer splits apostrophes. Retain its boundaries while
  // preserving the meaning of "don't", "isn't", etc. in alignment checks.
  'don','doesn','didn','won','wouldn','shouldn','couldn','isn','wasn','weren','aren','hasn','hadn','haven',
]);
const MAX_HEARD_WORDS = 96;
const MAX_VERSE_WORDS = 384;
const CANDIDATE_LIMIT = 128;
const BASE = `FROM verses_fts f JOIN verses v ON v.id=f.rowid WHERE verses_fts MATCH ? AND v.versionId=?`;

function words(text: string, limit: number) {
  // Keep the same apostrophe/punctuation boundaries as FTS; otherwise global
  // ambiguity probes could miss duplicate verses containing contractions.
  return (text.slice(0, 12000).toLowerCase().match(/[\p{L}\p{N}]+/gu) ?? []).slice(0, limit);
}
function negative(tokens: string[], index: number) { return NEGATIONS.has(tokens[index]) || (tokens[index] === 'can' && tokens[index + 1] === 't'); }
function meaningful(tokens: string[]) { return new Set(tokens.filter(word => word.length > 1 && !CONNECTORS.has(word))).size; }
function phrase(tokens: string[]) { return `"${tokens.join(' ')}"`; }
function phrases(tokens: string[], length: number, minimumMeaningful = 1) {
  const result = new Set<string>();
  for (let i = 0; i + length <= tokens.length; i++) {
    const part = tokens.slice(i, i + length);
    if (meaningful(part) >= minimumMeaningful) result.add(phrase(part));
  }
  return [...result];
}
function longestRun(heard: string[], verse: string[]): Run {
  let previous = new Uint16Array(verse.length + 1), best: Run = { length: 0, heard: 0, verse: 0 };
  for (let i = 1; i <= heard.length; i++) {
    const current = new Uint16Array(verse.length + 1);
    for (let j = 1; j <= verse.length; j++) if (heard[i - 1] === verse[j - 1]) {
      current[j] = previous[j - 1] + 1;
      if (current[j] > best.length) best = { length: current[j], heard: i - current[j], verse: j - current[j] };
    }
    previous = current;
  }
  return best;
}

/** Local ordered alignment identifies modest ASR differences for review only. */
function align(heard: string[], verse: string[]): Alignment {
  const width = verse.length + 1, scores = new Int16Array((heard.length + 1) * width), path = new Uint8Array(scores.length);
  let best = 0, bestAt = 0;
  for (let i = 1; i <= heard.length; i++) for (let j = 1; j <= verse.length; j++) {
    const at = i * width + j;
    const diagonal = scores[at - width - 1] + (heard[i - 1] === verse[j - 1] ? 3 : -2);
    const remove = scores[at - width] - 2, insert = scores[at - 1] - 2;
    const score = Math.max(0, diagonal, remove, insert);
    scores[at] = score;
    path[at] = !score ? 0 : score === diagonal ? 1 : score === remove ? 2 : 3;
    if (score > best) { best = score; bestAt = at; }
  }
  let i = Math.floor(bestAt / width), j = bestAt % width, matches = 0, edits = 0, negationMismatch = false;
  const end = i, content: string[] = [];
  while (i && j && path[i * width + j]) {
    const direction = path[i * width + j];
    if (direction === 1) {
      if (heard[i - 1] === verse[j - 1]) { matches++; content.push(heard[i - 1]); }
      else { edits++; negationMismatch ||= negative(heard, i - 1) || negative(verse, j - 1); }
      i--; j--;
    } else if (direction === 2) { edits++; negationMismatch ||= negative(heard, i - 1); i--; }
    else { edits++; negationMismatch ||= negative(verse, j - 1); j--; }
  }
  // A negative word right at an aligned quote boundary is significant too.
  // Do not turn "...shall preserve thy soul — not" into an exact quotation.
  const outside = [i - 1, end].filter(index => index >= 0 && negative(heard,index)).map(index => heard[index]);
  const verseOutside = [j - 1, bestAt % width].filter(index => index >= 0 && negative(verse,index)).map(index => verse[index]);
  if (outside.some(word => !verseOutside.includes(word))) negationMismatch = true;
  return { matches, meaningful: meaningful(content), edits, negationMismatch, start: i, end };
}

/**
 * Local alignment can correctly stop at the last unchanged word while hiding a
 * substituted last word ("...only begotten daughter"). Inspect the adjacent
 * continuation separately: a short changed ending, or a correlated continuation
 * which drops/adds a negative word, is not a clean exact quotation. Longer
 * unrelated sermon filler and ordinary interjections are not verse edits.
 */
function boundaryDifference(text: string, heard: string[], verse: string[], run: Run): 'negative' | 'wording' | null {
  const source = text.toLowerCase(), spans = [...source.matchAll(/[\p{L}\p{N}]+/gu)];
  const separated = (left: number, right: number, introduction = false) => {
    if (left < 0 || right >= spans.length) return false;
    const punctuation = source.slice(spans[left].index! + spans[left][0].length, spans[right].index!);
    return /[.!?]/.test(punctuation) || introduction && /[:;]/.test(punctuation);
  };
  const sides = [
    { spoken: heard.slice(run.heard + run.length), expected: verse.slice(run.verse + run.length), separateSentence: separated(run.heard + run.length - 1, run.heard + run.length) },
    { spoken: heard.slice(0, run.heard).reverse(), expected: verse.slice(0, run.verse).reverse(), separateSentence: separated(run.heard - 1, run.heard, true) },
  ];
  for (const { spoken, expected, separateSentence } of sides) {
    if (!spoken.length || !expected.length || spoken[0] === expected[0]) continue;
    const continuation = align(spoken.slice(0, 12), expected.slice(0, 16));
    if (continuation.matches >= 2 && continuation.negationMismatch) return 'negative';
    // Short words immediately replacing a verse ending/start are review-only.
    // Do not mistake a one-word worship interjection for a substituted noun.
    const interjection = spoken.length === 1 && ['amen','hallelujah','church','family','friends','beloved'].includes(spoken[0]);
    // Sentence-delimited commentary is outside the quotation, not a substituted
    // verse word. Correlated negative continuation above still needs review,
    // even if ASR inserted punctuation before it.
    if (spoken.length <= 3 && !interjection && !separateSentence && meaningful(spoken) > 0) return 'wording';
  }
  return null;
}

const empty = (reason: string): ScriptureQuoteMatch => ({ selection: null, score: 0, eligible: false, reason });

/**
 * Listening-only lookup. Every candidate and every ambiguity check starts with
 * the installed edition's FTS index. No corpus scan, fuzzy publication, model,
 * manual-search behaviour, output mutation or cross-edition substitution.
 */
export function matchScriptureQuote(db: Database.Database, versionId: string, text: string): ScriptureQuoteMatch {
  const heard = words(text, MAX_HEARD_WORDS + 1);
  // Bounds must not hide a contradictory ending and accidentally authorise a
  // truncated prefix. Ordinary five-second listening windows are much shorter.
  if (heard.length > MAX_HEARD_WORDS || text.length > 12000) return empty('Too much speech in one window to identify a quotation safely; waiting for a clearer phrase.');
  if (heard.length < 4 || meaningful(heard) < 2) return empty('Quotation is too short or common to identify a verse reliably.');
  const rows = new Map<number, Row>();
  const select = db.prepare(`SELECT v.id,v.versionId,v.book,v.chapter,v.verse,v.endVerse,v.text ${BASE} ORDER BY rank,v.id LIMIT ${CANDIDATE_LIMIT}`);
  const retrieve = (expressions: string[]) => {
    if (!expressions.length) return;
    for (const row of select.all(expressions.join(' OR '), versionId) as Row[]) rows.set(row.id, row);
  };
  // Exact long runs have their own query so many common short hits cannot bury
  // them in an arbitrary initial BM25 result window. All query terms are quoted.
  retrieve(phrases(heard, 8, 3));
  retrieve(phrases(heard, 4, 2));
  if (!rows.size) retrieve(phrases(heard, 3, 1));
  if (!rows.size) {
    const content = [...new Set(heard.filter(word => word.length > 1 && !CONNECTORS.has(word)))].slice(0, 24);
    // Two ordered neighbours need not survive ASR intact. Exact content pairs
    // may retrieve a suggestion, but this route can never make it eligible.
    retrieve(content.slice(0, -1).map((word, index) => `(${phrase([word])} AND ${phrase([content[index + 1]])})`));
  }
  if (!rows.size) return empty('No reliable quoted verse found in the selected version.');
  const candidates: Candidate[] = [...rows.values()].map(row => {
    const tokens = words(row.text, MAX_VERSE_WORDS), run = longestRun(heard, tokens), alignment = align(heard, tokens);
    // Ranking is lexical evidence, not probability. Exact contiguous evidence
    // dominates an unrelated verse with many scattered connector words.
    const score = Math.min(.99, run.length / 24 + alignment.matches / Math.max(heard.length, tokens.length) * .25 + Math.min(alignment.meaningful, 8) * .025);
    return { row, tokens, run, alignment, score };
  }).filter(candidate => candidate.alignment.matches >= 4 && candidate.alignment.meaningful >= 2 && candidate.alignment.matches / (candidate.alignment.matches + candidate.alignment.edits) >= .65)
    .sort((a, b) => b.run.length - a.run.length || b.score - a.score || a.row.id - b.row.id);
  const best = candidates[0];
  if (!best) return empty('Only weak quotation matches were found; waiting for clearer speech.');
  const selection: ScriptureSelection = { kind: 'scripture', versionId, book: best.row.book, chapter: best.row.chapter, verse: best.row.verse, ...(best.row.endVerse != null ? { endVerse: best.row.endVerse } : {}) };
  const result: ScriptureQuoteMatch = { selection, score: Math.round(best.score * 100) / 100, eligible: false, reason: '' };
  const quote = heard.slice(best.run.heard, best.run.heard + best.run.length);
  const boundary = boundaryDifference(text, heard, best.tokens, best.run);
  if (best.alignment.negationMismatch || boundary === 'negative') {
    result.reason = 'Possible quoted verse, but negative wording differs. Review before sending live.';
    return result;
  }
  if (best.run.length < 8 || meaningful(quote) < 3) {
    result.reason = best.alignment.edits ? 'Possible quoted verse with different wording. Prepared for review only.' : 'Quoted phrase is too short or common for automatic publishing. Prepared for review.';
    return result;
  }
  // If the ordered alignment extends the exact run with changed wording, it is
  // an approximate quote, not a licence to publish its unchanged prefix.
  if (boundary === 'wording' || best.alignment.edits && best.alignment.matches > best.run.length) {
    result.reason = 'Possible quoted verse with different wording. Prepared for review only.';
    return result;
  }
  const rival = db.prepare(`SELECT 1 ${BASE} AND v.id<>? LIMIT 1`);
  const other = (expressions: string[]) => expressions.length && !!rival.get(expressions.join(' OR '), versionId, best.row.id);
  // These independent indexed probes are deliberately NOT restricted to the
  // truncated ranked candidates. A duplicate/common phrase at row 30,000 still
  // prevents publication, as does a rival within a 20% exact-phrase margin.
  const marginLength = Math.max(6, Math.ceil(best.run.length * .8));
  if (other(phrases(quote, marginLength, 2))) {
    result.reason = 'Quoted wording is shared by multiple verses in this version. Choose the intended passage.';
    return result;
  }
  // Multiple independent long quotations in one window are not an instruction
  // to choose whichever ranked first. Search their complete indexed hit set.
  const independent = phrases(heard.slice(0, best.run.heard), 8, 3).concat(phrases(heard.slice(best.run.heard + best.run.length), 8, 3));
  if (other(independent)) {
    result.reason = 'More than one quoted verse was heard. Choose the intended passage.';
    return result;
  }
  result.eligible = true;
  result.score = Math.max(.9, result.score);
  result.reason = 'Distinctive exact quotation matched one verse in the selected version.';
  return result;
}
