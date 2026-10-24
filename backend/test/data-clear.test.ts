import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { DataClear } from '../src/data-clear.js';
import { WorshipLibrary } from '../src/worship-library.js';
import { ContentSchema } from '../src/schema.js';
import { ProductionStore } from '../src/production-store.js';
import { RecordingStore } from '../src/production-recordings.js';
import { ProductionDataTransfer } from '../src/production-data-transfer.js';

const none = { bibles: [], songs: [], presentations: [], media: [], scenes: [], recordings: [], setlists: [], clips: [], settings: false };
async function fixture() {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'lumen-clear-test-'));
  const library = new WorshipLibrary(path.join(root, 'worship.db'));
  library.importBible({ version: { id: 'KJV', name: 'Synthetic Bible', language: 'en', attribution: 'Test only' }, verses: [{ book: 1, chapter: 1, verse: 1, text: 'Synthetic verse for removal' }] });
  for (const id of ['selected','retained']) library.saveSong({ id, title: id, author: '', copyright: '', sections: [{ id: 'v1', label: 'Verse', text: `${id} distinct lyrics` }] });
  library.command('lyrics', 0, { type: 'setlist', songIds: ['selected'] });
  library.command('lyrics', 1, { type: 'take', selection: { kind: 'lyrics', songId: 'selected', sectionId: 'v1' } });
  const content = ContentSchema.parse({ version: 2, updatedAt: '2026-01-01T00:00:00.000Z', settings: { fontFamily: 'Custom Font' },
    playlists: [{ id: 'lyrics-deck', name: 'Service', items: [] }, { id: 'slides', name: 'Slides', items: [{ id: 'slide', type: 'image', background: { kind: 'image', src: '/media/backgrounds/sample.png' } }] }],
    channels: [{ id: 'lyrics', kind: 'lyrics', name: 'Service lyrics', playlistId: 'lyrics-deck' }, { id: 'screen', name: 'Presentation', playlistId: 'slides' }],
    sources: [{ id: 'source', kind: 'channel', ref: 'screen' }], routes: [{ id: 'route', sourceId: 'source', destinationId: 'dest' }], destinations: [{ id: 'dest', kind: 'screen', label: 'Screen' }], program: { programSourceId: 'source' }, music: {} });
  await fs.writeFile(path.join(root, 'content.json'), JSON.stringify(content));
  await fs.mkdir(path.join(root, 'media/backgrounds'), { recursive: true });
  await fs.writeFile(path.join(root, 'media/backgrounds/sample.png'), 'synthetic image');
  const store = new ProductionStore(root); await store.init();
  const recordings = new RecordingStore(path.join(root, 'recordings'), () => {}); await recordings.init();
  let live = false;
  const production = new ProductionDataTransfer(store, recordings, undefined, () => live);
  return { root, library, store, production, clear: new DataClear(library, root, production), setLive: (value: boolean) => { live = value; },
    close: async () => { library.close(); await fs.rm(root, { recursive: true, force: true }); } };
}

test('clear review blocks retained dependencies; selected data is removed with recoverable originals and search cleanup', async () => {
  const f = await fixture();
  try {
    const songsOnly = await f.clear.preview({ ...none, songs: ['selected'] });
    assert.match(songsOnly.blockers.join(' '), /retained setlist/);
    await assert.rejects(f.clear.clear(songsOnly), /retained setlist/);
    const mediaOnly = await f.clear.preview({ ...none, media: ['media/backgrounds/sample.png'] });
    assert.match(mediaOnly.blockers.join(' '), /used by “Slides”/);
    const selection = { ...none, songs: ['selected'], bibles: ['KJV'], setlists: ['lyrics'], presentations: ['slides'], media: ['media/backgrounds/sample.png'], scenes: f.store.get().scenes.map(s => s.id), settings: true };
    const plan = await f.clear.preview(selection); assert.deepEqual(plan.blockers, []);
    const result = await f.clear.clear(plan);
    assert.equal(result.removed.songs, 1); assert.equal(f.library.song('retained').title, 'retained');
    assert.throws(() => f.library.song('selected'), /not found/);
    assert.equal(f.library.searchSongs('selected').length, 0);
    assert.equal(f.library.versions().filter(v => v.installed).length, 0);
    assert.ok(f.library.db.prepare("SELECT 1 FROM worship_preferences WHERE key='suppress_default_kjv'").get());
    const workspace = f.library.workspace('lyrics'); assert.deepEqual(workspace.setlist, []); assert.deepEqual(workspace.recent, []); assert.equal(workspace.live, null);
    const after = JSON.parse(await fs.readFile(path.join(f.root, 'content.json'), 'utf8'));
    assert.equal(after.settings.fontFamily, 'Inter'); assert.equal(after.playlists.length, 1); assert.equal(after.channels.length, 1);
    assert.deepEqual(after.sources, []); assert.deepEqual(after.routes, []); assert.equal(after.program.programSourceId, null);
    assert.equal(f.store.get().scenes.length, 0); assert.equal(f.store.get().previewSceneId, null);
    assert.equal(await fs.readFile(path.join(result.backupPath, 'removed/media/backgrounds/sample.png'), 'utf8'), 'synthetic image');
    const backup = new WorshipLibrary(path.join(result.backupPath, 'worship.db'));
    try { assert.equal(backup.song('selected').title, 'selected'); assert.equal(backup.versions().filter(v => v.installed).length, 1); } finally { backup.close(); }
    await assert.rejects(fs.stat(path.join(f.root, 'media/backgrounds/sample.png')), { code: 'ENOENT' });
  } finally { await f.close(); }
});

test('stale reviews and active Studio cannot clear changed data', async () => {
  const f = await fixture();
  try {
    const plan = await f.clear.preview({ ...none, songs: ['retained'] });
    f.library.saveSong({ id: 'retained', revision: f.library.song('retained').revision, title: 'Edited after review', author: '', copyright: '', sections: [{ id: 'v1', label: 'Verse', text: 'New text' }] });
    await assert.rejects(f.clear.clear(plan), /changed/); assert.equal(f.library.song('retained').title, 'Edited after review');
    f.setLive(true);
    const live = await f.clear.preview({ ...none, scenes: f.store.get().scenes.map(s => s.id) });
    assert.match(live.blockers.join(' '), /Stop Studio/); await assert.rejects(f.clear.clear(live), /Stop Studio/);
    await assert.rejects(f.clear.preview({ ...none }), /Select something/);
  } finally { await f.close(); }
});

test('failure after production filesystem commit rolls back SQLite, media, content and Studio caches', async () => {
  const f = await fixture();
  try {
    const content = await fs.readFile(path.join(f.root, 'content.json')), studio = f.store.get();
    const original = f.production.transaction.bind(f.production);
    f.production.transaction = (backup, operation) => original(backup, tx => operation({ ...tx, commitSync() { tx.commitSync(); throw new Error('Injected commit failure'); } }));
    const plan = await f.clear.preview({ ...none, songs: ['retained'], presentations: ['slides'], media: ['media/backgrounds/sample.png'], scenes: studio.scenes.map(s => s.id) });
    await assert.rejects(f.clear.clear(plan), /Injected commit failure/);
    assert.equal(f.library.song('retained').title, 'retained'); assert.equal(f.library.searchSongs('retained').length, 1);
    assert.deepEqual(await fs.readFile(path.join(f.root, 'content.json')), content); assert.deepEqual(f.store.get(), studio);
    assert.equal(await fs.readFile(path.join(f.root, 'media/backgrounds/sample.png'), 'utf8'), 'synthetic image');
  } finally { await f.close(); }
});

test('authorization is rechecked after backup preparation and before any destructive write', async () => {
  const f = await fixture();
  try {
    const before = await fs.readFile(path.join(f.root, 'content.json'));
    const plan = await f.clear.preview({ ...none, songs: ['retained'] });
    await assert.rejects(f.clear.clear(plan, () => { throw new Error('Administrator access was revoked'); }), /revoked/);
    assert.equal(f.library.song('retained').title, 'retained');
    assert.deepEqual(await fs.readFile(path.join(f.root, 'content.json')), before);
  } finally { await f.close(); }
});
