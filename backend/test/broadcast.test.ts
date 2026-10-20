import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { spawn } from 'node:child_process';
import { Writable } from 'node:stream';
import { createBroadcast, broadcastDestinationUrl, BroadcastError, type BroadcastWatchRelay } from '../src/broadcast.js';
import { BROADCAST_SINK_LIMIT, BROADCAST_CHUNK_LIMIT, broadcastEncoderArguments, broadcastHlsArguments, spawnBroadcastProcess, writeBroadcastSink } from '../src/broadcast-process.js';
import { runClipMedia } from '../src/clip-media.js';

test('broadcast destinations keep fixed RTMPS authorities and bounded codec arguments', () => {
  assert.equal(new URL(broadcastDestinationUrl('youtube', 'opaque-key')).hostname, 'a.rtmps.youtube.com');
  assert.equal(new URL(broadcastDestinationUrl('facebook', 'opaque?s=1&ds=1')).hostname, 'live-api-s.facebook.com');
  for (const key of ['rtmp://127.0.0.1/private', '//elsewhere/path', 'file:/etc/passwd', 'key\n-injected', ' ']) assert.throws(() => broadcastDestinationUrl('youtube', key), BroadcastError);
  const args = broadcastEncoderArguments('720p'); assert.ok(args.includes('libx264')); assert.ok(args.includes('aac')); assert.ok(args.includes('pipe:1')); assert.ok(args.includes('pipe:3'));
  assert.match(args[args.indexOf('-vf') + 1], /1280:720/); assert.equal(args.filter(value => value === 'libx264').length, 1);
  assert.ok(broadcastHlsArguments('/private/generated').includes('6')); assert.ok(broadcastHlsArguments('/private/generated').includes('delete_segments+temp_file+independent_segments+discont_start'));
});
test('a blocked destination cannot grow beyond its independent queue or backpressure the encoder', () => {
  const blocked = new Writable({ highWaterMark: 1, write(_chunk, _encoding, _done) { /* Deliberately never drain. */ } });
  blocked.on('error', () => {});
  let accepted = 0; const chunk = Buffer.alloc(64 * 1024);
  while (writeBroadcastSink(blocked, chunk)) accepted += chunk.length;
  assert.equal(accepted, BROADCAST_SINK_LIMIT); assert.ok(blocked.writableLength <= BROADCAST_SINK_LIMIT); blocked.destroy();
});
test('broadcast configuration is private, secret-free in public snapshots, strict and crash safe', async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'lumen-broadcast-config-'));
  const sentinel = path.join(dir, 'operator-notes.txt'); await fs.writeFile(sentinel, 'Preserve unrelated files.');
  const service = await createBroadcast({ dir });
  try {
    assert.equal(service.preflight().ready, false); assert.equal(service.snapshot().config.destinations.some(d => d.enabled), false);
    assert.equal(service.snapshot().config.recordOnStart, true);
    for (const invalid of [{ path: '/tmp/output' }, { destinations: [{ id: 'custom', enabled: true, streamKey: 'secret' }] }, { profile: '4k' }, { watch: { enabled: true, relayToken: 'secret' } }, { destinations: [{ id: 'youtube', enabled: true, url: 'rtmp://127.0.0.1' }] }]) await assert.rejects(service.configure(invalid as never), { status: 422 });
    await assert.rejects(service.configure({ profile: '4k' } as never), { message: 'Choose supported Go Live settings and valid stream keys.' });
    const result = await service.configure({ destinations: [{ id: 'youtube', enabled: true, streamKey: 'private-test-key?private-query=123' }] });
    assert.equal(result.config.destinations.find(d => d.id === 'youtube')?.configured, true); assert.equal(result.preflight.ready, true);
    assert.equal(result.preflight.checks.find(check => check.id === 'destinations')?.message, 'Stream destinations selected.');
    assert.doesNotMatch(JSON.stringify(result), /private-test-key|private-query|rtmps:\/\//);
    const file = path.join(dir, 'broadcast-private.json'); assert.equal((await fs.stat(file)).mode & 0o777, 0o600); assert.match(await fs.readFile(file, 'utf8'), /private-test-key/);
    await service.configure({ destinations: [{ id: 'youtube', enabled: false, clearKey: true }], watch: { enabled: true } }); assert.equal(service.preflight().ready, false);
    assert.equal((await fs.readdir(dir)).filter(name => name.endsWith('.tmp')).length, 0); assert.equal(await fs.readFile(sentinel, 'utf8'), 'Preserve unrelated files.');
  } finally { await service.close(); await fs.rm(dir, { recursive: true, force: true }); }
});
test('a corrupt private config is preserved, never reset or exposed in an exception', async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'lumen-broadcast-corrupt-')), source = '{private-secret-corrupt';
  try { await fs.writeFile(path.join(dir, 'broadcast-private.json'), source); await assert.rejects(createBroadcast({ dir }), error => error instanceof BroadcastError && error.status === 503 && !error.message.includes('private-secret')); assert.equal(await fs.readFile(path.join(dir, 'broadcast-private.json'), 'utf8'), source); }
  finally { await fs.rm(dir, { recursive: true, force: true }); }
});

test('real shared encode fans out to FLV and independent HLS while a failed destination retries privately', { timeout: 60_000 }, async t => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'lumen-broadcast-media-')), source = path.join(dir, 'fixture.webm'), publicDir = path.join(dir, 'relay-copy'), stateDir = path.join(dir, 'broadcast');
  await fs.mkdir(publicDir);
  await runClipMedia(['-hide_banner', '-nostdin', '-y', '-f', 'lavfi', '-i', 'color=c=blue:s=160x90:r=30:d=8', '-f', 'lavfi', '-i', 'sine=f=440:r=48000:d=8', '-map', '0:v', '-map', '1:a', '-c:v', 'libvpx', '-deadline', 'realtime', '-cpu-used', '8', '-threads', '1', '-c:a', 'libopus', source], 15_000).result;
  const bytes = await fs.readFile(source), sentinel = Buffer.from('Existing Program, scene drafts and persistent Main audio are unchanged.');
  await fs.writeFile(path.join(dir, 'production.json'), sentinel);
  let began = 0, published = 0, finished = 0, encodeCount = 0, facebookStarts = 0; const processes: number[] = [], statuses: string[] = [], diagnostics: string[] = [];
  const relay: BroadcastWatchRelay = { configured: true, publicUrl: 'https://watch.example.test/watch/church',
    async begin() { began++; }, async publish({ directory, playlist }) {
      const value = await fs.readFile(path.join(directory, playlist), 'utf8');
      for (const name of value.split(/\r?\n/).filter(line => /^segment-\d{8,20}\.ts$/.test(line))) await fs.copyFile(path.join(directory, name), path.join(publicDir, name));
      await fs.writeFile(path.join(publicDir, 'index.m3u8'), value); published++;
    }, async finish() { finished++; } };
  const service = await createBroadcast({ dir: stateDir, watchRelay: relay, onStatus: status => statuses.push(JSON.stringify(status)),
    spawn(file, arguments_, options) {
      const args = [...arguments_];
      if (args.at(-1) === 'pipe:1') encodeCount++;
      else if (args[args.indexOf('-rtmp_tcurl') + 1]?.startsWith('rtmps://a.rtmps.youtube.com')) { args[args.length - 1] = path.join(dir, 'youtube-fixture.flv'); args[args.lastIndexOf('-protocol_whitelist') + 1] = 'file'; args.splice(args.indexOf('-rtmp_tcurl'), 2); }
      else if (args[args.indexOf('-rtmp_tcurl') + 1]?.startsWith('rtmps://live-api-s.facebook.com')) { facebookStarts++; args[args.length - 1] = path.join(dir, 'absent', 'facebook-fixture.flv'); args[args.lastIndexOf('-protocol_whitelist') + 1] = 'file'; args.splice(args.indexOf('-rtmp_tcurl'), 2); }
      const child = spawn(file, args, options); if (child.pid) processes.push(child.pid); child.stderr?.on('data', b => diagnostics.push(b.toString()));
      child.stdio[3]?.on('data', b => diagnostics.push(`progress ${String(args.at(-1)).replace(/.*\//, '')}: ${b.toString()}`)); return child;
    } });
  t.after(async () => { await service.close(); await fs.rm(dir, { recursive: true, force: true }); });
  await service.configure({ profile: '720p', watch: { enabled: true }, destinations: [{ id: 'youtube', enabled: true, streamKey: 'private-YT-key' }, { id: 'facebook', enabled: true, streamKey: 'private-FB-key?private-query=123' }] });
  assert.equal(service.preflight().estimatedUploadKbps, Math.ceil(2660 * 3 * 1.15));
  const attempts = await Promise.allSettled([service.start(), service.start()]); assert.equal(attempts.filter(result => result.status === 'fulfilled').length, 1); assert.equal(encodeCount, 1);
  const session = service.snapshot().session!; assert.equal(session.state, 'starting'); assert.equal(session.watch.state, 'connecting'); assert.ok(session.id.startsWith('broadcast_'));
  await assert.rejects(service.configure({ profile: '1080p' }), { status: 409 });
  await assert.rejects(service.chunk(session.id, 2, bytes.subarray(0, 10)), { status: 409 });
  await assert.rejects(service.chunk('broadcast_unknown', 0, bytes.subarray(0, 10)), { status: 409 });
  await assert.rejects(service.chunk(session.id, -1, bytes), { status: 422 });
  await assert.rejects(service.chunk(session.id, 0, Buffer.alloc(BROADCAST_CHUNK_LIMIT + 1)), { status: 413 });
  let sequence = 0;
  for (let at = 0; at < bytes.length; at += 4096) {
    const piece = bytes.subarray(at, at + 4096); await service.chunk(session.id, sequence, piece);
    if (!sequence) assert.equal((await service.chunk(session.id, 0, piece)).nextSequence, 1);
    sequence++;
    // MediaRecorder delivers an ongoing stream over time. FFmpeg progress is
    // wall-clock sampled, so a whole eight-second file in one instant would
    // correctly have only its initial frame=0 report until its next packet.
    await new Promise(resolve => setTimeout(resolve, 60));
  }
  const deadline = Date.now() + 15_000;
  while (Date.now() < deadline && (published === 0 || service.snapshot().session?.destinations.find(d => d.id === 'youtube')?.state !== 'live')) await new Promise(resolve => setTimeout(resolve, 30));
  const live = service.snapshot().session!; assert.equal(live.chunks, sequence); assert.equal(live.bytes, bytes.length); assert.equal(live.watch.state, 'live', diagnostics.join('\n')); assert.equal(live.state, 'live', diagnostics.join('\n')); assert.ok(began > 0 && published > 0);
  assert.equal(live.destinations.find(d => d.id === 'youtube')?.state, 'live', diagnostics.join('\n')); assert.ok(['retrying', 'connecting'].includes(live.destinations.find(d => d.id === 'facebook')!.state)); assert.ok(facebookStarts > 0);
  assert.doesNotMatch(statuses.join('\n'), /private-YT-key|private-FB-key|private-query|rtmps:\/\//);
  const stopped = await service.stop(); assert.equal(stopped.session?.state, 'stopped'); assert.ok(finished > 0); assert.equal(encodeCount, 1);
  const diagnostic = await runClipMedia(['-hide_banner', '-nostdin', '-i', path.join(dir, 'youtube-fixture.flv'), '-map', '0:v', '-map', '0:a', '-t', '0.1', '-f', 'null', '-'], 15_000).result;
  assert.match(diagnostic, /Video: h264/); assert.match(diagnostic, /1280x720/); assert.match(diagnostic, /Audio: aac/); assert.match(diagnostic, /stereo/);
  const playlist = await fs.readFile(path.join(publicDir, 'index.m3u8'), 'utf8'); assert.match(playlist, /#EXTM3U/); assert.match(playlist, /#EXTINF:/);
  const segments = (await fs.readdir(publicDir)).filter(name => name.endsWith('.ts')); assert.ok(segments.length > 0 && segments.length <= 6);
  const segmentDiagnostic = await runClipMedia(['-hide_banner', '-nostdin', '-i', path.join(publicDir, segments[0]), '-map', '0:v', '-map', '0:a', '-t', '0.1', '-f', 'null', '-'], 15_000).result;
  assert.match(segmentDiagnostic, /Video: h264/); assert.match(segmentDiagnostic, /Audio: aac/);
  assert.deepEqual(await fs.readFile(source), bytes); assert.deepEqual(await fs.readFile(path.join(dir, 'production.json')), sentinel);
  assert.equal((await fs.readdir(stateDir)).filter(name => name.startsWith('broadcast_')).length, 0);
  for (const pid of processes) assert.throws(() => process.kill(pid, 0), { code: 'ESRCH' });
});

test('real 1080p encoder produces high-profile H264 and stereo AAC with a single bounded process', { timeout: 30_000 }, async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'lumen-broadcast-1080-')), source = path.join(dir, 'source.webm'), output = path.join(dir, 'encoded.ts');
  let encoder: ReturnType<typeof spawnBroadcastProcess> | undefined;
  try {
    await runClipMedia(['-hide_banner', '-nostdin', '-y', '-f', 'lavfi', '-i', 'color=c=red:s=160x90:r=30:d=2', '-f', 'lavfi', '-i', 'sine=f=330:r=48000:d=2', '-c:v', 'libvpx', '-deadline', 'realtime', '-threads', '1', '-c:a', 'libopus', source], 15_000).result;
    const chunks: Buffer[] = []; encoder = spawnBroadcastProcess(broadcastEncoderArguments('1080p'), () => {}); encoder.output.on('data', b => chunks.push(b)); encoder.input.end(await fs.readFile(source)); assert.equal(await encoder.done, 0);
    const encoded = Buffer.concat(chunks); assert.ok(encoded.length > 1000 && encoded.length < 4 * 1024 * 1024); await fs.writeFile(output, encoded);
    const diagnostics = await runClipMedia(['-hide_banner', '-nostdin', '-i', output, '-map', '0:v', '-map', '0:a', '-t', '0.1', '-f', 'null', '-'], 15_000).result;
    assert.match(diagnostics, /Video: h264 \(High\)/); assert.match(diagnostics, /1920x1080/); assert.match(diagnostics, /Audio: aac/); assert.match(diagnostics, /48000 Hz, stereo/);
  } finally { await encoder?.terminate(); await fs.rm(dir, { recursive: true, force: true }); }
});

test('Watch packaging restart uses unique media names and a discontinuity while retaining one encoder', { timeout: 45_000 }, async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'lumen-broadcast-retry-')), stateDir = path.join(dir, 'broadcast'), source = path.join(dir, 'source.webm');
  await runClipMedia(['-hide_banner', '-nostdin', '-y', '-f', 'lavfi', '-i', 'color=c=navy:s=160x90:r=30:d=16', '-f', 'lavfi', '-i', 'sine=f=330:r=48000:d=16', '-c:v', 'libvpx', '-deadline', 'realtime', '-threads', '1', '-c:a', 'libopus', source], 15_000).result;
  const bytes = await fs.readFile(source), playlists: string[] = []; let encodeCount = 0;
  const service = await createBroadcast({ dir: stateDir,
    watchRelay: { configured: true, async begin() {}, async finish() {}, async publish({ directory, playlist }) { playlists.push(await fs.readFile(path.join(directory, playlist), 'utf8')); } },
    spawn(file, args, options) { if (args.at(-1) === 'pipe:1') encodeCount++; return spawn(file, args, options); } });
  const wait = async (check: () => boolean) => { const end = Date.now() + 10_000; while (Date.now() < end) { if (check()) return; await new Promise(resolve => setTimeout(resolve, 30)); } throw new Error('Watch did not publish its expected media window.'); };
  try {
    await service.configure({ watch: { enabled: true } }); const session = await service.start();
    const halfway = Math.ceil(bytes.length / 2 / 4096) * 4096; let sequence = 0;
    for (let at = 0; at < halfway; at += 4096) { await service.chunk(session.id, sequence++, bytes.subarray(at, Math.min(at + 4096, bytes.length))); await new Promise(resolve => setTimeout(resolve, 60)); }
    await wait(() => playlists.length > 0); const previous = new Set(playlists.flatMap(value => value.split(/\r?\n/).filter(line => /^segment-\d{8,20}\.ts$/.test(line))));
    await service.stopDestination('watch'); assert.equal(service.snapshot().session?.watch.state, 'stopped'); await service.retryDestination('watch'); const count = playlists.length;
    for (let at = halfway; at < bytes.length; at += 4096) { await service.chunk(session.id, sequence++, bytes.subarray(at, at + 4096)); await new Promise(resolve => setTimeout(resolve, 60)); }
    await wait(() => playlists.length > count); const next = playlists.at(-1)!; assert.match(next, /#EXT-X-DISCONTINUITY/);
    const names = next.split(/\r?\n/).filter(line => /^segment-\d{8,20}\.ts$/.test(line)); assert.ok(names.length > 0); for (const name of names) assert.equal(previous.has(name), false);
    const ownDir = path.join(stateDir, session.id), files = await fs.readdir(ownDir); assert.ok(files.filter(name => name.endsWith('.ts')).length <= 9); for (const name of previous) assert.equal(files.includes(name), false);
    assert.equal(encodeCount, 1); await service.stop();
  } finally { await service.close(); await fs.rm(dir, { recursive: true, force: true }); }
});

test('renderer failure stops only the broadcast, redacts details and clears media children', { timeout: 15_000 }, async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'lumen-broadcast-failure-')); let stoppedId = '';
  const service = await createBroadcast({ dir, watchRelay: { configured: true, async begin() {}, async publish() {}, async finish() {} }, onFatal: id => { stoppedId = id; } });
  try {
    await service.configure({ watch: { enabled: true } }); const session = await service.start();
    const result = await service.error(session.id, 'secret-output-URL?streamKey=do-not-echo');
    assert.equal(result.session?.state, 'error'); assert.equal(stoppedId, session.id); assert.doesNotMatch(JSON.stringify(result), /do-not-echo|secret-output/);
    await assert.rejects(service.chunk(session.id, 0, Buffer.from('late media')), { status: 409 });
    assert.equal((await fs.readdir(dir)).some(name => name.startsWith('broadcast_')), false);
  } finally { await service.close(); await fs.rm(dir, { recursive: true, force: true }); }
});

test('a late Watch publish cannot resurrect a destination after stop, even if an adapter ignores cancellation', { timeout: 15_000 }, async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'lumen-broadcast-watch-stop-'));
  let started = false, resolvePublish: () => void = () => {}, wasAborted = false;
  const publication = new Promise<void>(resolve => { resolvePublish = resolve; });
  const service = await createBroadcast({ dir, watchRelay: { configured: true, async begin() {}, async finish() {},
    async publish({ signal }) { started = true; signal?.addEventListener('abort', () => { wasAborted = true; }, { once: true }); await publication; } },
    // These isolated logic-test children consume input and exit on EOF; real
    // media encoding/packaging is covered by the fixture tests above.
    spawn(_file, _args, options) { return spawn(process.execPath, ['-e', "process.stdin.resume();process.stdin.on('end',()=>process.exit(0))"], options); } });
  try {
    await service.configure({ watch: { enabled: true } }); const session = await service.start();
    await fs.writeFile(path.join(dir, session.id, 'index.m3u8'), '#EXTM3U\n#EXTINF:2.0,\nsegment-00000000.ts\n');
    const deadline = Date.now() + 3000; while (!started && Date.now() < deadline) await new Promise(resolve => setTimeout(resolve, 20)); assert.equal(started, true);
    await service.stopDestination('watch'); assert.equal(wasAborted, true); resolvePublish(); await new Promise(resolve => setTimeout(resolve, 20));
    assert.equal(service.snapshot().session?.watch.state, 'stopped'); assert.notEqual(service.snapshot().session?.state, 'live');
  } finally { resolvePublish(); await service.close(); await fs.rm(dir, { recursive: true, force: true }); }
});

test('an unknown Watch begin outcome retries the same epoch instead of creating a second public session', { timeout: 10_000 }, async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'lumen-broadcast-epoch-retry-')), epochs: string[] = []; let published = false;
  const service = await createBroadcast({ dir, watchRelay: { configured: true,
    async begin({ epoch }) { epochs.push(epoch); if (epochs.length === 1) throw new Error('Fixture connection lost after a possible remote commit.'); },
    async publish() { published = true; }, async finish() {} },
    spawn(_file, _args, options) { return spawn(process.execPath, ['-e', "process.stdin.resume();process.stdin.on('end',()=>process.exit(0))"], options); } });
  try {
    await service.configure({ watch: { enabled: true } }); const session = await service.start();
    await fs.writeFile(path.join(dir, session.id, 'index.m3u8'), '#EXTM3U\n#EXTINF:2.0,\nsegment-00000000.ts\n');
    const deadline = Date.now() + 4000; while (!published && Date.now() < deadline) await new Promise(resolve => setTimeout(resolve, 20));
    assert.equal(published, true); assert.equal(epochs.length, 2); assert.equal(epochs[0], epochs[1]);
  } finally { await service.close(); await fs.rm(dir, { recursive: true, force: true }); }
});
