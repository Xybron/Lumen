import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import type { AddressInfo } from 'node:net';
import express from 'express';
import sharp from 'sharp';
import type { ClipDraft, ClipExport, ClipTimelineItem, ClipWorkspace } from '../../shared/clips.js';
import type { RecordingStore } from '../src/production-recordings.js';
import { runClipMedia } from '../src/clip-media.js';

// Every identity, original, imported asset, draft and export belongs to this
// disposable station. The listener uses an OS-assigned local-only port.
test('private editing imports and timeline drafts retain authentication, revision and live-production boundaries', { timeout: 90_000 }, async t => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'lumen-clip-assets-api-'));
  const previousDir = process.env.LUMEN_DATA_DIR;
  process.env.LUMEN_DATA_DIR = directory;
  const { initDb } = await import('../src/db.js');
  const database = initDb();
  const { login, createUser } = await import('../src/auth.js');
  const { createClips } = await import('../src/clips.js');
  const original = path.join(directory, 'original.mp4');
  await runClipMedia(['-hide_banner', '-nostdin', '-y', '-f', 'lavfi', '-i', 'color=c=navy:s=160x90:r=30:d=2', '-f', 'lavfi', '-i', 'sine=f=400:r=48000:d=2', '-map', '0:v', '-map', '1:a', '-c:v', 'libx264', '-threads', '1', '-c:a', 'aac', original], 15_000).result;
  const originalBytes = await fs.readFile(original);
  const productionSentinel = Buffer.from('Untouched operator Program and Main audio fixture.');
  await fs.writeFile(path.join(directory, 'production.json'), productionSentinel);
  const source = { id: 'rec_test', name: 'Disposable service', status: 'complete' as const, durationMs: 2000, bytes: originalBytes.length, createdAt: '2026-10-19T10:00:00.000Z' };
  const recordings = { list: () => [{ ...source }], download: (id: string) => { if (id !== source.id) throw new Error('Unexpected source.'); return { path: original, name: source.name }; } } as unknown as RecordingStore;
  let live = true;
  const clips = await createClips({ dir: path.join(directory, 'clips'), recordings, isLive: () => live });
  const app = express(); app.use(express.json({ limit: '1mb' })); app.use('/api', clips.router);
  let server: ReturnType<typeof app.listen> | undefined;
  t.after(async () => {
    if (server) await new Promise<void>(resolve => server!.close(() => resolve()));
    await clips.close(); database.close();
    if (previousDir === undefined) delete process.env.LUMEN_DATA_DIR; else process.env.LUMEN_DATA_DIR = previousDir;
    await fs.rm(directory, { recursive: true, force: true });
  });
  server = await new Promise<ReturnType<typeof app.listen>>((resolve, reject) => {
    const handle = app.listen(0, '127.0.0.1', () => resolve(handle)); handle.once('error', reject);
  });
  const origin = `http://127.0.0.1:${(server.address() as AddressInfo).port}/api/clips`;
  createUser('editor-one', 'Editor one', 'test-password'); createUser('editor-two', 'Editor two', 'test-password');
  const editor = `lumen_session=${login('editor-one', 'test-password')!.sessionId}`;
  const teammate = `lumen_session=${login('editor-two', 'test-password')!.sessionId}`;
  const json = (method: string, body: unknown, cookie = editor): RequestInit => ({ method, headers: { Cookie: cookie, 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
  const workspace = async (cookie = editor): Promise<ClipWorkspace> => { const response = await fetch(origin, { headers: { Cookie: cookie } }); assert.equal(response.status, 200); return response.json(); };
  const image = await sharp({ create: { width: 80, height: 40, channels: 4, background: '#00aa0080' } }).png().toBuffer();
  const upload = (data: Uint8Array, mime: string, name: string, cookie: string | undefined = editor, metadata = { durationMs: 0, width: 999, height: 999 }) => {
    const form = new FormData(); form.append('file', new Blob([data as BlobPart], { type: mime }), name);
    for (const [key, value] of Object.entries(metadata)) form.append(key, String(value));
    return fetch(`${origin}/assets`, { method: 'POST', headers: cookie ? { Cookie: cookie } : {}, body: form });
  };
  let assetId = '', draft: ClipDraft, job: ClipExport;
  const item = (patch: Partial<ClipTimelineItem>): ClipTimelineItem => ({
    id: 'item_original', name: 'Service', kind: 'video', source: { kind: 'recording', id: source.id }, startMs: 0, inMs: 0, durationMs: 1000,
    x: 0, y: 0, width: 1, height: 1, fit: 'cover', positionX: .5, positionY: .5, opacity: 1, volume: 1, muted: true,
    text: '', fontSize: 48, fontWeight: 600, color: '#ffffff', background: '#00000000', align: 'center', ...patch,
  });
  const settings = () => ({ name: 'Service social edit', inMs: 0, outMs: 1000, format: '16:9', fit: 'cover', positionX: .5, positionY: .5, timeline: {
    version: 1, background: '#000000', tracks: [
      { id: 'track_video', name: 'Video', kind: 'video', hidden: false, muted: false, locked: false, items: [item({})] },
      { id: 'track_overlay', name: 'Overlay', kind: 'video', hidden: false, muted: false, locked: false, items: [item({ id: 'item_overlay', name: 'Logo', kind: 'image', source: { kind: 'asset', id: assetId }, startMs: 250, durationMs: 500, x: .7, y: .1, width: .2, height: .2 })] },
    ],
  } });

  await t.test('all private URLs and imports require a session before receiving a file', async () => {
    assert.equal((await fetch(origin)).status, 401);
    const form = new FormData(); form.append('file', new Blob([image], { type: 'image/png' }), 'private.png');
    assert.equal((await fetch(`${origin}/assets`, { method: 'POST', body: form })).status, 401);
    assert.equal((await fetch(`${origin}/assets/asset_unknown/media`)).status, 401);
    assert.deepEqual(await fs.readdir(path.join(directory, 'clips', 'assets', 'incoming')), []);
  });
  await t.test('imported images use actual dimensions and private storage, not caller metadata or a public path', async () => {
    const response = await upload(image, 'image/png', 'Team logo.png'); assert.equal(response.status, 201);
    const asset = await response.json(); assetId = asset.id;
    assert.equal(asset.width, 80); assert.equal(asset.height, 40); assert.equal(asset.durationMs, 0); assert.equal(asset.kind, 'image');
    assert.equal(asset.path, undefined); assert.equal(asset.extension, undefined);
    assert.equal((await workspace()).liveProtected, true, 'Importing is allowed without starting a heavy export during production.');
    assert.equal((await workspace(teammate)).assets?.[0].id, assetId);
    assert.deepEqual(await fs.readdir(path.join(directory, 'clips', 'assets', 'incoming')), []);
    await assert.rejects(fs.stat(path.join(directory, 'media')), { code: 'ENOENT' });
  });
  await t.test('signature validation rejects SVG/playlists/path-like unsupported content and cleans failed uploads', async () => {
    for (const [data, mime, name] of [
      [Buffer.from('<svg xmlns="http://www.w3.org/2000/svg"><image href="file:///etc/passwd"/></svg>'), 'image/svg+xml', 'logo.svg'],
      [Buffer.from('#EXTM3U\nhttp://127.0.0.1/private\n'), 'video/mp4', 'recording.mp4'],
      [Buffer.from('not a png'), 'image/png', '../untrusted.png'],
    ] as const) assert.equal((await upload(data, mime, name)).status, 415);
    const invalid = await upload(image, 'image/png', 'metadata.png', editor, { durationMs: 0, width: -1, height: 10 });
    assert.equal(invalid.status, 422);
    const truncated = await upload(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), 'image/png', 'truncated.png');
    assert.equal(truncated.status, 422, 'A recognized signature is not proof that an image can be read.');
    assert.deepEqual(await fs.readdir(path.join(directory, 'clips', 'assets', 'incoming')), []);
    assert.equal((await workspace()).assets?.length, 1);
  });
  await t.test('authorized media supports byte ranges, missing IDs and unsatisfiable ranges safely', async () => {
    const response = await fetch(`${origin}/assets/${assetId}/media`, { headers: { Cookie: teammate, Range: 'bytes=0-15' } });
    assert.equal(response.status, 206); assert.equal(response.headers.get('content-type'), 'image/png');
    assert.equal(response.headers.get('content-range'), `bytes 0-15/${image.length}`);
    assert.deepEqual(Buffer.from(await response.arrayBuffer()), image.subarray(0, 16));
    assert.match(response.headers.get('cache-control') ?? '', /private/);
    assert.equal((await fetch(`${origin}/assets/${assetId}/media`, { headers: { Cookie: editor, Range: 'bytes=999999-' } })).status, 416);
    assert.equal((await fetch(`${origin}/assets/asset_missing/media`, { headers: { Cookie: editor } })).status, 404);
  });
  await t.test('timeline saves persist independent revisions; teammates cannot replace another editor’s draft', async () => {
    const created = await fetch(`${origin}/drafts`, json('POST', { recordingId: source.id, ...settings() }));
    assert.equal(created.status, 201); draft = await created.json();
    assert.equal(draft.revision, 0); assert.equal(draft.timeline?.tracks.length, 2);
    const update = { ...settings(), name: 'Edited title', revision: 0 };
    const saved = await fetch(`${origin}/drafts/${draft.id}`, json('PUT', update)); assert.equal(saved.status, 200); draft = await saved.json();
    assert.equal(draft.revision, 1);
    assert.equal((await fetch(`${origin}/drafts/${draft.id}`, json('PUT', update))).status, 409);
    assert.equal((await fetch(`${origin}/drafts/${draft.id}`, json('PUT', { ...update, revision: 1 }, teammate))).status, 403);
    const forged = settings(); forged.timeline.tracks[1].items[0].source!.id = 'asset_missing';
    assert.equal((await fetch(`${origin}/drafts`, json('POST', { recordingId: source.id, ...forged }))).status, 404);
    assert.equal((await workspace(teammate)).drafts.find(value => value.id === draft.id)?.canEdit, false);
    const copied = await fetch(`${origin}/drafts`, json('POST', { recordingId: source.id, ...settings(), name: 'Teammate copy' }, teammate)); assert.equal(copied.status, 201);
    assert.equal((await copied.json()).ownerName, 'Editor two');
  });
  await t.test('queued exports snapshot the timeline and wait for live production without touching the original or Program', async () => {
    const response = await fetch(`${origin}/drafts/${draft.id}/exports`, json('POST', { revision: draft.revision })); assert.equal(response.status, 202); job = await response.json();
    assert.equal(job.status, 'waiting-live'); assert.equal(job.draftRevision, 1);
    const updated = settings(); updated.timeline.tracks[1].items[0].x = .1;
    assert.equal((await fetch(`${origin}/drafts/${draft.id}`, json('PUT', { ...updated, revision: 1 }))).status, 200);
    const current = (await workspace()).exports.find(value => value.id === job.id)!;
    assert.equal(current.settings.timeline?.tracks[1].items[0].x, .7, 'A queued render retains its immutable edit snapshot.');
    assert.deepEqual(await fs.readFile(original), originalBytes);
    assert.deepEqual(await fs.readFile(path.join(directory, 'production.json')), productionSentinel);
    assert.equal((await fetch(`${origin}/exports/${job.id}/cancel`, json('POST', {}, teammate))).status, 403);
  });
  await t.test('idle worker probes imported media, exports MP4 and exposes authenticated download only', async () => {
    live = false;
    const deadline = Date.now() + 30_000;
    let current = job!;
    while (Date.now() < deadline) {
      current = (await workspace()).exports.find(value => value.id === job.id)!;
      if (['complete', 'error', 'interrupted'].includes(current.status)) break;
      await new Promise(resolve => setTimeout(resolve, 100));
    }
    assert.equal(current.status, 'complete', current.error);
    assert.ok(current.bytes > 100);
    assert.equal((await fetch(`${origin}/exports/${job.id}/download`)).status, 401);
    const download = await fetch(`${origin}/exports/${job.id}/download`, { headers: { Cookie: teammate, Range: 'bytes=0-31' } });
    assert.equal(download.status, 206); assert.match(download.headers.get('content-disposition') ?? '', /\.mp4/);
    assert.equal(Buffer.from(await download.arrayBuffer()).toString('ascii', 4, 8), 'ftyp');
    assert.deepEqual(await fs.readFile(original), originalBytes);
    assert.deepEqual(await fs.readFile(path.join(directory, 'production.json')), productionSentinel);
    const exportFiles = await fs.readdir(path.join(directory, 'clips', 'exports'));
    assert.ok(exportFiles.every(filename => !filename.includes('.work-') && !filename.includes('.partial')));
  });
  await t.test('starting live production preempts an active composition render and leaves its editable draft intact', async () => {
    const edit = settings(); edit.name = 'Pause for live';
    edit.timeline.tracks[0].items = [item({ id: 'long_image', name: 'Long image', kind: 'image', source: { kind: 'asset', id: assetId }, durationMs: 90_000 })];
    edit.timeline.tracks[1].items = [];
    const created = await fetch(`${origin}/drafts`, json('POST', { recordingId: source.id, ...edit })); assert.equal(created.status, 201);
    const saved: ClipDraft = await created.json();
    const requested = await fetch(`${origin}/drafts/${saved.id}/exports`, json('POST', { revision: saved.revision })); assert.equal(requested.status, 202);
    const queued: ClipExport = await requested.json();
    const deadline = Date.now() + 10_000;
    let current = queued;
    while (Date.now() < deadline) {
      current = (await workspace()).exports.find(value => value.id === queued.id)!;
      if (current.status === 'exporting' || current.status === 'error') break;
      await new Promise(resolve => setTimeout(resolve, 20));
    }
    assert.equal(current.status, 'exporting', current.error);
    live = true;
    const started = Date.now(); await clips.pauseForLive();
    assert.ok(Date.now() - started < 4000, 'Live engine startup must not wait for a long composition to finish.');
    const paused = (await workspace()).exports.find(value => value.id === queued.id)!;
    assert.equal(paused.status, 'waiting-live');
    assert.equal((await workspace()).drafts.find(value => value.id === saved.id)?.timeline?.tracks[0].items[0].durationMs, 90_000);
    const exportFiles = await fs.readdir(path.join(directory, 'clips', 'exports'));
    assert.ok(exportFiles.every(filename => !filename.includes('.work-') && !filename.includes('.partial')));
    assert.equal((await fetch(`${origin}/exports/${queued.id}/cancel`, json('POST', {}))).status, 200);
    assert.equal((await workspace()).exports.find(value => value.id === queued.id)?.status, 'cancelled');
    assert.deepEqual(await fs.readFile(path.join(directory, 'production.json')), productionSentinel);
    assert.deepEqual(await fs.readFile(original), originalBytes);
  });
});
