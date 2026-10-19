import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import Database from 'better-sqlite3';
import { WorshipLibrary } from '../src/worship-library.js';
import { ensureLyricsSearchIndex, invalidateLyricsSearch, searchLyrics, updateLyricsSearchIndex } from '../src/lyrics-search.js';

function library(filename = ':memory:') {
  const library = new WorshipLibrary(filename);
  const grace = library.saveSong({ id: 'grace', title: 'Amazing Grace', sections: [
    { id: 'verse-one', label: 'Verse 1', text: 'Amazing grace! How sweet the sound,\nThat saved a wretch like me.' },
    { id: 'verse-two', label: 'Verse 2', text: 'I once was lost, but now am found;\nWas blind, but now I see.' },
  ] });
  const mercy = library.saveSong({ id: 'mercy', title: 'Great Is Your Mercy', sections: [
    { id: 'chorus', label: 'Chorus', text: 'Amazing grace rings through the valley.\nYour mercy follows me all my days.' },
  ] });
  const love = library.saveSong({ id: 'love', title: 'Love Never Fails', sections: [
    { id: 'verse', label: 'Verse', text: 'You hold my heart forever.\nYour faithfulness will never let me go.' },
    { id: 'chorus', label: 'Chorus', text: 'Hallelujah, hallelujah!\nEvery nation sings your wonderful name.' },
  ] });
  const live = library.saveSong({ id: 'live', title: 'Live Forever', sections: [
    { id: 'verse', label: 'Verse', text: 'We live forever, singing hallelujah in the light.' },
  ] });
  return { library, grace, mercy, love, live };
}

test('song search finds partial title words in either order and ranks title above lyrics', () => {
  const { library: db } = library();
  try {
    for (const query of ['amaz gra', 'gra ama', 'AMAZING GRACE', 'amazing—grace!!']) {
      const result = searchLyrics(db.db, query);
      assert.equal(result[0].song.id, 'grace', query);
      assert.deepEqual(result[0].match, { kind: 'title', sectionId: null, excerpt: 'Amazing Grace', corrected: false });
      assert.equal(result[1].song.id, 'mercy', 'a title match precedes a lyric phrase in another song');
    }
    assert.equal(searchLyrics(db.db, 'never lo')[0].song.id, 'love');
    assert.equal(searchLyrics(db.db, 'forev')[0].song.id, 'live');
  } finally { db.close(); }
});

test('remembered lyric words find the actual section, including unordered prefixes', () => {
  const { library: db } = library();
  try {
    for (const query of ['blind now see', 'see blin', 'found lost once']) {
      const hit = searchLyrics(db.db, query)[0];
      assert.equal(hit.song.id, 'grace', query);
      assert.equal(hit.match.kind, 'lyrics');
      assert.equal(hit.match.sectionId, 'verse-two');
      assert.match(hit.match.excerpt, /Was blind, but now I see/);
      assert.equal(hit.match.corrected, false);
    }
    assert.equal(searchLyrics(db.db, 'never let go')[0].match.sectionId, 'verse');
    assert.equal(searchLyrics(db.db, 'nati sing wonder')[0].match.sectionId, 'chorus');
    assert.equal(searchLyrics(db.db, 'saved blind').length, 0, 'words scattered over separate verses are not a useful prepared section');
  } finally { db.close(); }
});

test('common title and lyric typos, transpositions and unfinished typo words are recoverable', () => {
  const { library: db } = library();
  try {
    const samples = [
      { query: 'amzing graec', song: 'grace', section: null },
      { query: 'amazng grace', song: 'grace', section: null },
      { query: 'amzin gra', song: 'grace', section: null },
      { query: 'grat mery', song: 'mercy', section: null },
      { query: 'blnid see', song: 'grace', section: 'verse-two' },
      { query: 'wretc saevd', song: 'grace', section: 'verse-one' },
      { query: 'halelujha wonderful', song: 'love', section: 'chorus' },
      { query: 'faithfullness never', song: 'love', section: 'verse' },
    ];
    for (const sample of samples) {
      const result = searchLyrics(db.db, sample.query);
      assert.equal(result[0]?.song.id, sample.song, sample.query);
      assert.equal(result[0].match.sectionId, sample.section, sample.query);
      assert.equal(result[0].match.corrected, true, sample.query);
    }
  } finally { db.close(); }
});

test('search never drops query words, negations or rewrites an already valid prefix', () => {
  const { library: db } = library();
  try {
    assert.deepEqual(searchLyrics(db.db, 'amzing NEVERMATCH'), []);
    assert.deepEqual(searchLyrics(db.db, 'blind not see'), []);
    assert.deepEqual(searchLyrics(db.db, 'wonderfull love'), [], 'valid love must not silently become live');
    for (const query of ['', ' ', '*', '" OR *', '()', 'a', 'x', '" NEAR(sing,5) NOT *']) {
      assert.deepEqual(searchLyrics(db.db, query), [], query);
    }
    assert.equal(searchLyrics(db.db, 'mercy mercy mercy')[0].song.id, 'mercy');
    assert.doesNotThrow(() => searchLyrics(db.db, 'a'.repeat(100_000)));
    assert.doesNotThrow(() => searchLyrics(db.db, '\u0000"\'~[]%\n🥁'));
  } finally { db.close(); }
});

test('title phrase ranking is deterministic and result list is capped without changing rows or channels', () => {
  const { library: db } = library();
  try {
    db.saveSong({ id: 'longer', title: 'Amazing Grace Forever', sections: [{ id: 'one', label: 'Verse', text: 'An unrelated verse.' }] });
    db.saveSong({ id: 'unordered', title: 'Grace Is Truly Amazing', sections: [{ id: 'one', label: 'Verse', text: 'An unrelated verse.' }] });
    for (let index = 0; index < 130; index++) db.saveSong({ id: `song-${index}`, title: `Grace Song ${String(index).padStart(3, '0')}`, sections: [{ id: 'chorus', label: 'Chorus', text: 'Let this house sing with joy.' }] });
    const before = db.db.prepare('SELECT total_changes() AS changes').get();
    const first = searchLyrics(db.db, 'amazing grace');
    assert.deepEqual(first.slice(0, 3).map(hit => hit.song.id), ['grace', 'longer', 'unordered']);
    assert.deepEqual(searchLyrics(db.db, 'amazing grace'), first);
    assert.equal(searchLyrics(db.db, 'grace').length, 100);
    assert.equal(new Set(searchLyrics(db.db, 'grace').map(hit => hit.song.id)).size, 100);
    assert.deepEqual(db.db.prepare('SELECT total_changes() AS changes').get(), before);
    assert.deepEqual(db.workspace('lyrics').live, null);
  } finally { db.close(); }
});

test('diacritics, non-Latin words, punctuation and original excerpt text stay intact', () => {
  const { library: db } = library();
  try {
    db.saveSong({ id: 'unicode', title: 'Grâce Éternelle — 永遠の愛', sections: [
      { id: 'first', label: 'Refrain', text: `${'We come to worship in this place. '.repeat(15)}Éternelle grâce, merveilleux amour! 永遠の愛 🌟 ${'We sing together with joy. '.repeat(12)}` },
    ] });
    assert.equal(searchLyrics(db.db, 'grace eter')[0].song.id, 'unicode');
    assert.equal(searchLyrics(db.db, '永遠')[0].song.id, 'unicode');
    const result = searchLyrics(db.db, 'merveilleux amour')[0];
    assert.equal(result.match.sectionId, 'first');
    assert.match(result.match.excerpt, /Éternelle grâce, merveilleux amour!/);
    assert.ok(result.match.excerpt.length <= 172);
    assert.ok(!/[\uD800-\uDBFF]$|^[\uDC00-\uDFFF]/.test(result.match.excerpt));
    assert.equal(searchLyrics(db.db, 'eternele grace')[0].song.id, 'unicode');
  } finally { db.close(); }
});

test('song edits/imports invalidate correction vocabulary and fetch current section text', () => {
  const { library: db, grace } = library();
  try {
    assert.equal(searchLyrics(db.db, 'amzing graec')[0].song.id, grace.id);
    const revised = db.saveSong({ ...grace, title: 'Resurrection Anthem', sections: [{ id: 'new', label: 'New chorus', text: 'Resurrection power brings victorious freedom.' }] });
    const remaining = searchLyrics(db.db, 'amzing graec');
    assert.ok(!remaining.some(hit => hit.song.id === grace.id), 'the edited song no longer has this title or lyric');
    assert.equal(remaining[0].song.id, 'mercy', 'other songs legitimately containing the remembered words remain searchable');
    const result = searchLyrics(db.db, 'resurection anhtem')[0];
    assert.equal(result.song.revision, revised.revision);
    assert.equal(result.song.title, revised.title);
    assert.equal(searchLyrics(db.db, 'victoroius freedm')[0].match.sectionId, 'new');
    const imported = db.saveSong({ id: 'imported', title: 'Magnificent Saviour', sections: [{ id: 'v', label: 'Verse', text: 'The incomparable king reigns forever.' }] });
    assert.equal(searchLyrics(db.db, 'magnficent savoiur')[0].song.id, imported.id);
    db.db.transaction(() => { db.db.prepare('DELETE FROM songs WHERE id=?').run(imported.id); db.db.prepare('DELETE FROM songs_fts WHERE id=?').run(imported.id); })();
    invalidateLyricsSearch(db.db);
    assert.deepEqual(searchLyrics(db.db, 'magnficent savoiur'), []);
  } finally { db.close(); }
});

test('external commits refresh vocabulary while cue changes do not rebuild the cached word index', () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'lumen-lyrics-search-'));
  const filename = path.join(directory, 'worship.db');
  const { library: db } = library(filename);
  let second: WorshipLibrary | undefined;
  try {
    assert.equal(searchLyrics(db.db, 'amzing graec')[0].song.id, 'grace');
    second = new WorshipLibrary(filename);
    second.saveSong({ id: 'external', title: 'Unshakeable Foundation', sections: [{ id: 'verse', label: 'Verse', text: 'We stand secure upon this rock.' }] });
    assert.equal(searchLyrics(db.db, 'unshakable foundtaion')[0].song.id, 'external');
    const existing = second.song('external');
    second.saveSong({ ...existing, title: 'Incomparable Majesty' });
    assert.equal(searchLyrics(db.db, 'incomparble majsety')[0].song.id, 'external');
    assert.deepEqual(searchLyrics(db.db, 'unshakable foundtaion'), []);
  } finally {
    second?.close(); db.close(); fs.rmSync(directory, { recursive: true, force: true });
  }

  const statements: string[] = [];
  const observed = new Database(':memory:', { verbose: statement => statements.push(String(statement)) });
  try {
    observed.exec(`
      CREATE TABLE songs(id TEXT PRIMARY KEY, revision INTEGER, title TEXT, author TEXT, copyright TEXT, sections TEXT, updatedAt TEXT);
      CREATE VIRTUAL TABLE songs_fts USING fts5(id UNINDEXED,title,body,prefix='2 3 4');
      CREATE VIRTUAL TABLE songs_vocab USING fts5vocab(songs_fts,'row');
      CREATE TABLE unrelated(state TEXT);
    `);
    observed.prepare('INSERT INTO songs VALUES(?,?,?,?,?,?,?)').run('grace', 1, 'Amazing Grace', '', '', JSON.stringify([{ id: 'verse', label: 'Verse', text: 'The sound of mercy rings.' }]), new Date().toISOString());
    observed.prepare('INSERT INTO songs_fts VALUES(?,?,?)').run('grace', 'Amazing Grace', 'The sound of mercy rings.');
    ensureLyricsSearchIndex(observed);
    assert.equal(searchLyrics(observed, 'amzing graec')[0].song.id, 'grace');
    observed.prepare('INSERT INTO unrelated VALUES(?)').run('cue changed');
    assert.equal(searchLyrics(observed, 'amzing graec')[0].song.id, 'grace');
    assert.equal(statements.filter(statement => /SELECT term AS value,doc AS documents FROM songs_vocab/.test(statement)).length, 1);
  } finally { observed.close(); }
});

test('thousands of songs retain quick indexed lookup and bounded warm typo search', () => {
  const { library: db } = library();
  try {
    const insert = db.db.prepare('INSERT INTO songs VALUES(?,?,?,?,?,?,?)');
    const fts = db.db.prepare('INSERT INTO songs_fts VALUES(?,?,?)');
    const sectionFts = db.db.prepare('INSERT INTO song_sections_fts VALUES(?,?,?)');
    const now = new Date().toISOString();
    db.db.transaction(() => {
      for (let index = 0; index < 4000; index++) {
        const title = `Gathering Song ${index}`;
        const body = `Let every voice sing together today, with everlasting joy and steadfast courage. Specialword${index} belongs here.`;
        const sections = [{ id: 'verse', label: 'Verse', text: body }, { id: 'chorus', label: 'Chorus', text: 'We lift our hearts in worship, let the whole earth sing with joy.' }];
        insert.run(`load-${index}`, 1, title, '', '', JSON.stringify(sections), now);
        fts.run(`load-${index}`, title, sections.map(section => section.text).join('\n'));
        for (const section of sections) sectionFts.run(`load-${index}`, section.id, section.text);
      }
    })();
    invalidateLyricsSearch(db.db);
    const coldStarted = performance.now();
    assert.equal(searchLyrics(db.db, 'amzing graec')[0].song.id, 'grace');
    const coldElapsed = performance.now() - coldStarted;
    const started = performance.now();
    const samples = ['amaz gra', 'blind now see', 'blnid see', 'faithfullness never', 'halelujha wonderful', 'gather song 3099'];
    for (const query of samples) assert.ok(searchLyrics(db.db, query).length, query);
    const elapsed = performance.now() - started;
    assert.ok(coldElapsed < 2000, `4,000-song cold fuzzy lookup took ${Math.round(coldElapsed)} ms`);
    assert.ok(elapsed < 1500, `six warm 4,000-song lookups took ${Math.round(elapsed)} ms`);
    console.log(`Lyrics search, 4,004 songs: ${Math.round(coldElapsed)} ms cold typo index; ${Math.round(elapsed / samples.length)} ms average warm lookup.`);
  } finally { db.close(); }
});

test('existing-library section index migration is atomic and preserves original songs', () => {
  const db = new Database(':memory:');
  try {
    db.exec('CREATE TABLE songs(id TEXT PRIMARY KEY,sections TEXT)');
    const text = JSON.stringify([{ id: 'verse', label: 'Verse', text: 'Old mercy keeps singing.' }, { id: 'chorus', label: 'Chorus', text: 'New hope wakes again.' }]);
    db.prepare('INSERT INTO songs VALUES(?,?)').run('existing', text);
    db.prepare('INSERT INTO songs VALUES(?,?)').run('invalid', 'malformed JSON');
    assert.throws(() => ensureLyricsSearchIndex(db), /malformed JSON/);
    assert.equal(db.prepare("SELECT 1 FROM sqlite_master WHERE name='song_sections_fts'").get(), undefined, 'failed backfill must also roll back virtual table creation');
    db.prepare('DELETE FROM songs WHERE id=?').run('invalid');
    ensureLyricsSearchIndex(db);
    assert.deepEqual(db.prepare('SELECT songId,sectionId,body FROM song_sections_fts ORDER BY rowid').all(), [
      { songId: 'existing', sectionId: 'verse', body: 'Old mercy keeps singing.' },
      { songId: 'existing', sectionId: 'chorus', body: 'New hope wakes again.' },
    ]);
    const changes = db.prepare('SELECT total_changes() AS changes').get();
    ensureLyricsSearchIndex(db);
    assert.deepEqual(db.prepare('SELECT total_changes() AS changes').get(), changes, 'reopening a migrated library does not reindex');
    assert.equal((db.prepare('SELECT sections FROM songs WHERE id=?').get('existing') as { sections: string }).sections, text);
  } finally { db.close(); }
});

test('cross-section decoys cannot hide a useful song beyond the candidate cap', () => {
  const { library: db } = library();
  try {
    for (let index = 0; index < 260; index++) db.saveSong({ id: `decoy-${index}`, title: `A Decoy ${index}`, sections: [
      { id: 'verse', label: 'Verse', text: 'The radiant dawn awakens.' },
      { id: 'chorus', label: 'Chorus', text: 'We sing victorious praise.' },
    ] });
    db.saveSong({ id: 'useful', title: 'Z Useful Song', sections: [{ id: 'bridge', label: 'Bridge', text: 'Radiant love carries us in victorious praise.' }] });
    const hits = searchLyrics(db.db, 'radiant victorious');
    assert.equal(hits.length, 1);
    assert.equal(hits[0].song.id, 'useful');
    assert.equal(hits[0].match.sectionId, 'bridge');
    assert.equal(searchLyrics(db.db, 'radaint victoriuos')[0].song.id, 'useful');
  } finally { db.close(); }
});

test('index updates roll back with failed song transactions and replace removed sections', () => {
  const { library: db, grace } = library();
  try {
    assert.throws(() => db.db.transaction(() => {
      updateLyricsSearchIndex(db.db, { ...grace, sections: [{ id: 'wrong', label: 'Wrong', text: 'This transaction will never be committed.' }] });
      throw new Error('rollback test');
    })(), /rollback test/);
    assert.equal(searchLyrics(db.db, 'blind see')[0].match.sectionId, 'verse-two');
    assert.deepEqual(searchLyrics(db.db, 'transaction committed'), []);
    db.saveSong({ ...grace, sections: [{ id: 'only', label: 'New verse', text: 'Unfailing compassion fills the morning.' }] });
    assert.deepEqual(searchLyrics(db.db, 'blind see'), []);
    assert.equal(searchLyrics(db.db, 'compassion morning')[0].match.sectionId, 'only');
  } finally { db.close(); }
});

test('repetitive long lyric excerpts remain bounded and fast', () => {
  const { library: db } = library();
  try {
    db.db.transaction(() => {
      for (let index = 0; index < 245; index++) db.saveSong({ id: `repeat-${index}`, title: `Refrain ${index}`, sections: [
        { id: 'chorus', label: 'Chorus', text: 'Mercy mercy mercy '.repeat(220) },
      ] });
    })();
    const started = performance.now();
    const result = searchLyrics(db.db, 'mercy');
    const elapsed = performance.now() - started;
    assert.equal(result.length, 100);
    assert.ok(result.every(hit => hit.match.excerpt.length <= 170));
    assert.ok(elapsed < 1500, `repeated-word excerpt lookup took ${Math.round(elapsed)} ms`);
    console.log(`Lyrics repeated-word search: ${Math.round(elapsed)} ms for 240 long matching sections.`);
  } finally { db.close(); }
});

test('an exact title with long lyrics is not buried behind shorter-body title prefixes', () => {
  const { library: db } = library();
  try {
    for (let index = 0; index < 135; index++) db.saveSong({ id: `title-decoy-${index}`, title: `Celestial Harmony ${index}`, sections: [{ id: 'verse', label: 'Verse', text: 'Sing praise.' }] });
    db.saveSong({ id: 'exact-title', title: 'Celestial Harmony', sections: Array.from({ length: 20 }, (_, index) => ({ id: `verse-${index}`, label: `Verse ${index}`, text: 'Our song rises through the heavens in a chorus of joyful praise. '.repeat(60) })) });
    const result = searchLyrics(db.db, 'celestial harmony');
    assert.equal(result[0].song.id, 'exact-title');
    assert.equal(result[0].match.kind, 'title');
  } finally { db.close(); }
});

test('negation words are never corrected, omitted or expanded into unrelated word beginnings', () => {
  const { library: db } = library();
  try {
    db.saveSong({ id: 'noteworthy', title: 'Noteworthy Praise', sections: [{ id: 'verse', label: 'Verse', text: 'Noteworthy love and mercy fill the house.' }] });
    db.saveSong({ id: 'negated', title: 'Fear Not', sections: [{ id: 'chorus', label: 'Chorus', text: 'We never fear, not in the storm.' }] });
    assert.deepEqual(searchLyrics(db.db, 'not mercy'), []);
    assert.deepEqual(searchLyrics(db.db, 'blind not see'), []);
    assert.deepEqual(searchLyrics(db.db, 'blind never see'), []);
    assert.equal(searchLyrics(db.db, 'not storm')[0].song.id, 'negated');
    assert.equal(searchLyrics(db.db, 'never fear')[0].song.id, 'negated');
  } finally { db.close(); }
});
