import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';

const script = new URL('../scripts/deploy.mjs', import.meta.url);
const config = JSON.parse(readFileSync(new URL('../wrangler.json', import.meta.url), 'utf8'));
const targets = JSON.parse(readFileSync(new URL('../targets.json', import.meta.url), 'utf8'));
const account = targets.staging.cloudflareAccountId;

function denied(args, overrides = {}) {
  const result = spawnSync(process.execPath, [script.pathname, ...args], { encoding: 'utf8',
    env: { PATH: process.env.PATH, ...overrides } });
  assert.equal(result.status, 1, result.stdout + result.stderr);
  assert.equal(result.stdout, '');
  return result.stderr;
}

test('targets are limited to reviewed LAB staging with no production deployment', () => {
  assert.equal(targets.repository, 'Xybron/Lumen');
  assert.equal(targets.staging.supabaseProjectName, 'LAB');
  assert.equal(config.env.staging.vars.SUPABASE_URL,
    `https://${targets.staging.supabaseProjectRef}.supabase.co`);
  assert.equal(targets.production, null);
  assert.equal(config.env.production.workers_dev, false);
  assert.match(denied(['production']), /deliberately unconfigured/);
});

test('deployment needs explicit free-plan confirmation and exact account', () => {
  assert.match(denied(['staging']), /Workers Free/);
  assert.match(denied(['staging'], { LUMEN_WORKERS_FREE_CONFIRMED: 'true', CLOUDFLARE_ACCOUNT_ID: 'wrong' }), /reviewed target/);
  assert.match(denied(['staging', '--name', 'other']), /without additional Wrangler overrides/);
});

test('CI cannot deploy from a fork, pull request or unexpected branch', () => {
  const base = { GITHUB_ACTIONS: 'true', GITHUB_REPOSITORY: targets.repository,
    GITHUB_REF: 'refs/heads/cloud-staging', GITHUB_EVENT_NAME: 'push',
    CLOUDFLARE_ACCOUNT_ID: account, LUMEN_WORKERS_FREE_CONFIRMED: 'true' };
  for (const extra of [
    { GITHUB_REPOSITORY: 'other/Lumen' }, { GITHUB_EVENT_NAME: 'pull_request' },
    { GITHUB_EVENT_NAME: 'pull_request_target' }, { GITHUB_REF: 'refs/heads/prod' },
  ]) assert.match(denied(['staging'], { ...base, ...extra }), /unexpected repository, event or branch/);
  assert.match(denied(['staging'], base), /own scoped Cloudflare secret/);
});
