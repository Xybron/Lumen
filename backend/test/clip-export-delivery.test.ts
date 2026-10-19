import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import express from 'express';
import sharp from 'sharp';
import type { ClipExport, ClipWorkspace } from '../../shared/clips.js';
import type { RecordingStore } from '../src/production-recordings.js';
import { runClipMedia } from '../src/clip-media.js';

test('destination delivery uses private temporary exports, actual posters and safe acknowledged cleanup', { timeout: 90_000 }, async t => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'lumen-export-delivery-')), previous = process.env.LUMEN_DATA_DIR;
  process.env.LUMEN_DATA_DIR = directory;
  const { initDb } = await import('../src/db.js'); const database = initDb();
  const { createUser, login } = await import('../src/auth.js');
  const { createClips, TEMP_EXPORT_TTL_MS, MAX_TEMP_EXPORT_BYTES } = await import('../src/clips.js');
  const original = path.join(directory, 'recording.mp4'), clipDir = path.join(directory, 'clips');
  await runClipMedia(['-hide_banner', '-nostdin', '-y', '-f', 'lavfi', '-i', 'color=c=red:s=160x90:r=30:d=1', '-f', 'lavfi', '-i', 'color=c=blue:s=160x90:r=30:d=1',
    '-f', 'lavfi', '-i', 'sine=f=440:r=48000:d=2', '-filter_complex', '[0:v][1:v]concat=n=2:v=1:a=0[v]', '-map', '[v]', '-map', '2:a', '-c:v', 'libx264', '-threads', '1', '-c:a', 'aac', original], 15_000).result;
  const originalBytes = await fs.readFile(original), production = Buffer.from('Preview, Program, sources and persistent Main audio must not change.');
  await fs.writeFile(path.join(directory, 'production.json'), production);
  const record = { id: 'rec_delivery', name: 'Service', status: 'complete' as const, durationMs: 2000, bytes: originalBytes.length, createdAt: '2026-10-19T12:00:00.000Z' };
  const recordings = { list: () => [{ ...record }], download: () => ({ path: original, name: record.name }) } as unknown as RecordingStore;
  let live = true, clips = await createClips({ dir: clipDir, recordings, isLive: () => live }), clipsClosed = false;
  const app = express(); app.use(express.json()); app.use('/api', (req, res, next) => clips.router(req, res, next));
  let server: ReturnType<typeof app.listen> | undefined;
  t.after(async () => {
    server?.closeAllConnections();
    if (server) await new Promise<void>(resolve => server!.close(() => resolve()));
    if (!clipsClosed) await clips.close(); database.close();
    if (previous === undefined) delete process.env.LUMEN_DATA_DIR; else process.env.LUMEN_DATA_DIR = previous;
    await fs.rm(directory, { recursive: true, force: true });
  });
  server = await new Promise<ReturnType<typeof app.listen>>((resolve, reject) => { const instance = app.listen(0, '127.0.0.1', () => resolve(instance)); instance.once('error', reject); });
  createUser('delivery-editor', 'Editor', 'test-password'); createUser('delivery-teammate', 'Teammate', 'test-password'); createUser('delivery-admin', 'Admin', 'test-password', true);
  const cookie = (name: string) => `lumen_session=${login(name, 'test-password')!.sessionId}`;
  const editor = cookie('delivery-editor'), teammate = cookie('delivery-teammate'), admin = cookie('delivery-admin');
  const origin = `http://127.0.0.1:${(server.address() as AddressInfo).port}/api/clips`;
  const get = (route: string, session = editor, headers: Record<string, string> = {}) => fetch(`${origin}${route}`, { headers: { Cookie: session, ...headers } });
  const post = (route: string, body: unknown, session = editor) => fetch(`${origin}${route}`, { method: 'POST', headers: { Cookie: session, 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
  const workspace = async () => await (await get('')).json() as ClipWorkspace;
  const artifact = (id: string, extension = 'mp4') => path.join(clipDir, 'scratch', `${id}.${extension}`);
  const poster = (id: string) => path.join(clipDir, 'scratch', `${id}.thumbnail.jpg`);
  const exists = async (filename: string) => { try { await fs.stat(filename); return true; } catch { return false; } };
  const wait = async (check: () => Promise<boolean>, label: string, timeout = 20_000) => { const deadline = Date.now() + timeout; while (Date.now() < deadline) { if (await check()) return; await new Promise(resolve => setTimeout(resolve, 15)); } throw new Error(label); };
  const draftResponse = await post('/drafts', { recordingId: record.id, name: 'Blue highlight', inMs: 1000, outMs: 2000, format: '16:9', fit: 'cover', positionX: .5, positionY: .5 });
  assert.equal(draftResponse.status, 201); const draft = await draftResponse.json();
  let video!: ClipExport, audio!: ClipExport, permanent!: ClipExport;

  await t.test('explicit temporary mode is strict and release requires a completed owner-controlled job', async () => {
    for (const fields of [{ temporary: 'true' }, { temporary: true, path: '/tmp/user-path.mp4' }, { temporary: true, expiresAt: '2099-01-01T00:00:00.000Z' }]) assert.equal((await post(`/drafts/${draft.id}/exports`, { revision: 0, ...fields })).status, 422);
    video = await (await post(`/drafts/${draft.id}/exports`, { revision: 0, temporary: true, options: { container: 'mp4', resolution: '720p' } })).json();
    audio = await (await post(`/drafts/${draft.id}/exports`, { revision: 0, temporary: true, options: { container: 'mp3', resolution: '720p' } })).json();
    permanent = await (await post(`/drafts/${draft.id}/exports`, { revision: 0, options: { container: 'mp4', resolution: '720p' } })).json();
    assert.equal(video.temporary, true); assert.equal(video.expiresAt, undefined); assert.equal(permanent.temporary, undefined);
    assert.equal(video.status, 'waiting-live');
    assert.equal((await fetch(`${origin}/exports/${video.id}/release`, { method: 'POST' })).status, 401);
    assert.equal((await post(`/exports/${video.id}/release`, {}, teammate)).status, 403);
    assert.equal((await post(`/exports/${video.id}/release`, {})).status, 409);
    assert.equal((await post(`/exports/${video.id}/release`, { path: original })).status, 422);
    assert.equal((await post(`/exports/${permanent.id}/release`, {})).status, 409);
    live = false;
    await wait(async () => (await workspace()).exports.every(job => ['complete', 'error'].includes(job.status)), 'Exports did not finish.');
    const finished = (await workspace()).exports;
    for (const job of finished) assert.equal(job.status, 'complete', job.error);
    video = finished.find(job => job.id === video.id)!; audio = finished.find(job => job.id === audio.id)!; permanent = finished.find(job => job.id === permanent.id)!;
    assert.equal(Date.parse(video.expiresAt!) - Date.parse(video.completedAt!), TEMP_EXPORT_TTL_MS);
    assert.equal(audio.posterReady, false); assert.equal(video.posterReady, true); assert.equal(permanent.expiresAt, undefined);
    assert.ok(await exists(artifact(video.id))); assert.ok(await exists(artifact(audio.id, 'mp3')));
    assert.equal(await exists(path.join(clipDir, 'exports', `${video.id}.mp4`)), false);
    assert.ok(await exists(path.join(clipDir, 'exports', `${permanent.id}.mp4`)));
  });
  await t.test('complete job already has an actual edited-frame thumbnail, and downloads alone never acknowledge delivery', async () => {
    assert.equal((await fetch(`${origin}/exports/${video.id}/thumbnail`)).status, 401);
    const image = await get(`/exports/${video.id}/thumbnail`); assert.equal(image.status, 200); assert.equal(image.headers.get('content-type'), 'image/jpeg'); assert.match(image.headers.get('cache-control') ?? '', /private.*no-store/);
    const { data, info } = await sharp(Buffer.from(await image.arrayBuffer())).raw().toBuffer({ resolveWithObject: true });
    assert.equal(info.width, 640); assert.equal(info.height, 360); assert.ok(data[2] > 220 && data[0] < 20, 'Poster is blue from the edited second, not the red original thumbnail.');
    assert.equal((await get(`/exports/${audio.id}/thumbnail`)).status, 404);
    for (let retry = 0; retry < 2; retry++) {
      const response = await get(`/exports/${video.id}/download`, teammate, { Range: 'bytes=0-31' }); assert.equal(response.status, 206); assert.equal((await response.arrayBuffer()).byteLength, 32);
      assert.equal(response.headers.get('content-type'), 'video/mp4'); assert.match(response.headers.get('content-disposition') ?? '', /Blue highlight\.mp4/);
    }
    const retained = (await workspace()).exports.find(job => job.id === video.id)!; assert.equal(retained.deliveredAt, undefined); assert.ok(await exists(artifact(video.id)));
  });
  await t.test('verified delivery releases only that temporary artifact and thumbnail with an idempotent receipt', async () => {
    const bytes = video.bytes;
    const released = await post(`/exports/${video.id}/release`, {}); assert.equal(released.status, 200); const receipt = await released.json() as ClipExport;
    assert.equal(receipt.status, 'complete'); assert.equal(receipt.bytes, bytes); assert.equal(receipt.posterReady, false); assert.ok(receipt.deliveredAt);
    assert.equal(await exists(artifact(video.id)), false); assert.equal(await exists(poster(video.id)), false);
    assert.equal((await get(`/exports/${video.id}/download`)).status, 410); assert.equal((await get(`/exports/${video.id}/thumbnail`)).status, 410);
    assert.equal((await (await post(`/exports/${video.id}/release`, {})).json()).deliveredAt, receipt.deliveredAt);
    assert.ok(await exists(artifact(audio.id, 'mp3'))); assert.ok(await exists(path.join(clipDir, 'exports', `${permanent.id}.mp4`)));
    const adminRelease = await post(`/exports/${audio.id}/release`, {}, admin); assert.equal(adminRelease.status, 200); assert.equal(await exists(artifact(audio.id, 'mp3')), false);
    assert.deepEqual(await fs.readFile(original), originalBytes); assert.deepEqual(await fs.readFile(path.join(directory, 'production.json')), production);
  });

  await clips.close(); clipsClosed = true;
  const indexPath = path.join(clipDir, 'clips.json'), index = JSON.parse(await fs.readFile(indexPath, 'utf8'));
  const now = Date.now(), future = new Date(now + TEMP_EXPORT_TTL_MS).toISOString(), past = new Date(now - 1000).toISOString();
  const seed = (id: string, fields: Partial<ClipExport> = {}) => ({ ...permanent, id, temporary: true, expiresAt: future, posterReady: undefined, canCancel: undefined, ...fields });
  const expired = seed('export_expired', { expiresAt: past }), transferred = seed('export_transferred', { deliveredAt: past }), retained = seed('export_retained'), held = seed('export_held', { bytes: 32 * 1024 * 1024 }), quota = seed('export_quota', { bytes: MAX_TEMP_EXPORT_BYTES }), interrupted = seed('export_interrupted', { status: 'exporting' });
  index.exports.push(expired, transferred, retained, held, quota, interrupted);
  // Seed only this disposable fixture's private scratch files. Sparse data tests
  // transfer lifetime and quota without allocating gigabytes or decoding it.
  for (const job of [expired, transferred, retained, held, quota, interrupted]) {
    const handle = await fs.open(artifact(job.id), 'w'); await handle.truncate(job.bytes); await handle.close();
    await fs.writeFile(poster(job.id), 'private generated fixture poster');
  }
  const unknownScratch = path.join(clipDir, 'scratch', 'keep-user-file.mp4'), unknownLegacy = path.join(clipDir, 'exports', 'unrelated.mp4');
  await fs.writeFile(unknownScratch, 'never delete unknown files'); await fs.writeFile(unknownLegacy, 'never delete legacy files');
  const partial = path.join(clipDir, 'scratch', `${retained.id}.partial.mp4`), generatedWork = path.join(clipDir, 'scratch', `${retained.id}.work-a1b2c3`);
  await fs.writeFile(partial, 'interrupted own partial'); await fs.mkdir(generatedWork); await fs.writeFile(path.join(generatedWork, 'text.png'), 'own work');
  await fs.writeFile(indexPath, JSON.stringify(index));
  live = true; clips = await createClips({ dir: clipDir, recordings, isLive: () => live }); clipsClosed = false;
  await t.test('startup expires only temporary exports and cleans only known generated files', async () => {
    assert.equal(await exists(artifact(expired.id)), false); assert.equal(await exists(poster(expired.id)), false);
    assert.equal(await exists(artifact(transferred.id)), false); assert.equal(await exists(poster(transferred.id)), false);
    assert.equal(await exists(artifact(interrupted.id)), false); assert.equal(await exists(poster(interrupted.id)), false);
    assert.equal((await workspace()).exports.find(job => job.id === interrupted.id)!.status, 'interrupted');
    assert.equal(await exists(partial), false); assert.equal(await exists(generatedWork), false);
    assert.ok(await exists(artifact(retained.id))); assert.ok(await exists(artifact(held.id)));
    assert.equal((await get(`/exports/${expired.id}/download`)).status, 410); assert.equal((await get(`/exports/${expired.id}/thumbnail`)).status, 410);
    assert.ok((await workspace()).exports.find(job => job.id === expired.id)!.expiredAt);
    assert.equal(await fs.readFile(unknownScratch, 'utf8'), 'never delete unknown files'); assert.equal(await fs.readFile(unknownLegacy, 'utf8'), 'never delete legacy files');
    const legacy = await get(`/exports/${permanent.id}/download`); assert.equal(legacy.status, 200); await legacy.arrayBuffer();
    assert.equal((await post(`/exports/${permanent.id}/release`, {})).status, 409);
    assert.equal((await post(`/drafts/${draft.id}/exports`, { revision: 0, temporary: true })).status, 507);
    assert.equal((await post(`/exports/${quota.id}/release`, {})).status, 200);
    assert.equal(await exists(artifact(quota.id)), false);
  });
  await t.test('an acknowledged file is retained while a teammate is still downloading it', async () => {
    const response = await new Promise<http.IncomingMessage>((resolve, reject) => {
      const request = http.get(`${origin}/exports/${held.id}/download`, { headers: { Cookie: teammate } }, resolve); request.once('error', reject);
    });
    response.pause(); assert.equal(response.statusCode, 200);
    const release = await post(`/exports/${held.id}/release`, {}); assert.equal(release.status, 200); assert.ok((await release.json()).deliveredAt);
    assert.ok(await exists(artifact(held.id)), 'A paused transfer still owns its artifact.');
    assert.equal((await get(`/exports/${held.id}/download`)).status, 410);
    response.destroy();
    await wait(async () => !await exists(artifact(held.id)), 'Released file was not reclaimed after the active transfer closed.');
    assert.equal(await exists(poster(held.id)), false);
  });
  await t.test('cancelled scratch jobs leave no output, and originals, drafts and permanent archives survive cleanup', async () => {
    const response = await post(`/drafts/${draft.id}/exports`, { revision: 0, temporary: true }); assert.equal(response.status, 202); const job = await response.json();
    const cancel = await post(`/exports/${job.id}/cancel`, {}); assert.equal(cancel.status, 200); assert.equal((await cancel.json()).status, 'cancelled');
    assert.equal(await exists(artifact(job.id)), false); assert.equal((await post(`/exports/${job.id}/release`, {})).status, 409);
    const result = await workspace(); assert.equal(result.drafts.find(value => value.id === draft.id)?.revision, 0);
    assert.deepEqual(await fs.readFile(original), originalBytes); assert.deepEqual(await fs.readFile(path.join(directory, 'production.json')), production);
    assert.ok(await exists(path.join(clipDir, 'exports', `${permanent.id}.mp4`)));
    assert.equal((await fs.readdir(path.join(clipDir, 'scratch'))).some(name => name.includes('.partial') || name.includes('.work-')), false);
  });
});
