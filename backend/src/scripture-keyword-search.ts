import type Database from 'better-sqlite3';

export interface ScriptureKeywordRow {
  versionId: string;
  book: number;
  chapter: number;
  verse: number;
  text: string;
}

export interface ScriptureKeywordResults {
  rows: ScriptureKeywordRow[];
  /** Relaxed results omit only the reported connector/pronoun words. */
  mode: 'keywords' | 'relaxed';
  ignoredWords: string[];
}

// A manual phrase may be remembered approximately ("the lord my shepherd").
// These words may be omitted only after the full AND query has no results.
// Negations such as "not", "no" and "nor" deliberately remain meaningful.
const CONNECTORS = new Set([
  'a', 'an', 'the', 'and', 'or', 'but', 'to', 'of', 'in', 'on', 'at', 'for',
  'from', 'by', 'with', 'as', 'is', 'are', 'was', 'were', 'be', 'been', 'being',
  'it', 'its', 'that', 'this', 'these', 'those', 'which', 'who', 'whom', 'whose',
  'i', 'me', 'my', 'we', 'our', 'us', 'you', 'your', 'he', 'him', 'his', 'she',
  'her', 'they', 'them', 'their', 'thy', 'thou', 'thine', 'thee',
]);
const LIMIT = 80;
const SELECT = `SELECT v.versionId,v.book,v.chapter,v.verse,v.text
  FROM verses_fts f JOIN verses v ON v.id=f.rowid
  WHERE verses_fts MATCH ? AND v.versionId=?
  ORDER BY rank,v.book,v.chapter,v.verse LIMIT ${LIMIT}`;

function words(query: string) {
  // API input is already limited to 500 characters. Retain bounds for direct
  // callers as well, and never pass user punctuation/operators to FTS syntax.
  return (query.slice(0, 500).toLocaleLowerCase('en').match(/[\p{L}\p{N}]+/gu) ?? []).slice(0, 40);
}

/**
 * Indexed, version-scoped manual search. No network/model, table scan, schema
 * mutation, edition changes, or publication side effects. Listening deliberately
 * keeps its existing stricter reference/phrase matching outside this helper.
 */
export function searchScriptureKeywords(db: Database.Database, versionId: string, query: string): ScriptureKeywordResults {
  const tokens = words(query);
  const meaningful = tokens.filter(token => !CONNECTORS.has(token));
  const empty: ScriptureKeywordResults = { rows: [], mode: 'keywords', ignoredWords: [] };
  // An isolated common connector is not a useful passage search. Do not turn
  // arbitrary FTS operators (e.g. " OR *") into a large unhelpful result list.
  if (!meaningful.some(token => token.length > 1)) return empty;

  const statement = db.prepare(SELECT);
  const find = (expression: string) => statement.all(expression, versionId) as ScriptureKeywordRow[];
  const quoted = (token: string) => `"${token}"`;
  const prefix = (token: string) => `${quoted(token)}*`;
  const all = (terms: string[]) => [...new Set(terms)].map(prefix).join(' AND ');
  let terms = tokens;
  let matches = find(all(terms));
  let mode: ScriptureKeywordResults['mode'] = 'keywords';
  let ignoredWords: string[] = [];
  if (!matches.length && meaningful.length !== tokens.length) {
    terms = meaningful;
    matches = find(all(terms));
    if (matches.length) {
      mode = 'relaxed';
      ignoredWords = [...new Set(tokens.filter(token => CONNECTORS.has(token)))];
    }
  }
  if (!matches.length) return empty;
  if (terms.length === 1) return { rows: matches, mode, ignoredWords };

  const rows: ScriptureKeywordRow[] = [];
  const seen = new Set<string>();
  const append = (candidates: ScriptureKeywordRow[]) => {
    for (const row of candidates) {
      const key = `${row.book}:${row.chapter}:${row.verse}`;
      if (!seen.has(key)) { rows.push(row); seen.add(key); }
      if (rows.length === LIMIT) break;
    }
  };
  // Each tier is independently bounded, so a common term cannot bury an exact
  // remembered phrase outside an arbitrary initial BM25 candidate window.
  append(find(`"${terms.join(' ')}"`));
  if (rows.length < LIMIT) append(find(terms.map(prefix).join(' + ')));
  if (rows.length < LIMIT) append(find(`NEAR(${[...new Set(terms)].map(prefix).join(' ')}, 6)`));
  if (rows.length < LIMIT) append(matches);
  return { rows, mode, ignoredWords };
}
