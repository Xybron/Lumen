import Database from 'better-sqlite3';
import fs from 'node:fs/promises';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { z } from 'zod';
import { SongSchema, WorshipLibrary } from './worship-library.js';

type ImportSong = z.infer<typeof SongSchema> & { id: string };
type StoredSong = { id: string; title: string; author: string; copyright: string; sections: string };
type Conflict = { id: string; title: string };
export interface SongImportResult {
  mode: 'dry-run' | 'applied';
  inputCount: number;
  wouldAdd: number;
  added: number;
  unchanged: number;
  conflicts: Conflict[];
  backup?: string;
}

/** Validate the entire batch before opening the destination for writing. */
export function validateSongImport(raw: unknown): ImportSong[] {
  const input = z.object({ songs: z.array(z.unknown()).min(1) }).parse(raw);
  const ids = new Set<string>();
  return input.songs.map((value, index) => {
    const song = SongSchema.parse(value);
    if (!song.id) throw new Error(`Song ${index + 1} must supply a stable source ID.`);
    if (ids.has(song.id)) throw new Error(`Duplicate song ID: ${song.id}.`);
    ids.add(song.id);
    return { ...song, id: song.id };
  });
}

function content(song: Pick<ImportSong, 'title' | 'author' | 'copyright' | 'sections'>) {
  return JSON.stringify([song.title, song.author, song.copyright, song.sections.map(s => [s.id, s.label, s.text])]);
}

function plan(db: Database.Database, songs: ImportSong[]) {
  const get = db.prepare('SELECT id,title,author,copyright,sections FROM songs WHERE id=?');
  const additions: ImportSong[] = [], conflicts: Conflict[] = [];
  let unchanged = 0;
  for (const song of songs) {
    const stored = get.get(song.id) as StoredSong | undefined;
    if (!stored) additions.push(song);
    else if (content({ ...stored, sections: JSON.parse(stored.sections) }) === content(song)) unchanged++;
    else conflicts.push({ id: song.id, title: song.title });
  }
  return { additions, conflicts, unchanged };
}

async function backupDatabase(db: Database.Database, database: string, destination: string) {
  const backup = path.join(await fs.realpath(path.dirname(path.resolve(destination))), path.basename(destination));
  if ([database, `${database}-wal`, `${database}-shm`, `${database}-journal`].includes(backup)) {
    throw new Error('The backup must be separate from the destination database and its journal files.');
  }
  // Reserve the path exclusively: an existing backup must never be overwritten.
  const handle = await fs.open(backup, 'wx', 0o600);
  await handle.close();
  try { await db.backup(backup); }
  catch (error) { await fs.unlink(backup).catch(() => {}); throw error; }
  return backup;
}

export async function importWorshipSongs(raw: unknown, options: { database: string; apply?: boolean; backup?: string }): Promise<SongImportResult> {
  const songs = validateSongImport(raw);
  if (options.apply && !options.backup) throw new Error('--backup is required with --apply.');
  const database = await fs.realpath(options.database);
  const reader = new Database(database, { readonly: true, fileMustExist: true });
  let backup: string | undefined;
  try {
    const preview = plan(reader, songs);
    if (!options.apply) return { mode: 'dry-run', inputCount: songs.length, wouldAdd: preview.additions.length, added: 0, unchanged: preview.unchanged, conflicts: preview.conflicts };
    backup = await backupDatabase(reader, database, options.backup!);
  } finally { reader.close(); }

  const library = new WorshipLibrary(database);
  try {
    // Recheck while holding the write lock: edits since the preview/backup must
    // also be classified as conflicts, never overwritten by the import.
    return library.db.transaction(() => {
      const current = plan(library.db, songs);
      for (const song of current.additions) library.saveSong({ ...song, revision: 0 });
      return { mode: 'applied' as const, inputCount: songs.length, wouldAdd: 0, added: current.additions.length, unchanged: current.unchanged, conflicts: current.conflicts, backup };
    }).immediate();
  } finally { library.close(); }
}

async function main(args: string[]) {
  const usage = 'Usage: tsx src/import-worship-songs.ts --input songs.json --database /path/worship.db [--apply --backup /path/new-backup.db]';
  if (args.includes('--help')) { console.log(usage); return; }
  const values: Record<string, string> = {};
  let apply = false;
  for (let i = 0; i < args.length; i++) {
    const key = args[i];
    if (key === '--apply') { if (apply) throw new Error('Duplicate --apply.'); apply = true; continue; }
    if (!['--input', '--database', '--backup'].includes(key) || values[key] !== undefined || !args[i + 1] || args[i + 1].startsWith('--')) throw new Error(usage);
    values[key] = args[++i];
  }
  if (!values['--input'] || !values['--database']) throw new Error(usage);
  const input = JSON.parse((await fs.readFile(values['--input'], 'utf8')).replace(/^\uFEFF/, ''));
  const result = await importWorshipSongs(input, { database: values['--database'], apply, backup: values['--backup'] });
  console.log(JSON.stringify(result, null, 2));
  if (result.conflicts.length) process.exitCode = 2;
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  main(process.argv.slice(2)).catch(error => { console.error((error as Error).message); process.exitCode = 1; });
}
