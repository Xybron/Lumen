import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { spawn } from 'node:child_process';
import { readConfig } from '../src/index.js';

const directory = fileURLToPath(new URL('../', import.meta.url));
const config = JSON.parse(await readFile(new URL('../wrangler.json', import.meta.url), 'utf8'));
const targets = JSON.parse(await readFile(new URL('../targets.json', import.meta.url), 'utf8'));
const targetName = process.argv[2];

function stop(message) { console.error(message); process.exit(1); }
if (!['staging', 'production'].includes(targetName) || process.argv.length !== 3) {
  stop('Use the staging or production deployment script without additional Wrangler overrides.');
}
const target = targets[targetName];
if (!target) stop('Production is deliberately unconfigured. Approve its account, database and domain in a reviewed change first.');
if (process.env.LUMEN_WORKERS_FREE_CONFIRMED !== 'true') {
  stop('Deployment blocked: verify the target account is on Workers Free, then set LUMEN_WORKERS_FREE_CONFIRMED=true. Never enable a paid tier to bypass a limit.');
}
if (process.env.CLOUDFLARE_ACCOUNT_ID !== target.cloudflareAccountId) {
  stop('Deployment blocked: CLOUDFLARE_ACCOUNT_ID must match the reviewed target in cloud/targets.json.');
}
const environment = config.env[targetName];
try { readConfig(environment.vars); }
catch { stop('Deployment configuration is incomplete or unsafe.'); }
if (environment.vars.SUPABASE_URL !== `https://${target.supabaseProjectRef}.supabase.co`) {
  stop('Supabase URL does not match the reviewed deployment target.');
}
const forbiddenBindings = ['r2_buckets', 'd1_databases', 'kv_namespaces', 'durable_objects',
  'containers', 'queues', 'ai', 'vectorize', 'hyperdrive', 'analytics_engine_datasets',
  'services', 'dispatch_namespaces', 'workflows', 'unsafe', 'assets', 'routes', 'triggers',
  'email', 'send_email', 'browser', 'pipelines', 'secrets_store_secrets'];
for (const item of [config, environment]) {
  if (forbiddenBindings.some(key => key in item) || item.usage_model || item.logpush) {
    stop('Foundation deployment must remain binding-free, without routes, schedules or paid products. Review infrastructure changes separately.');
  }
}
if (process.env.GITHUB_ACTIONS === 'true') {
  const expectedRef = targetName === 'staging' ? 'refs/heads/cloud-staging' : 'refs/heads/prod';
  if (process.env.GITHUB_REPOSITORY !== targets.repository || process.env.GITHUB_REF !== expectedRef ||
      !['push', 'workflow_dispatch'].includes(process.env.GITHUB_EVENT_NAME ?? '') ||
      (targetName === 'production' && process.env.GITHUB_EVENT_NAME !== 'workflow_dispatch')) {
    stop('Deployment blocked: unexpected repository, event or branch.');
  }
  if (!process.env.CLOUDFLARE_API_TOKEN) stop('GitHub deployment requires its own scoped Cloudflare secret, not local OAuth credentials.');
}
const child = spawn(process.execPath, [
  fileURLToPath(new URL('../node_modules/wrangler/bin/wrangler.js', import.meta.url)),
  'deploy', '--env', targetName, '--strict', '--autoconfig=false',
], { cwd: directory, stdio: 'inherit', env: { ...process.env, WRANGLER_SEND_METRICS: 'false' } });
child.on('error', () => stop('Unable to start locked Wrangler tooling. Run npm --prefix cloud ci first.'));
child.on('exit', code => process.exit(code ?? 1));
