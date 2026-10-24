import { spawn, spawnSync } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { promises as fs } from 'node:fs';
import dns from 'node:dns/promises';
import net from 'node:net';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export const LAB_HOST = 'db.xfppsgiothkvhndmbixx.supabase.co';
export const LAB_JWKS = 'https://xfppsgiothkvhndmbixx.supabase.co/auth/v1/.well-known/jwks.json';
export const PS_IMAGE = 'journeyapps/powersync-service:1.27.0@sha256:15b8e4dbbab17ba45d3abfef29df29b21489266e55ff9aa95bbfd56d9548c00f';
const root = fileURLToPath(new URL('../', import.meta.url));
const directory = path.join(root, 'infra', 'team-sync');
const runtime = path.join(directory, '.runtime');
const configPath = path.join(runtime, 'local.json');
const commands = new Set(['setup', 'doctor', 'rules', 'check', 'up', 'status', 'down', 'help']);

export function parseTeamSyncArgs(args) {
  if (args.length !== 1 || !commands.has(args[0])) throw new Error('Use node scripts/team-sync.mjs setup|doctor|rules|check|up|status|down without Docker overrides.');
  return args[0];
}

export function sanitizeDockerEnvironment(source) {
  return Object.fromEntries(Object.entries(source).filter(([name]) =>
    !name.startsWith('COMPOSE_') && !name.startsWith('DOCKER_') && !name.startsWith('PS_')));
}

export function validatePrivateConfig(config) {
  if (!config || config.version !== 1 || Object.keys(config).some(key => !['version', 'sourcePassword', 'sourceCaPem', 'sourceRoleVerified', 'bucketAdminPassword', 'bucketPassword'].includes(key))) throw new Error('Local PowerSync configuration is invalid. Use the generated local.json shape; endpoints cannot be overridden.');
  const strong = value => typeof value === 'string' && /^[A-Za-z0-9_-]{43,128}$/.test(value);
  if (!strong(config.bucketAdminPassword) || !strong(config.bucketPassword) || config.bucketAdminPassword === config.bucketPassword) throw new Error('Local bucket passwords must be independent random URL-safe values (at least 256 bits).');
  if (typeof config.sourcePassword !== 'string' || config.sourcePassword.length < 24 || config.sourcePassword.length > 512 || /[\r\n\0]/.test(config.sourcePassword)) throw new Error('Configure the dedicated lumen_sync_replica password in infra/team-sync/.runtime/local.json; never use the project postgres password.');
  if (typeof config.sourceCaPem !== 'string' || config.sourceCaPem.length > 32768 || !/^-----BEGIN CERTIFICATE-----\r?\n[A-Za-z0-9+/=\r\n]+-----END CERTIFICATE-----\s*$/.test(config.sourceCaPem)) throw new Error('Configure the verified LAB database root CA certificate PEM in local.json. TLS verification will not be disabled.');
  if (config.sourceRoleVerified !== true) throw new Error('Verify the dedicated read-only LAB replication role, explicit publication and grants, then set sourceRoleVerified in local.json. This launcher never grants database privileges.');
  return config;
}

export async function createLocalConfig(target = runtime) {
  try {
    const stat = await fs.lstat(target);
    if (!stat.isDirectory() || stat.isSymbolicLink()) throw new Error('Local PowerSync credentials must use a real directory, not a symlink.');
  } catch (error) { if (error.code !== 'ENOENT') throw error; }
  await fs.mkdir(target, { recursive: true, mode: 0o700 });
  if (process.platform !== 'win32') await fs.chmod(target, 0o700);
  const file = path.join(target, 'local.json');
  const secret = () => randomBytes(32).toString('base64url');
  const config = { version: 1, sourcePassword: '', sourceCaPem: '', sourceRoleVerified: false, bucketAdminPassword: secret(), bucketPassword: secret() };
  try { await fs.writeFile(file, JSON.stringify(config, null, 2) + '\n', { flag: 'wx', mode: 0o600 }); }
  catch (error) { if (error.code === 'EEXIST') throw new Error('Local PowerSync configuration already exists; it was not overwritten.'); throw error; }
  return file;
}

async function readPrivateConfig() {
  const parent = await fs.lstat(runtime).catch(() => { throw new Error('Run node scripts/team-sync.mjs setup first.'); });
  const stat = await fs.lstat(configPath).catch(() => { throw new Error('Run node scripts/team-sync.mjs setup first.'); });
  if (parent.isSymbolicLink() || !parent.isDirectory() || stat.isSymbolicLink() || !stat.isFile() || stat.size > 65536) throw new Error('Local PowerSync credentials must be a regular private file in a real directory.');
  if (process.platform !== 'win32' && ((stat.mode & 0o077) || (parent.mode & 0o077))) throw new Error('Protect local PowerSync credentials: chmod 700 infra/team-sync/.runtime && chmod 600 infra/team-sync/.runtime/local.json');
  try { return validatePrivateConfig(JSON.parse(await fs.readFile(configPath, 'utf8'))); }
  catch (error) { if (error instanceof SyntaxError) throw new Error('Local PowerSync JSON is invalid; no services were started.'); throw error; }
}

export function localDockerEnvironment(source = process.env) {
  const environment = sanitizeDockerEnvironment(source);
  let socket = source.DOCKER_CONTEXT ? undefined : source.DOCKER_HOST;
  if (!socket) {
    const args = ['context', 'inspect'];
    if (source.DOCKER_CONTEXT) args.push(source.DOCKER_CONTEXT);
    args.push('--format', '{{.Endpoints.docker.Host}}');
    const context = spawnSync('docker', args, { encoding: 'utf8', timeout: 10000, env: source });
    if (context.status !== 0) throw new Error('A local Docker context is unavailable. Start Docker Desktop and select its local context.');
    socket = context.stdout.trim();
  }
  if (!socket.startsWith('unix:///') && !socket.startsWith('npipe://')) throw new Error('Local PowerSync refuses remote Docker hosts. Select the local Docker context first.');
  return { ...environment, DOCKER_HOST: socket };
}

function docker(args, environment, { timeout = 20000, quiet = true } = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn('docker', args, { cwd: directory, env: environment, stdio: ['ignore', 'pipe', 'pipe'] });
    let output = '';
    for (const stream of [child.stdout, child.stderr]) stream.on('data', bytes => {
      if (output.length < 100000) output += bytes;
      if (!quiet) process.stdout.write(bytes);
    });
    let killTimer;
    const timer = setTimeout(() => { child.kill('SIGTERM'); killTimer = setTimeout(() => child.kill('SIGKILL'), 3000); }, timeout);
    child.once('error', () => { clearTimeout(timer); clearTimeout(killTimer); reject(new Error('Docker is unavailable; install and start Docker Desktop.')); });
    child.once('exit', code => { clearTimeout(timer); clearTimeout(killTimer); resolve({ code, output }); });
  });
}

export async function assertHostSourceReachable() {
  let addresses;
  try { addresses = await dns.resolve6(LAB_HOST); }
  catch { throw new Error('LAB direct IPv6 DNS lookup failed. PowerSync cannot use a Supabase pooler. No paid IPv4 add-on was enabled.'); }
  for (const host of addresses) {
    const connected = await new Promise(resolve => {
      const socket = net.connect({ host, port: 5432, timeout: 5000 });
      let finished = false;
      function done(value) { if (finished) return; finished = true; socket.destroy(); resolve(value); }
      socket.once('connect', () => done(true));
      socket.once('timeout', () => done(false));
      socket.once('error', () => done(false));
    });
    if (connected) return;
  }
  throw new Error('LAB direct IPv6 is unreachable from this computer. Real PowerSync replication is blocked until routed IPv6 works on the host and Docker. Auth and LAB editing may still work over HTTPS, but that is not a successful PowerSync connection. No pooler workaround or paid IPv4 add-on was enabled.');
}

// A bounded disposable container checks the exact project's IPv6 network. It has
// no credentials, no station mounts, no published ports and starts no service.
async function assertDockerSourceReachable(environment) {
  const name = `lumen-team-check-${randomBytes(8).toString('hex')}`;
  const container = `${name}-probe`;
  const created = await docker(['network', 'create', '--ipv6', '--label', 'com.lumen.purpose=team-sync-connectivity-check', name], environment);
  if (created.code !== 0) throw new Error('Docker could not create an isolated IPv6 test bridge. No daemon/firewall settings were changed.');
  try {
    const code = `const d=require('dns'),n=require('net');d.resolve6('${LAB_HOST}',(e,a)=>{if(e||!a.length)process.exit(2);let s=n.connect({host:a[0],port:5432,timeout:6000});s.on('connect',()=>{s.destroy();process.exit(0)});s.on('timeout',()=>{s.destroy();process.exit(2)});s.on('error',()=>process.exit(2))});setTimeout(()=>process.exit(2),9000);`;
    const checked = await docker(['run', '--rm', '--name', container, '--label', 'com.lumen.purpose=team-sync-connectivity-check', '--network', name, '--entrypoint', 'node', PS_IMAGE, '-e', code], environment, { timeout: 15000 });
    if (checked.code !== 0) throw new Error('LAB direct IPv6 is unreachable from Docker. Enable routed IPv6 for this local network or test on an IPv6-capable machine. No source credentials were sent and no services were started.');
  } finally {
    // If an interrupted Docker client left its disposable container running,
    // clean only the exact random name created by this invocation.
    await docker(['rm', '--force', container], environment);
    // This exact random name was created above and has no user containers.
    const removed = await docker(['network', 'rm', name], environment);
    if (removed.code !== 0) process.stderr.write(`The owned connectivity-check bridge ${name} could not be removed; no application network was touched.\n`);
  }
}

async function compileRules(environment) {
  const parser = `import fs from 'node:fs';import {SqlSyncRules} from '/app/packages/sync-rules/dist/index.js';const result=await SqlSyncRules.fromYaml(fs.readFileSync('/check/sync-config.yaml','utf8'),{defaultSchema:'public',throwOnError:true});if(result.errors?.length)throw new Error('Sync rules failed validation');console.log('Pinned PowerSync 1.27.0 rule compilation passed.');`;
  const checked = await docker(['run', '--rm', '--network', 'none', '--mount', `type=bind,src=${path.join(directory, 'sync-config.yaml')},dst=/check/sync-config.yaml,readonly`, '--entrypoint', 'node', PS_IMAGE, '--input-type=module', '-e', parser], environment, { timeout: 20000, quiet: false });
  if (checked.code !== 0) throw new Error('The pinned PowerSync image could not compile the reviewed membership-filtered sync rules. No credentials were sent or services started.');
}

async function assertPortAvailable() {
  const server = net.createServer();
  try {
    await new Promise((resolve, reject) => { server.once('error', reject); server.listen({ port: 8189, host: '127.0.0.1', exclusive: true }, resolve); });
  } catch { throw new Error('Local PowerSync port 8189 is occupied. No process was stopped. Use status to inspect the owned stack first.'); }
  finally { if (server.listening) await new Promise(resolve => server.close(resolve)); }
}

function composeArgs(args) { return ['compose', '--project-name', 'lumen-team-sync', '--file', path.join(directory, 'compose.yaml'), ...args]; }

export async function runTeamSync(command) {
  if (command === 'help') {
    console.log('Local LAB PowerSync: node scripts/team-sync.mjs setup|doctor|rules|check|up|status|down\nsetup creates private local configuration, doctor checks direct IPv6 without credentials, rules compiles streams offline in the pinned image, check validates readiness, up starts the opt-in service, down stops only this stack and retains its bucket data. No station files or paid services are changed.');
    return;
  }
  if (command === 'setup') {
    await createLocalConfig();
    console.log('Created ignored private PowerSync config at infra/team-sync/.runtime/local.json. Bucket credentials generated; source credentials are intentionally empty. Nothing was connected or started. See infra/team-sync/README.md.');
    return;
  }
  if (process.env.NODE_ENV === 'production') throw new Error('This is a loopback-only development launcher, not a production deployment command.');
  const environment = localDockerEnvironment();
  if (command === 'rules') { await compileRules(environment); return; }
  if (command === 'doctor') {
    await assertHostSourceReachable();
    await assertDockerSourceReachable(environment);
    console.log('LAB direct TCP connectivity works from both host and Docker. This does not yet verify TLS, credentials, replication grants or initial sync.');
    return;
  }
  if (command === 'status' || command === 'down') {
    // Compose needs nonempty placeholders even for ps/down; no credentials are
    // loaded or sent, containers are never recreated and volumes are retained.
    const placeholders = { ...environment, PS_SOURCE_PASSWORD: 'unused', PS_SOURCE_CA: 'unused', PS_BUCKET_ADMIN_PASSWORD: 'unused', PS_BUCKET_PASSWORD: 'unused' };
    const result = await docker(composeArgs(command === 'status' ? ['ps'] : ['down']), placeholders, { quiet: false, timeout: 30000 });
    if (result.code !== 0) throw new Error(`Local PowerSync ${command} failed. No other stack or volume was changed.`);
    return;
  }
  // Fail before touching credentials or starting containers when IPv6 is down.
  await assertHostSourceReachable();
  const config = await readPrivateConfig();
  const configured = { ...environment, PS_SOURCE_PASSWORD: config.sourcePassword, PS_SOURCE_CA: config.sourceCaPem, PS_BUCKET_ADMIN_PASSWORD: config.bucketAdminPassword, PS_BUCKET_PASSWORD: config.bucketPassword };
  const checked = await docker(composeArgs(['config', '--quiet']), configured);
  if (checked.code !== 0) throw new Error('The reviewed local PowerSync Compose configuration did not validate; no services were started.');
  await compileRules(environment);
  await assertDockerSourceReachable(environment);
  const jwks = await fetch(LAB_JWKS, { signal: AbortSignal.timeout(8000) }).then(response => response.ok ? response.json() : null).catch(() => null);
  if (!jwks?.keys?.some(key => ['EC', 'RSA'].includes(key.kty) && !key.d)) throw new Error('LAB asymmetric public JWKS is unavailable; local PowerSync remains stopped.');
  if (command === 'check') { console.log('Configuration, public JWKS and host/Docker connectivity checks passed. Start remains a separate deliberate step; TLS/replication and first sync still require end-to-end verification.'); return; }
  await assertPortAvailable();
  const started = await docker(composeArgs(['up', '-d', '--wait', '--wait-timeout', '45']), configured, { quiet: false, timeout: 55000 });
  if (started.code !== 0) throw new Error('The owned local PowerSync stack did not become healthy. Run status; down stops only this stack and preserves bucket data. No live station files were changed.');
  console.log('Local PowerSync is running at http://127.0.0.1:8189. Health alone is not proof of tenant isolation or completed sync; confirm a real authenticated client reaches Synced in Lumen. Ctrl+C does not stop detached Docker services; use node scripts/team-sync.mjs down when finished.');
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try { await runTeamSync(parseTeamSyncArgs(process.argv.slice(2))); }
  catch (error) { console.error(`[team-sync] ${error.message}`); process.exitCode = 1; }
}
