import type Database from 'better-sqlite3';
import type { LyricsSearchHit, Song } from '../../shared/worship.js';

// Manual song finding deliberately lives separately from matchLyrics(). Fuzzy
// operator suggestions must never broaden automatic listening/publication rules.
const RESULT_LIMIT = 100;
const TITLE_CANDIDATES = 120;
const LYRIC_CANDIDATES = 240;
const VOCABULARY_LIMIT = 30_000;
const CORRECTION_LIMIT = 8;
const FUZZY_CANDIDATES = 256;
const EXCERPT_LENGTH = 168;
const NEGATIONS = new Set([
  'not', 'no', 'nor', 'never', 'without', 'cannot', 'neither', 'nothing', 'nobody', 'nowhere',
  'cant', 'wont', 'dont', 'isnt', 'wasnt', 'werent', 'arent', 'couldnt', 'shouldnt', 'wouldnt',
  'didnt', 'doesnt', 'hasnt', 'havent', 'hadnt', 'mustnt',
]);

interface Word { value: string; start: number; end: number }
interface Alternative { value: string; distance: number }
interface Term { value: string; documents: number }
interface Vocabulary {
  dataVersion: number;
  terms: Term[];
  sorted: string[];
  deletes: Map<string, number[]>;
  grams: Map<string, number[]>;
}
interface MatchScore { corrected: boolean; distance: number; phrase: number; span: number; positions: number[] }
interface RankedHit { songId: string; title: string; match: LyricsSearchHit['match']; score: number[] }
type SongRow = Omit<Song, 'sections'> & { sections: string };
const vocabularies = new WeakMap<Database.Database, Vocabulary>();

function normalized(value: string) {
  return value.normalize('NFKD').replace(/\p{M}/gu, '').toLocaleLowerCase('en');
}
function exactToken(value: string) { return value.length === 1 || NEGATIONS.has(value); }
function words(value: string): Word[] {
  // Match SQLite unicode61 token boundaries; punctuation is never FTS syntax.
  return [...value.matchAll(/[\p{L}\p{N}][\p{L}\p{M}\p{N}]*/gu)].map(match => ({
    value: normalized(match[0]), start: match.index!, end: match.index! + match[0].length,
  }));
}
function deletes(value: string) {
  const characters = Array.from(value);
  return new Set([value, ...characters.map((_, index) => characters.slice(0, index).join('') + characters.slice(index + 1).join(''))]);
}
function grams(value: string) {
  const characters = Array.from(value);
  return new Set(characters.slice(0, -2).map((_, index) => characters.slice(index, index + 3).join('')));
}
function append(index: Map<string, number[]>, key: string, id: number) {
  const posting = index.get(key);
  if (posting) posting.push(id); else index.set(key, [id]);
}

/** Call only after committing a song edit/import/deletion. Channel cue writes
 * intentionally do not invalidate this index. Other connections are detected by
 * SQLite data_version, including edits with the same song ID. */
export function invalidateLyricsSearch(db: Database.Database) { vocabularies.delete(db); }

/** Build the derived section index once for an existing library. Table creation
 * and backfill share one transaction, so interruption cannot leave an apparently
 * installed but empty index. Call after creating the ordinary songs table. */
export function ensureLyricsSearchIndex(db: Database.Database) {
  db.transaction(() => {
    if (db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='song_sections_fts'").get()) return;
    db.exec("CREATE VIRTUAL TABLE song_sections_fts USING fts5(songId UNINDEXED,sectionId UNINDEXED,body,prefix='2 3 4')");
    db.exec(`INSERT INTO song_sections_fts(songId,sectionId,body)
      SELECT song.id,json_extract(section.value,'$.id'),json_extract(section.value,'$.text')
      FROM songs song,json_each(song.sections) section`);
  })();
}

/** Maintain the derived index inside the same transaction as the song/FTS edit.
 * The caller invalidates the typo vocabulary only after that commit succeeds. */
export function updateLyricsSearchIndex(db: Database.Database, song: Song) {
  db.prepare('DELETE FROM song_sections_fts WHERE songId=?').run(song.id);
  const insert = db.prepare('INSERT INTO song_sections_fts(songId,sectionId,body) VALUES(?,?,?)');
  for (const section of song.sections) insert.run(song.id, section.id, section.text);
}

function vocabulary(db: Database.Database): Vocabulary {
  const dataVersion = db.pragma('data_version', { simple: true }) as number;
  const cached = vocabularies.get(db);
  if (cached?.dataVersion === dataVersion) return cached;
  // fts5vocab reads distinct indexed words, not every section's complete text.
  // A bounded, frequency-first typo vocabulary cannot make prefix/exact search
  // incomplete: those paths always query the entire FTS index directly.
  const terms = (db.prepare(`SELECT term AS value,doc AS documents FROM songs_vocab
    WHERE length(term) BETWEEN 3 AND 40 ORDER BY doc DESC,term LIMIT ${VOCABULARY_LIMIT}`).all() as Term[])
    .filter(term => /^[\p{L}\p{N}]+$/u.test(term.value));
  const result: Vocabulary = { dataVersion, terms, sorted: terms.map(term => term.value).sort(), deletes: new Map(), grams: new Map() };
  terms.forEach((term, id) => {
    for (const key of deletes(term.value)) append(result.deletes, key, id);
    for (const key of grams(term.value)) append(result.grams, key, id);
  });
  vocabularies.set(db, result);
  return result;
}

function lowerBound(values: string[], value: string) {
  let low = 0, high = values.length;
  while (low < high) { const middle = (low + high) >>> 1; if (values[middle] < value) low = middle + 1; else high = middle; }
  return low;
}

/** Banded optimal-string-alignment distance includes the common adjacent
 * transposition ("graec"), and stops before work can grow with a long input. */
function distance(left: string, right: string, maximum: number) {
  const a = Array.from(left), b = Array.from(right);
  if (Math.abs(a.length - b.length) > maximum) return maximum + 1;
  let previousPrevious: number[] = [], previous = Array.from({ length: b.length + 1 }, (_, index) => index);
  for (let i = 1; i <= a.length; i++) {
    const current = Array(b.length + 1).fill(maximum + 1) as number[];
    current[0] = i;
    let smallest = maximum + 1;
    for (let j = Math.max(1, i - maximum); j <= Math.min(b.length, i + maximum); j++) {
      current[j] = Math.min(previous[j] + 1, current[j - 1] + 1, previous[j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1));
      if (i > 1 && j > 1 && a[i - 1] === b[j - 2] && a[i - 2] === b[j - 1]) current[j] = Math.min(current[j], previousPrevious[j - 2] + 1);
      smallest = Math.min(smallest, current[j]);
    }
    if (smallest > maximum) return maximum + 1;
    previousPrevious = previous; previous = current;
  }
  return previous[b.length];
}

function corrections(term: string, index: Vocabulary): Alternative[] {
  const size = Array.from(term).length;
  if (size < 3 || size > 40 || NEGATIONS.has(term) || /^\p{N}+$/u.test(term)) return [];
  const prefixIndex = lowerBound(index.sorted, term);
  // A valid typed word/prefix is not changed merely because a different query
  // word contains a typo. This prevents "love" silently becoming "live".
  if (index.sorted[prefixIndex]?.startsWith(term)) return [];
  const candidates = new Set<number>();
  for (const key of deletes(term)) {
    for (const id of index.deletes.get(key) ?? []) {
      candidates.add(id); if (candidates.size >= FUZZY_CANDIDATES) break;
    }
    if (candidates.size >= FUZZY_CANDIDATES) break;
  }
  // Rare trigrams recover longer two-edit words and a typo followed by an
  // unfinished word. Never scan the full vocabulary or unbounded common grams.
  const postings = [...grams(term)].map(key => index.grams.get(key) ?? []).filter(posting => posting.length)
    .sort((a, b) => a.length - b.length).slice(0, 3);
  for (const posting of postings) {
    for (const id of posting.slice(0, 512)) {
      if (candidates.size >= FUZZY_CANDIDATES) break;
      candidates.add(id);
    }
  }
  const maximum = size >= 8 ? 2 : 1;
  const matches: (Alternative & { documents: number })[] = [];
  for (const id of candidates) {
    const candidate = index.terms[id];
    const characters = Array.from(candidate.value);
    if (characters.length < size - maximum) continue;
    let cost = distance(term, candidate.value, maximum);
    // For longer unfinished words, allow one typo within the prefix. The FTS
    // alternative still uses the concrete indexed word, never a broad wildcard.
    if (size >= 5 && characters.length > size) {
      for (const length of [size - 1, size, size + 1]) cost = Math.min(cost, distance(term, characters.slice(0, length).join(''), maximum));
    }
    if (cost <= maximum) matches.push({ value: candidate.value, distance: Math.max(1, cost), documents: candidate.documents });
  }
  return matches.sort((a, b) => a.distance - b.distance || b.documents - a.documents || a.value.localeCompare(b.value))
    .slice(0, CORRECTION_LIMIT).map(({ value, distance }) => ({ value, distance }));
}

function compareScore(left: number[], right: number[]) {
  for (let index = 0; index < Math.max(left.length, right.length); index++) {
    const difference = (left[index] ?? 0) - (right[index] ?? 0);
    if (difference) return difference;
  }
  return 0;
}
function score(text: string, tokens: string[], alternatives: Alternative[][]): MatchScore | null {
  const source = words(text), positions: number[] = [], matched: number[][] = [];
  let totalDistance = 0;
  for (let termIndex = 0; termIndex < tokens.length; termIndex++) {
    let best = Number.POSITIVE_INFINITY;
    const indices: number[] = [];
    source.forEach((word, wordIndex) => {
      const token = tokens[termIndex];
      const cost = (exactToken(token) ? word.value === token : word.value.startsWith(token)) ? 0 : alternatives[termIndex].find(alternative => alternative.value === word.value)?.distance;
      if (cost === undefined || cost > best) return;
      if (cost < best) { best = cost; indices.length = 0; }
      indices.push(wordIndex);
    });
    if (!indices.length) return null;
    matched.push(indices); positions.push(...indices.map(index => source[index].start)); totalDistance += best;
  }
  // Ordered consecutive words are more useful than a loose unordered match;
  // otherwise retain every query word rather than falling back to OR results.
  const phrase = matched[0].some(start => matched.every((indices, index) => indices.includes(start + index))) ? 0 : 1;
  const ordered = matched.flatMap((indices, term) => indices.map(position => ({ position, term }))).sort((a, b) => a.position - b.position);
  const counts = Array(tokens.length).fill(0) as number[];
  let covered = 0, begin = 0, span = source.length;
  for (let end = 0; end < ordered.length; end++) {
    if (!counts[ordered[end].term]++) covered++;
    while (covered === tokens.length) {
      span = Math.min(span, ordered[end].position - ordered[begin].position);
      if (!--counts[ordered[begin++].term]) covered--;
    }
  }
  return { corrected: totalDistance > 0, distance: totalDistance, phrase, span, positions };
}

function excerpt(text: string, positions: number[]) {
  if (text.length <= EXCERPT_LENGTH) return text.replace(/\s+/g, ' ').trim();
  const ordered = [...new Set(positions)].sort((a, b) => a - b);
  let start = 0, best = -1, first = 0, last = 0;
  for (const position of ordered) {
    const candidate = Math.min(Math.max(0, position - 36), text.length - EXCERPT_LENGTH);
    while (first < ordered.length && ordered[first] < candidate) first++;
    while (last < ordered.length && ordered[last] < candidate + EXCERPT_LENGTH) last++;
    const count = last - first;
    if (count > best) { best = count; start = candidate; }
  }
  let end = start + EXCERPT_LENGTH;
  // Keep original spelling/case and avoid half a word or surrogate pair at the
  // excerpt edges. The full original section remains in the Song payload.
  if (start > 0) {
    const boundary = text.slice(start, start + 24).search(/\s/u);
    if (boundary >= 0) start += boundary + 1;
    else if (/^[\uDC00-\uDFFF]$/.test(text[start])) start++;
  }
  if (end < text.length) {
    const boundary = text.slice(Math.max(start, end - 24), end).lastIndexOf(' ');
    if (boundary >= 0) end = Math.max(start, end - 24) + boundary;
    else if (/^[\uD800-\uDBFF]$/.test(text[end - 1])) end--;
  }
  return `${start ? '…' : ''}${text.slice(start, end).replace(/\s+/g, ' ').trim()}${end < text.length ? '…' : ''}`;
}

/** Fast, read-only manual search. FTS prefix/AND lookup covers the full library;
 * bounded typo expansion is a fallback. Every lyric result must match within a
 * single section, so its sectionId always identifies an actual useful cue. */
export function searchLyrics(db: Database.Database, query: string): LyricsSearchHit[] {
  const tokens = [...new Set(words(query.slice(0, 500)).map(word => word.value))].slice(0, 40);
  if (!tokens.some(token => token.length >= 2)) return [];
  const decoded = new Map<string, Song>();
  const decode = (row: SongRow) => {
    const existing = decoded.get(row.id);
    if (existing) return existing;
    const song: Song = { ...row, sections: JSON.parse(row.sections) };
    decoded.set(song.id, song); return song;
  };
  const find = (alternatives: Alternative[][]) => {
    const quote = (value: string) => `"${value.replace(/"/g, '""')}"`;
    const expression = tokens.map((token, index) => `(${[`${quote(token)}${exactToken(token) ? '' : '*'}`, ...alternatives[index].map(term => quote(term.value))].join(' OR ')})`).join(' AND ');
    const ranked = new Map<string, RankedHit>();
    const titles = db.prepare(`SELECT s.id,s.title FROM songs_fts f JOIN songs s ON s.id=f.id
      WHERE songs_fts MATCH ? ORDER BY length(s.title),bm25(songs_fts,0,10,1),s.title COLLATE NOCASE,s.id LIMIT ${TITLE_CANDIDATES}`)
      .all(`title:(${expression})`) as { id: string; title: string }[];
    for (const song of titles) {
      const match = score(song.title, tokens, alternatives);
      if (!match) continue;
      const title = words(song.title).map(word => word.value).join(' ');
      ranked.set(song.id, { songId: song.id, title: song.title, match: { kind: 'title', sectionId: null, excerpt: song.title, corrected: match.corrected },
        score: [0, match.distance, title === tokens.join(' ') ? 0 : 1, match.phrase, match.span, title.length] });
    }
    const sections = db.prepare(`SELECT f.songId,f.sectionId,f.body,s.title FROM song_sections_fts f JOIN songs s ON s.id=f.songId
      WHERE song_sections_fts MATCH ? ORDER BY bm25(song_sections_fts),s.title COLLATE NOCASE,s.id,f.rowid LIMIT ${LYRIC_CANDIDATES}`)
      .all(expression) as { songId: string; sectionId: string; body: string; title: string }[];
    for (const section of sections) {
      const existing = ranked.get(section.songId);
      if (existing?.match.kind === 'title') continue;
      const match = score(section.body, tokens, alternatives);
      if (!match) continue;
      const rank = [1, match.distance, match.phrase, match.span];
      if (existing && compareScore(rank, existing.score) >= 0) continue;
      ranked.set(section.songId, { songId: section.songId, title: section.title,
        match: { kind: 'lyrics', sectionId: section.sectionId, excerpt: excerpt(section.body, match.positions), corrected: match.corrected }, score: rank });
    }
    const getSong = db.prepare('SELECT * FROM songs WHERE id=?');
    return [...ranked.values()].sort((left, right) => compareScore(left.score, right.score) || left.title.localeCompare(right.title) || left.songId.localeCompare(right.songId))
      .slice(0, RESULT_LIMIT).map(result => ({ song: decode(getSong.get(result.songId) as SongRow), match: result.match }));
  };
  const strict = find(tokens.map(() => []));
  if (strict.length) return strict;
  const index = vocabulary(db), alternatives = tokens.map(token => corrections(token, index));
  return alternatives.some(terms => terms.length) ? find(alternatives) : [];
}
