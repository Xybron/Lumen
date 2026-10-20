const target = process.argv[2];
if (!target) throw new Error('Usage: npm --prefix cloud run probe -- https://<staging-worker>.workers.dev');
const origin = new URL(target);
if (origin.username || origin.password || origin.search || origin.hash || origin.pathname !== '/' ||
    (origin.protocol !== 'https:' && !(origin.protocol === 'http:' && ['localhost', '127.0.0.1'].includes(origin.hostname)))) {
  throw new Error('Use an HTTPS origin or a local loopback HTTP origin without credentials.');
}
const tests = [
  ['/healthz', {}, 200, 'ok'],
  ['/api/session', {}, 401, 'unauthorized'],
  ['/api/session', { headers: { Authorization: 'Bearer fake.invalid.signature' } }, 401, 'unauthorized'],
  ['/api/production/take', { method: 'POST' }, 404, 'not_found'],
  ['/healthz', { headers: { Origin: 'https://untrusted.example' } }, 403, 'origin_not_allowed'],
];
for (const [path, init, expectedStatus, expectedValue] of tests) {
  const response = await fetch(new URL(path, origin), { ...init, redirect: 'error', signal: AbortSignal.timeout(12000) });
  const body = await response.json();
  if (response.status !== expectedStatus || (body.status ?? body.error) !== expectedValue ||
      response.headers.get('cache-control') !== 'no-store') {
    throw new Error(`Probe failed: ${path} returned ${response.status}`);
  }
  console.log(`PASS ${init.method ?? 'GET'} ${path} → ${response.status}`);
}
