// Test-only RTMPS ingest. A local TLS socket forwards to FFmpeg's actual RTMP
// listener, so both the TLS handshake and AMF/RTMP/FLV publication are real.
import tls from 'node:tls';
import net from 'node:net';
import fs from 'node:fs/promises';
import path from 'node:path';
import { spawn } from 'node:child_process';
import ffmpeg from 'ffmpeg-static';

async function freePort() {
  const server = net.createServer(); await new Promise((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve); });
  const port = server.address().port; await new Promise(resolve => server.close(resolve)); return port;
}
async function processRun(file, args) {
  return new Promise((resolve, reject) => { const child = spawn(file, args, { stdio: ['ignore', 'pipe', 'pipe'] }), diagnostics = []; child.stderr.on('data', value => diagnostics.push(value)); child.once('error', reject); child.once('close', code => code === 0 ? resolve() : reject(new Error(Buffer.concat(diagnostics).toString()))); });
}
async function connect(port) {
  const started = Date.now();
  for (;;) {
    try { return await new Promise((resolve, reject) => { const socket = net.connect({ host: '127.0.0.1', port }); socket.once('connect', () => { socket.removeListener('error', reject); resolve(socket); }); socket.once('error', error => { socket.destroy(); reject(error); }); }); }
    catch (error) { if (Date.now() - started > 4000) throw error; await new Promise(resolve => setTimeout(resolve, 20)); }
  }
}
export async function localRtmpsReceivers(directory, options = {}) {
  await fs.mkdir(directory, { recursive: true });
  const keyFile = path.join(directory, 'test-only-key.pem'), certFile = path.join(directory, 'test-only-cert.pem');
  await processRun('openssl', ['req', '-x509', '-newkey', 'rsa:2048', '-nodes', '-keyout', keyFile, '-out', certFile, '-days', '1', '-subj', '/CN=localhost']);
  const [key, cert] = await Promise.all([fs.readFile(keyFile), fs.readFile(certFile)]), endpoints = {}, records = [], sockets = new Set(), children = new Set();
  let closing = false;
  for (const name of ['youtube', 'facebook']) {
    const route = options.paths?.[name] ?? '/live/fixture';
    if (!/^\/(?:live|live2|rtmp)\/[a-zA-Z0-9_-]{1,100}$/.test(route)) throw new Error('A safe local RTMP fixture path is required.');
    let sequence = 0;
    const server = tls.createServer({ key, cert, minVersion: 'TLSv1.2' }, secure => {
      const events = [], event = value => events.push({ elapsedMs: Date.now() - started, value }), started = Date.now();
      secure.setNoDelay(true); secure.pause(); sockets.add(secure); secure.on('error', error => event(`tls-error:${error.code}`)); secure.once('end', () => event('tls-end')); secure.once('close', () => { sockets.delete(secure); event('tls-close'); });
      void (async () => {
        if (closing) { secure.destroy(); return; }
        const number = ++sequence, port = await freePort(), filename = path.join(directory, `${name}-${number}.flv`);
        const child = spawn(ffmpeg, ['-hide_banner', '-nostdin', '-loglevel', 'error', '-y', '-threads', '1', '-protocol_whitelist', 'rtmp,tcp', '-listen', '1', '-rw_timeout', '15000000', '-i', `rtmp://127.0.0.1:${port}${route}`, '-map', '0:v:0', '-map', '0:a:0', '-c', 'copy', '-flush_packets', '1', '-flvflags', 'no_duration_filesize', '-f', 'flv', filename], { stdio: ['ignore', 'ignore', 'pipe'] });
        children.add(child);
        const record = { name, number, filename, pid: child.pid, receivedBytes: 0, sentBytes: 0, closed: false, diagnostics: '', events }; records.push(record);
        child.stderr.on('data', value => { record.diagnostics = (record.diagnostics + value.toString()).slice(-4000); });
        child.once('error', () => { secure.destroy(); });
        child.once('close', code => { record.closed = true; record.exitCode = code; children.delete(child); });
        const plain = await connect(port); plain.setNoDelay(true); event('plain-connected'); sockets.add(plain); plain.on('error', error => event(`plain-error:${error.code}`)); plain.once('end', () => event('plain-end')); plain.once('close', () => { sockets.delete(plain); event('plain-close'); secure.destroy(); });
        secure.on('data', data => { record.receivedBytes += data.length; }); plain.on('data', data => { record.sentBytes += data.length; });
        secure.once('end', () => plain.end()); secure.once('close', () => plain.destroy());
        plain.pipe(secure); secure.pipe(plain); secure.resume();
      })().catch(() => secure.destroy());
    });
    server.on('tlsClientError', () => {});
    await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
    endpoints[name] = { url: `rtmps://127.0.0.1:${server.address().port}${route}`, server };
  }
  return {
    endpoints, records, certificate: cert,
    async snapshot() { return Promise.all(records.map(async record => ({ ...record, filename: path.basename(record.filename), bytes: (await fs.stat(record.filename).catch(() => ({ size: 0 }))).size }))); },
    async close() {
      closing = true; for (const socket of sockets) socket.destroy();
      await Promise.all(Object.values(endpoints).map(({ server }) => new Promise(resolve => server.close(resolve))));
      for (const child of children) child.kill('SIGTERM');
      await Promise.all([...children].map(child => new Promise(resolve => { child.once('close', resolve); setTimeout(() => { child.kill('SIGKILL'); resolve(); }, 1500).unref(); })));
    },
  };
}
