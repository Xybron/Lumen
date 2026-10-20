import test from 'node:test';
import assert from 'node:assert/strict';
import { createLocalJWKSet, exportJWK, generateKeyPair, SignJWT } from 'jose';
import { createWorker, readConfig } from '../src/index.js';

const env = {
  DEPLOYMENT_ENV: 'staging',
  SUPABASE_URL: 'https://lab.example',
  ALLOWED_ORIGINS: 'http://127.0.0.1:5173,https://operators.example',
};
const issuer = `${env.SUPABASE_URL}/auth/v1`;
const userId = '00000000-0000-4000-8000-000000000001';
const sessionId = '00000000-0000-4000-8000-000000000002';
const { publicKey, privateKey } = await generateKeyPair('ES256');
const jwk = { ...await exportJWK(publicKey), kid: 'test-key', alg: 'ES256', use: 'sig' };
const worker = createWorker({ getKeySet: () => createLocalJWKSet({ keys: [jwk] }) });
const request = (path = '/api/session', init = {}, bindings = env, implementation = worker) =>
  implementation.fetch(new Request(`https://edge.example${path}`, init), bindings);

async function token(claims = {}, signingKey = privateKey, header = {}) {
  return new SignJWT({ role: 'authenticated', session_id: sessionId, is_anonymous: false, ...claims })
    .setProtectedHeader({ alg: 'ES256', kid: 'test-key', ...header })
    .setIssuer(issuer).setAudience('authenticated').setSubject(userId)
    .setIssuedAt().setExpirationTime('5m').sign(signingKey);
}

test('liveness is small, uncached and honest about unavailable features', async () => {
  const res = await request('/healthz');
  assert.equal(res.status, 200);
  assert.equal(res.headers.get('cache-control'), 'no-store');
  assert.equal(res.headers.get('x-content-type-options'), 'nosniff');
  assert.deepEqual(await res.json(), { service: 'lumen-cloud', environment: 'staging', status: 'ok',
    capabilities: { identity: true, collaboration: false, sync: false, productionControl: false } });
});

test('unconfigured cloud fails closed without exposing environment values', async () => {
  const res = await request('/healthz', {}, { ...env, SUPABASE_URL: 'http://secret@localhost:3000' });
  assert.equal(res.status, 503);
  assert.deepEqual(await res.json(), { error: 'cloud_not_configured' });
});

test('configuration requires exact origins and HTTPS except staging loopback', () => {
  for (const origin of ['*', 'https://a.example/', 'https://a.example/path', 'null', 'http://lan.example']) {
    assert.throws(() => readConfig({ ...env, ALLOWED_ORIGINS: origin }));
  }
  assert.throws(() => readConfig({ ...env, DEPLOYMENT_ENV: 'production' }));
  assert.throws(() => readConfig({ ...env, SUPABASE_URL: 'https://lab.example/a' }));
  assert.throws(() => readConfig({ ...env, SUPABASE_URL: 'https://user:password@lab.example' }));
  assert.equal(readConfig(env).issuer, issuer);
});

test('no station, streaming, media, refresh or database proxy endpoints exist', async () => {
  for (const path of ['/api/production/take', '/api/content', '/api/broadcast/start', '/api/sync',
    '/rest/v1/users', '/auth/v1/token', '/ws', '/data/production.json']) {
    assert.equal((await request(path, { method: 'POST' })).status, 404, path);
  }
  const res = await request('/healthz', { method: 'PUT' });
  assert.equal(res.status, 405);
  assert.equal(res.headers.get('allow'), 'GET, HEAD, OPTIONS');
});

test('exact-origin CORS and restricted preflight, with no credential cookies', async () => {
  const origin = 'https://operators.example';
  const res = await request('/healthz', { headers: { Origin: origin } });
  assert.equal(res.headers.get('access-control-allow-origin'), origin);
  assert.equal(res.headers.get('access-control-allow-credentials'), null);
  assert.equal(res.headers.get('vary'), 'Origin');
  const allowed = await request('/api/session', { method: 'OPTIONS', headers: { Origin: origin,
    'Access-Control-Request-Method': 'GET', 'Access-Control-Request-Headers': 'authorization' } });
  assert.equal(allowed.status, 204);
  for (const headers of [
    { Origin: 'https://operators.example.attacker.test' },
    { Origin: 'null' },
  ]) assert.equal((await request('/healthz', { headers })).status, 403);
  for (const extra of [
    { 'Access-Control-Request-Method': 'POST' },
    { 'Access-Control-Request-Headers': 'Authorization, X-Admin' },
  ]) assert.equal((await request('/api/session', { method: 'OPTIONS', headers: { Origin: origin,
    'Access-Control-Request-Method': 'GET', ...extra } })).status, 403);
});

test('missing, query-string, cookie and malformed credentials never authenticate', async () => {
  for (const init of [{}, { headers: { Cookie: 'token=some-token' } },
    { headers: { Authorization: 'Bearer forged.invalid.signature' } },
    { headers: { Authorization: `Bearer ${'a'.repeat(8200)}.x.y` } }]) {
    const res = await request('/api/session', init);
    assert.equal(res.status, 401);
    assert.deepEqual(await res.json(), { error: 'unauthorized' });
  }
  assert.equal((await request(`/api/session?token=${await token()}`)).status, 401);
});

test('signed user token returns only identity, not user metadata or roles', async () => {
  const jwt = await token({ user_metadata: { role: 'admin', team_id: 'attacker' }, email: 'private@example.test' });
  const res = await request('/api/session', { headers: { Authorization: `Bearer ${jwt}` } });
  assert.equal(res.status, 200);
  assert.equal(res.headers.get('www-authenticate'), null);
  assert.deepEqual(await res.json(), { user: { id: userId }, environment: 'staging' });
});

test('signed anonymous, service, malformed and future-issued identities fail', async () => {
  for (const claims of [
    { role: 'service_role' }, { role: 'anon' }, { is_anonymous: true }, { session_id: 'invalid' },
    { session_id: undefined },
  ]) {
    const jwt = await token(claims);
    assert.equal((await request('/api/session', { headers: { Authorization: `Bearer ${jwt}` } })).status, 401);
  }
  const future = await new SignJWT({ role: 'authenticated', session_id: sessionId })
    .setProtectedHeader({ alg: 'ES256', kid: 'test-key' }).setIssuer(issuer).setAudience('authenticated')
    .setSubject(userId).setIssuedAt(Math.floor(Date.now() / 1000) + 1000).setExpirationTime('1h').sign(privateKey);
  assert.equal((await request('/api/session', { headers: { Authorization: `Bearer ${future}` } })).status, 401);
});

test('expired, wrong-project, wrong-audience, missing-expiry and forged signatures fail', async () => {
  const { privateKey: wrongKey } = await generateKeyPair('ES256');
  for (const [iss, aud, expiry, key] of [
    [issuer, 'authenticated', -100, privateKey],
    ['https://another.example/auth/v1', 'authenticated', '5m', privateKey],
    [issuer, 'service_role', '5m', privateKey],
    [issuer, 'authenticated', undefined, privateKey],
    [issuer, 'authenticated', '5m', wrongKey],
  ]) {
    let builder = new SignJWT({ role: 'authenticated', session_id: sessionId })
      .setProtectedHeader({ alg: 'ES256', kid: 'test-key' }).setIssuer(iss).setAudience(aud)
      .setSubject(userId).setIssuedAt();
    if (expiry !== undefined) builder = builder.setExpirationTime(expiry);
    const jwt = await builder.sign(key);
    assert.equal((await request('/api/session', { headers: { Authorization: `Bearer ${jwt}` } })).status, 401);
  }
});

test('symmetric API keys cannot substitute for a signed user session', async () => {
  const jwt = await new SignJWT({ role: 'authenticated', session_id: sessionId })
    .setProtectedHeader({ alg: 'HS256' }).setIssuer(issuer).setAudience('authenticated')
    .setSubject(userId).setIssuedAt().setExpirationTime('5m').sign(new Uint8Array(32));
  assert.equal((await request('/api/session', { headers: { Authorization: `Bearer ${jwt}` } })).status, 401);
});

test('key-service failure is bounded and does not leak tokens or upstream errors', async () => {
  const unavailable = createWorker({ getKeySet: () => { throw new Error('secret upstream detail'); } });
  const res = await request('/api/session', { headers: { Authorization: `Bearer ${await token()}` } }, env, unavailable);
  assert.equal(res.status, 503);
  assert.deepEqual(await res.json(), { error: 'identity_unavailable' });
});

test('HEAD returns no body and still enforces authentication', async () => {
  const res = await request('/healthz', { method: 'HEAD' });
  assert.equal(res.status, 200);
  assert.equal(await res.text(), '');
  assert.equal((await request('/api/session', { method: 'HEAD' })).status, 401);
});
