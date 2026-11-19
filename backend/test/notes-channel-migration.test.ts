import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { ContentSchema } from '../src/schema.js';
import { migrateNotesChannel, notesChannelUpgrade } from '../src/notes-channel-migration.js';
import { NotesStore } from '../src/notes-store.js';

const note = (id: string, extra = {}) => ({ id, type: 'notes', title: 'A sermon point', body: 'Published words', ...extra });
const content = () => ContentSchema.parse({ version: 2, updatedAt: '2026-01-01T00:00:00.000Z', settings: {}, music: {},
  playlists: [
    { id: 'sermon-deck', name: 'Listening rehearsal', items: [note('root'), note('child', { notesSourceId: 'root' })] },
    { id: 'service-deck', name: 'Presentation', items: [note('legacy-note'), { id: 'welcome', type: 'text', body: 'Welcome' }] },
  ],
  channels: [
    { id: 'sermon', name: 'Listening rehearsal', kind: 'presentation', playlistId: 'sermon-deck', defaultMode: 'manual' },
    { id: 'service', name: 'Presentation', kind: 'announcement', playlistId: 'service-deck' },
  ],
  sources: [{ id: 'sermon-source', kind: 'channel', ref: 'sermon' }],
  destinations: [{ id: 'screen', kind: 'screen', label: 'Screen' }],
  routes: [{ id: 'route', sourceId: 'sermon-source', destinationId: 'screen' }],
  program: { programSourceId: 'sermon-source', previewSourceId: null },
});

test('promoting Notes keeps channel, playlist, item, routing and series identities; mixed decks stay intact', () => {
  const original = content(), before = structuredClone(original);
  const upgrade = notesChannelUpgrade(original);
  assert.deepEqual(original, before, 'Planning a migration does not mutate the input');
  assert.deepEqual(upgrade.promoted, ['sermon']); assert.equal(upgrade.created, null);
  assert.deepEqual(upgrade.content.channels[0], { ...before.channels[0], kind: 'notes' });
  assert.deepEqual(upgrade.content.channels[1], before.channels[1]);
  for (const key of ['playlists', 'sources', 'routes', 'destinations', 'program'] as const) assert.deepEqual(upgrade.content[key], before[key]);
  assert.deepEqual(notesChannelUpgrade(upgrade.content), { content: upgrade.content, promoted: [], created: null });
  assert.equal(ContentSchema.parse(upgrade.content).channels[0].kind, 'notes');
});

test('one default Notes channel is added without ID collisions or changing mixed presentation notes', () => {
  const original = content(); original.channels.shift();
  original.channels[0].id = 'chnl_notes'; original.playlists[0].id = 'plst_notes';
  original.sources.push({ id: 'src_chnl_notes_2', kind: 'media', ref: 'retained' });
  const upgrade = notesChannelUpgrade(original);
  assert.equal(upgrade.created, 'chnl_notes_2');
  assert.equal(upgrade.content.channels.at(-1)?.playlistId, 'plst_notes_2');
  assert.equal(upgrade.content.sources.at(-1)?.id, 'src_chnl_notes_2_2');
  assert.deepEqual(upgrade.content.playlists.slice(0, -1), original.playlists);
  assert.equal(upgrade.content.channels.filter(channel => channel.kind === 'notes').length, 1);
});

test('startup migration preserves private Notes byte-for-byte, exact backups, unknown metadata and later deletions', async t => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'lumen-notes-upgrade-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const original = { ...content(), stationExtra: { keep: true } };
  Object.assign(original.playlists[0].items[0], { legacyExtra: 'preserve' });
  const raw = JSON.stringify(original), file = path.join(root, 'content.json');
  await fs.writeFile(file, raw);
  let store = new NotesStore(path.join(root, 'notes.db'));
  const initial = store.get('sermon', 'root');
  store.saveDraft('sermon', 'root', initial.revision, { title: 'Private title', body: 'Unpublished draft', reference: 'Speaker', layout: 'key-points', grouping: 'pointers' });
  store.appendSegment('sermon', 'root', 'saved-session', 0, 'Private transcript', false);
  const privateBefore = store.get('sermon', 'root'); store.close();
  const databaseBefore = await fs.readFile(path.join(root, 'notes.db'));
  assert.deepEqual(await migrateNotesChannel(root), { promoted: ['sermon'], created: null, skipped: false });
  assert.deepEqual(await fs.readFile(path.join(root, 'notes.db')), databaseBefore);
  assert.equal(await fs.readFile(path.join(root, 'migrations/notes-channel-v1.before.json'), 'utf8'), raw);
  const saved = JSON.parse(await fs.readFile(file, 'utf8'));
  assert.deepEqual(saved.stationExtra, original.stationExtra);
  assert.deepEqual(saved.playlists, original.playlists);
  store = new NotesStore(path.join(root, 'notes.db'));
  assert.deepEqual(store.get('sermon', 'root'), privateBefore); store.close();
  // Simulate interruption after the content commit but before the marker: the
  // retry must keep IDs and the first exact backup, rather than adding a lane.
  await fs.rm(path.join(root, 'migrations/notes-channel-v1.json'));
  const migratedRaw = await fs.readFile(file, 'utf8');
  assert.deepEqual(await migrateNotesChannel(root), { promoted: [], created: null, skipped: false });
  assert.equal(await fs.readFile(file, 'utf8'), migratedRaw);
  assert.equal(await fs.readFile(path.join(root, 'migrations/notes-channel-v1.before.json'), 'utf8'), raw);
  saved.channels = []; saved.sources = []; await fs.writeFile(file, JSON.stringify(saved));
  assert.equal((await migrateNotesChannel(root)).skipped, true);
  assert.deepEqual(JSON.parse(await fs.readFile(file, 'utf8')).channels, [], 'A deliberately deleted channel stays deleted after restart');
});

test('fresh stations receive Notes and invalid existing content is not overwritten or marked complete', async t => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'lumen-notes-new-'));
  const invalid = await fs.mkdtemp(path.join(os.tmpdir(), 'lumen-notes-invalid-'));
  t.after(() => Promise.all([root, invalid].map(directory => fs.rm(directory, { recursive: true, force: true }))));
  assert.equal((await migrateNotesChannel(root)).created, 'chnl_notes');
  const saved = ContentSchema.parse(JSON.parse(await fs.readFile(path.join(root, 'content.json'), 'utf8')));
  assert.equal(saved.channels[0].kind, 'notes'); assert.equal(saved.channels[0].defaultMode, 'manual');
  const rawSaved = JSON.parse(await fs.readFile(path.join(root, 'content.json'), 'utf8'));
  assert.equal(rawSaved.settings.fontFamily, 'Inter'); assert.equal(rawSaved.music.volume, 0.6);
  await fs.writeFile(path.join(invalid, 'content.json'), 'invalid');
  await assert.rejects(migrateNotesChannel(invalid));
  assert.equal(await fs.readFile(path.join(invalid, 'content.json'), 'utf8'), 'invalid');
  await assert.rejects(fs.access(path.join(invalid, 'migrations/notes-channel-v1.json')));
});
