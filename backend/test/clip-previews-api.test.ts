import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import type { AddressInfo } from 'node:net';
import express from 'express';
import sharp from 'sharp';
import type { RecordingStore } from '../src/production-recordings.js';
import { runClipMedia } from '../src/clip-media.js';

test('authenticated timeline preview API preserves private media and live worker isolation', { timeout: 90_000 }, async t => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'lumen-previews-api-'));
  const previousDir = process.env.LUMEN_DATA_DIR; process.env.LUMEN_DATA_DIR = directory;
  const { initDb } = await import('../src/db.js'); const database = initDb();
  const { createUser, login } = await import('../src/auth.js');
  const { createClips } = await import('../src/clips.js');
  const original = path.join(directory, 'recording.mp4'), speech = path.join(directory, 'speech.wav');
  await runClipMedia(['-hide_banner', '-nostdin', '-y', '-f', 'lavfi', '-i', "aevalsrc='if(between(t,0.2,0.4),0.5*sin(2*PI*440*t),0)|if(between(t,0.6,0.8),0.4*sin(2*PI*220*t),0)':s=48000:d=1", '-c:a', 'pcm_s16le', speech], 15_000).result;
  await runClipMedia(['-hide_banner', '-nostdin', '-y', '-f', 'lavfi', '-i', 'color=c=red:s=160x90:r=30:d=0.5', '-f', 'lavfi', '-i', 'color=c=blue:s=160x90:r=30:d=0.5', '-i', speech, '-filter_complex', '[0:v][1:v]concat=n=2:v=1:a=0[v]', '-map', '[v]', '-map', '2:a', '-c:v', 'libx264', '-threads', '1', '-c:a', 'aac', original], 15_000).result;
  const originalBytes = await fs.readFile(original), speechBytes = await fs.readFile(speech), production = Buffer.from('Program, Main audio and current service remain untouched.');
  await fs.writeFile(path.join(directory, 'production.json'), production);
  const record = { id: 'rec_preview', name: 'Preview fixture', status: 'complete' as const, durationMs: 1000, bytes: originalBytes.length, createdAt: '2026-10-19T12:00:00.000Z' };
  const recordings = { list: () => [{ ...record }], download: (id: string) => { if (id !== record.id) throw new Error('Unknown recording.'); return { path: original, name: record.name }; } } as unknown as RecordingStore;
  let live = true, clipsClosed = false;
  const clips = await createClips({ dir: path.join(directory, 'clips'), recordings, isLive: () => live });
  const app = express(); app.use(express.json()); app.use('/api', clips.router);
  let server: ReturnType<typeof app.listen> | undefined;
  t.after(async () => {
    if (server) await new Promise<void>(resolve => server!.close(() => resolve()));
    if (!clipsClosed) await clips.close(); database.close();
    if (previousDir === undefined) delete process.env.LUMEN_DATA_DIR; else process.env.LUMEN_DATA_DIR = previousDir;
    await fs.rm(directory, { recursive: true, force: true });
  });
  server = await new Promise<ReturnType<typeof app.listen>>((resolve, reject) => { const instance = app.listen(0, '127.0.0.1', () => resolve(instance)); instance.once('error', reject); });
  createUser('clip-editor', 'Clip editor', 'test-password'); createUser('clip-teammate', 'Clip teammate', 'test-password');
  const editor = `lumen_session=${login('clip-editor', 'test-password')!.sessionId}`, teammate = `lumen_session=${login('clip-teammate', 'test-password')!.sessionId}`;
  const origin = `http://127.0.0.1:${(server.address() as AddressInfo).port}/api/clips`, cache = path.join(directory, 'clips', 'timeline-previews');
  const url = (kind: 'recording' | 'asset', id: string, type: 'frame' | 'waveform', atMs: number) => `${origin}/timeline/${kind}/${id}/${type}?atMs=${atMs}`;
  const get = (target: string, cookie = editor) => fetch(target, { headers: { Cookie: cookie } });
  const waitImage = async (target: string, type: string) => {
    const deadline = Date.now() + 15_000;
    while (Date.now() < deadline) {
      const response = await get(target);
      if (response.status === 200 && response.headers.get('content-type')?.startsWith(type)) return response;
      const data = await response.json(); assert.equal(response.status, 202, JSON.stringify(data));
      assert.ok(['queued', 'processing', 'waiting-live'].includes(data.status)); assert.ok(data.retryAfterMs > 0);
      await new Promise(resolve => setTimeout(resolve, 10));
    }
    throw new Error('The worker did not produce a preview in time.');
  };
  const upload = async (bytes: Buffer, mime: string, name: string, width: number, height: number) => {
    const form = new FormData(); form.append('file', new Blob([bytes], { type: mime }), name);
    form.append('durationMs', '1000'); form.append('width', String(width)); form.append('height', String(height));
    const response = await fetch(`${origin}/assets`, { method: 'POST', headers: { Cookie: editor }, body: form }); assert.equal(response.status, 201);
    return (await response.json()).id as string;
  };
  let videoAsset = '', audioAsset = '';

  await t.test('auth and strict public preview queries reject missing sessions, arbitrary paths and invalid times', async () => {
    assert.equal((await fetch(url('recording', record.id, 'frame', 0))).status, 401);
    for (const suffix of ['?atMs=-1', '?atMs=0.5', '?atMs=86400001', '', '?atMs=hello', '?atMs=', '?atMs[]=0', '?atMs=0&atMs=100']) {
      assert.equal((await get(`${origin}/timeline/recording/${record.id}/frame${suffix}`)).status, 422, suffix);
    }
    assert.equal((await get(`${origin}/timeline/url/rec_preview/frame?atMs=0`)).status, 422);
    assert.equal((await get(`${origin}/timeline/recording/..%2Fsecret/frame?atMs=0`)).status, 422);
    assert.equal((await get(`${origin}/timeline/recording/${record.id}/filter?atMs=0`)).status, 422);
    assert.equal((await get(url('recording', 'rec_missing', 'frame', 0))).status, 404);
    assert.deepEqual(await fs.readdir(cache), []);
  });
  await t.test('uncached requests deduplicate while live and return no paths or generated files', async () => {
    const responses = await Promise.all(Array.from({ length: 24 }, (_, index) => get(url('recording', record.id, 'frame', index % 2 ? 149 : 199))));
    for (const response of responses) {
      assert.equal(response.status, 202); const result = await response.json();
      assert.equal(result.status, 'waiting-live'); assert.ok(result.retryAfterMs > 0); assert.equal(result.path, undefined); assert.equal(result.key, undefined);
    }
    await new Promise(resolve => setTimeout(resolve, 50)); assert.deepEqual(await fs.readdir(cache), []);
    videoAsset = await upload(originalBytes, 'video/mp4', 'Imported video.mp4', 160, 90);
    audioAsset = await upload(speechBytes, 'audio/wav', 'Imported speech.wav', 0, 0);
    assert.equal((await get(url('asset', videoAsset, 'frame', 750))).status, 202);
  });
  await t.test('the idle shared worker serves actual private JPEG frames once per quantized key', async () => {
    live = false;
    const response = await waitImage(url('recording', record.id, 'frame', 149), 'image/jpeg');
    assert.match(response.headers.get('cache-control') ?? '', /private/); assert.match(response.headers.get('cache-control') ?? '', /no-store/);
    const data = Buffer.from(await response.arrayBuffer()), info = await sharp(data).metadata(); assert.equal(info.width, 192); assert.equal(info.height, 108);
    const rgb = await sharp(data).raw().toBuffer(); assert.ok(rgb[0] > 220 && rgb[2] < 20);
    const imported = await waitImage(url('asset', videoAsset, 'frame', 750), 'image/jpeg');
    const blue = await sharp(Buffer.from(await imported.arrayBuffer())).raw().toBuffer(); assert.ok(blue[2] > 220 && blue[0] < 20);
    const cacheFiles = await fs.readdir(cache); assert.equal(cacheFiles.filter(name => name.endsWith('.jpg')).length, 2, 'Repeated polling does not duplicate generated images.');
    const teammateView = await get(url('recording', record.id, 'frame', 199), teammate); assert.equal(teammateView.status, 200); assert.equal(teammateView.headers.get('content-type'), 'image/jpeg'); await teammateView.arrayBuffer();
  });
  await t.test('recordings and imported audio expose actual transparent stereo PNG waveforms with silent tail padding', async () => {
    const recordingWave = await waitImage(url('recording', record.id, 'waveform', 200), 'image/png'); assert.equal((await sharp(Buffer.from(await recordingWave.arrayBuffer())).metadata()).width, 3000);
    const response = await waitImage(url('asset', audioAsset, 'waveform', 400), 'image/png');
    assert.match(response.headers.get('cache-control') ?? '', /private.*no-store/);
    const { data, info } = await sharp(Buffer.from(await response.arrayBuffer())).ensureAlpha().raw().toBuffer({ resolveWithObject: true });
    assert.equal(info.width, 3000); assert.equal(info.height, 64);
    const ink = (x0: number, x1: number, y0: number, y1: number) => { let count = 0; for (let y = y0; y < y1; y++) for (let x = x0; x < x1; x++) if (data[(y * info.width + x) * 4 + 3]) count++; return count; };
    assert.ok(ink(22, 38, 0, 32) > 20); assert.equal(ink(22, 38, 32, 64), 0); assert.ok(ink(62, 78, 32, 64) > 20); assert.equal(ink(110, 2999, 0, 64), 0);
    assert.equal((await get(url('asset', audioAsset, 'frame', 0))).status, 200);
    assert.deepEqual(await (await get(url('asset', audioAsset, 'frame', 0))).json(), { status: 'unavailable', reason: 'not-video' });
  });
  await t.test('cached images remain available during live production while new images wait without decoding', async () => {
    live = true; await clips.pauseForLive();
    const before = await fs.readdir(cache);
    const cached = await get(url('recording', record.id, 'frame', 100)); assert.equal(cached.status, 200); assert.equal(cached.headers.get('content-type'), 'image/jpeg'); await cached.arrayBuffer();
    const uncached = await get(url('recording', record.id, 'frame', 500)); assert.equal(uncached.status, 202); assert.equal((await uncached.json()).status, 'waiting-live');
    await new Promise(resolve => setTimeout(resolve, 50)); assert.deepEqual(await fs.readdir(cache), before);
    live = false; const resumed = await waitImage(url('recording', record.id, 'frame', 500), 'image/jpeg'); await resumed.arrayBuffer();
    assert.deepEqual(await fs.readFile(original), originalBytes); assert.deepEqual(await fs.readFile(path.join(directory, 'production.json')), production);
  });
  await t.test('an active preview is preempted before live starts, safely requeues and resumes after idle', async () => {
    let target = '', processing = false;
    // A particularly fast decoder may finish a tiny fixture before its first
    // status poll returns. Try another uncached frame rather than failing on
    // that timing race; pause only after observing real shared-worker activity.
    for (const atMs of [300, 200, 400, 600, 900]) {
      target = url('recording', record.id, 'frame', atMs);
      for (let index = 0; index < 30; index++) {
        const response = await get(target);
        if (response.status === 200) { await response.arrayBuffer(); break; }
        const result = await response.json();
        if (result.status === 'processing') { processing = true; break; }
      }
      if (processing) break;
    }
    assert.equal(processing, true, 'The request should enter the shared worker before being paused.');
    live = true; const started = Date.now(); await clips.pauseForLive(); assert.ok(Date.now() - started < 4000);
    const paused = await get(target); assert.equal(paused.status, 202); assert.equal((await paused.json()).status, 'waiting-live');
    assert.ok((await fs.readdir(cache)).every(name => !name.endsWith('.partial')));
    live = false; const resumed = await waitImage(target, 'image/jpeg'); await resumed.arrayBuffer();
    assert.deepEqual(await fs.readFile(original), originalBytes); assert.deepEqual(await fs.readFile(path.join(directory, 'production.json')), production);
  });
  await t.test('closing the station rejects further preview work and leaves no partial cache outputs', async () => {
    await get(url('recording', record.id, 'frame', 800));
    await clips.close(); clipsClosed = true;
    assert.equal((await get(url('recording', record.id, 'frame', 900))).status, 503);
    assert.ok((await fs.readdir(cache)).every(name => !name.endsWith('.partial')));
    assert.deepEqual(await fs.readFile(original), originalBytes); assert.deepEqual(await fs.readFile(path.join(directory, 'production.json')), production);
  });
});
