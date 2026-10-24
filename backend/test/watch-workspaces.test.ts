import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { randomBytes } from 'node:crypto';
import { createBroadcastRelay, createProtectedOutputRelay, createWatchRelayFromEnv, probeProtectedOutput } from '../src/broadcast-relay.js';
import { createExternalOutput } from '../src/output-external.js';

const a = '11111111-1111-4111-8111-111111111111', b = '22222222-2222-4222-8222-222222222222';
const token = () => randomBytes(48).toString('hex');
const manifest = '#EXTM3U\n#EXT-X-TARGETDURATION:2\n#EXT-X-MEDIA-SEQUENCE:0\n#EXTINF:2.000000,\nsegment-00000000.ts\n';

test('server-provisioned workspace identity scopes Watch and protected Program links, never display names', () => {
  const base = { LUMEN_WATCH_RELAY_URL: 'https://watch.example.com', LUMEN_WATCH_RELAY_SLUG: 'live', LUMEN_WATCH_RELAY_TOKEN: token() };
  assert.equal(createWatchRelayFromEnv(base).publicUrl, 'https://watch.example.com/watch/live', 'Explicit standalone legacy mode remains compatible.');
  assert.equal(createWatchRelayFromEnv({ ...base, LUMEN_WORKSPACE_ID: a }).publicUrl, `https://watch.example.com/watch/${a}/live`);
  assert.notEqual(createWatchRelayFromEnv({ ...base, LUMEN_WORKSPACE_ID: a }).publicUrl, createWatchRelayFromEnv({ ...base, LUMEN_WORKSPACE_ID: b }).publicUrl);
  for (const id of ['Grace Media Team', '../other', '', `${a}/../${b}`, a.toUpperCase().replace('1', 'A')]) {
    const relay = createWatchRelayFromEnv({ ...base, LUMEN_WORKSPACE_ID: id });
    assert.equal(relay.configured, false, 'An invalid workspace cannot downgrade into an unscoped Watch publisher.');
    assert.throws(() => createBroadcastRelay({ baseUrl: base.LUMEN_WATCH_RELAY_URL, token: base.LUMEN_WATCH_RELAY_TOKEN, slug: 'live', workspaceId: id }));
  }
});

test('two real relay workspaces publish the same stream names without crossing media, credentials or private-link verification', async t => {
  const { createWatchRelay } = await import('../../watch-relay/server.mjs');
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'lumen-watch-workspaces-'));
  const tenants = [a, b].map(workspaceId => ({ workspaceId, pushToken: token(), viewerToken: token(), allowedSlugs: ['live', 'program'], privateSlugs: ['program'] }));
  const relay = await createWatchRelay({ dataDir: path.join(directory, 'relay'), tenants, allowInsecureLocalhostForTests: true });
  await new Promise<void>(resolve => relay.server.listen(0, '127.0.0.1', resolve));
  const address = relay.server.address(); assert.ok(address && typeof address === 'object');
  const baseUrl = `http://127.0.0.1:${address.port}`;
  t.after(async () => { await relay.close(); await fs.rm(directory, { recursive: true, force: true }); });
  const adapters = [];
  for (const tenant of tenants) {
    const folder = path.join(directory, tenant.workspaceId); await fs.mkdir(folder);
    await fs.writeFile(path.join(folder, 'index.m3u8'), manifest);
    await fs.writeFile(path.join(folder, 'segment-00000000.ts'), `generated-${tenant.workspaceId}`);
    const options = { baseUrl, workspaceId: tenant.workspaceId, token: tenant.pushToken, allowLocalhostForTests: true, timeoutMs: 1000 };
    const adapter = createBroadcastRelay({ ...options, slug: 'live' });
    assert.equal(adapter.publicUrl, `${baseUrl}/watch/${tenant.workspaceId}/live`);
    await adapter.begin({ epoch: 'same-epoch-per-workspace-0001' });
    await adapter.publish({ directory: folder, playlist: 'index.m3u8' }); adapters.push(adapter);
    const status = await (await fetch(`${baseUrl}/api/watch/${tenant.workspaceId}/live`)).json();
    assert.equal(status.status, 'live'); assert.match(status.playlistUrl, new RegExp(`^/hls/${tenant.workspaceId}/live/`));
    const media = new URL('segment-00000000.ts', `${baseUrl}${status.playlistUrl}`);
    assert.equal(await (await fetch(media)).text(), `generated-${tenant.workspaceId}`);
    const protectedOptions = { ...options, slug: 'program', viewerToken: tenant.viewerToken };
    const privateAdapter = createProtectedOutputRelay(protectedOptions);
    await privateAdapter.begin({ epoch: 'same-private-epoch-0001' });
    await privateAdapter.publish({ directory: folder, playlist: 'index.m3u8' });
    const info = await probeProtectedOutput(protectedOptions);
    assert.equal(info.workspaceId, tenant.workspaceId); assert.equal(info.watchUrl, `/output/${tenant.workspaceId}/program`);
    const external = createExternalOutput({ LUMEN_WORKSPACE_ID: tenant.workspaceId, LUMEN_OUTPUT_RELAY_URL: baseUrl, LUMEN_OUTPUT_RELAY_TOKEN: tenant.pushToken, LUMEN_OUTPUT_VIEWER_TOKEN: tenant.viewerToken }, { allowLocalhostForTests: true });
    const verified = await external.verify(); assert.equal(verified.verified, true);
    assert.equal(new URL(verified.url!).pathname, `/output/${tenant.workspaceId}/program`);
  }
  await assert.rejects(createBroadcastRelay({ baseUrl, workspaceId: b, token: tenants[0].pushToken, slug: 'live', allowLocalhostForTests: true }).begin({ epoch: 'cross-tenant-forgery-0001' }), /rejected/);
  const wrongViewer = createExternalOutput({ LUMEN_WORKSPACE_ID: b, LUMEN_OUTPUT_RELAY_URL: baseUrl, LUMEN_OUTPUT_RELAY_TOKEN: tenants[0].pushToken, LUMEN_OUTPUT_VIEWER_TOKEN: tenants[0].viewerToken }, { allowLocalhostForTests: true });
  assert.equal((await wrongViewer.verify()).url, null);
  assert.equal((await fetch(`${baseUrl}/api/watch/live`)).status, 404, 'Tenant mode has no legacy unscoped feed.');
  await adapters[0].finish();
  assert.equal((await (await fetch(`${baseUrl}/api/watch/${a}/live`)).json()).status, 'offline');
  assert.equal((await (await fetch(`${baseUrl}/api/watch/${b}/live`)).json()).status, 'live', 'Ending A cannot stop B.');
});
