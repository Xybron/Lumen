import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { broadcastDestinationUrl, createBroadcast } from '../src/broadcast.js';
import { normalizeInstagramStreamUrl } from '../src/broadcast-destinations.js';
import { openBroadcastRtmpsTransport } from '../src/broadcast-rtmps.js';
import { broadcastRtmpBridgeArguments } from '../src/broadcast-process.js';

const instagramUrl = 'rtmps://edgetee-upload-los4-1.xx.fbcdn.net:443/rtmp/';
const key = 'fixture-instagram-key?s_bl=1&s_fbp=lhr11-1&s_ow=10&s_prp=';

test('Instagram accepts Live Producer ingest hosts and preserves opaque query-bearing keys through the bridge', async () => {
  for (const host of ['live-upload.instagram.com', 'edgetee-upload-los4-1.xx.fbcdn.net', 'edge-upload-lhr8-2.xx.fbcdn.net']) {
    const url = `rtmps://${host}:443/rtmp/`;
    assert.equal(normalizeInstagramStreamUrl(`  rtmps://${host}/rtmp  `), url);
    assert.equal(normalizeInstagramStreamUrl(`${url}\n`), url);
    assert.equal(broadcastDestinationUrl('instagram', key, url), url + key);
    const bridge = await openBroadcastRtmpsTransport(url + key);
    try {
      assert.equal(bridge.tcUrl, `rtmps://${host}:443/rtmp`);
      const local = new URL(bridge.url);
      assert.equal(local.pathname + local.search, '/rtmp/' + key);
      const args = broadcastRtmpBridgeArguments(bridge.url, bridge.tcUrl);
      assert.equal(args.at(-1), bridge.url);
      assert.equal(args[args.indexOf('-rtmp_tcurl') + 1], bridge.tcUrl);
    } finally { await bridge.close(); }
  }
});

test('Instagram URL input cannot select an arbitrary host, protocol, port, path or credential-bearing URL', async () => {
  const invalid = ['http://127.0.0.1/rtmp/', 'rtmp://live-upload.instagram.com/rtmp/',
    'rtmps://127.0.0.1/rtmp/', 'rtmps://[::1]/rtmp/', 'rtmps://example.com/rtmp/',
    'rtmps://live-upload.instagram.com.evil.test/rtmp/', 'rtmps://evilinstagram.com/rtmp/',
    'rtmps://edgetee-upload-los4-1.xx.fbcdn.net.evil.test/rtmp/', 'rtmps://arbitrary.fbcdn.net/rtmp/',
    'rtmps://live-upload.instagram.com:444/rtmp/', 'rtmps://user:secret@live-upload.instagram.com/rtmp/',
    `${instagramUrl}${key}`, `${instagramUrl}?key=secret`, `${instagramUrl}#secret`,
    'rtmps://live-upload.instagram.com/wrong/', 'rtmps://live-upload.instagram.com/rtmp/../private',
    'rtmps://live-upload.instagram.com\\@example.com/rtmp/'];
  for (const url of invalid) {
    assert.throws(() => normalizeInstagramStreamUrl(url), /Stream URL/);
    assert.throws(() => broadcastDestinationUrl('instagram', key, url), { status: 422 });
  }
  for (const url of invalid.slice(0, 11)) {
    await assert.rejects(openBroadcastRtmpsTransport(url + 'fixture-key'));
    assert.throws(() => broadcastRtmpBridgeArguments('rtmp://127.0.0.1:1234/rtmp/key', url));
  }
  for (const invalidKey of ['../elsewhere', '%2e%2e/private', '#secret', 'rtmps://example.com/rtmp/key', 'key\\private']) {
    assert.throws(() => broadcastDestinationUrl('instagram', invalidKey, instagramUrl), { status: 422 });
  }
});

test('existing settings migrate without losing keys, and Instagram URL/key lifecycle survives restart privately', async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'lumen-instagram-config-'));
  const file = path.join(dir, 'broadcast-private.json');
  const legacy = JSON.stringify({ version: 1, profile: '1080p', recordOnStart: false,
    destinations: [{ id: 'youtube', enabled: true, key: 'fixture-old-youtube' }, { id: 'facebook', enabled: true, key: 'fixture-old-facebook' }], watch: { enabled: false } });
  await fs.writeFile(file, legacy);
  let service = await createBroadcast({ dir });
  try {
    const initial = service.snapshot();
    assert.equal(initial.config.profile, '1080p'); assert.equal(initial.config.recordOnStart, false);
    assert.equal(initial.config.destinations.length, 3);
    assert.ok(initial.config.destinations.slice(0, 2).every(d => d.enabled && d.configured));
    assert.deepEqual(initial.config.destinations[2], { id: 'instagram', enabled: false, configured: false, streamUrl: '', hasKey: false });
    assert.equal(await fs.readFile(file, 'utf8'), legacy, 'Reading migrates in memory without overwriting the saved setup.');
    await service.configure({ destinations: [{ id: 'instagram', enabled: true, streamKey: key }] });
    assert.equal(service.preflight().ready, false);
    await assert.rejects(service.start(), { status: 409 });
    await service.configure({ destinations: [{ id: 'instagram', enabled: true, streamUrl: instagramUrl }] });
    assert.equal(service.preflight().ready, true);
    assert.equal(service.preflight().estimatedUploadKbps, Math.ceil(4660 * 3 * 1.15));
    const saved = JSON.parse(await fs.readFile(file, 'utf8'));
    assert.equal(saved.version, 2); assert.deepEqual(saved.destinations.slice(0, 2), JSON.parse(legacy).destinations);
    assert.equal((await fs.stat(file)).mode & 0o777, 0o600);
    await service.close(); service = await createBroadcast({ dir });
    assert.deepEqual(service.snapshot().config.destinations[2], { id: 'instagram', enabled: true, configured: true, streamUrl: instagramUrl, hasKey: true });
    assert.doesNotMatch(JSON.stringify(service.snapshot()), /fixture-old|fixture-instagram-key|s_fbp|s_bl/);
    await assert.rejects(service.configure({ destinations: [{ id: 'instagram', enabled: true, streamUrl: instagramUrl + key }] }),
      { status: 422, message: 'Enter the secure Stream URL from Instagram Live Producer, without the stream key.' });
    for (const input of [
      { destinations: [{ id: 'instagram', enabled: true, streamUrl: 'rtmps://127.0.0.1/rtmp/' }] },
      { destinations: [{ id: 'youtube', enabled: true, streamUrl: instagramUrl }] },
      { destinations: [{ id: 'instagram', enabled: true }, { id: 'instagram', enabled: false }] },
      { destinations: [{ id: 'instagram', enabled: true, clearKey: true, streamKey: key }] },
    ]) {
      const before = await fs.readFile(file);
      await assert.rejects(service.configure(input as never), { status: 422 });
      assert.deepEqual(await fs.readFile(file), before);
    }
    await service.configure({ destinations: [{ id: 'instagram', enabled: true, streamUrl: '' }] });
    assert.equal(service.preflight().ready, false); assert.equal(service.snapshot().config.destinations[2].hasKey, true);
    await service.configure({ destinations: [{ id: 'instagram', enabled: true, streamUrl: instagramUrl, clearKey: true }] });
    assert.equal(service.preflight().ready, false); assert.equal(service.snapshot().config.destinations[2].hasKey, false);
    assert.doesNotMatch(await fs.readFile(file, 'utf8'), /fixture-instagram-key/);
    await service.configure({ destinations: [{ id: 'instagram', enabled: false }] });
    assert.equal(service.preflight().ready, true, 'Unconfigured Instagram does not block other destinations when disabled.');
  } finally { await service.close(); await fs.rm(dir, { recursive: true, force: true }); }
});
