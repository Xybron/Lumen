import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import net from 'node:net';
import { fileURLToPath } from 'node:url';
import { z } from 'zod';
import { createBroadcastRelay } from './broadcast-relay.js';
import { StationInUseError } from './station-lock.js';

const port = z.number().int().min(1).max(65535);
const origin = z.string().regex(/^http:\/\/127\.0\.0\.1(?::([1-9]\d{0,4}))?\/?$/).refine(value => {
  try { return Number(new URL(value).port || '80') <= 65535; } catch { return false; }
});
const messageSchema = z.object({ t: z.literal('local-watch-config'), relayUrl: origin,
  token: z.string().min(32).max(256).regex(/^[\x21-\x7e]+$/), broadcastDirectory: z.string().min(1),
  backendPort: port, frontendUrl: origin }).strict();
export type LocalWatchConfig = z.infer<typeof messageSchema>;

/** Only an IPC parent may grant the local relay capability. Normal environment
 * configuration still uses the public HTTPS / pinned-address adapter rules. */
export async function validateLocalWatchConfig(input: unknown): Promise<LocalWatchConfig> {
  const parsed = messageSchema.safeParse(input);
  if (!parsed.success) throw new Error('The local Watch startup message is invalid.');
  const value = parsed.data, ports = [value.backendPort, Number(new URL(value.frontendUrl).port || '80'), Number(new URL(value.relayUrl).port || '80')];
  if (new Set(ports).size !== ports.length) throw new Error('Studio, Watch and the backend must use separate local ports.');
  const directory = path.resolve(value.broadcastDirectory), parent = path.dirname(directory), temporary = await fs.realpath(os.tmpdir());
  if (path.basename(directory) !== 'broadcast' || !/^lumen-local-watch-[A-Za-z0-9]{6}$/.test(path.basename(parent))) throw new Error('Local Watch requires a private temporary settings directory.');
  try {
    const info = await fs.lstat(parent), child = await fs.lstat(directory);
    if (!info.isDirectory() || info.isSymbolicLink() || !child.isDirectory() || child.isSymbolicLink()
      || path.dirname(await fs.realpath(parent)) !== temporary || await fs.realpath(directory) !== path.join(await fs.realpath(parent), 'broadcast')
      || (info.mode & 0o077) !== 0 || (child.mode & 0o077) !== 0
      || process.getuid && (info.uid !== process.getuid() || child.uid !== process.getuid())) throw new Error();
    if ((await fs.readdir(directory)).length !== 0) throw new Error();
  } catch { throw new Error('Local Watch requires an empty private temporary settings directory.'); }
  return value;
}

export async function loopbackPortInUse(value: number): Promise<boolean> {
  return new Promise((resolve, reject) => {
    const socket = net.connect({ host: '127.0.0.1', port: value });
    const finish = (occupied: boolean) => { socket.destroy(); resolve(occupied); };
    socket.once('connect', () => finish(true)); socket.setTimeout(1000, () => finish(true));
    socket.once('error', error => {
      socket.destroy();
      if ((error as NodeJS.ErrnoException).code === 'ECONNREFUSED') resolve(false);
      else reject(new Error('The backend port could not be checked safely.'));
    });
  });
}

export async function assertLocalWatchPortsAvailable(config: LocalWatchConfig, dataDirectory: string, defaultDirectory: string,
  probe: (port: number) => Promise<boolean> = loopbackPortInUse) {
  const canonical = async (value: string) => fs.realpath(value).catch(() => path.resolve(value));
  const ports = new Set([config.backendPort]);
  if (await canonical(dataDirectory) === await canonical(defaultDirectory)) ports.add(3000);
  for (const selected of ports) if (await probe(selected)) throw new Error('Another Lumen backend is already running. Stop that instance before starting Studio + Local Watch.');
}

export async function runLocalWatchChild() {
  if (typeof process.send !== 'function' || process.env.NODE_ENV === 'production') throw new Error('Local Watch must be started through the dedicated local development launcher.');
  let server: Awaited<ReturnType<typeof import('./server.js')['startLumenServer']>> | null = null;
  let stopping = false, starting = false;
  const stop = () => {
    if (stopping) return; stopping = true;
    if (server) void server.close().catch(() => {}).finally(() => process.exit(0));
    else if (!starting) { process.exit(0); return; }
    setTimeout(() => process.exit(1), 8000).unref();
  };
  process.on('message', value => { if (value && typeof value === 'object' && (value as { t?: string }).t === 'local-watch-stop') stop(); });
  process.once('disconnect', stop); process.once('SIGINT', stop); process.once('SIGTERM', stop);
  const input = await new Promise<unknown>((resolve, reject) => {
    const timer = setTimeout(() => { process.off('message', receive); reject(new Error('Local Watch startup was not configured.')); }, 10_000); timer.unref();
    const receive = (value: unknown) => { clearTimeout(timer); resolve(value); };
    process.once('message', receive);
  });
  const config = await validateLocalWatchConfig(input);
  const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
  const defaultDirectory = path.join(root, 'data'), dataDirectory = process.env.LUMEN_DATA_DIR ?? defaultDirectory;
  await assertLocalWatchPortsAvailable(config, dataDirectory, defaultDirectory);
  // Do not initialize real stores until the IPC grant, isolation checks and
  // duplicate-instance checks have all passed.
  const { startLumenServer } = await import('./server.js');
  const relay = createBroadcastRelay({ baseUrl: config.relayUrl, token: config.token, slug: 'live', allowLocalhostForTests: true });
  starting = true;
  server = await startLumenServer({ port: config.backendPort, host: '127.0.0.1', rendererUrl: config.frontendUrl, development: true,
    productionDependencies: { watchRelay: relay, broadcastDirectory: config.broadcastDirectory, localWatch: true } });
  starting = false;
  if (stopping) { await server.close(); process.exit(0); return; }
  if (!process.connected) { stop(); return; }
  process.send?.({ t: 'local-watch-ready', backendUrl: new URL(`http://127.0.0.1:${config.backendPort}`).origin, watchUrl: `${new URL(config.relayUrl).origin}/watch/live` });
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) void runLocalWatchChild().catch((error: unknown) => {
  // A malformed IPC payload may contain the private token. Never serialize it
  // or a raw validation issue in logs/IPC errors.
  console.error('[lumen] Local Watch could not start. Check the local launcher, free ports and temporary settings.');
  process.exitCode = 1;
  const message = error instanceof StationInUseError ? error.message : 'Local Watch could not start. Stop any other Lumen instance, then check free ports and the private temporary settings. Do not remove runtime lease files while a backend may be running.';
  if (process.connected) process.send?.({ t: 'local-watch-error', message }, () => { if (process.connected) process.disconnect(); });
});
