import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import type { AddressInfo } from 'node:net';
import express from 'express';
import type { ClipExport, ClipExportOptions, ClipWorkspace } from '../../shared/clips.js';
import type { RecordingStore } from '../src/production-recordings.js';
import { clipExportProfile, runClipMedia } from '../src/clip-media.js';

test('export options are validated immutable jobs with private format-correct downloads and legacy defaults', { timeout: 60_000 }, async t => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'lumen-export-options-api-')), previous = process.env.LUMEN_DATA_DIR;
  process.env.LUMEN_DATA_DIR = directory;
  const { initDb } = await import('../src/db.js'); const database = initDb();
  const { createUser, login } = await import('../src/auth.js'); const { createClips } = await import('../src/clips.js');
  const original = path.join(directory, 'recording.mp4');
  await runClipMedia(['-hide_banner', '-nostdin', '-y', '-f', 'lavfi', '-i', 'color=c=navy:s=160x90:r=30:d=1', '-f', 'lavfi', '-i', 'sine=f=440:r=48000:d=1', '-map', '0:v', '-map', '1:a', '-c:v', 'libx264', '-threads', '1', '-c:a', 'aac', original], 15_000).result;
  const originalBytes = await fs.readFile(original), sentinel = Buffer.from('Program and Main audio are unchanged by exporting.');
  await fs.writeFile(path.join(directory, 'production.json'), sentinel);
  const source = { id: 'rec_test', name: 'Service', status: 'complete' as const, durationMs: 1000, bytes: originalBytes.length, createdAt: '2026-10-19T12:00:00.000Z' };
  const recordings = { list: () => [{ ...source }], download: () => ({ path: original, name: source.name }) } as unknown as RecordingStore;
  let live = true;
  const clips = await createClips({ dir: path.join(directory, 'clips'), recordings, isLive: () => live });
  const app = express(); app.use(express.json()); app.use('/api', clips.router);
  let server: ReturnType<typeof app.listen> | undefined;
  t.after(async () => {
    if (server) await new Promise<void>(resolve => server!.close(() => resolve()));
    await clips.close(); database.close();
    if (previous === undefined) delete process.env.LUMEN_DATA_DIR; else process.env.LUMEN_DATA_DIR = previous;
    await fs.rm(directory, { recursive: true, force: true });
  });
  server = await new Promise<ReturnType<typeof app.listen>>((resolve, reject) => { const instance = app.listen(0, '127.0.0.1', () => resolve(instance)); instance.once('error', reject); });
  createUser('editor', 'Editor', 'test-password'); const cookie = `lumen_session=${login('editor', 'test-password')!.sessionId}`;
  const origin = `http://127.0.0.1:${(server.address() as AddressInfo).port}/api/clips`;
  const json = (method: string, body: unknown) => ({ method, headers: { Cookie: cookie, 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
  const settings = { name: 'Service highlight', inMs: 0, outMs: 500, format: '16:9', fit: 'cover', positionX: .5, positionY: .5 };
  const created = await fetch(`${origin}/drafts`, json('POST', { recordingId: source.id, ...settings })); assert.equal(created.status, 201); const draft = await created.json();
  for (const options of [{ container: 'avi', resolution: '720p' }, { container: 'mp4', resolution: '4k' }, { container: 'mp4', resolution: '720p', path: '/etc/passwd' }, {}]) {
    assert.equal((await fetch(`${origin}/drafts/${draft.id}/exports`, json('POST', { revision: 0, options }))).status, 422);
  }
  const jobs: ClipExport[] = [];
  for (const options of [undefined, ...(['webm', 'mov', 'mp3', 'wav'] as const).map(container => ({ container, resolution: '720p' as const }))]) {
    const response = await fetch(`${origin}/drafts/${draft.id}/exports`, json('POST', { revision: 0, ...(options ? { options } : {}) })); assert.equal(response.status, 202);
    const job = await response.json() as ClipExport; assert.equal(job.status, 'waiting-live'); assert.deepEqual(job.options, options ?? { container: 'mp4', resolution: '1080p' }); jobs.push(job);
  }
  const changed = await fetch(`${origin}/drafts/${draft.id}`, json('PUT', { ...settings, name: 'Changed later', outMs: 750, revision: 0 })); assert.equal(changed.status, 200);
  live = false;
  let workspace: ClipWorkspace | undefined;
  const deadline = Date.now() + 30_000;
  while (Date.now() < deadline) {
    workspace = await (await fetch(origin, { headers: { Cookie: cookie } })).json();
    if (workspace!.exports.every(job => ['complete', 'error'].includes(job.status))) break;
    await new Promise(resolve => setTimeout(resolve, 30));
  }
  for (const requested of jobs) {
    const job = workspace!.exports.find(value => value.id === requested.id)!;
    assert.equal(job.status, 'complete', `${job.options?.container}: ${job.error}`); assert.deepEqual(job.options, requested.options); assert.equal(job.settings.outMs, 500); assert.equal(job.name, settings.name); assert.equal(job.draftRevision, 0);
    const profile = clipExportProfile(job.options), target = `${origin}/exports/${job.id}/download`;
    assert.equal((await fetch(target)).status, 401);
    const response = await fetch(target, { headers: { Cookie: cookie, Range: 'bytes=0-31' } }); assert.equal(response.status, 206);
    assert.equal(response.headers.get('content-type'), profile.mime); assert.match(response.headers.get('content-disposition') ?? '', new RegExp(`\\.${profile.extension}`)); assert.match(response.headers.get('cache-control') ?? '', /private/);
    const bytes = Buffer.from(await response.arrayBuffer());
    if (profile.container === 'mp4' || profile.container === 'mov') assert.equal(bytes.toString('ascii', 4, 8), 'ftyp');
    if (profile.container === 'wav') assert.equal(bytes.toString('ascii', 0, 4), 'RIFF');
    if (profile.container === 'webm') assert.deepEqual([...bytes.subarray(0, 4)], [26, 69, 223, 163]);
    const diagnostic = await runClipMedia(['-hide_banner', '-nostdin', '-threads', '1', '-i', path.join(directory, 'clips', 'exports', `${job.id}.${profile.extension}`), ...(profile.video ? ['-map', '0:v', '-an', '-frames:v', '1'] : ['-map', '0:a', '-vn', '-t', '0.05']), '-f', 'null', '-'], 15_000).result;
    if (profile.video) assert.match(diagnostic, job.options!.resolution === '720p' ? /1280x720/ : /1920x1080/);
    else assert.doesNotMatch(diagnostic, /Stream.*Video:/);
  }
  const stored = JSON.parse(await fs.readFile(path.join(directory, 'clips', 'clips.json'), 'utf8'));
  for (const job of jobs) assert.deepEqual(stored.exports.find((value: ClipExport) => value.id === job.id).options, job.options);
  assert.deepEqual(await fs.readFile(original), originalBytes); assert.deepEqual(await fs.readFile(path.join(directory, 'production.json')), sentinel);
  assert.ok((await fs.readdir(path.join(directory, 'clips', 'exports'))).every(name => !name.includes('.partial')));
});
