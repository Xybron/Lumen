import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import Database from 'better-sqlite3';
import { WorshipLibrary } from '../src/worship-library.js';
import { ListeningSessions } from '../src/listening-session.js';

const version = { id: 'SPAN', name: 'Synthetic range edition', attribution: 'Synthetic fixtures' };
const joined = 'Silver lanterns illuminate the courtyard while curious travelers gather beside the ancient fountain.';
const select = (verse: number, endVerse?: number) => ({ kind: 'scripture' as const, versionId: 'SPAN', book: 43, chapter: 3, verse, ...(endVerse !== undefined ? { endVerse } : {}) });
function library() {
  const db = new WorshipLibrary(':memory:');
  db.importBible({ version, verses: [
    { book: 43, chapter: 3, verse: 1, text: 'First synthetic paragraph.' },
    { book: 43, chapter: 3, verse: 2, endVerse: 4, text: joined },
    { book: 43, chapter: 3, verse: 5, text: 'Last synthetic paragraph.' },
    { book: 43, chapter: 3, verse: 7, text: 'A later synthetic paragraph after a gap.' },
    { book: 43, chapter: 4, verse: 1, text: 'Next chapter synthetic paragraph.' },
  ] });
  return db;
}

test('source ranges count covered verses and resolve every interior reference with the full source label', () => {
  const db = library();
  try {
    assert.equal(db.versions().find(v => v.id === 'SPAN')?.verseCount, 7);
    for (const number of [2, 3, 4]) {
      const result = db.searchScripture('SPAN', `John 3:${number}`);
      assert.equal(result.verses.length, 1);
      assert.equal(result.verses[0].verse, 2); assert.equal(result.verses[0].endVerse, 4);
      const cue = db.cue(select(number));
      assert.equal(cue.reference, 'John 3:2–4 · SPAN'); assert.equal(cue.text, joined);
      assert.deepEqual(cue.selection, select(2, 4));
    }
    assert.equal(db.searchScripture('SPAN', 'John 3').verses.length, 4);
    assert.equal(db.searchScripture('SPAN', 'jo3 3-5').resolution.suggestions[0].label, 'John 3:3–5');
    assert.equal(db.searchScripture('SPAN', 'jo3 3-6').resolution.suggestions.length, 0);
  } finally { db.close(); }
});

test('multirow passages include joined prose once and fail on gaps or an expanded span over 12 verses', () => {
  const db = library();
  try {
    const cue = db.cue(select(3, 5));
    assert.equal(cue.reference, 'John 3:2–5 · SPAN');
    assert.equal(cue.text, `2–4 ${joined}\n\n5 Last synthetic paragraph.`);
    assert.deepEqual(cue.selection, select(2, 5));
    assert.equal(db.passage(select(1, 5)).length, 3);
    assert.throws(() => db.cue(select(4, 7)), /not present/);
    assert.throws(() => db.cue(select(1, 13)), /1–12/);
    const longVerses: { book: number; chapter: number; verse: number; endVerse?: number; text: string }[] = Array.from({ length: 12 }, (_, index) => ({ book: 43, chapter: 3, verse: index + 1, text: 'Synthetic entry.' }));
    longVerses.push({ book: 43, chapter: 3, verse: 13, endVerse: 15, text: 'Joined final source entry.' });
    db.importBible({ version: { ...version, id: 'LONG' }, verses: longVerses });
    assert.throws(() => db.cue({ ...select(2, 13), versionId: 'LONG' }), /full source passage/);
  } finally { db.close(); }
});

test('range import rejects overlaps, reversed spans and oversized spans atomically', () => {
  const db = library();
  try {
    for (const verses of [
      [{ book: 43, chapter: 3, verse: 2, endVerse: 4, text: 'Joined.' }, { book: 43, chapter: 3, verse: 3, text: 'Conflicting.' }],
      [{ book: 43, chapter: 3, verse: 4, text: 'Conflicting.' }, { book: 43, chapter: 3, verse: 2, endVerse: 4, text: 'Joined.' }],
      [{ book: 43, chapter: 3, verse: 4, endVerse: 2, text: 'Backwards.' }],
      [{ book: 43, chapter: 3, verse: 1, endVerse: 13, text: 'Oversized.' }],
    ]) {
      assert.throws(() => db.importBible({ version, replace: true, verses }));
      assert.equal(db.cue(select(3)).text, joined);
    }
  } finally { db.close(); }
});

test('next and previous traverse source spans once and preserve ordinary verse selections', () => {
  const db = library();
  try {
    let state = db.command('s', 0, { type: 'take', selection: select(3) });
    assert.deepEqual(state.live!.selection, select(2, 4));
    assert.deepEqual(state.recent[0], select(2, 4));
    state = db.command('s', state.revision, { type: 'step', direction: 1 });
    assert.deepEqual(state.live!.selection, select(5));
    state = db.command('s', state.revision, { type: 'step', direction: -1 });
    assert.deepEqual(state.live!.selection, select(2, 4));
    state = db.command('s', state.revision, { type: 'step', direction: -1 });
    assert.deepEqual(state.live!.selection, select(1));
    assert.equal(state.live!.reference, 'John 3:1 · SPAN');
    assert.equal(db.searchScripture('SPAN', 'John 3:1').verses[0].endVerse, undefined);
  } finally { db.close(); }
});

test('keyword and quotation hits preserve source spans; repeated interior citations do not republish', () => {
  const db = library();
  try {
    const hit = db.searchScripture('SPAN', 'silver lanterns').verses[0];
    assert.equal(hit.verse, 2); assert.equal(hit.endVerse, 4);
    assert.equal(db.searchScripture('SPAN', 'silver lanterns', 'listening').verses[0].endVerse, 4);
    const match = db.matchScriptureQuote('SPAN', joined);
    assert.deepEqual(match.selection, select(2, 4)); assert.equal(match.eligible, true);
    db.command('s', 0, { type: 'version', versionId: 'SPAN' });
    const sessions = new ListeningSessions(db, () => {});
    const session = sessions.start('s', 'u', { mode: 'automatic', language: 'en', commands: false });
    assert.equal(sessions.accept('s', session.id, 'u', 0, 'scripture', 'John 3:3', 10, 1).switched, true);
    assert.equal(sessions.accept('s', session.id, 'u', 1, 'scripture', 'John 3:4', 10, 2).decision, 'already-live');
  } finally { db.close(); }
});

test('existing verse databases gain optional ranges without changing their text', () => {
  const folder = fs.mkdtempSync(path.join(os.tmpdir(), 'lumen-range-migration-')), file = path.join(folder, 'worship.db');
  const old = new Database(file);
  old.exec(`CREATE TABLE bible_versions(id TEXT PRIMARY KEY,name TEXT NOT NULL,language TEXT NOT NULL,attribution TEXT NOT NULL);
    CREATE TABLE verses(id INTEGER PRIMARY KEY,versionId TEXT NOT NULL,book INTEGER NOT NULL,chapter INTEGER NOT NULL,verse INTEGER NOT NULL,text TEXT NOT NULL,UNIQUE(versionId,book,chapter,verse));
    INSERT INTO bible_versions VALUES('OLD','Old synthetic edition','en','Synthetic');
    INSERT INTO verses(versionId,book,chapter,verse,text) VALUES('OLD',43,3,1,'Untouched synthetic text.');`);
  old.close();
  const db = new WorshipLibrary(file);
  try {
    assert.equal(db.cue({ ...select(1), versionId: 'OLD' }).text, 'Untouched synthetic text.');
    assert.ok((db.db.pragma('table_info(verses)') as { name: string }[]).some(column => column.name === 'endVerse'));
    assert.equal(db.versions().find(v => v.id === 'OLD')?.verseCount, 1);
  } finally { db.close(); fs.rmSync(folder, { recursive: true, force: true }); }
});
