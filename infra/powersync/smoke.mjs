import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { sign } from 'node:crypto';
import { join } from 'node:path';
import { evaluationDirectory } from './setup.mjs';

// Deliberately fixed: cannot be pointed at LAB, production or a remote endpoint.
const origin = 'http://127.0.0.1:8188';
const fixtures = [
  { owner: '11111111-1111-4111-8111-111111111111', row: '11111111-1111-4111-8111-111111111101' },
  { owner: '22222222-2222-4222-8222-222222222222', row: '22222222-2222-4222-8222-222222222202' },
];
let privateKey;
function tokenFor(owner) {
  const encode = value => Buffer.from(JSON.stringify(value)).toString('base64url');
  const now = Math.floor(Date.now() / 1000);
  const content = `${encode({ alg: 'RS256', typ: 'JWT', kid: 'lumen-local-evaluation' })}.${encode({ sub: owner, aud: 'lumen-local-evaluation', iat: now, exp: now + 120 })}`;
  return `${content}.${sign('RSA-SHA256', Buffer.from(content), privateKey).toString('base64url')}`;
}

async function checkOwner(own, other) {
  const abort = new AbortController();
  const timeout = setTimeout(() => abort.abort(), 30_000);
  try {
    const response = await fetch(`${origin}/sync/stream`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Accept: 'application/x-ndjson', Authorization: `Bearer ${tokenFor(own.owner)}` },
      body: JSON.stringify({ buckets: [], raw_data: true, include_checksum: true }),
      signal: abort.signal,
    });
    assert.equal(response.status, 200, 'Authenticated sync stream must open.');
    const decoder = new TextDecoder();
    let pending = '';
    let sawOwnRow = false;
    for await (const bytes of response.body) {
      pending += decoder.decode(bytes, { stream: true });
      assert(pending.length < 1_000_000, 'Unexpected evaluation stream size.');
      let newline;
      while ((newline = pending.indexOf('\n')) >= 0) {
        const line = pending.slice(0, newline);
        pending = pending.slice(newline + 1);
        if (!line.trim()) continue;
        const value = JSON.parse(line);
        assert(!line.includes(other.row), 'Cross-owner row leaked through the sync stream.');
        sawOwnRow ||= line.includes(own.row);
        if (value.checkpoint_complete) {
          assert(sawOwnRow, 'Initial snapshot did not contain this owner’s demo row.');
          return;
        }
      }
    }
    throw new Error('Stream closed before the initial checkpoint completed.');
  } finally {
    clearTimeout(timeout);
    abort.abort();
  }
}

try {
  privateKey = await readFile(join(evaluationDirectory, '.runtime/signing-key.pem'), 'utf8');
  const health = await fetch(`${origin}/probes/liveness`, { signal: AbortSignal.timeout(5_000) });
  assert.equal(health.status, 200, 'Local PowerSync liveness probe failed.');
  const unauthenticated = await fetch(`${origin}/sync/stream`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ buckets: [] }),
    signal: AbortSignal.timeout(5_000),
  });
  assert([401, 403].includes(unauthenticated.status), 'Anonymous sync was not rejected.');
  for (let index = 0; index < fixtures.length; index++) {
    await checkOwner(fixtures[index], fixtures[1 - index]);
  }
  console.log('PASS: local health, anonymous access rejection and two-owner initial sync isolation.');
  console.log('This does not validate Lumen’s future offline upload/conflict/recovery integration.');
} catch (error) {
  console.error(`Evaluation smoke check failed: ${error.message}`);
  process.exitCode = 1;
}
