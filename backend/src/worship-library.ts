import Database from 'better-sqlite3';
import { z } from 'zod';
import { randomUUID } from 'node:crypto';
import { BOOK_NAMES, ftsQuery, parseReference, searchWords } from './scripture-reference.js';
import { resolveScriptureSearch } from './scripture-search.js';
import { searchScriptureKeywords } from './scripture-keyword-search.js';
import { matchScriptureQuote } from './scripture-quote-match.js';
import { searchLyrics, invalidateLyricsSearch, ensureLyricsSearchIndex, updateLyricsSearchIndex } from './lyrics-search.js';
import { ProductionError } from './production-store.js';
import type { BibleVersion, Verse, Song, CueSelection, LiveCue, WorshipWorkspace, WorshipCommand, ScriptureSelection, ScriptureSearchResult, LyricsSearchHit } from '../../shared/worship.js';

const key = z.string().regex(/^[\w-]{1,80}$/);
const importedVerse = z.object({ book: z.number().int().min(1).max(66), chapter: z.number().int().min(1).max(150), verse: z.number().int().min(1).max(200), endVerse: z.number().int().min(1).max(200).optional(), text: z.string().trim().min(1).max(12000) }).superRefine((value, ctx) => {
  if (value.endVerse !== undefined && (value.endVerse < value.verse || value.endVerse - value.verse > 11)) ctx.addIssue({ code: 'custom', path: ['endVerse'], message: 'A source passage must span 1–12 verses.' });
});
export const BibleImportSchema = z.object({
  version: z.object({ id: key, name: z.string().trim().min(1).max(160), language: z.string().min(2).max(20).default('en'), attribution: z.string().trim().min(1).max(1500) }),
  verses: z.array(importedVerse).min(1).max(40000),
  replace: z.boolean().default(false),
});
export const SongSchema = z.object({
  id: key.optional(), revision: z.number().int().nonnegative().default(0), title: z.string().trim().min(1).max(160),
  author: z.string().max(300).default(''), copyright: z.string().max(1500).default(''),
  sections: z.array(z.object({ id: key, label: z.string().trim().min(1).max(80), text: z.string().trim().min(1).max(4000) })).min(1).max(100),
}).superRefine((song, ctx) => { if (new Set(song.sections.map(s => s.id)).size !== song.sections.length) ctx.addIssue({ code: 'custom', message: 'Song sections need unique IDs.' }); });
export const SelectionSchema = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('scripture'), versionId: key, book: z.number().int().min(1).max(66), chapter: z.number().int().min(1).max(150), verse: z.number().int().min(1).max(200), endVerse: z.number().int().min(1).max(200).optional() }),
  z.object({ kind: z.literal('lyrics'), songId: key, sectionId: key }),
]);
const hex = z.string().regex(/^#[a-f\d]{6}$/i);
export const WorshipCommandSchema = z.discriminatedUnion('type', [
  z.object({ type: z.literal('take'), selection: SelectionSchema }),
  z.object({ type: z.literal('step'), direction: z.union([z.literal(1), z.literal(-1)]) }),
  z.object({ type: z.literal('blank'), value: z.boolean() }),
  z.object({ type: z.literal('version'), versionId: key }),
  z.object({ type: z.literal('setlist'), songIds: z.array(key).max(100) }),
  z.object({ type: z.literal('theme'), theme: z.object({ background: hex, color: hex, size: z.enum(['sm','md','lg','xl','2xl']), align: z.enum(['left','center','right']) }) }),
]);
const CATALOG = [ ['NKJV','New King James Version'], ['KJV','King James Version'], ['NIV','New International Version'], ['NLT','New Living Translation'], ['AMP','Amplified Bible'], ['GNT','Good News Translation'], ['TPT','The Passion Translation'] ];

function coversVerses(rows: { verse: number; endVerse?: number | null }[], start: number, end: number) {
  let next = start;
  for (const row of rows) {
    if (row.verse > next) return false;
    next = Math.max(next, (row.endVerse ?? row.verse) + 1);
    if (next > end) return true;
  }
  return false;
}

export class WorshipLibrary {
  readonly db: Database.Database;
  constructor(filename: string) {
    this.db = new Database(filename);
    this.db.pragma('journal_mode = WAL'); this.db.pragma('foreign_keys = ON'); this.db.pragma('busy_timeout = 5000');
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS bible_versions (id TEXT PRIMARY KEY, name TEXT NOT NULL, language TEXT NOT NULL, attribution TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS verses (id INTEGER PRIMARY KEY, versionId TEXT NOT NULL REFERENCES bible_versions(id) ON DELETE CASCADE, book INTEGER NOT NULL, chapter INTEGER NOT NULL, verse INTEGER NOT NULL, text TEXT NOT NULL, endVerse INTEGER, UNIQUE(versionId,book,chapter,verse));
      CREATE VIRTUAL TABLE IF NOT EXISTS verses_fts USING fts5(text, content='verses', content_rowid='id', prefix='2 3 4');
      CREATE TRIGGER IF NOT EXISTS verse_insert AFTER INSERT ON verses BEGIN INSERT INTO verses_fts(rowid,text) VALUES(new.id,new.text); END;
      CREATE TRIGGER IF NOT EXISTS verse_delete AFTER DELETE ON verses BEGIN INSERT INTO verses_fts(verses_fts,rowid,text) VALUES('delete',old.id,old.text); END;
      CREATE TABLE IF NOT EXISTS songs (id TEXT PRIMARY KEY, revision INTEGER NOT NULL, title TEXT NOT NULL, author TEXT NOT NULL, copyright TEXT NOT NULL, sections TEXT NOT NULL, updatedAt TEXT NOT NULL);
      CREATE VIRTUAL TABLE IF NOT EXISTS songs_fts USING fts5(id UNINDEXED,title,body,prefix='2 3 4');
      CREATE VIRTUAL TABLE IF NOT EXISTS songs_vocab USING fts5vocab(songs_fts,'row');
      CREATE TABLE IF NOT EXISTS worship_workspaces (channelId TEXT PRIMARY KEY, state TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS worship_preferences (key TEXT PRIMARY KEY, value TEXT NOT NULL);
    `);
    this.db.transaction(() => {
      if (!(this.db.pragma('table_info(verses)') as { name: string }[]).some(column => column.name === 'endVerse')) this.db.exec('ALTER TABLE verses ADD COLUMN endVerse INTEGER');
    })();
    ensureLyricsSearchIndex(this.db);
  }
  versions(): BibleVersion[] {
    const installed = this.db.prepare('SELECT b.*,coalesce(sum(coalesce(v.endVerse,v.verse)-v.verse+1),0) AS verseCount FROM bible_versions b LEFT JOIN verses v ON v.versionId=b.id GROUP BY b.id').all() as Omit<BibleVersion, 'installed'>[];
    const rows = installed.map(v => ({ ...v, installed: true }));
    return [...CATALOG.map(([id,name]) => rows.find(v => v.id === id) ?? { id,name,language:'en',attribution:'Import an authorised digital edition to enable this version.',verseCount:0,installed:false }), ...rows.filter(v => !CATALOG.some(([id]) => id === v.id))];
  }
  importBible(raw: unknown) {
    const input = BibleImportSchema.parse(raw);
    const id = input.version.id.toUpperCase();
    const ids = new Set<string>();
    for (const verse of input.verses) for (let number = verse.verse; number <= (verse.endVerse ?? verse.verse); number++) {
      const key = `${verse.book}:${verse.chapter}:${number}`;
      if (ids.has(key)) throw new ProductionError(422, `Duplicate or overlapping verse ${key}.`);
      ids.add(key);
    }
    this.db.transaction(() => {
      if (this.db.prepare('SELECT 1 FROM bible_versions WHERE id=?').get(id) && !input.replace) throw new ProductionError(409, 'This version is installed. Explicitly enable replacement to import a new edition.');
      this.db.prepare('DELETE FROM bible_versions WHERE id=?').run(id);
      this.db.prepare('INSERT INTO bible_versions VALUES(?,?,?,?)').run(id,input.version.name,input.version.language,input.version.attribution);
      const insert = this.db.prepare('INSERT INTO verses(versionId,book,chapter,verse,endVerse,text) VALUES(?,?,?,?,?,?)');
      for (const v of input.verses) insert.run(id,v.book,v.chapter,v.verse,v.endVerse && v.endVerse > v.verse ? v.endVerse : null,v.text);
    })();
    return this.versions().find(v => v.id === id)!;
  }
  private requireVersion(id: string) {
    if (!this.db.prepare('SELECT 1 FROM bible_versions WHERE id=?').get(id)) throw new ProductionError(409, `${id} is not installed. Import its authorised text in Library.`);
  }
  private verse(row: unknown): Verse {
    const { endVerse, ...v } = row as Verse & { endVerse?: number | null };
    return { ...v, ...(endVerse != null && endVerse > v.verse ? { endVerse } : {}), bookName: BOOK_NAMES[v.book - 1] };
  }
  searchScripture(versionId: string, query: string, mode: 'manual' | 'listening' = 'manual'): ScriptureSearchResult {
    this.requireVersion(versionId);
    // Operator search may resolve abbreviations and typos. Speech recognition
    // deliberately keeps its existing exact parser/FTS rules: fuzzy manual
    // suggestions must never broaden automatic publication eligibility.
    const resolved = mode === 'manual' ? resolveScriptureSearch(query) : null;
    const ref = resolved ? resolved.reference : parseReference(query);
    const resolution: ScriptureSearchResult['resolution'] = {
      kind: resolved?.kind ?? (ref ? 'reference' : 'text'),
      label: resolved?.label ?? null,
      match: resolved?.match ?? (ref ? 'exact' : null),
      suggestions: resolved?.kind === 'ambiguous' ? resolved.candidates.filter(candidate => {
        const reference=candidate.reference;
        let sql='FROM verses WHERE versionId=? AND book=?';
        const params:(string|number)[]=[versionId,reference.book];
        if(reference.chapter!==undefined){sql+=' AND chapter=?';params.push(reference.chapter);}
        if(reference.verse!==undefined){sql+=' AND verse<=? AND coalesce(endVerse,verse)>=?';params.push(reference.endVerse??reference.verse,reference.verse);}
        if(reference.endVerse!==undefined&&reference.verse!==undefined){
          const rows=this.db.prepare(`SELECT verse,endVerse ${sql} ORDER BY verse`).all(...params) as {verse:number;endVerse:number|null}[];
          return coversVerses(rows,reference.verse,reference.endVerse);
        }
        return !!this.db.prepare(`SELECT 1 ${sql} LIMIT 1`).get(...params);
      }) : [],
    };
    let rows: unknown[];
    let keywordMode: ScriptureSearchResult['keywordMode'] = null;
    let ignoredWords: string[] = [];
    if (ref) {
      let sql = 'SELECT versionId,book,chapter,verse,endVerse,text FROM verses WHERE versionId=? AND book=?';
      const params: (string | number)[] = [versionId,ref.book];
      if (ref.chapter) { sql += ' AND chapter=?'; params.push(ref.chapter); }
      if (ref.verse) { sql += ' AND verse<=? AND coalesce(endVerse,verse)>=?'; params.push(ref.endVerse ?? ref.verse,ref.verse); }
      rows = this.db.prepare(`${sql} ORDER BY book,chapter,verse LIMIT 200`).all(...params);
    } else if (mode === 'manual' && resolution.kind === 'text') {
      const result = searchScriptureKeywords(this.db,versionId,query);
      rows = result.rows; keywordMode = result.mode; ignoredWords = result.ignoredWords;
    } else if (mode === 'listening') {
      const q = ftsQuery(query);
      rows = q ? this.db.prepare('SELECT v.versionId,v.book,v.chapter,v.verse,v.endVerse,v.text FROM verses_fts f JOIN verses v ON v.id=f.rowid WHERE verses_fts MATCH ? AND v.versionId=? ORDER BY rank LIMIT 80').all(q,versionId) : [];
    } else rows = [];
    return { verses: rows.map(r => this.verse(r)), reference: ref, resolution, keywordMode, ignoredWords };
  }
  matchScriptureQuote(versionId: string, text: string) { this.requireVersion(versionId); return matchScriptureQuote(this.db, versionId, text); }
  books(versionId: string) { return (this.db.prepare('SELECT book,MAX(chapter) AS chapters FROM verses WHERE versionId=? GROUP BY book ORDER BY book').all(versionId) as { book:number; chapters:number }[]).map(b => ({ ...b,name:BOOK_NAMES[b.book-1] })); }
  passage(selection: ScriptureSelection): Verse[] {
    this.requireVersion(selection.versionId);
    const end = selection.endVerse ?? selection.verse;
    if (end < selection.verse || end - selection.verse > 11) throw new ProductionError(422, 'Choose a passage of 1–12 verses.');
    const rows = this.db.prepare('SELECT versionId,book,chapter,verse,endVerse,text FROM verses WHERE versionId=? AND book=? AND chapter=? AND verse<=? AND coalesce(endVerse,verse)>=? ORDER BY verse').all(selection.versionId,selection.book,selection.chapter,end,selection.verse).map(v => this.verse(v));
    if (!coversVerses(rows,selection.verse,end)) throw new ProductionError(404, 'That passage is not present in the installed edition.');
    if ((rows.at(-1)!.endVerse ?? rows.at(-1)!.verse) - rows[0].verse > 11) throw new ProductionError(422, 'Choose a passage of 1–12 verses, including the full source passage.');
    return rows;
  }
  songs(query = ''): Song[] {
    const q = ftsQuery(query);
    const rows = q ? this.db.prepare('SELECT s.* FROM songs_fts f JOIN songs s ON s.id=f.id WHERE songs_fts MATCH ? ORDER BY rank LIMIT 100').all(q) : this.db.prepare('SELECT * FROM songs ORDER BY title COLLATE NOCASE LIMIT 500').all();
    return rows.map(row => this.decodeSong(row));
  }
  searchSongs(query=''): LyricsSearchHit[] {
    if(query.trim())return searchLyrics(this.db,query);
    return this.songs().map(song=>({song,match:{kind:'title',sectionId:null,excerpt:'',corrected:false}}));
  }
  private decodeSong(row: unknown): Song { const r = row as Omit<Song,'sections'> & { sections:string }; return { ...r,sections:JSON.parse(r.sections) }; }
  song(id: string) { const row = this.db.prepare('SELECT * FROM songs WHERE id=?').get(id); if (!row) throw new ProductionError(404,'Song not found.'); return this.decodeSong(row); }
  saveSong(raw: unknown) {
    const input = SongSchema.parse(raw), id = input.id ?? `song_${randomUUID()}`;
    const saved=this.db.transaction(() => {
      const row = this.db.prepare('SELECT revision FROM songs WHERE id=?').get(id) as { revision:number } | undefined;
      if (row && row.revision !== input.revision) throw new ProductionError(409,'This song changed on another device. Reopen it before editing.');
      const song: Song = { ...input,id,revision:(row?.revision ?? 0)+1,updatedAt:new Date().toISOString() };
      this.db.prepare('INSERT OR REPLACE INTO songs VALUES(?,?,?,?,?,?,?)').run(id,song.revision,song.title,song.author,song.copyright,JSON.stringify(song.sections),song.updatedAt);
      this.db.prepare('DELETE FROM songs_fts WHERE id=?').run(id);
      this.db.prepare('INSERT INTO songs_fts(id,title,body) VALUES(?,?,?)').run(id,song.title,song.sections.map(s=>s.text).join('\n'));
      updateLyricsSearchIndex(this.db,song);
      return song;
    })();
    invalidateLyricsSearch(this.db);
    return saved;
  }
  cue(selection: CueSelection): LiveCue {
    if (selection.kind === 'scripture') {
      const verses = this.passage(selection), first = verses[0], last = verses.at(-1)!, end = last.endVerse ?? last.verse;
      const ref = `${first.bookName} ${first.chapter}:${first.verse}${end>first.verse ? `–${end}` : ''}`;
      const actual: ScriptureSelection = { ...selection, verse: first.verse, ...(end > first.verse ? { endVerse: end } : {}) };
      return { selection:actual,title:ref,text:verses.map(v=>verses.length>1?`${v.verse}${v.endVerse ? `–${v.endVerse}` : ''} ${v.text}`:v.text).join('\n\n'),reference:`${ref} · ${selection.versionId}`,attribution:this.versions().find(v=>v.id===selection.versionId)!.attribution,takenAt:new Date().toISOString() };
    }
    const song = this.song(selection.songId), section = song.sections.find(s=>s.id===selection.sectionId);
    if (!section) throw new ProductionError(404,'Song section not found.');
    return { selection,title:song.title,text:section.text,reference:section.label,attribution:[song.author,song.copyright].filter(Boolean).join(' · '),takenAt:new Date().toISOString() };
  }
  workspace(channelId: string): WorshipWorkspace {
    const row = this.db.prepare('SELECT state FROM worship_workspaces WHERE channelId=?').get(channelId) as { state:string } | undefined;
    return row ? JSON.parse(row.state) : { channelId,revision:0,versionId:'KJV',setlist:[],recent:[],live:null,blanked:false,theme:{background:'#0a0a0c',color:'#f4f4f5',size:'lg',align:'center'} };
  }
  workspaces(): WorshipWorkspace[] { return (this.db.prepare('SELECT state FROM worship_workspaces').all() as {state:string}[]).map(r=>JSON.parse(r.state)); }
  command(channelId: string, revision: number, command: WorshipCommand): WorshipWorkspace {
    return this.db.transaction(() => {
      const state = this.workspace(channelId);
      if (state.revision !== revision) throw new ProductionError(409,'This channel changed. Your view has been refreshed; please retry.');
      if (command.type === 'take') {
        state.live = this.cue(command.selection); state.blanked = false;
        state.recent = [state.live.selection,...state.recent.filter(r=>JSON.stringify(r)!==JSON.stringify(state.live!.selection))].slice(0,30);
        if (command.selection.kind === 'scripture') state.versionId = command.selection.versionId;
      } else if (command.type === 'step') {
        if (!state.live) throw new ProductionError(409,'Send a verse or lyric section live first.');
        const sel = state.live.selection;
        let next: CueSelection;
        if (sel.kind === 'scripture') {
          const operator = command.direction === 1 ? '>' : '<', order = command.direction === 1 ? 'ASC' : 'DESC';
          const row = this.db.prepare(`SELECT versionId,book,chapter,verse,endVerse FROM verses WHERE versionId=? AND (book,chapter,verse) ${operator} (?,?,?) ORDER BY book ${order},chapter ${order},verse ${order} LIMIT 1`).get(sel.versionId,sel.book,sel.chapter,command.direction===1 ? sel.endVerse ?? sel.verse : sel.verse) as (ScriptureSelection & { endVerse?: number | null }) | undefined;
          if (!row) throw new ProductionError(409,'You have reached the end of the installed text.');
          const { endVerse, ...start } = row;
          next = { ...start,...(endVerse != null ? { endVerse } : {}),kind:'scripture' };
        } else {
          const song = this.song(sel.songId), index = song.sections.findIndex(s=>s.id===sel.sectionId)+command.direction;
          if (index<0 || index>=song.sections.length) throw new ProductionError(409,'You have reached the end of this song.');
          next = { kind:'lyrics',songId:song.id,sectionId:song.sections[index].id };
        }
        state.live = this.cue(next); state.blanked = false;
      } else if (command.type === 'blank') state.blanked = command.value;
      else if (command.type === 'version') { this.requireVersion(command.versionId); state.versionId = command.versionId; }
      else if (command.type === 'theme') state.theme = command.theme;
      else if (command.type === 'setlist') { for (const id of command.songIds) this.song(id); state.setlist = [...new Set(command.songIds)]; }
      state.revision++;
      this.db.prepare('INSERT OR REPLACE INTO worship_workspaces VALUES(?,?)').run(channelId,JSON.stringify(state));
      return state;
    })();
  }
  matchLyrics(transcript: string, songIds: string[]) {
    const words = searchWords(transcript).filter(w=>w.length>1);
    if (words.length<4 || !songIds.length) return [];
    const heard = new Set(words);
    const candidates = songIds.flatMap(id=>{ try { const song=this.song(id); return song.sections.map(section=>{
      const tokens = searchWords(section.text), known = new Set(tokens);
      const common = [...heard].filter(w=>known.has(w)).length;
      const score = common / Math.max(heard.size,Math.min(known.size,8));
      return { selection:{kind:'lyrics' as const,songId:id,sectionId:section.id},score,common };
    }); } catch { return []; } });
    return candidates.filter(c=>c.common>=4).sort((a,b)=>b.score-a.score).slice(0,3);
  }
  close() { this.db.close(); }
}
