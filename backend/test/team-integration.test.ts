import test from 'node:test';
import assert from 'node:assert/strict';
import { teamConfiguration } from '../src/team-config.js';
import { teamEnvironment } from '../../scripts/dev-team.mjs';
import { overlayPending, validateDraft, type TeamResource } from '../../frontend/src/lib/team/model.js';

test('team integration is opt-in and exposes only public LAB client configuration', () => {
  assert.deepEqual(teamConfiguration({}), { enabled: false });
  const config = teamConfiguration({ LUMEN_TEAM_LOCAL_TEST: 'true' });
  assert.equal(config.enabled, true);
  assert.ok(config.enabled && config.publishableKey.startsWith('sb_publishable_'));
  assert.throws(() => teamConfiguration({ LUMEN_TEAM_LOCAL_TEST: 'true', NODE_ENV: 'production' }), /not a production/);
  assert.throws(() => teamConfiguration({ LUMEN_TEAM_LOCAL_TEST: 'true', LUMEN_TEAM_SUPABASE_URL: 'https://attacker.example' }), /requires LAB/);
  for (const url of ['https://sync.example', 'http://localhost:8189', 'http://user:password@127.0.0.1:8189', 'http://127.0.0.1:8189?secret=x']) {
    assert.throws(() => teamConfiguration({ LUMEN_TEAM_LOCAL_TEST: 'true', LUMEN_TEAM_POWERSYNC_URL: url }), /loopback/);
  }
  assert.throws(() => teamConfiguration({ LUMEN_TEAM_LOCAL_TEST: 'true', LUMEN_TEAM_PUBLISHABLE_KEY: 'sb_secret_never_a_client_key' }), /publishable/);
});

test('team launcher cannot inherit real station files, saved keys, audio or remote bridges', () => {
  const env = teamEnvironment({ LUMEN_DATA_DIR: '/real-station', LUMEN_VPS_URL: 'https://prod.example', LUMEN_WATCH_RELAY_TOKEN: 'saved-key', LUMEN_TEAM_SUPABASE_URL: 'http://bad.example', VITE_SECRET: 'not-public', SUPABASE_SERVICE_ROLE_KEY: 'private', POWERSYNC_PASSWORD: 'private', PATH: '/usr/bin' });
  assert.ok(env.LUMEN_DATA_DIR.endsWith('/Lumen/.team-local/station'));
  for (const key of ['LUMEN_VPS_URL', 'LUMEN_WATCH_RELAY_TOKEN', 'VITE_SECRET', 'SUPABASE_SERVICE_ROLE_KEY', 'POWERSYNC_PASSWORD']) assert.equal((env as Record<string, string>)[key], undefined);
  assert.equal(env.HOST, '127.0.0.1'); assert.equal(env.PORT, '3300'); assert.equal(env.PATH, '/usr/bin');
  assert.throws(() => teamEnvironment({ NODE_ENV: 'production' }), /local development/);
});

test('only preparation drafts enter the offline queue, never live commands or credentials', () => {
  validateDraft({ schemaVersion: 1, background: '#151619', layers: [{ kind: 'text', text: 'Welcome', x: 10 }] });
  for (const key of ['program', 'previewSceneId', 'programSceneId', 'mainAudioSourceId', 'masterMuted', 'masterVolume', 'sourceId', 'audio', 'streamKey', 'password', 'token', 'secret', 'deviceId', 'command', 'credentials', 'src', 'url']) {
    assert.throws(() => validateDraft({ schemaVersion: 1, items: [{ [key]: 'must-not-leave-station' }] }), /station-only/);
  }
  assert.throws(() => validateDraft({ items: [] }), /schemaVersion/);
  assert.throws(() => validateDraft({ schemaVersion: 1, body: 'x'.repeat(250001) }), /250 KB/);
});

test('a remote checkpoint never erases a queued offline edit; latest local version wins only in local UI', () => {
  const remote: TeamResource = { id: 'a', team_id: 't', kind: 'scene', name: 'Server', document: { schemaVersion: 1 }, revision: 5, updated_at: 'now' };
  const local = { ...remote, name: 'Offline revision', revision: 2 };
  const next = { ...local, name: 'Latest offline edit', revision: 3 };
  assert.deepEqual(overlayPending([remote], [{ resource_id: 'a', value: JSON.stringify(local) }, { resource_id: 'a', value: JSON.stringify(next) }]), [next]);
  assert.equal(remote.name, 'Server');
});
