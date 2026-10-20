import { BOOK_NAMES, normalizeReference, type ParsedReference } from './scripture-reference.js';

/** Manual search only. Do not use tolerant book matching for automatic listening. */
export type ScriptureSearchMatch = 'exact' | 'prefix' | 'corrected';
export interface ScriptureSearchCandidate {
  reference: ParsedReference;
  label: string;
  match: ScriptureSearchMatch;
}
export interface ScriptureSearchResolution {
  kind: 'reference' | 'ambiguous' | 'text' | 'invalid';
  reference: ParsedReference | null;
  candidates: ScriptureSearchCandidate[];
  label: string | null;
  match: ScriptureSearchMatch | 'ambiguous' | null;
}

// Kept separate from the strict speech parser: changing manual search must not
// make an uncertain spoken reference eligible for an automatic publication.
const BOOK_ALIASES = [
  'gen ge gn', 'ex exod', 'lev lv', 'num nm', 'deut dt', 'josh jos', 'judg jdg', 'ru',
  '1 sam 1 sa', '2 sam 2 sa', '1 kgs 1 ki', '2 kgs 2 ki', '1 chr 1 ch', '2 chr 2 ch',
  'ezr', 'neh ne', 'est es', 'jb', 'ps psalm psa pss', 'prov pr', 'eccl ecc',
  'song songs sos sng canticles', 'isa is', 'jer je', 'lam la', 'ezek ez', 'dan dn',
  'hos ho', 'jl', 'am', 'obad ob', 'jon', 'mic mi', 'nah na', 'hab hb', 'zeph zep',
  'hag hg', 'zech zec', 'mal ml', 'matt mt', 'mk mr', 'lk lu', 'jn joh jhn',
  'ac act', 'rom ro roman', '1 cor 1 co 1 corinthian', '2 cor 2 co 2 corinthian',
  'gal ga', 'eph ep ephesian', 'phil php philippian', 'col colossian',
  '1 thess 1 thes 1 th 1 thessalonian', '2 thess 2 thes 2 th 2 thessalonian',
  '1 tim 1 ti', '2 tim 2 ti', 'tit', 'phlm phm', 'heb he', 'jas jm',
  '1 pet 1 pe', '2 pet 2 pe', '1 jn 1 jhn', '2 jn 2 jhn', '3 jn 3 jhn', 'jud',
  'rev re revelations',
];
const SINGLE_CHAPTER_BOOKS = new Set([31, 57, 63, 64, 65]);
const compact = (value: string) => value.replace(/\s/g, '');
const books = BOOK_NAMES.map((name, index) => ({
  book: index + 1,
  ordinal: name.match(/^[123]/)?.[0] ?? '',
  keys: [...new Set([
    name.toLowerCase(),
    ...(BOOK_ALIASES[index].match(/(?:[123] )?[a-z]+/g) ?? []),
    ...(index === 21 ? ['song of songs'] : []),
  ].map(compact))],
}));
const exact = new Map(books.flatMap(book => book.keys.map(key => [key, book] as const)));

// Bounded optimal-string-alignment distance handles a common adjacent-key
// transposition without scoring arbitrary short snippets as a Bible book.
function distance(left: string, right: string, limit: number) {
  if (Math.abs(left.length - right.length) > limit) return limit + 1;
  let previous = Array.from({ length: right.length + 1 }, (_, index) => index);
  let beforePrevious = previous;
  for (let row = 1; row <= left.length; row++) {
    const current = [row];
    let minimum = row;
    for (let column = 1; column <= right.length; column++) {
      let value = Math.min(
        current[column - 1] + 1,
        previous[column] + 1,
        previous[column - 1] + Number(left[row - 1] !== right[column - 1]),
      );
      if (row > 1 && column > 1 && left[row - 1] === right[column - 2] && left[row - 2] === right[column - 1]) {
        value = Math.min(value, beforePrevious[column - 2] + 1);
      }
      current[column] = value;
      minimum = Math.min(minimum, value);
    }
    if (minimum > limit) return limit + 1;
    beforePrevious = previous;
    previous = current;
  }
  return previous[right.length];
}

function matchBooks(input: string): Array<{ book: number; match: ScriptureSearchMatch }> {
  const key = compact(input), ordinal = key.match(/^[123]/)?.[0] ?? '';
  const direct = exact.get(key);
  if (direct) return [{ book: direct.book, match: 'exact' }];
  const eligible = books.filter(book => !ordinal || book.ordinal === ordinal);
  // An omitted ordinal offers the whole numbered family, never an invented
  // choice of 1/2/3. Exact unnumbered names above still win (John, Col, etc.).
  const comparable = (candidate: string) => ordinal ? candidate : candidate.replace(/^[123]/, '');
  const prefixes = eligible.filter(book => book.keys.some(candidate => comparable(candidate).startsWith(key)));
  if (prefixes.length) return prefixes.map(book => ({ book: book.book, match: 'prefix' }));
  const letters = key.replace(/^[123]/, '');
  if (letters.length < 4) return [];
  const limit = letters.length >= 7 ? 2 : 1;
  const scored = eligible.map(book => ({
    book: book.book,
    ordinal: book.ordinal,
    distance: Math.min(...book.keys.filter(candidate => candidate.replace(/^[123]/, '').length >= 4).map(candidate => distance(key, comparable(candidate), limit))),
  })).filter(book => book.distance <= limit);
  if (!scored.length) return [];
  // Preserve the natural correction `jonn` -> John rather than introducing its
  // numbered letters; a numbered-only family such as `samuell` stays ambiguous.
  const unnumbered = !ordinal ? scored.filter(book => !book.ordinal) : [];
  const corrections = unnumbered.length ? unnumbered : scored;
  const best = Math.min(...corrections.map(book => book.distance));
  return corrections.filter(book => book.distance === best).map(book => ({ book: book.book, match: 'corrected' }));
}

function empty(kind: 'text' | 'invalid'): ScriptureSearchResolution {
  return { kind, reference: null, candidates: [], label: null, match: null };
}

/**
 * Resolves the entire manual query, never a reference embedded in a phrase.
 * Short ambiguous book prefixes return choices instead of choosing silently.
 * Numeric runs are not segmented: `jn316` is NOT interpreted as John 3:16.
 * The installed edition remains authoritative for actual chapter/verse bounds.
 */
export function resolveScriptureSearch(query: string): ScriptureSearchResolution {
  if (!query.trim() || query.length > 500) return empty('text');
  const ordinals = query.normalize('NFKC').toLowerCase()
    .replace(/\b(?:first|1st)\s*/g, '1 ')
    .replace(/\b(?:second|2nd)\s*/g, '2 ')
    .replace(/\b(?:third|3rd)\s*/g, '3 ')
    .replace(/^\s*(iii|ii|i)\s+(?=[a-z])/, (_, roman: string) => `${roman.length} `)
    .replace(/[–—−]/g, '-');
  const value = normalizeReference(ordinals);
  const head = /^((?:[123]\s*)?[a-z]+(?:\s+[a-z]+)*?)(?=\s*(?:(?:chapter|verses?)\s*)?\d|$)/.exec(value);
  if (!head) return empty('text');
  const matches = matchBooks(head[1]);
  if (!matches.length) return empty('text');
  const tail = value.slice(head[0].length).trim();
  const numbers = tail ? /^(?:(chapter|verses?)\s*)?(\d{1,3})(?:(?:\s*:\s*|\s*(?:verses?|v)\s*|\s+)(\d{1,3})?)?(?:\s*(?:-|to|through)\s*(\d{1,3}))?$/.exec(tail) : null;
  // A trailing phrase is a text search, not a partly consumed reference.
  if (tail && !numbers) return empty('text');
  const first = numbers?.[2] ? Number(numbers[2]) : undefined;
  const second = numbers?.[3] ? Number(numbers[3]) : undefined;
  const endVerse = numbers?.[4] ? Number(numbers[4]) : undefined;
  const explicitChapter = numbers?.[1] === 'chapter';
  const explicitVerse = numbers?.[1]?.startsWith('verse') ?? false;
  const candidates: ScriptureSearchCandidate[] = [];
  for (const match of matches) {
    let chapter = first, verse = second;
    if (first !== undefined && second === undefined && SINGLE_CHAPTER_BOOKS.has(match.book) && !explicitChapter) {
      chapter = 1;
      verse = first;
    } else if (explicitVerse) continue;
    if (chapter !== undefined && (chapter < 1 || chapter > 150)) continue;
    if (verse !== undefined && (verse < 1 || verse > 200)) continue;
    if (endVerse !== undefined && (endVerse < 1 || endVerse > 200 || verse === undefined || endVerse < verse)) continue;
    const reference: ParsedReference = { book: match.book, chapter, verse, endVerse, complete: chapter !== undefined && verse !== undefined };
    const label = `${BOOK_NAMES[match.book - 1]}${chapter !== undefined ? ` ${chapter}` : ''}${verse !== undefined ? `:${verse}` : ''}${endVerse !== undefined ? `–${endVerse}` : ''}`;
    candidates.push({ reference, label, match: match.match });
  }
  if (!candidates.length) return empty('invalid');
  if (candidates.length > 1) return { kind: 'ambiguous', reference: null, candidates, label: null, match: 'ambiguous' };
  const result = candidates[0];
  return { kind: 'reference', reference: result.reference, candidates, label: result.label, match: result.match };
}
