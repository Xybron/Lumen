// Explicit local HTTPS setup/start. Never changes OS trust, firewall or station data.
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { X509Certificate, createPrivateKey } from 'node:crypto';
import { spawn, execFileSync } from 'node:child_process';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { assertLocalPortAvailable } from './dev-watch.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const runtime = path.join(root, '.mobile-local');
const privateV4 = value => /^(?:10\.|192\.168\.|172\.(?:1[6-9]|2\d|3[01])\.)/.test(value) && value.split('.').length === 4 && value.split('.').every(part => /^\d{1,3}$/.test(part) && Number(part) <= 255 && String(Number(part)) === part);
export function mobileAddresses() {
  return [...new Set(Object.values(os.networkInterfaces()).flatMap(entries => (entries ?? []).filter(entry => !entry.internal && entry.family === 'IPv4' && privateV4(entry.address)).map(entry => entry.address)))];
}
export function parseMobileArgs(args) {
  const options = { mode: 'start', address: null, port: 4433, help: false };
  if (['setup', 'start'].includes(args[0])) options.mode = args.shift();
  for (let index = 0; index < args.length; index++) {
    const key = args[index];
    if (key === '--help' || key === '-h') { options.help = true; continue; }
    const value = args[++index];
    if (key === '--address' && typeof value === 'string' && privateV4(value)) options.address = value;
    else if (key === '--port' && /^\d+$/.test(value ?? '') && Number(value) >= 1024 && Number(value) <= 65535) options.port = Number(value);
    else throw new Error('Use --address with a private LAN IPv4 address and --port with a port from 1024 to 65535.');
  }
  if ([3000, 5173].includes(options.port)) throw new Error('Mobile HTTPS must use a different port from Studio/backend.');
  return options;
}
async function regularFile(filename, limit = 100000) {
  const stat = await fs.lstat(filename);
  if (!stat.isFile() || stat.isSymbolicLink() || stat.size > limit || (process.platform !== 'win32' && stat.mode & 0o077)) throw new Error('Mobile settings and private keys must be regular private files, not links.');
  return fs.readFile(filename);
}
async function privateDirectory(directory) {
  const stat = await fs.lstat(directory).catch(error => { if (error.code === 'ENOENT') return null; throw error; });
  if (stat && (!stat.isDirectory() || stat.isSymbolicLink())) throw new Error('The mobile HTTPS directory must be a real directory. Existing files were preserved.');
  await fs.mkdir(directory, { recursive: true, mode: 0o700 });
  if (process.platform !== 'win32') await fs.chmod(directory, 0o700);
}
export async function setupMobile(options, directory = runtime) {
  if (!options.address || !privateV4(options.address)) throw new Error('Choose a connected private address: npm run mobile:setup -- --address <LAN-IP>.');
  if (!mobileAddresses().includes(options.address)) throw new Error('That address is not on a connected private network interface. No network settings were changed.');
  await privateDirectory(directory);
  // New exact directory only. Never overwrite an existing trust anchor or key.
  const target = path.join(directory, 'tls');
  await fs.mkdir(target, { mode: 0o700 }).catch(error => { if (error.code === 'EEXIST') throw new Error('Mobile TLS already exists. Keep it, or archive .mobile-local before deliberately creating a new trust anchor. Nothing was overwritten.'); throw error; });
  let completed = false;
  try {
    const tool = process.env.LUMEN_OPENSSL_PATH ?? 'openssl';
    const caKey = path.join(target, 'ca-key.pem'), ca = path.join(target, 'lumen-mobile-ca.crt');
    const key = path.join(target, 'server-key.pem'), csr = path.join(target, 'server.csr'), cert = path.join(target, 'server-cert.pem'), extensions = path.join(target, 'extensions.cnf');
    const openssl = args => execFileSync(tool, args, { stdio: ['ignore', 'pipe', 'pipe'], timeout: 60000 });
    await fs.writeFile(extensions, `basicConstraints=critical,CA:FALSE\nkeyUsage=critical,digitalSignature,keyEncipherment\nextendedKeyUsage=serverAuth\nsubjectAltName=IP:${options.address},IP:127.0.0.1,DNS:localhost\n`, { mode: 0o600, flag: 'wx' });
    openssl(['req', '-x509', '-newkey', 'rsa:3072', '-nodes', '-sha256', '-days', '365', '-subj', '/CN=Lumen Local Mobile CA', '-addext', 'basicConstraints=critical,CA:TRUE,pathlen:0', '-addext', 'keyUsage=critical,keyCertSign,cRLSign', '-keyout', caKey, '-out', ca]);
    openssl(['req', '-new', '-newkey', 'rsa:3072', '-nodes', '-sha256', '-subj', '/CN=Lumen Local Mobile Controller', '-keyout', key, '-out', csr]);
    openssl(['x509', '-req', '-in', csr, '-CA', ca, '-CAkey', caKey, '-CAcreateserial', '-out', cert, '-days', '90', '-sha256', '-extfile', extensions]);
    for (const name of await fs.readdir(target)) if (process.platform !== 'win32') await fs.chmod(path.join(target, name), 0o600);
    const certificate = new X509Certificate(await fs.readFile(cert));
    if (!certificate.checkIP(options.address) || !certificate.verify(new X509Certificate(await fs.readFile(ca)).publicKey)) throw new Error('The generated mobile certificate did not validate.');
    const config = { version: 1, address: options.address, port: options.port, origin: `https://${options.address}:${options.port}`, key, cert, ca, createdAt: new Date().toISOString() };
    await fs.writeFile(path.join(directory, 'settings.json'), JSON.stringify(config, null, 2) + '\n', { mode: 0o600, flag: 'wx' });
    completed = true;
    return { ...config, fingerprint: new X509Certificate(await fs.readFile(ca)).fingerprint256 };
  } catch {
    throw new Error('Mobile HTTPS setup could not finish. Check OpenSSL availability and private-directory permissions. Existing files were preserved; no system trust/network settings changed.');
  } finally {
    // Only files in our newly-created exact tls directory are eligible here.
    if (!completed) await fs.rm(target, { recursive: true, force: true });
  }
}
export async function readMobileSettings(directory = runtime) {
  const stat = await fs.lstat(directory);
  if (!stat.isDirectory() || stat.isSymbolicLink()) throw new Error('Invalid mobile HTTPS directory.');
  const config = JSON.parse((await regularFile(path.join(directory, 'settings.json'))).toString());
  if (config.version !== 1 || !privateV4(config.address) || !Number.isInteger(config.port) || config.port < 1024 || config.port > 65535 || config.origin !== `https://${config.address}:${config.port}`) throw new Error('Invalid mobile HTTPS settings.');
  for (const [field, filename] of [['key', 'server-key.pem'], ['cert', 'server-cert.pem'], ['ca', 'lumen-mobile-ca.crt']]) if (config[field] !== path.join(directory, 'tls', filename)) throw new Error('Mobile HTTPS files must remain in their original private directory.');
  const cert = new X509Certificate(await regularFile(config.cert)), ca = new X509Certificate(await regularFile(config.ca)), key = createPrivateKey(await regularFile(config.key));
  if (!cert.checkPrivateKey(key) || !cert.verify(ca.publicKey) || !cert.checkIP(config.address) || Date.parse(cert.validTo) <= Date.now() || Date.parse(ca.validTo) <= Date.now()) throw new Error('Mobile HTTPS certificate is expired or does not match its private key/address.');
  return config;
}
export async function startMobileDevelopment(directory = runtime) {
  if (process.env.NODE_ENV === 'production') throw new Error('Use your normal production service with explicit HTTPS configuration; this launcher is development-only.');
  const config = await readMobileSettings(directory);
  if (!mobileAddresses().includes(config.address)) throw new Error('The configured LAN address is no longer connected. No service or network setting was changed.');
  await assertLocalPortAvailable(3000, 'Backend'); await assertLocalPortAvailable(5173, 'Studio');
  const probe = (await import('node:net')).createServer();
  try { await new Promise((resolve, reject) => { probe.once('error', reject); probe.listen(config.port, config.address, resolve); }); }
  catch { throw new Error('The mobile HTTPS port is unavailable; existing services were left running.'); }
  finally { if (probe.listening) await new Promise(resolve => probe.close(resolve)); }
  await fs.access(path.join(root, 'frontend/dist/index.html')).catch(() => { throw new Error('Build the phone interface first: npm run build.'); });
  const backendRequire = createRequire(new URL('../backend/package.json', import.meta.url)), frontendRequire = createRequire(new URL('../frontend/package.json', import.meta.url));
  const env = { ...process.env, HOST: '127.0.0.1', PORT: '3000', LUMEN_DEV_BACKEND_PORT: '3000', LUMEN_MOBILE_HOST: config.address, LUMEN_MOBILE_PORT: String(config.port), LUMEN_MOBILE_ORIGIN: config.origin, LUMEN_MOBILE_TLS_KEY: config.key, LUMEN_MOBILE_TLS_CERT: config.cert };
  const children = [
    spawn(process.execPath, ['--import', backendRequire.resolve('tsx'), path.join(root, 'backend/src/server.ts')], { cwd: root, env, stdio: 'inherit' }),
    spawn(process.execPath, [path.join(path.dirname(frontendRequire.resolve('vite/package.json')), 'bin/vite.js'), '--host', '127.0.0.1', '--port', '5173', '--strictPort'], { cwd: path.join(root, 'frontend'), env, stdio: 'inherit' }),
  ];
  let closing = false;
  const close = () => { if (closing) return; closing = true; for (const child of children) if (child.exitCode === null && child.signalCode === null) child.kill('SIGTERM'); };
  process.once('SIGINT', close); process.once('SIGTERM', close);
  for (const child of children) { child.once('error', close); child.once('exit', close); }
  console.log(`\nStudio: http://127.0.0.1:5173/studio\nPhone controller: ${config.origin}/remote\nUse Studio → Mobile control to create a one-use pairing code.\nThe phone must trust your local CA; see docs/MOBILE-CONTROLLER.md.\nNo stream/recording starts automatically. Ctrl+C stops only these owned services.\n`);
  try { await Promise.all(children.map(child => new Promise(resolve => { if (child.exitCode !== null || child.signalCode !== null) resolve(); else child.once('exit', resolve); }))); }
  finally { process.off('SIGINT', close); process.off('SIGTERM', close); }
}
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    const options = parseMobileArgs(process.argv.slice(2));
    if (options.help) console.log(`Usage: npm run mobile:setup -- --address <private LAN IPv4> [--port 4433]\n       npm run dev:mobile\nConnected private addresses: ${mobileAddresses().join(', ') || 'none'}\nCreates private local certificates only; never installs trust or changes firewall settings.`);
    else if (options.mode === 'setup') {
      const config = await setupMobile(options);
      console.log(`Mobile HTTPS created for ${config.origin}\nTrust only this public CA certificate on your phone: ${config.ca}\nVerify its SHA-256 fingerprint: ${config.fingerprint}\nNever share ca-key.pem or server-key.pem. Nothing was installed or started.\nNext: npm run build, then stop the old dev command and run npm run dev:mobile.\n`);
    } else await startMobileDevelopment();
  } catch (error) { console.error(`[mobile] ${error.message}`); process.exitCode = 1; }
}
