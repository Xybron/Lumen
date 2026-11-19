import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { ContentSchema, ItemSchema, type Content } from '../src/schema.js';
import { initialProduction } from '../src/production-schema.js';
import { mediaReferences, resolveMediaUsage } from '../src/media-usage.js';
import { MediaCatalog, removeLibraryFile } from '../src/media-catalog.js';
import { ProductionStore } from '../src/production-store.js';
import { listMediaLibrary } from '../src/media-library.js';
import type { ClipIndex, ClipTransferAccess, ClipTransferSession } from '../src/clips.js';
import type { SavedAsset } from '../src/clip-assets.js';

const blank = (): Content => ContentSchema.parse({ version: 2, updatedAt: new Date().toISOString(), settings: {}, music: {} });
const background = (src: string) => ({ kind: 'image' as const, src });
const timeline = (id: string, kind: 'image' | 'video' | 'audio' = 'image') => ({ version: 1 as const, background: '#000000', tracks: [{ id: 'track_main', name: 'Media', kind: kind === 'audio' ? 'audio' as const : 'video' as const, muted: false, hidden: false, locked: false, items: [{
  id: 'item_title', name: 'Imported media', kind, source: { kind: 'asset' as const, id }, startMs: 0, inMs: 0, durationMs: 1000,
  x: 0, y: 0, width: 1, height: 1, fit: 'contain' as const, positionX: .5, positionY: .5, opacity: 1, volume: 0, muted: true,
  text: '', fontSize: 36, fontWeight: 400, color: '#ffffff', background: '#000000', align: 'center' as const,
}] }] });
const settings = (id: string) => ({ inMs: 0, outMs: 1000, format: '16:9' as const, fit: 'contain' as const, positionX: .5, positionY: .5, timeline: timeline(id) });
async function fixture(t: { after(fn: () => Promise<void>): void }, rendererActive = false) {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'lumen-media-catalog-'));
  t.after(() => fs.rm(dir, { recursive: true, force: true }));
  for (const sub of ['media/backgrounds', 'media/music', 'media/thumbnails', 'clips/assets', 'clips/exports']) await fs.mkdir(path.join(dir, sub), { recursive: true });
  const contentFile = path.join(dir, 'content.json'), mediaDir = path.join(dir, 'media');
  let content = blank(); await fs.writeFile(contentFile, JSON.stringify(content));
  const store = new ProductionStore(dir, undefined, undefined, () => rendererActive); await store.init();
  const snapshot: { data: ClipIndex; assets: SavedAsset[]; activeExportIds: string[]; downloads: string[] } = { data: { version: 1, drafts: [], exports: [], media: {} }, assets: [], activeExportIds: [], downloads: [] };
  let chain: Promise<unknown> = Promise.resolve();
  const clips: ClipTransferAccess = {
    snapshot: () => structuredClone(snapshot), resolveAsset: id => path.join(dir, 'clips/assets', `${id}.png`), resolveExport: id => path.join(dir, 'clips/exports', `${id}.mp4`),
    withLock<T>(fn: (session: ClipTransferSession) => Promise<T>) {
      const run = chain.then(() => fn({ ...structuredClone(snapshot), file: path.join(dir, 'clips/clips.json'), assetFile: path.join(dir, 'clips/assets/assets.json'),
        assetDir: path.join(dir, 'clips/assets'), exportsDir: path.join(dir, 'clips/exports'), downloads: new Set(snapshot.downloads), activeExportIds: new Set(snapshot.activeExportIds),
        replaceSync(data, assets) { snapshot.data = structuredClone(data); snapshot.assets = structuredClone(assets); },
      })); chain = run.catch(() => {}); return run;
    },
  };
  const catalog = new MediaCatalog(store, clips, { dir, mediaDir, contentFile });
  return { dir, mediaDir, contentFile, content, store, clips, snapshot, catalog,
    async saveContent(next = content) { content = next; await fs.writeFile(contentFile, JSON.stringify(next)); },
    async image(name: string) { await fs.writeFile(path.join(mediaDir, 'backgrounds', name), 'original'); await fs.writeFile(path.join(mediaDir, 'thumbnails', name.replace(/\.[^.]+$/, '.jpg')), 'thumb'); },
  };
}

test('usage references preserve raw filenames, encoded paths and URL suffixes conservatively', () => {
  assert.deepEqual(mediaReferences('/media/backgrounds/image%20one.png'), ['media/backgrounds/image%20one.png', 'media/backgrounds/image one.png']);
  for (const [reference, expected] of [
    ['/media/backgrounds/100%_off.png', 'media/backgrounds/100%_off.png'],
    ['/media/backgrounds/hero%23one.png?v=2#preview', 'media/backgrounds/hero#one.png'],
    ['/media/backgrounds/hero#one.png', 'media/backgrounds/hero#one.png'],
    ['/media/backgrounds/hero?one.png', 'media/backgrounds/hero?one.png'],
    ['%2Fmedia%2Fbackgrounds%2Fimage.png', 'media/backgrounds/image.png'],
    ['http://127.0.0.1:3000/media/backgrounds/image.png?size=2#preview', 'media/backgrounds/image.png'],
    ['/media/backgrounds/image%2520one.png', 'media/backgrounds/image%20one.png'],
  ]) assert.ok(mediaReferences(reference).includes(expected), reference);
  assert.deepEqual(mediaReferences('file:///etc/passwords'), []);
});

test('resolver locates orphan slides, unrouted media and unattached Studio sources', () => {
  const content = blank(), state = initialProduction();
  content.playlists.push({ id: 'deck_orphan', name: 'Orphan deck', items: [{ id: 'slide_title', type: 'image', title: 'Title', body: '', reference: '', subtitle: '', durationMs: 1000, background: background('/media/backgrounds/title.png') }] });
  content.sources.push({ id: 'routing_title', kind: 'media', ref: 'media/backgrounds/title.png', label: 'Routing title' });
  state.sources.push({ id: 'source_title', name: 'Saved title', kind: 'image', url: 'media/backgrounds/title.png', loop: false, audio: { muted: true, volume: 0, mode: 'follow', delayMs: 0 } });
  const usage = resolveMediaUsage(content, state).get('media/backgrounds/title.png')!;
  assert.deepEqual(usage.map(value => value.type), ['presentation', 'routing', 'source']);
  assert.match(usage[0].href, /playlist=deck_orphan&slide=slide_title/);
  assert.match(usage[1].href, /\/switch\?source=routing_title/);
  assert.match(usage[2].detail, /Saved Studio source/);
});

test('catalogue, rename and bulk deletion share authoritative usage and clean derivatives', async t => {
  const f = await fixture(t); await f.image('used.png'); await f.image('unused.png');
  f.content.playlists.push({ id: 'deck_main', name: 'Sunday', items: [{ id: 'slide_one', type: 'image', title: 'Welcome', body: '', reference: '', subtitle: '', durationMs: 1000, background: background('media/backgrounds/used.png') }] });
  f.content.channels.push({ id: 'channel_main', name: 'Sunday', kind: 'presentation', playlistId: 'deck_main' }); await f.saveContent();
  const listed = await f.catalog.list();
  assert.equal(listed.assets.length, 2); assert.equal(listed.assets.find(a => a.id === 'library:used.png')?.usage.length, 1);
  const renamed = await f.catalog.rename('library:used.png', 'Sunday welcome');
  assert.equal(renamed.displayName, 'Sunday welcome'); assert.equal(renamed.url, '/media/backgrounds/used.png');
  assert.equal((await listMediaLibrary('backgrounds', f.mediaDir)).find(a => a.name === 'used.png')?.displayName, 'Sunday welcome');
  const deleted = await f.catalog.delete(['library:used.png', 'library:unused.png']);
  assert.deepEqual(deleted.deleted, ['library:unused.png']); assert.equal(deleted.blocked[0].usage[0].type, 'presentation');
  await assert.rejects(fs.access(path.join(f.mediaDir, 'backgrounds/unused.png')));
  await assert.rejects(fs.access(path.join(f.mediaDir, 'thumbnails/unused.jpg')));
  assert.equal(await fs.readFile(path.join(f.mediaDir, 'backgrounds/used.png'), 'utf8'), 'original');
});

test('a fresh delete check protects usage added after the catalogue was loaded', async t => {
  const f = await fixture(t); await f.image('later.png');
  assert.equal((await f.catalog.list()).assets[0].usage.length, 0);
  f.content.sources.push({ id: 'new_source', kind: 'media', ref: 'http://localhost:3000/media/backgrounds/later.png?cache=1', label: 'New source' }); await f.saveContent();
  assert.equal((await f.catalog.delete(['library:later.png'])).blocked[0].usage[0].type, 'routing');
  await assert.rejects(f.catalog.withUnusedMedia(['media/backgrounds/later.png'], async () => { throw new Error('must not run'); }), /media is in use/);
});

test('raw percent filenames remain protected by encoded and literal references', async t => {
  const f = await fixture(t); await f.image('image%20one.png'); await f.image('image one.png');
  f.content.sources.push({ id: 'percent_source', kind: 'media', ref: 'media/backgrounds/image%20one.png' }); await f.saveContent();
  assert.ok((await f.catalog.list()).assets.every(asset => asset.usage.length === 1));
  assert.equal((await f.catalog.delete(['library:image%20one.png', 'library:image one.png'])).blocked.length, 2);
});

test('saved Program and pinned outputs protect backgrounds after draft removal', async t => {
  const f = await fixture(t); await f.image('stage.png');
  let state = f.store.get(); state.scenes[0].layers[0].mediaBackground = { kind: 'image', url: '/media/backgrounds/stage.png', fit: 'cover', dim: 0, loop: false };
  state = await f.store.save(state); state = await f.store.command(state.revision, { type: 'take', sceneId: state.scenes[0].id });
  state = await f.store.command(state.revision, { type: 'route', outputId: state.outputs[0].id, sceneId: state.scenes[0].id });
  state.scenes[0].layers[0].mediaBackground = null; state = await f.store.save(state);
  const types = (await f.catalog.list()).assets[0].usage.map(u => u.type);
  assert.deepEqual(types, ['program', 'output']); assert.equal((await f.catalog.delete(['library:stage.png'])).blocked.length, 1);
  state = await f.store.command(state.revision, { type: 'clear-program' });
  assert.equal((await f.catalog.delete(['library:stage.png'])).blocked.length, 1);
  await f.store.command(state.revision, { type: 'route', outputId: state.outputs[0].id, sceneId: null });
  assert.deepEqual((await f.catalog.delete(['library:stage.png'])).deleted, ['library:stage.png']);
});

test('an outgoing Program fade retains its image until the transition finishes', async t => {
  const f = await fixture(t); await f.image('fade.png');
  let state = f.store.get(); state.scenes[0].layers[0].mediaBackground = { kind: 'image', url: 'media/backgrounds/fade.png', fit: 'cover', dim: 0, loop: false };
  state = await f.store.save(state); state = await f.store.command(state.revision, { type: 'take', sceneId: state.scenes[0].id });
  state.scenes[0].layers[0].mediaBackground = null; state = await f.store.save(state);
  await f.store.command(state.revision, { type: 'take', sceneId: state.scenes[1].id, transition: 'fade', durationMs: 100 });
  assert.equal((await f.catalog.delete(['library:fade.png'])).blocked[0].usage[0].label, 'Program transition');
  await new Promise(resolve => setTimeout(resolve, 280));
  assert.deepEqual((await f.catalog.delete(['library:fade.png'])).deleted, ['library:fade.png']);
});

test('private Clip imports retain draft and export usage, and unused originals are removed privately', async t => {
  const f = await fixture(t), id = 'asset_title';
  const saved: SavedAsset = { id, name: 'Private title.png', kind: 'image', mime: 'image/png', bytes: 8, durationMs: 0, width: 64, height: 32,
    ownerId: 'operator', ownerName: 'Operator', createdAt: new Date().toISOString(), extension: 'png' };
  f.snapshot.assets.push(saved); await fs.writeFile(f.clips.resolveAsset(id), 'original');
  f.snapshot.data.drafts.push({ id: 'draft_title', recordingId: 'rec_service', name: 'Conference recap', revision: 0, ownerId: 'operator', ownerName: 'Operator', createdAt: saved.createdAt, updatedAt: saved.createdAt, ...settings(id) });
  f.snapshot.data.exports.push({ id: 'export_title', draftId: 'draft_title', draftRevision: 0, recordingId: 'rec_service', name: 'Recap export', ownerId: 'operator', status: 'complete', progress: 1, bytes: 100, createdAt: saved.createdAt, settings: settings(id) });
  const listed = (await f.catalog.list()).assets[0];
  assert.equal(listed.url, '/api/clips/assets/asset_title/media'); assert.equal(listed.origin, 'clip'); assert.equal(listed.width, 64);
  assert.deepEqual(listed.usage.map(u => u.type), ['clip', 'export']);
  f.snapshot.data.drafts = []; assert.equal((await f.catalog.delete([`clip:${id}`])).blocked[0].usage[0].type, 'export');
  const job = f.snapshot.data.exports[0]; job.temporary = true; job.status = 'cancelled'; f.snapshot.activeExportIds = [job.id];
  assert.equal((await f.catalog.delete([`clip:${id}`])).blocked.length, 1, 'A cancelling worker still owns its original inputs.');
  f.snapshot.activeExportIds = []; job.status = 'complete'; job.deliveredAt = new Date().toISOString(); f.snapshot.downloads = [job.id];
  assert.equal((await f.catalog.delete([`clip:${id}`])).blocked.length, 1, 'A released scratch export remains protected while its transfer drains.');
  f.snapshot.downloads = []; assert.deepEqual((await f.catalog.delete([`clip:${id}`])).deleted, [`clip:${id}`]);
  assert.deepEqual(f.snapshot.assets, []); await assert.rejects(fs.access(f.clips.resolveAsset(id)));
  assert.deepEqual(JSON.parse(await fs.readFile(path.join(f.dir, 'clips/assets/assets.json'), 'utf8')), []);
});

test('outgoing channel-insert backgrounds stay protected until the renderer settles, including delayed cues', async t => {
  const f = await fixture(t, true); await f.image('insert.png');
  const state = f.store.get();
  state.sources.push({ id: 'channel_source', kind: 'channel', channelId: 'channel_scripture', name: 'Scripture', loop: false, audio: { muted: true, volume: 0, mode: 'follow', delayMs: 0 } });
  state.program = structuredClone(state.scenes[0]);
  state.channelInsert = { id: 'insert_scripture', channelId: 'channel_scripture', sourceId: 'channel_source', mode: 'overlay',
    layer: { ...state.scenes[0].layers[0], id: 'insert_layer', kind: 'source', sourceId: 'channel_source', mediaBackground: { kind: 'image', url: 'media/backgrounds/insert.png', fit: 'cover', dim: 0, loop: false } } };
  await f.store.withTransferLock(async session => { session.replaceSync(state); });
  const next = await f.store.command(state.revision, { type: 'take', sceneId: state.scenes[1].id, transition: 'fade', durationMs: 100 });
  assert.equal(next.channelInsert, undefined);
  await new Promise(resolve => setTimeout(resolve, 280));
  let result = await f.catalog.delete(['library:insert.png']);
  assert.equal(result.blocked[0].usage[0].label, 'Program transition');
  assert.match(result.blocked[0].usage[0].detail, /Outgoing channel background/);
  f.store.releaseMediaTransitions(next.revision - 1);
  assert.equal((await f.catalog.delete(['library:insert.png'])).blocked.length, 1, 'An old heartbeat cannot release a newer transition.');
  f.store.releaseMediaTransitions(next.revision + 1);
  assert.equal((await f.catalog.delete(['library:insert.png'])).blocked.length, 1, 'A future revision cannot acknowledge unrendered state.');
  f.store.releaseMediaTransitions(next.revision);
  assert.deepEqual((await f.catalog.delete(['library:insert.png'])).deleted, ['library:insert.png']);
});

test('unavailable reference stores fail closed instead of reporting unused images', async t => {
  const f = await fixture(t); await f.image('safe.png'); await fs.writeFile(f.contentFile, '{broken');
  const listed = await f.catalog.list(); assert.equal(listed.assets[0].usageStatus, 'unavailable'); assert.ok(listed.warning);
  await assert.rejects(f.catalog.delete(['library:safe.png']), /usage could not be checked/);
  await f.saveContent();
  const noClips = new MediaCatalog(f.store, undefined, { dir: f.dir, mediaDir: f.mediaDir, contentFile: f.contentFile });
  assert.equal((await noClips.list()).assets[0].usageStatus, 'unavailable');
  await assert.rejects(noClips.delete(['library:safe.png']), /Clips workspace is offline/);
  await fs.access(path.join(f.mediaDir, 'backgrounds/safe.png'));
});

test('deletion rejects traversal and symlinks and retains shared thumbnails', async t => {
  const f = await fixture(t); await f.image('same.png'); await f.image('same.jpg');
  await removeLibraryFile(f.mediaDir, 'backgrounds', 'same.png'); await fs.access(path.join(f.mediaDir, 'thumbnails/same.jpg'));
  await removeLibraryFile(f.mediaDir, 'backgrounds', 'same.jpg'); await assert.rejects(fs.access(path.join(f.mediaDir, 'thumbnails/same.jpg')));
  const outside = path.join(f.dir, 'outside.png'); await fs.writeFile(outside, 'preserve'); await fs.symlink(outside, path.join(f.mediaDir, 'backgrounds/link.png'));
  await assert.rejects(f.catalog.delete(['library:../outside.png']));
  assert.equal((await f.catalog.delete(['library:link.png'])).blocked.length, 1);
  assert.equal(await fs.readFile(outside, 'utf8'), 'preserve');
});

test('audio and video catalogue entries keep raw references, renamed metadata and music usage', async t => {
  const f = await fixture(t);
  await f.image('opening.webm');
  await fs.writeFile(path.join(f.mediaDir, 'music', 'peace%20song.mp3'), 'audio');
  await fs.writeFile(path.join(f.mediaDir, 'music', 'unused.wav'), 'audio');
  f.content.music.current = 'media/music/peace%20song.mp3';
  f.content.music.queue = ['/media/music/peace%2520song.mp3?version=1'];
  f.content.sources.push({ id: 'music_route', kind: 'music', ref: 'media/music/peace%20song.mp3' });
  await f.saveContent();
  const entries = (await f.catalog.list()).assets;
  const audio = entries.find(value => value.id === 'music:peace%20song.mp3')!;
  assert.equal(audio.kind, 'audio'); assert.equal(audio.libraryPath, 'media/music/peace%20song.mp3');
  assert.equal(audio.url, '/media/music/peace%2520song.mp3');
  assert.deepEqual(audio.usage.map(value => value.type), ['routing', 'music', 'music']);
  assert.equal(new URL(audio.usage[1].href, 'http://localhost').searchParams.get('music'), f.content.music.current);
  assert.equal(entries.find(value => value.id === 'library:opening.webm')!.kind, 'video');
  await f.catalog.rename(audio.id, 'Peace song');
  assert.equal((await listMediaLibrary('music', f.mediaDir)).find(value => value.name === audio.name)!.displayName, 'Peace song');
  const result = await f.catalog.delete([audio.id, 'music:unused.wav', 'library:opening.webm']);
  assert.deepEqual(result.deleted, ['music:unused.wav', 'library:opening.webm']); assert.equal(result.blocked[0].id, audio.id);
  await assert.rejects(f.catalog.withUnusedMedia(['media/music/peace%20song.mp3'], async () => {}), /media is in use/);
});

test('retained MOV and prepared MP4 are one video with symmetric usage and safe deletion', async t => {
  const f = await fixture(t); await f.image('opening%20clip.MOV');
  await fs.writeFile(path.join(f.mediaDir, 'backgrounds', 'opening%20clip.mp4'), 'prepared video');
  f.content.playlists.push({ id: 'deck', name: 'Service', items: [ItemSchema.parse({
    id: 'video_slide', type: 'video', background: { kind: 'video', src: '/media/backgrounds/opening%2520clip.mp4' },
  })] }); await f.saveContent();
  const listed = (await f.catalog.list()).assets;
  assert.equal(listed.length, 1); const video = listed[0];
  assert.equal(video.id, 'library:opening%20clip.MOV'); assert.equal(video.kind, 'video'); assert.equal(video.preparation, 'ready');
  assert.equal(video.playbackPath, 'media/backgrounds/opening%20clip.mp4'); assert.equal(video.playbackUrl, '/media/backgrounds/opening%2520clip.mp4');
  assert.equal(video.usage[0].type, 'presentation');
  assert.equal((await f.catalog.delete([video.id])).blocked.length, 1);
  await assert.rejects(f.catalog.withUnusedMedia(['media/backgrounds/opening%20clip.MOV'], async () => {}), /media is in use/);
  f.content.playlists = []; f.content.sources.push({ id: 'mov_source', kind: 'media', ref: video.libraryPath! }); await f.saveContent();
  await assert.rejects(f.catalog.withUnusedMedia(['media/backgrounds/opening%20clip.mp4'], async () => {}), /media is in use/);
  f.content.sources = []; await f.saveContent();
  await assert.rejects(removeLibraryFile(f.mediaDir, 'backgrounds', 'opening%20clip.mp4'), /prepared copy/);
  assert.deepEqual((await f.catalog.delete([video.id])).deleted, [video.id]);
  for (const filename of ['backgrounds/opening%20clip.MOV', 'backgrounds/opening%20clip.mp4', 'thumbnails/opening%20clip.jpg']) await assert.rejects(fs.access(path.join(f.mediaDir, filename)));
});

test('catalogue reads do not start conversions and unavailable usage protects every media type', async t => {
  const f = await fixture(t); await f.image('legacy.mov'); await fs.writeFile(path.join(f.mediaDir, 'music', 'track.flac'), 'audio');
  assert.equal((await f.catalog.list()).assets.find(value => value.kind === 'video')!.preparation, 'missing');
  await fs.writeFile(f.contentFile, '{invalid');
  assert.ok((await f.catalog.list()).assets.every(value => value.usageStatus === 'unavailable'));
  await assert.rejects(f.catalog.delete(['library:legacy.mov', 'music:track.flac']), /usage could not be checked/);
  await fs.access(path.join(f.mediaDir, 'backgrounds', 'legacy.mov'));
});

test('private video and audio imports protect export snapshots and delete originals after release', async t => {
  const f = await fixture(t);
  for (const kind of ['video', 'audio'] as const) {
    const id = `asset_${kind}`, extension = kind === 'video' ? 'mp4' : 'mp3';
    const saved: SavedAsset = { id, name: `Private ${kind}.${extension}`, kind, mime: `${kind}/${extension}`, bytes: 20, durationMs: 4200, width: kind === 'video' ? 640 : 0, height: kind === 'video' ? 360 : 0,
      ownerId: 'operator', ownerName: 'Operator', createdAt: new Date().toISOString(), extension };
    f.snapshot.assets.push(saved); await fs.writeFile(path.join(f.dir, 'clips/assets', `${id}.${extension}`), 'private original');
    const clipSettings = { ...settings(id), timeline: timeline(id, kind) };
    f.snapshot.data.exports.push({ id: `export_${kind}`, draftId: `draft_${kind}`, draftRevision: 0, recordingId: 'rec_service', name: `${kind} export`, ownerId: 'operator', status: 'queued', progress: 0, bytes: 0, createdAt: saved.createdAt, settings: clipSettings });
  }
  const listed = (await f.catalog.list()).assets;
  assert.deepEqual(new Set(listed.map(value => value.kind)), new Set(['video', 'audio']));
  assert.ok(listed.every(value => value.durationMs === 4200 && !value.libraryPath && value.url.startsWith('/api/clips/assets/')));
  assert.equal((await f.catalog.delete(listed.map(value => value.id))).blocked.length, 2);
  f.snapshot.data.exports = [];
  assert.equal((await f.catalog.delete(listed.map(value => value.id))).deleted.length, 2);
  assert.deepEqual(f.snapshot.assets, []);
});
