import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import Database from 'better-sqlite3';
import { searchScriptureKeywords } from '../src/scripture-keyword-search.js';

function database() {
  const db = new Database(':memory:');
  db.exec(`
    CREATE TABLE verses(id INTEGER PRIMARY KEY,versionId TEXT,book INTEGER,chapter INTEGER,verse INTEGER,text TEXT);
    CREATE VIRTUAL TABLE verses_fts USING fts5(text,content='verses',content_rowid='id',prefix='2 3 4');
    CREATE TRIGGER verse_insert AFTER INSERT ON verses BEGIN
      INSERT INTO verses_fts(rowid,text) VALUES(new.id,new.text);
    END;
  `);
  const insert = db.prepare('INSERT INTO verses(versionId,book,chapter,verse,text) VALUES(?,?,?,?,?)');
  const add = (verse: number, text: string, version = 'KJV') => insert.run(version, 19, 23, verse, text);
  add(1, 'The LORD is my shepherd; I shall not want.');
  add(2, 'My shepherd watches faithfully beside the valley where the Lord leads me.');
  add(3, 'The Lord walks with the faithful through a valley and shall guide their hearts to the mountain where a shepherd waits.');
  add(4, 'The lord my shepherd is near.');
  add(5, 'Thy word is a lamp unto my feet, and a light unto my path.');
  add(6, 'Fear not: for I am with thee; be not dismayed; for I am thy God.');
  add(7, 'Fear the shepherd and follow the light.');
  add(8, 'For God so loved the world, that he gave his only begotten Son.');
  add(9, 'The Lord is my shepherd; I lack nothing.', 'OTHER');
  return { db, add };
}

test('manual keywords rank exact phrase, nearby terms and unordered words without dropping content', () => {
  const { db } = database();
  try {
    const result = searchScriptureKeywords(db, 'KJV', 'lord my shepherd');
    assert.equal(result.rows[0].verse, 4, 'exact contiguous phrase outranks proximity/BM25');
    assert.ok(result.rows.find(row => row.verse === 1), 'near phrase need not include every remembered connector');
    assert.ok(result.rows.find(row => row.verse === 2), 'word order is not required');
    assert.ok(!result.rows.find(row => row.verse === 3), 'my is not dropped while full-word matches exist');
    assert.equal(result.mode, 'keywords');
    assert.deepEqual(result.ignoredWords, []);
  } finally { db.close(); }
});

test('manual keyword prefixes, omitted connectors and punctuation work locally', () => {
  const { db } = database();
  try {
    assert.equal(searchScriptureKeywords(db, 'KJV', 'god so lov').rows[0].verse, 8);
    assert.equal(searchScriptureKeywords(db, 'KJV', 'shep lor').rows[0].book, 19);
    assert.equal(searchScriptureKeywords(db, 'KJV', 'WORLD, loved—GOD!').rows[0].verse, 8);
    const relaxed = searchScriptureKeywords(db, 'KJV', 'your word lamp');
    assert.equal(relaxed.rows[0].verse, 5);
    assert.equal(relaxed.mode, 'relaxed');
    assert.deepEqual(relaxed.ignoredWords, ['your']);
    assert.equal(searchScriptureKeywords(db, 'KJV', 'thy wor lam').rows[0].verse, 5);
  } finally { db.close(); }
});

test('fallback never drops meaningful terms or negations, and never adds unrelated OR matches', () => {
  const { db } = database();
  try {
    assert.equal(searchScriptureKeywords(db, 'KJV', 'the lamp shepherd').rows.length, 0);
    assert.equal(searchScriptureKeywords(db, 'KJV', 'fear not shepherd').rows.length, 0);
    assert.equal(searchScriptureKeywords(db, 'KJV', 'fear not').rows[0].verse, 6);
    for (const input of ['', ' ', '*', '" OR *', 'the and my', 'g', '(){}:";--']) {
      assert.deepEqual(searchScriptureKeywords(db, 'KJV', input).rows, [], input);
    }
    assert.equal(searchScriptureKeywords(db, 'KJV', 'god NEVERMATCH').rows.length, 0);
  } finally { db.close(); }
});

test('all ranking tiers remain edition scoped, deterministic and capped without writes', () => {
  const { db, add } = database();
  try {
    for (let i = 10; i < 130; i++) add(i, `The Lord is my shepherd number ${i}.`);
    const before = db.prepare('SELECT total_changes() AS changes').get();
    const first = searchScriptureKeywords(db, 'KJV', 'lord shepherd');
    assert.equal(first.rows.length, 80);
    assert.ok(first.rows.every(row => row.versionId === 'KJV'));
    assert.deepEqual(searchScriptureKeywords(db, 'KJV', 'lord shepherd'), first);
    assert.deepEqual(db.prepare('SELECT total_changes() AS changes').get(), before);
    assert.equal(searchScriptureKeywords(db, 'OTHER', 'lord shepherd').rows.length, 1);
    assert.equal(searchScriptureKeywords(db, 'MISSING', 'lord shepherd').rows.length, 0);
    assert.doesNotThrow(() => searchScriptureKeywords(db, 'KJV', 'lamp '.repeat(10000)));
  } finally { db.close(); }
});

test('full offline KJV keyword lookup finds short phrases in bounded interactive time', () => {
  const { db } = database();
  try {
    db.exec('DELETE FROM verses_fts; DELETE FROM verses;');
    const books = JSON.parse(fs.readFileSync(new URL('../assets/kjv.source.json', import.meta.url), 'utf8').replace(/^\uFEFF/, ''));
    const insert = db.prepare('INSERT INTO verses(versionId,book,chapter,verse,text) VALUES(?,?,?,?,?)');
    db.transaction(() => {
      books.forEach((book: { chapters: string[][] }, bookIndex: number) => {
        book.chapters.forEach((chapter, chapterIndex) => chapter.forEach((text, verseIndex) => {
          insert.run('KJV', bookIndex + 1, chapterIndex + 1, verseIndex + 1, text);
        }));
      });
    })();
    const cases = [
      { query: 'the lord my shep', book: 19, chapter: 23, verse: 1 },
      { query: 'god so lov world', book: 43, chapter: 3, verse: 16 },
      { query: 'word lamp feet', book: 19, chapter: 119, verse: 105 },
      { query: 'all things work together', book: 45, chapter: 8, verse: 28 },
      { query: 'your word lamp', book: 19, chapter: 119, verse: 105 },
    ];
    const started = performance.now();
    for (const sample of cases) {
      const result = searchScriptureKeywords(db, 'KJV', sample.query);
      assert.ok(result.rows.some(row => row.book === sample.book && row.chapter === sample.chapter && row.verse === sample.verse), sample.query);
    }
    const elapsed = performance.now() - started;
    assert.ok(elapsed < 2500, `five 31,102-verse FTS lookups took ${Math.round(elapsed)} ms`);
    console.log(`KJV keyword search: ${Math.round(elapsed / cases.length)} ms average across ${cases.length} short queries.`);
  } finally { db.close(); }
});
