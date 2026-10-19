import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import tls from 'node:tls';
import net from 'node:net';
import { spawn } from 'node:child_process';
import ffmpeg from 'ffmpeg-static';
import { broadcastRtmpsArguments, broadcastFailureMessage, broadcastFailureCanRetry, createBroadcastFailureClassifier, selectBroadcastEncoder, broadcastEncoderArguments, timeout } from '../src/broadcast-process.js';
import { createBroadcast } from '../src/broadcast.js';
import { runClipMedia } from '../src/clip-media.js';
import { openBroadcastRtmpsTransport } from '../src/broadcast-rtmps.js';

test('private RTMPS bridge verifies trust and hostname, carries bytes both ways and accepts only one local client', { timeout: 15_000 }, async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'lumen-rtmps-verified-'));
  const key = path.join(dir, 'fixture.key'), certificate = path.join(dir, 'fixture.crt');
  const openssl = spawn('openssl', ['req', '-x509', '-newkey', 'rsa:2048', '-nodes', '-days', '1', '-subj', '/CN=localhost', '-addext', 'subjectAltName=DNS:localhost', '-keyout', key, '-out', certificate], { stdio: 'ignore' });
  assert.equal(await new Promise(resolve => openssl.once('close', resolve)), 0);
  const cert = await fs.readFile(certificate), sockets = new Set<tls.TLSSocket>();
  const server = tls.createServer({ key: await fs.readFile(key), cert }, socket => {
    sockets.add(socket); socket.on('error', () => {}); socket.on('close', () => sockets.delete(socket));
    socket.on('data', bytes => socket.write(Buffer.concat([Buffer.from('verified:'), bytes])));
  });
  server.on('tlsClientError', () => {});
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  const address = server.address(); assert.ok(address && typeof address !== 'string');
  const target = 'rtmps://a.rtmps.youtube.com:443/live2/fixture-private-key?fixture-secret=never-log';
  let calls = 0, failures = 0;
  const transport = await openBroadcastRtmpsTransport(target, { connectTls(options) {
    calls++; assert.equal(options.host, 'a.rtmps.youtube.com'); assert.equal(options.port, 443); assert.equal(options.servername, 'a.rtmps.youtube.com'); assert.equal(options.rejectUnauthorized, true);
    return tls.connect({ ...options, host: '127.0.0.1', port: address.port, servername: 'localhost', ca: cert });
  }, onFailure: () => { failures++; } });
  const local = new URL(transport.url);
  const client = net.connect({ host: local.hostname, port: Number(local.port) }); client.on('error', () => {});
  try {
    assert.equal(local.hostname, '127.0.0.1'); assert.equal(transport.tcUrl, 'rtmps://a.rtmps.youtube.com:443/live2');
    const response = new Promise<Buffer>((resolve, reject) => { client.once('data', resolve); client.once('error', reject); });
    client.write('real-media-fixture');
    assert.equal((await timeout(response, 3000)).toString(), 'verified:real-media-fixture'); assert.equal(calls, 1);
    const second = net.connect({ host: local.hostname, port: Number(local.port) }); second.on('error', () => {});
    assert.equal(await timeout(new Promise(resolve => { second.once('error', () => resolve('refused')); second.once('connect', () => resolve('connected')); }), 2000), 'refused'); second.destroy();
    await transport.close(); await transport.close(); assert.equal(failures, 0); assert.equal(transport.failure(), 'unknown');
    for (const mode of ['untrusted', 'wrong-hostname'] as const) {
      const failure = new Promise<string>(async resolve => {
        const rejected = await openBroadcastRtmpsTransport(target, { connectTls: options => tls.connect({ ...options, host: '127.0.0.1', port: address.port, servername: mode === 'wrong-hostname' ? 'not-localhost.invalid' : 'localhost', ...(mode === 'wrong-hostname' ? { ca: cert } : {}) }), onFailure: resolve });
        const url = new URL(rejected.url), socket = net.connect({ host: url.hostname, port: Number(url.port) }); socket.on('error', () => {}); socket.write('fixture');
      });
      assert.equal(await timeout(failure, 3000), 'certificate');
    }
    const unused = await openBroadcastRtmpsTransport(target); const unusedUrl = new URL(unused.url); await unused.close(); await unused.close();
    const stopped = net.connect({ host: unusedUrl.hostname, port: Number(unusedUrl.port) }); stopped.on('error', () => {});
    assert.equal(await timeout(new Promise(resolve => { stopped.once('error', () => resolve('refused')); stopped.once('connect', () => resolve('connected')); }), 2000), 'refused'); stopped.destroy();
    for (const invalid of ['rtmp://a.rtmps.youtube.com/live2/key', 'rtmps://example.invalid/live2/key', 'rtmps://a.rtmps.youtube.com:444/live2/key', 'rtmps://user:pass@a.rtmps.youtube.com/live2/key', 'rtmps://live-api-s.facebook.com/wrong/key', `${target}#fragment`]) await assert.rejects(openBroadcastRtmpsTransport(invalid), /fixed secure/);
  } finally {
    client.destroy(); await transport.close(); for (const socket of sockets) socket.destroy();
    await new Promise<void>(resolve => server.close(() => resolve())); await fs.rm(dir, { recursive: true, force: true });
  }
});

test('RTMPS reaches a loopback TLS endpoint instead of being rejected by a pipe-only output whitelist', { timeout: 20_000 }, async t => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'lumen-broadcast-tls-')), key = path.join(dir, 'fixture.key'), certificate = path.join(dir, 'fixture.crt'), media = path.join(dir, 'fixture.ts');
  const openssl = spawn('openssl', ['req', '-x509', '-newkey', 'rsa:2048', '-nodes', '-days', '1', '-subj', '/CN=localhost', '-keyout', key, '-out', certificate], { stdio: 'ignore' });
  assert.equal(await new Promise(resolve => openssl.once('close', resolve)), 0);
  await runClipMedia(['-hide_banner', '-nostdin', '-y', '-f', 'lavfi', '-i', 'color=c=blue:s=160x90:r=30:d=1', '-f', 'lavfi', '-i', 'sine=f=440:r=48000:d=1', '-c:v', 'libx264', '-threads', '1', '-c:a', 'aac', '-f', 'mpegts', media], 10_000).result;
  let connections = 0, rtmpBytes = 0;
  const sockets = new Set<tls.TLSSocket>();
  const server = tls.createServer({ key: await fs.readFile(key), cert: await fs.readFile(certificate) }, socket => {
    sockets.add(socket); connections++; socket.on('error', () => {}); socket.on('data', bytes => { rtmpBytes += bytes.length; socket.destroy(); }); socket.on('close', () => sockets.delete(socket)); socket.setTimeout(1000, () => socket.destroy());
  });
  server.on('tlsClientError', () => {});
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve)); const address = server.address(); assert.ok(address && typeof address !== 'string');
  const target = `rtmps://127.0.0.1:${address.port}/live/fixture-key-not-a-real-account`;
  const input = await fs.readFile(media);
  const attempt = async (args: string[]) => {
    const before = connections, priorBytes = rtmpBytes;
    const child = spawn(ffmpeg!, args, { stdio: ['pipe', 'ignore', 'pipe', 'pipe'] }); let blocked = false;
    (child.stdio[3] as NodeJS.ReadableStream).resume();
    child.stdin.on('error', () => {}); child.stderr.on('data', bytes => { if (/not on whitelist/i.test(bytes.toString())) blocked = true; }); child.stdin.end(input);
    try { await timeout(new Promise(resolve => child.once('close', resolve)), 4000); } finally { child.kill('SIGKILL'); }
    return { connected: connections > before, handshakeBytes: rtmpBytes - priorBytes, blocked };
  };
  try {
    const original = broadcastRtmpsArguments(target); original.splice(original.lastIndexOf('-protocol_whitelist'), 2);
    const baseline = await attempt(original);
    t.diagnostic(JSON.stringify({ originalTlsConnected: baseline.connected, originalProtocolBlocked: baseline.blocked, originalRtmpHandshakeBytes: baseline.handshakeBytes }));
    assert.equal(baseline.blocked, false); assert.equal(baseline.connected, true);
    const fixed = await attempt(broadcastRtmpsArguments(target)); assert.equal(fixed.blocked, false); assert.equal(fixed.connected, true); assert.ok(fixed.handshakeBytes >= 1537);
  } finally { for (const socket of sockets) socket.destroy(); await new Promise<void>(resolve => server.close(() => resolve())); await fs.rm(dir, { recursive: true, force: true }); }
});

test('diagnostics become only bounded finite codes, including patterns split across secret-bearing chunks', () => {
  const cases = [ ['protocol', "Protocol 'tls' not on whitelist 'pipe'"], ['certificate', 'certificate verify failed'], ['publish-rejected', 'NetStream.Publish.BadName'], ['network', 'Cannot read RTMP handshake response'], ['encoder', 'cannot create compression session'], ['input', 'Invalid data found'], ['storage', 'No space left on device'] ] as const;
  for (const [code, message] of cases) {
    const classifier = createBroadcastFailureClassifier(), text = `rtmps://fixture.test/live/private-key?private-query=123 ${message} remote-secret-body`;
    for (let offset = 0; offset < text.length; offset += 3) classifier.push(text.slice(offset, offset + 3));
    assert.equal(classifier.code(), code); assert.doesNotMatch(JSON.stringify(classifier), /private-key|private-query|remote-secret-body/);
    assert.doesNotMatch(broadcastFailureMessage(code), /rtmps|private-key|private-query|\bbroadcast\b/i);
  }
  assert.equal(broadcastFailureCanRetry('network', 4), true); assert.equal(broadcastFailureCanRetry('network', 5), false); assert.equal(broadcastFailureCanRetry('publish-rejected', 1), false);
});

test('hardware selection requires a real probe and never enables implicit software VideoToolbox fallback', { timeout: 8000 }, async () => {
  const encoder = await selectBroadcastEncoder('720p'); assert.ok(['software', 'videotoolbox'].includes(encoder));
  const args = broadcastEncoderArguments('720p', encoder);
  assert.equal(args[args.indexOf('-c:v') + 1], encoder === 'videotoolbox' ? 'h264_videotoolbox' : 'libx264');
  if (encoder === 'videotoolbox') assert.equal(args[args.indexOf('-allow_sw') + 1], '0');
});

test('confirmed publish rejection stops only an unusable broadcast and exposes no credentials', { timeout: 10_000 }, async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'lumen-broadcast-rejection-')), keys = 'fixture-private-key?private-query=secret'; let captureStopped = '';
  const service = await createBroadcast({ dir, onFatal: id => { captureStopped = id; },
    spawn(file, args, options) {
      if (args.includes('-rtmp_tcurl')) return spawn(process.execPath, ['-e', `process.stderr.write('NetStream.Publish.BadName rtmps://fixture.invalid/${keys}'); process.exit(1);`], options);
      return spawn(file, args, options);
    } });
  try {
    await service.configure({ destinations: [{ id: 'youtube', enabled: true, streamKey: keys }] }); const session = await service.start();
    const deadline = Date.now() + 4000; while (Date.now() < deadline && !service.snapshot().session?.stoppedAt) await new Promise(resolve => setTimeout(resolve, 20));
    const snapshot = service.snapshot(); assert.equal(snapshot.session?.state, 'error'); assert.equal(captureStopped, session.id);
    const destination = snapshot.session?.destinations.find(d => d.id === 'youtube')!; assert.match(destination.error ?? '', /platform rejected publishing/i); assert.equal(destination.retries, 0);
    assert.match(snapshot.session?.error ?? '', /stopped to save resources/); assert.doesNotMatch(JSON.stringify(snapshot), /fixture-private-key|private-query|remote-secret-body/);
  } finally { await service.close(); await fs.rm(dir, { recursive: true, force: true }); }
});

test('one rejected destination never terminates another still-connected destination', { timeout: 10_000 }, async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'lumen-broadcast-sink-isolation-')); let fatal = 0;
  const service = await createBroadcast({ dir, onFatal: () => { fatal++; },
    spawn(_file, args, options) {
      const rejected = args.includes('-rtmp_tcurl') && args[args.indexOf('-rtmp_tcurl') + 1]?.includes('youtube.com');
      return spawn(process.execPath, ['-e', rejected ? "process.stderr.write('NetStream.Publish.Rejected');process.exit(1)" : "process.stdin.resume();process.stdin.on('end',()=>process.exit(0))"], options);
    } });
  try {
    await service.configure({ destinations: [{ id: 'youtube', enabled: true, streamKey: 'fixture-youtube' }, { id: 'facebook', enabled: true, streamKey: 'fixture-facebook' }] }); await service.start();
    const deadline = Date.now() + 3000; while (Date.now() < deadline && service.snapshot().session?.destinations.find(d => d.id === 'youtube')?.state !== 'error') await new Promise(resolve => setTimeout(resolve, 20));
    assert.equal(service.snapshot().session?.destinations.find(d => d.id === 'youtube')?.state, 'error');
    assert.equal(service.snapshot().session?.destinations.find(d => d.id === 'facebook')?.state, 'connecting'); assert.equal(fatal, 0); assert.equal(service.snapshot().session?.state, 'starting');
    await service.retryDestination('youtube'); await new Promise(resolve => setTimeout(resolve, 100)); assert.equal(fatal, 0);
  } finally { await service.close(); await fs.rm(dir, { recursive: true, force: true }); }
});

test('repeated first-frame connection drops cannot reset the finite retry budget forever', { timeout: 23_000 }, async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'lumen-broadcast-flapping-')); let attempts = 0, fatal = 0;
  const service = await createBroadcast({ dir, onFatal: () => { fatal++; }, spawn(_file, args, options) {
    const sink = args.includes('-rtmp_tcurl'); if (sink) attempts++;
    return spawn(process.execPath, ['-e', sink ? "require('node:fs').writeSync(3,'out_time_us=1000\\nprogress=continue\\n');setTimeout(()=>{process.stderr.write('Connection reset');process.exit(1)},40);process.stdin.resume()" : "process.stdin.resume();process.stdin.on('end',()=>process.exit(0))"], options);
  } });
  try {
    await service.configure({ destinations: [{ id: 'youtube', enabled: true, streamKey: 'fixture-not-a-real-key' }] }); await service.start();
    const deadline = Date.now() + 20_000;
    while (Date.now() < deadline && !service.snapshot().session?.stoppedAt) await new Promise(resolve => setTimeout(resolve, 25));
    const session = service.snapshot().session!; assert.equal(session.state, 'error'); assert.equal(attempts, 5); assert.equal(fatal, 1);
    const sink = session.destinations.find(value => value.id === 'youtube')!; assert.equal(sink.retries, 4); assert.match(sink.error ?? '', /Automatic retries paused/);
  } finally { await service.close(); await fs.rm(dir, { recursive: true, force: true }); }
});
