import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { randomBytes } from 'node:crypto';
import { spawn } from 'node:child_process';
import { createBroadcast } from '../src/broadcast.js';
import { createBroadcastRelay } from '../src/broadcast-relay.js';
import { runClipMedia } from '../src/clip-media.js';

test('real Watch relay can Stop/Retry and recover its persisted epoch fence after relay restart', { timeout: 60_000 }, async t => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'lumen-broadcast-relay-integration-')), source = path.join(directory, 'fixture.webm');
  // The actual independent public relay is intentionally loopback-only here.
  const { createWatchRelay } = await import('../../watch-relay/server.mjs');
  const token = randomBytes(48).toString('hex'), relayDirectory = path.join(directory, 'relay');
  let relay = await createWatchRelay({ dataDir: relayDirectory, pushToken: token, allowedSlugs: ['service'] });
  await new Promise<void>(resolve => relay.server.listen(0, '127.0.0.1', resolve));
  const address = relay.server.address(); assert.ok(address && typeof address !== 'string'); const port = address.port;
  const baseUrl = `http://127.0.0.1:${port}`, adapter = createBroadcastRelay({ baseUrl, token, slug: 'service', allowLocalhostForTests: true, timeoutMs: 1500 });
  let encoderStarts = 0;
  const service = await createBroadcast({ dir: path.join(directory, 'station'), watchRelay: adapter,
    spawn(file, args, options) { if (args.at(-1) === 'pipe:1') encoderStarts++; return spawn(file, args, options); } });
  t.after(async () => { await service.close(); await relay.close(); await fs.rm(directory, { recursive: true, force: true }); });
  await runClipMedia(['-hide_banner', '-nostdin', '-y', '-f', 'lavfi', '-i', 'color=c=blue:s=160x90:r=30:d=30', '-f', 'lavfi', '-i', 'sine=f=440:r=48000:d=30', '-c:v', 'libvpx', '-deadline', 'realtime', '-threads', '1', '-c:a', 'libopus', source], 15_000).result;
  await service.configure({ watch: { enabled: true } }); const session = await service.start(), bytes = await fs.readFile(source);
  const third = Math.ceil(bytes.length / 3 / 4096) * 4096; let sequence = 0;
  const feed = async (from: number, until: number) => {
    for (let at = from; at < Math.min(until, bytes.length); at += 4096) { await service.chunk(session.id, sequence++, bytes.subarray(at, at + 4096)); await new Promise(resolve => setTimeout(resolve, 60)); }
  };
  const publicLive = async (previous?: string) => {
    const deadline = Date.now() + 16_000;
    while (Date.now() < deadline) {
      const response = await fetch(`${baseUrl}/api/watch/service`), state = await response.json();
      if (state.status === 'live' && state.playlistUrl && state.playlistUrl !== previous) {
        const playlist = await fetch(`${baseUrl}${state.playlistUrl}`); assert.equal(playlist.status, 200); assert.match(await playlist.text(), /#EXTINF:/); return state.playlistUrl as string;
      }
      await new Promise(resolve => setTimeout(resolve, 30));
    }
    throw new Error(`Real relay did not become Live: ${JSON.stringify(service.snapshot().session?.watch)}`);
  };
  await feed(0, third); const first = await publicLive();
  // Two controllers may issue Stop then Retry before the first network finish
  // resolves. The shared lock must end the old epoch before creating a new one.
  const stopping = service.stopDestination('watch'), retrying = service.retryDestination('watch');
  assert.equal((await stopping).session?.watch.state, 'stopped'); await retrying;
  await feed(third, third * 2); const second = await publicLive(first); assert.notEqual(second, first);
  assert.equal((await fetch(`${baseUrl}${first}`)).status, 410);
  const beforeRestart = JSON.parse(await fs.readFile(path.join(relayDirectory, 'service', 'session.json'), 'utf8')); assert.equal(new Set(beforeRestart.epochs).size, 2);
  // Restart is Offline and retains fenced epochs. The existing station adapter
  // initially still has its old session; publish409 -> begin409 -> fresh epoch
  // must recover without a new encoder or a manual new broadcast.
  await relay.close(); relay = await createWatchRelay({ dataDir: relayDirectory, pushToken: token, allowedSlugs: ['service'] });
  await new Promise<void>(resolve => relay.server.listen(port, '127.0.0.1', resolve));
  assert.equal((await (await fetch(`${baseUrl}/api/watch/service`)).json()).status, 'offline');
  await feed(third * 2, bytes.length); const recovered = await publicLive(second); assert.notEqual(recovered, second);
  const afterRestart = JSON.parse(await fs.readFile(path.join(relayDirectory, 'service', 'session.json'), 'utf8')); assert.equal(new Set(afterRestart.epochs).size, 3); assert.equal(encoderStarts, 1);
  assert.equal(service.snapshot().session?.watch.state, 'live'); assert.equal(service.snapshot().session?.id, session.id);
  await service.stop(); assert.equal((await (await fetch(`${baseUrl}/api/watch/service`)).json()).status, 'offline');
});
