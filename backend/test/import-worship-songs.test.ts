import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import Database from 'better-sqlite3';
import { importWorshipSongs } from '../src/import-worship-songs.js';
import { WorshipLibrary } from '../src/worship-library.js';

const song = (id: string, text = 'Silver lanterns illuminate the courtyard') => ({ id, title: `Fixture ${id}`, author: 'Synthetic author', copyright: 'Synthetic test content', sections: [{ id: 'v1', label: 'Verse 1', text }] });
async function fixture() {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'lumen-song-import-'));
  const database = path.join(dir, 'worship.db'), library = new WorshipLibrary(database);
  return { dir, database, library, backup: (name = 'backup') => path.join(dir, `${name}.db`), async close() { library.close(); await fs.rm(dir, { recursive: true, force: true }); } };
}

test('validates the whole batch and stable IDs before any write; dry-run is read-only', async () => {
  const f = await fixture();
  try {
    for (const songs of [[song('one'), { ...song('two'), sections: [] }], [song('one'), { ...song('two'), id: undefined }], [song('one'), song('one')]]) {
      await assert.rejects(importWorshipSongs({ songs }, { database: f.database, apply: true, backup: f.backup() }));
      assert.equal(f.library.songs().length, 0);
      await assert.rejects(fs.stat(f.backup()), { code: 'ENOENT' });
    }
    const preview = await importWorshipSongs({ songs: [song('one')] }, { database: f.database });
    assert.equal(preview.mode, 'dry-run'); assert.equal(preview.wouldAdd, 1); assert.equal(preview.added, 0);
    assert.equal(f.library.songs().length, 0);
    await assert.rejects(importWorshipSongs({ songs: [song('one')] }, { database: f.database, apply: true }), /--backup/);
  } finally { await f.close(); }
});

test('apply backs up the open WAL database, indexes songs, and is idempotent without changing live state', async () => {
  const f = await fixture();
  try {
    f.library.saveSong(song('existing'));
    f.library.command('lyrics', 0, { type: 'take', selection: { kind: 'lyrics', songId: 'existing', sectionId: 'v1' } });
    const state = f.library.workspace('lyrics');
    // Prime the other connection's typo vocabulary before the import.
    f.library.searchSongs('lantern');
    const input = { songs: [song('new', 'Cobalt mountains shimmer beneath the moon')] };
    const result = await importWorshipSongs(input, { database: f.database, apply: true, backup: f.backup() });
    assert.equal(result.added, 1); assert.equal(result.conflicts.length, 0);
    assert.equal(f.library.searchSongs('cobalt mountains')[0].song.id, 'new');
    assert.equal(f.library.searchSongs('coblat mountains')[0].song.id, 'new');
    assert.deepEqual(f.library.workspace('lyrics'), state);
    const backup = new Database(f.backup(), { readonly: true });
    try { assert.equal((backup.prepare('SELECT COUNT(*) AS n FROM songs').get() as { n: number }).n, 1); assert.equal(backup.pragma('quick_check', { simple: true }), 'ok'); }
    finally { backup.close(); }
    const revision = f.library.song('new').revision;
    const repeated = await importWorshipSongs(input, { database: f.database, apply: true, backup: f.backup('again') });
    assert.equal(repeated.added, 0); assert.equal(repeated.unchanged, 1); assert.equal(f.library.song('new').revision, revision);
    await assert.rejects(importWorshipSongs(input, { database: f.database, apply: true, backup: f.backup() }), { code: 'EEXIST' });
  } finally { await f.close(); }
});

test('conflicts preserve existing edits while new IDs import', async () => {
  const f = await fixture();
  try {
    const existing = f.library.saveSong(song('shared', 'A locally edited synthetic verse'));
    const input = { songs: [song('shared'), song('new')] };
    const preview = await importWorshipSongs(input, { database: f.database });
    assert.deepEqual(preview.conflicts, [{ id: 'shared', title: 'Fixture shared' }]);
    const result = await importWorshipSongs(input, { database: f.database, apply: true, backup: f.backup() });
    assert.equal(result.added, 1); assert.equal(result.conflicts.length, 1);
    assert.deepEqual(f.library.song('shared'), existing);
  } finally { await f.close(); }
});

test('an insertion failure rolls back the whole batch and indexes', async () => {
  const f = await fixture();
  try {
    f.library.db.exec("CREATE TRIGGER fail_import BEFORE INSERT ON songs WHEN NEW.id='fail' BEGIN SELECT RAISE(ABORT,'Synthetic failure'); END");
    await assert.rejects(importWorshipSongs({ songs: [song('first'), song('fail')] }, { database: f.database, apply: true, backup: f.backup() }), /Synthetic failure/);
    assert.equal(f.library.songs().length, 0);
    assert.equal(f.library.searchSongs('lanterns').length, 0);
    assert.equal((f.library.db.prepare('SELECT COUNT(*) AS n FROM song_sections_fts').get() as { n: number }).n, 0);
  } finally { await f.close(); }
});
