import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { gzipSync, gunzipSync } from 'node:zlib';
import { createHash } from 'node:crypto';
import { DataTransfer, MAX_TRANSFER_COMPRESSED_BYTES, type ValidatedArchive } from '../src/data-transfer.js';
import { WorshipLibrary } from '../src/worship-library.js';
import { ContentSchema } from '../src/schema.js';
import { initialProduction } from '../src/production-schema.js';
import { ProductionStore } from '../src/production-store.js';
import { RecordingStore } from '../src/production-recordings.js';
import { ProductionDataTransfer } from '../src/production-data-transfer.js';
import { writeArchiveFile } from '../src/data-transfer-codec.js';

const none = { bibles: [] as string[], songs: [] as string[], presentations: [] as string[], media: [] as string[], settings: false };
const sampleSong = (id: string, text = 'A portable lyric with a distinctive phrase') => ({ id, title: `Song ${id}`, author: 'Fixture author', copyright: 'Synthetic test text', sections: [{ id: 'v1', label: 'Verse 1', text }] });
const sampleBible = (id: string) => ({ version: { id, name: `Fixture ${id}`, language: 'en', attribution: 'Synthetic test edition' }, verses: [{ book: 1, chapter: 1, verse: 1, endVerse: 3, text: 'A source passage spanning three verses.' }] });
async function fixture() {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'lumen-transfer-'));
  const library = new WorshipLibrary(path.join(root, 'worship.db'));
  const content = ContentSchema.parse({ version: 2, updatedAt: '2026-01-01T00:00:00.000Z', settings: { fontFamily: 'Fixture Sans' }, playlists: [], channels: [], sources: [{ id: 'live-source', kind: 'media', ref: 'existing' }], destinations: [{ id: 'screen', kind: 'screen', label: 'Screen' }], routes: [{ id: 'on-air', sourceId: 'live-source', destinationId: 'screen' }], music: { mode: 'loop', volume: .2, current: 'existing.mp3', queue: ['existing.mp3'] }, program: { programSourceId: 'live-source', previewSourceId: null } });
  await fs.writeFile(path.join(root, 'content.json'), JSON.stringify(content));
  return { root, library, transfer: new DataTransfer(library, root), content, close: async () => { library.close(); await fs.rm(root, { recursive: true, force: true }); } };
}
function unpack(buffer: Buffer) { return JSON.parse(gunzipSync(buffer).toString('utf8')); }
function pack(value: unknown) { return gzipSync(Buffer.from(JSON.stringify(value))); }

test('selective .lumen roundtrip covers more than 500 songs, source ranges, conflict skips and backups', async () => {
  const source = await fixture(), target = await fixture();
  try {
    source.library.importBible(sampleBible('SPAN')); source.library.importBible(sampleBible('OTHER'));
    source.library.db.transaction(() => { for (let i = 0; i < 521; i++) source.library.saveSong(sampleSong(`s${i}`)); })();
    target.library.saveSong(sampleSong('s0', 'Keep the destination text'));
    target.library.command('lyrics-live', 0, { type: 'take', selection: { kind: 'lyrics', songId: 's0', sectionId: 'v1' } });
    const beforeWorkspace = target.library.workspace('lyrics-live');
    const catalog = await source.transfer.catalog(); assert.equal(catalog.songs.length, 521);
    const selection = { ...none, bibles: ['SPAN'], songs: catalog.songs.map(s => s.id) };
    const bytes = await source.transfer.export(selection); const payload = unpack(bytes).payload;
    assert.deepEqual(Object.keys(payload).sort(), ['bibles', 'media', 'presentations', 'settings', 'songs']);
    assert.equal(payload.bibles.length, 1); assert.equal(payload.songs.length, 521); assert.equal(payload.settings, null);
    const preview = await target.transfer.preview(bytes); assert.equal(preview.catalog.songs.find(s => s.id === 's0')?.exists, true);
    const result = await target.transfer.import(preview.archive, selection);
    assert.deepEqual(result.imported, { bibles: 1, songs: 520, presentations: 0, media: 0, settings: 0, scenes: 0, recordings: 0, setlists: 0, clips: 0 });
    assert.equal(result.skipped.songs, 1); assert.equal(target.library.song('s0').sections[0].text, 'Keep the destination text');
    assert.equal(target.library.song('s520').title, 'Song s520'); assert.equal(target.library.versions().find(v => v.id === 'OTHER')?.installed, undefined);
    const verse = target.library.searchScripture('SPAN', 'Genesis 1:2').verses[0]; assert.equal(verse.verse, 1); assert.equal(verse.endVerse, 3);
    assert.deepEqual(target.library.workspace('lyrics-live'), beforeWorkspace);
    assert.equal((await fs.stat(path.join(result.backupPath, 'worship.db'))).isFile(), true);
    assert.equal((await fs.stat(path.join(result.backupPath, 'content.json'))).isFile(), true);
    await assert.rejects(() => target.transfer.import(preview.archive, selection), /already been used/);
    const again = await target.transfer.preview(bytes); const repeated = await target.transfer.import(again.archive, selection);
    assert.equal(repeated.imported.songs, 0); assert.equal(repeated.skipped.songs, 521); assert.equal(repeated.skipped.bibles, 1);
  } finally { await source.close(); await target.close(); }
});

test('presentation copies remap IDs and implicit media dependencies without changing live, routing or music', async () => {
  const source = await fixture(), target = await fixture();
  try {
    const image = Buffer.alloc(6 * 1024 * 1024, 0x61), id = 'media/backgrounds/Église photo.png';
    await fs.mkdir(path.join(source.root, 'media/backgrounds'), { recursive: true });
    await fs.mkdir(path.join(target.root, 'media/backgrounds'), { recursive: true });
    await fs.writeFile(path.join(source.root, id), image); await fs.writeFile(path.join(source.root, 'media/backgrounds/unselected.jpg'), 'unselected');
    await fs.writeFile(path.join(target.root, id), 'existing media');
    source.content.playlists.push({ id: 'deck', name: 'A presentation', items: [{ id: 'slide', type: 'image', title: 'Image', body: '', reference: '', subtitle: '', durationMs: 30000, background: { kind: 'image', src: `/${id}` }, stanzas: [{ id: 'stanza', label: 'Verse', lines: 'Text' }] }] });
    source.content.channels.push({ id: 'channel', name: 'Presentation channel', kind: 'presentation', playlistId: 'deck', defaultMode: 'auto' });
    await fs.writeFile(path.join(source.root, 'content.json'), JSON.stringify(source.content));
    const bytes = await source.transfer.export({ ...none, presentations: ['deck'] });
    const payload = unpack(bytes).payload; assert.deepEqual(payload.media.map((m: any) => m.id), [id]); assert.equal(payload.presentations[0].channels.length, 1);
    const preview = await target.transfer.preview(bytes), before = structuredClone(target.content);
    const result = await target.transfer.import(preview.archive, { ...none, presentations: ['deck'] });
    assert.equal(result.imported.media, 1); assert.equal(result.imported.presentations, 1);
    const after = JSON.parse(await fs.readFile(path.join(target.root, 'content.json'), 'utf8'));
    for (const key of ['program', 'routes', 'destinations', 'music', 'settings']) assert.deepEqual(after[key], (before as any)[key], key);
    assert.notEqual(after.playlists[0].id, 'deck'); assert.notEqual(after.playlists[0].items[0].id, 'slide'); assert.notEqual(after.playlists[0].items[0].stanzas[0].id, 'stanza');
    assert.equal(after.channels[0].defaultMode, 'manual'); assert.equal(after.channels[0].playlistId, after.playlists[0].id);
    assert.equal(after.sources[0].id, 'live-source'); assert.equal(after.sources[1].ref, after.channels[0].id);
    const rewritten = after.playlists[0].items[0].background.src; assert.notEqual(rewritten, id); assert.deepEqual(await fs.readFile(path.join(target.root, rewritten)), image);
    assert.equal(await fs.readFile(path.join(target.root, id), 'utf8'), 'existing media');
    assert.equal((await target.transfer.catalog()).media.some(m => m.id.endsWith('unselected.jpg')), false);
  } finally { await source.close(); await target.close(); }
});

test('malformed archives, traversal, unsupported media, corrupt hashes and overlapping verses fail before mutations', async () => {
  const source = await fixture(), target = await fixture();
  try {
    source.library.importBible(sampleBible('SPAN')); const bytes = await source.transfer.export({ ...none, bibles: ['SPAN'] });
    const before = await fs.readFile(path.join(target.root, 'content.json')); const cases: Buffer[] = [Buffer.from('not gzip'), bytes.subarray(0, bytes.length - 4)];
    const modify = (fn: (v: any) => void) => { const v = unpack(bytes); fn(v); cases.push(pack(v)); };
    modify(v => { v.version = 2; }); modify(v => { v.payload.bibles.push(structuredClone(v.payload.bibles[0])); v.payload.bibles[1].version.id = 'span'; });
    modify(v => { v.payload.bibles[0].verses.push({ book: 1, chapter: 1, verse: 2, text: 'overlap' }); });
    modify(v => { v.payload.songs = [sampleSong('../escape')]; });
    const media = (id: string) => ({ id, bytes: 3, sha256: createHash('sha256').update('abc').digest('hex'), data: 'YWJj' });
    modify(v => { v.payload.media = [media('media/backgrounds/../escape.png')]; });
    modify(v => { v.payload.media = [media('media/backgrounds/script.html')]; });
    modify(v => { v.payload.media = [{ ...media('media/backgrounds/a.png'), sha256: '0'.repeat(64) }]; });
    modify(v => { v.payload.media = [{ ...media('media/backgrounds/a.png'), data: 'YW=J' }]; });
    modify(v => { v.payload.settings = { fontFamily: 'Bad', globalFontScale: 1, unknownSecret: 'x' }; });
    for (const bad of cases) await assert.rejects(() => target.transfer.preview(bad));
    await assert.rejects(() => target.transfer.preview(Buffer.alloc(MAX_TRANSFER_COMPRESSED_BYTES + 1)), /128 MiB/);
    assert.deepEqual(await fs.readFile(path.join(target.root, 'content.json')), before);
    assert.equal(target.library.versions().filter(v => v.installed).length, 0); assert.equal((await fs.readdir(target.root)).includes('backups'), false);
    await assert.rejects(() => target.transfer.import({} as ValidatedArchive, { ...none, bibles: ['SPAN'] }), /expired/);
  } finally { await source.close(); await target.close(); }
});

test('settings replacement is explicit and missing selections do not create a backup', async () => {
  const source = await fixture(), target = await fixture();
  try {
    source.content.settings.fontFamily = 'Transferred Font'; await fs.writeFile(path.join(source.root, 'content.json'), JSON.stringify(source.content));
    const preview = await target.transfer.preview(await source.transfer.export({ ...none, settings: true }));
    await assert.rejects(() => target.transfer.import(preview.archive, { ...none, songs: ['missing'] }), /no longer available/);
    assert.equal((await fs.readdir(target.root)).includes('backups'), false);
    const result = await target.transfer.import(preview.archive, { ...none, settings: true }); assert.equal(result.imported.settings, 1);
    const after = JSON.parse(await fs.readFile(path.join(target.root, 'content.json'), 'utf8')); assert.equal(after.settings.fontFamily, 'Transferred Font'); assert.deepEqual(after.program, target.content.program);
  } finally { await source.close(); await target.close(); }
});

test('symlink assets and symlink media directories cannot export or receive imported media', async () => {
  const source = await fixture(), target = await fixture();
  try {
    await fs.mkdir(path.join(source.root, 'media/backgrounds'), { recursive: true });
    await fs.writeFile(path.join(source.root, 'private'), 'private'); await fs.symlink(path.join(source.root, 'private'), path.join(source.root, 'media/backgrounds/link.png'));
    assert.equal((await source.transfer.catalog()).media.length, 0);
    await assert.rejects(() => source.transfer.export({ ...none, media: ['media/backgrounds/link.png'] }), /Symlinks/);
    await fs.writeFile(path.join(source.root, 'media/backgrounds/a.png'), 'image');
    const preview = await target.transfer.preview(await source.transfer.export({ ...none, media: ['media/backgrounds/a.png'] }));
    await fs.mkdir(path.join(target.root, 'media')); await fs.symlink(path.join(source.root, 'media/backgrounds'), path.join(target.root, 'media/backgrounds'));
    await assert.rejects(() => target.transfer.import(preview.archive, { ...none, media: ['media/backgrounds/a.png'] }), /Symlinks/);
    assert.equal(await fs.readFile(path.join(source.root, 'media/backgrounds/a.png'), 'utf8'), 'image');
  } finally { await source.close(); await target.close(); }
});

test('library insertion failure rolls back all songs and cleans staged media; preview remains retryable', async () => {
  const source = await fixture(), target = await fixture();
  try {
    source.library.saveSong(sampleSong('first')); source.library.saveSong(sampleSong('second'));
    await fs.mkdir(path.join(source.root, 'media/backgrounds'), { recursive: true }); await fs.writeFile(path.join(source.root, 'media/backgrounds/a.png'), 'image');
    const selection = { ...none, songs: ['first', 'second'], media: ['media/backgrounds/a.png'] };
    const preview = await target.transfer.preview(await source.transfer.export(selection)); const original = target.library.saveSong.bind(target.library);
    target.library.saveSong = ((raw: any) => { if (raw.id === 'second') throw new Error('injected failure'); return original(raw); }) as typeof target.library.saveSong;
    const before = await fs.readFile(path.join(target.root, 'content.json'));
    await assert.rejects(() => target.transfer.import(preview.archive, selection), /injected failure/);
    assert.equal((await target.transfer.catalog()).songs.length, 0); assert.equal(target.library.searchSongs('distinctive').length, 0);
    assert.deepEqual(await fs.readFile(path.join(target.root, 'content.json')), before); assert.deepEqual(await fs.readdir(path.join(target.root, 'media/backgrounds')), []);
    target.library.saveSong = original; const result = await target.transfer.import(preview.archive, selection); assert.equal(result.imported.songs, 2); assert.equal(result.imported.media, 1);
  } finally { await source.close(); await target.close(); }
});

test('backup failures abort before mutation and final insertion checks IDs created while backup awaited', async () => {
  const source = await fixture(), target = await fixture();
  try {
    source.library.saveSong(sampleSong('arrived-later')); source.library.importBible(sampleBible('LATER'));
    const selection = { ...none, songs: ['arrived-later'], bibles: ['LATER'] };
    const preview = await target.transfer.preview(await source.transfer.export(selection));
    const backup = target.library.db.backup.bind(target.library.db);
    target.library.db.backup = (async () => { throw new Error('backup unavailable'); }) as typeof target.library.db.backup;
    await assert.rejects(() => target.transfer.import(preview.archive, selection), /backup unavailable/);
    assert.equal((await target.transfer.catalog()).songs.length, 0); assert.equal(target.library.versions().filter(v => v.installed).length, 0);
    target.library.db.backup = (async (...args: Parameters<typeof backup>) => {
      const result = await backup(...args);
      target.library.saveSong(sampleSong('arrived-later', 'Destination edit during backup'));
      target.library.importBible({ ...sampleBible('LATER'), verses: [{ book: 1, chapter: 1, verse: 1, text: 'Destination Bible during backup' }] });
      return result;
    }) as typeof target.library.db.backup;
    const result = await target.transfer.import(preview.archive, selection);
    assert.equal(result.imported.songs, 0); assert.equal(result.imported.bibles, 0); assert.equal(result.skipped.songs, 1); assert.equal(result.skipped.bibles, 1);
    assert.equal(target.library.song('arrived-later').sections[0].text, 'Destination edit during backup');
    assert.equal(target.library.searchScripture('LATER', 'Genesis 1:1').verses[0].text, 'Destination Bible during backup');
    target.library.db.backup = backup;
  } finally { await source.close(); await target.close(); }
});

test('v2 scenes include media, channel setlists and library dependencies; recordings copy and all stores roll back together', async () => {
  const source = await fixture(), target = await fixture();
  try {
    source.library.saveSong(sampleSong('setlist_song')); source.library.importBible(sampleBible('SPAN'));
    source.content.playlists.push({ id: 'worship_playlist', name: 'Imported worship deck', items: [] });
    source.content.channels.push({ id: 'worship_channel', name: 'Sunday setlist', kind: 'lyrics', playlistId: 'worship_playlist', defaultMode: 'auto' });
    await fs.writeFile(path.join(source.root, 'content.json'), JSON.stringify(source.content));
    source.library.command('worship_channel', 0, { type: 'setlist', songIds: ['setlist_song'] });
    source.library.command('worship_channel', 1, { type: 'version', versionId: 'SPAN' });
    source.library.command('worship_channel', 2, { type: 'take', selection: { kind: 'lyrics', songId: 'setlist_song', sectionId: 'v1' } });
    await fs.mkdir(path.join(source.root, 'media/backgrounds'), { recursive: true });
    await fs.writeFile(path.join(source.root, 'media/backgrounds/portable.png'), 'synthetic pixels');
    const studio = initialProduction(), layer = studio.scenes[0].layers[0];
    studio.sources = [
      { id: 'channel_source', kind: 'channel', name: 'Lyrics', channelId: 'worship_channel', loop: false, audio: { volume: 1, muted: false, mode: 'always', delayMs: 0 } },
      { id: 'image_source', kind: 'image', name: 'Backdrop', url: 'media/backgrounds/portable.png', loop: false, audio: { volume: 1, muted: true, mode: 'follow', delayMs: 0 } },
    ];
    studio.scenes = [{ id: 'portable_scene', name: 'Portable scene', background: '#000000', layers: [
      { ...layer, id: 'channel_layer', kind: 'source', sourceId: 'channel_source' },
      { ...layer, id: 'image_layer', kind: 'source', sourceId: 'image_source' },
    ] }]; studio.previewSceneId = 'portable_scene';
    await fs.writeFile(path.join(source.root, 'production.json'), JSON.stringify(studio));
    const retained = initialProduction(); retained.program = structuredClone(retained.scenes[0]);
    retained.outputs[0].mode = 'scene'; retained.outputs[0].scene = structuredClone(retained.scenes[1]);
    await fs.writeFile(path.join(target.root, 'production.json'), JSON.stringify(retained));
    const recordingId = 'rec_portable', recordingBytes = Buffer.alloc(2 * 1024 * 1024, 0x62);
    await fs.mkdir(path.join(source.root, 'recordings', recordingId), { recursive: true });
    await fs.writeFile(path.join(source.root, 'recordings', recordingId, 'recording.webm'), recordingBytes);
    await fs.writeFile(path.join(source.root, 'recordings', recordingId, 'recording.json'), JSON.stringify({ id: recordingId, name: 'Portable service', status: 'complete', createdAt: '2026-01-01T00:00:00.000Z', durationMs: 120000, bytes: recordingBytes.length, nextChunk: 0 }));
    const sourceStore = new ProductionStore(source.root), targetStore = new ProductionStore(target.root);
    const sourceRecordings = new RecordingStore(path.join(source.root, 'recordings'), () => {}), targetRecordings = new RecordingStore(path.join(target.root, 'recordings'), () => {});
    await Promise.all([sourceStore.init(), targetStore.init(), sourceRecordings.init(), targetRecordings.init()]);
    const sourceAdapter = new ProductionDataTransfer(sourceStore, sourceRecordings, undefined);
    const targetAdapter = new ProductionDataTransfer(targetStore, targetRecordings, undefined);
    const sourceTransfer = new DataTransfer(source.library, source.root, sourceAdapter), targetTransfer = new DataTransfer(target.library, target.root, targetAdapter);
    const selection = { ...none, scenes: ['portable_scene'], recordings: [recordingId] };
    const archive = path.join(source.root, 'everything.lumen'); await sourceTransfer.exportToFile(selection, archive);
    const staging = path.join(target.root, 'preview-assets'), preview = await targetTransfer.previewFile(archive, staging);
    assert.equal(preview.catalog.setlists.length, 1); assert.equal(preview.catalog.songs.length, 1); assert.equal(preview.catalog.bibles.length, 1); assert.equal(preview.catalog.media.length, 1);
    const beforeContent = await fs.readFile(path.join(target.root, 'content.json'));
    const beforeStudio = targetStore.get(), transaction = targetAdapter.transaction.bind(targetAdapter);
    targetAdapter.transaction = (backupPath, operation) => transaction(backupPath, tx => operation({ ...tx, commitSync() { tx.commitSync(); throw new Error('injected post-commit failure'); } }));
    await assert.rejects(() => targetTransfer.import(preview.archive, selection), /injected post-commit/);
    assert.deepEqual(targetStore.get(), beforeStudio); assert.deepEqual(targetRecordings.list(), []);
    assert.deepEqual(await fs.readFile(path.join(target.root, 'content.json')), beforeContent);
    assert.equal((await targetTransfer.catalog()).songs.length, 0); assert.deepEqual(await fs.readdir(path.join(target.root, 'media/backgrounds')), []);
    targetAdapter.transaction = transaction;
    const result = await targetTransfer.import(preview.archive, selection);
    assert.deepEqual(result.imported, { bibles: 1, songs: 1, presentations: 1, media: 1, scenes: 1, recordings: 1, setlists: 1, clips: 0, settings: 0 });
    const afterStudio = targetStore.get(); assert.deepEqual(afterStudio.program, beforeStudio.program); assert.deepEqual(afterStudio.outputs, beforeStudio.outputs);
    const newScene = afterStudio.scenes.find(scene => scene.name === 'Portable scene')!; assert.notEqual(newScene.id, 'portable_scene');
    const importedChannel = afterStudio.sources.find(source => source.name === 'Lyrics')!.channelId!;
    assert.notEqual(importedChannel, 'worship_channel');
    const workspace = target.library.workspace(importedChannel); assert.deepEqual(workspace.setlist, ['setlist_song']); assert.equal(workspace.versionId, 'SPAN'); assert.equal(workspace.live, null); assert.deepEqual(workspace.recent, []);
    assert.equal(afterStudio.sources.find(source => source.name === 'Lyrics')!.audio.muted, true);
    const importedRecording = targetRecordings.list()[0]; assert.notEqual(importedRecording.id, recordingId); assert.equal(importedRecording.status, 'complete');
    assert.deepEqual(await fs.readFile(targetRecordings.download(importedRecording.id).path), recordingBytes);
    await assert.rejects(() => fs.access(staging));
    const oldFile = path.join(source.root, 'old.lumen'); await fs.writeFile(oldFile, await source.transfer.export({ ...none, songs: ['setlist_song'] }));
    const legacy = await targetTransfer.previewFile(oldFile, path.join(target.root, 'legacy-assets')); assert.equal(legacy.catalog.songs[0].exists, true); await targetTransfer.release(legacy.archive);
  } finally { await source.close(); await target.close(); }
});

test('v2 validates application paths and exact asset references before extracting or changing station data', async () => {
  const target = await fixture();
  try {
    const input = path.join(target.root, 'synthetic.png'); await fs.writeFile(input, 'synthetic');
    const base = { bibles: [], songs: [], presentations: [], settings: null };
    const cases = [
      { id: 'media/backgrounds/../escape.png', payload: (assets: any[]) => ({ ...base, media: assets }) },
      { id: 'media/backgrounds/valid.png', payload: (_assets: any[]) => ({ ...base, media: [] }) },
      { id: 'media/backgrounds/hash.png', payload: (assets: any[]) => ({ ...base, media: assets.map(asset => ({ ...asset, sha256: '0'.repeat(64) })) }) },
    ];
    for (const [index, item] of cases.entries()) {
      const archive = path.join(target.root, `invalid-${index}.lumen`), staging = path.join(target.root, `preview-${index}`);
      await writeArchiveFile(archive, item.payload, [{ id: item.id, path: input }]);
      await assert.rejects(() => target.transfer.previewFile(archive, staging));
      await assert.rejects(() => fs.access(staging));
    }
    assert.equal((await target.transfer.catalog()).songs.length, 0);
    assert.equal((await fs.readdir(target.root)).includes('backups'), false);
  } finally { await target.close(); }
});
