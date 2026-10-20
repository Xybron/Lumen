import { lookup } from 'node:dns/promises';
import http from 'node:http';
import https from 'node:https';
import { isIP } from 'node:net';
import fs from 'node:fs/promises';
import path from 'node:path';

export interface WatchRelayAdapter {
  readonly configured: boolean;
  readonly publicUrl?: string;
  readonly configurationError?: string;
  begin(input: { epoch: string; signal?: AbortSignal }): Promise<void>;
  publish(input: { directory: string; playlist: string; signal?: AbortSignal }): Promise<void>;
  finish(input?: { signal?: AbortSignal }): Promise<void>;
}
export interface WatchRelayOptions {
  baseUrl: string;
  token: string;
  slug: string;
  /** Constructor-only local launcher/test capability: loopback, never LAN hosts. */
  allowLocalhostForTests?: boolean;
  timeoutMs?: number;
  maxSegmentBytes?: number;
}
const SLUG = /^[a-z0-9](?:[a-z0-9-]{0,62}[a-z0-9])?$/;
const SEGMENT = /^segment-\d{8,20}\.ts$/;
const SESSION = /^[a-f0-9-]{36}$/;
const MAX_PLAYLIST = 65536;
export class WatchRelayError extends Error {
  constructor(message: string, public readonly code: 'configuration' | 'timeout' | 'cancelled' | 'busy' | 'connection' | 'rejected' | 'media' = 'connection', public readonly httpStatus?: number) { super(message); this.name = 'WatchRelayError'; }
}

function ipv4Public(address: string): boolean {
  const octets = address.split('.').map(Number);
  if (octets.length !== 4 || octets.some(value => !Number.isInteger(value) || value < 0 || value > 255)) return false;
  const [a, b, c] = octets;
  return !(a === 0 || a === 10 || a === 127 || a >= 224 || a === 169 && b === 254 || a === 172 && b >= 16 && b <= 31 || a === 192 && (b === 168 || b === 0 || b === 2) || a === 100 && b >= 64 && b <= 127 || a === 198 && (b === 18 || b === 19 || b === 51 && c === 100) || a === 203 && b === 0 && c === 113);
}
function ipv6Number(address: string): bigint | undefined {
  if (address.includes('%')) return;
  let text = address.toLowerCase();
  if (text.includes('.')) {
    const lastColon = text.lastIndexOf(':'), v4 = text.slice(lastColon + 1).split('.').map(Number);
    if (v4.length !== 4 || v4.some(value => !Number.isInteger(value) || value < 0 || value > 255)) return;
    text = `${text.slice(0, lastColon + 1)}${((v4[0] << 8) | v4[1]).toString(16)}:${((v4[2] << 8) | v4[3]).toString(16)}`;
  }
  const halves = text.split('::'); if (halves.length > 2) return;
  const left = halves[0] ? halves[0].split(':') : [], right = halves.length === 2 && halves[1] ? halves[1].split(':') : [];
  const zeroes = 8 - left.length - right.length;
  if (halves.length === 1 && zeroes !== 0 || halves.length === 2 && zeroes < 1) return;
  const words = [...left, ...Array(halves.length === 2 ? zeroes : 0).fill('0'), ...right];
  if (words.length !== 8 || words.some(word => !/^[a-f0-9]{1,4}$/.test(word))) return;
  return words.reduce((value, word) => value << 16n | BigInt(parseInt(word, 16)), 0n);
}
/** Reject private, loopback, multicast, documentation and IPv4-translation ranges. */
export function isPublicRelayAddress(address: string): boolean {
  if (isIP(address) === 4) return ipv4Public(address);
  if (isIP(address) !== 6) return false;
  const value = ipv6Number(address); if (value === undefined) return false;
  // Public global unicast only; reject Teredo, benchmarking, documentation and
  // 6to4/translation mechanisms which can carry an internal IPv4 destination.
  if (value >> 125n !== 1n) return false; // 2000::/3
  const first32 = value >> 96n;
  return !(first32 === 0x20010000n || first32 === 0x20010002n || first32 === 0x20010db8n || value >> 112n === 0x2002n);
}
function loopback(address: string) { return address === '127.0.0.1' || address === '::1'; }
function validateOptions(options: WatchRelayOptions): URL {
  let base: URL; try { base = new URL(options.baseUrl); } catch { throw new WatchRelayError('The public watch relay URL is invalid.', 'configuration'); }
  const hostname = base.hostname.replace(/^\[|\]$/g, '');
  const testHost = options.allowLocalhostForTests === true && (hostname === 'localhost' || loopback(hostname));
  if ((base.protocol !== 'https:' && !(testHost && base.protocol === 'http:')) || base.username || base.password || base.search || base.hash || base.pathname !== '/' || !testHost && (hostname === 'localhost' || hostname.endsWith('.localhost') || isIP(hostname) && !isPublicRelayAddress(hostname))) throw new WatchRelayError('The watch relay must use a public HTTPS origin without credentials or a path.', 'configuration');
  if (!SLUG.test(options.slug) || typeof options.token !== 'string' || Buffer.byteLength(options.token) < 32 || /[\r\n]/.test(options.token)) throw new WatchRelayError('The watch relay slug or private publishing token is invalid.', 'configuration');
  return base;
}
async function request(base: URL, route: string, token: string, options: WatchRelayOptions, body: Buffer, signal?: AbortSignal, method = 'POST'): Promise<Record<string, unknown>> {
  if (signal?.aborted) throw new WatchRelayError('Watch publishing was cancelled.', 'cancelled');
  const controller = new AbortController(), timeout = setTimeout(() => controller.abort(new Error('deadline')), options.timeoutMs ?? 10000);
  const abort = () => controller.abort(signal?.reason); signal?.addEventListener('abort', abort, { once: true }); if (signal?.aborted) abort();
  try {
    // Resolve and pin a fresh approved address for each connection. Redirects
    // are rejected, so the Authorization token cannot move to another origin.
    const hostname = base.hostname.replace(/^\[|\]$/g, '');
    const addresses = await Promise.race([lookup(hostname, { all: true, verbatim: true }), new Promise<never>((_resolve, reject) => { controller.signal.addEventListener('abort', () => reject(new WatchRelayError('Watch relay lookup timed out.', signal?.aborted ? 'cancelled' : 'timeout')), { once: true }); })]);
    if (!addresses.length || addresses.some(item => !(options.allowLocalhostForTests === true && (hostname === 'localhost' || loopback(hostname)) && loopback(item.address)) && !isPublicRelayAddress(item.address))) throw new WatchRelayError('The watch relay resolved to a non-public address.', 'configuration');
    const address = addresses[0];
    return await new Promise((resolve, reject) => {
      const transport = base.protocol === 'https:' ? https : http;
      const req = transport.request(new URL(route, base), {
        method, agent: false, family: address.family,
        lookup: (_hostname, _options, callback) => callback(null, address.address, address.family),
        signal: controller.signal,
        headers: { Authorization: `Bearer ${token}`, 'Content-Type': route.endsWith('.ts') ? 'video/mp2t' : route.endsWith('.m3u8') ? 'application/vnd.apple.mpegurl' : 'application/json', 'Content-Length': body.length },
      }, response => {
        const chunks: Buffer[] = []; let size = 0;
        response.on('data', (chunk: Buffer) => { size += chunk.length; if (size > 8192) { response.destroy(); reject(new WatchRelayError('The watch relay response exceeded its limit.', 'rejected')); } else chunks.push(chunk); });
        response.once('error', () => reject(new WatchRelayError('The watch relay connection was interrupted.', 'connection')));
        response.once('end', () => {
          if ((response.statusCode ?? 0) < 200 || (response.statusCode ?? 500) >= 300) { reject(new WatchRelayError(response.statusCode === 409 ? 'This watch publishing session is no longer current.' : `The watch relay rejected publishing (${response.statusCode ?? 0}).`, 'rejected', response.statusCode === 409 ? 409 : undefined)); return; }
          try { resolve(JSON.parse(Buffer.concat(chunks).toString('utf8')) as Record<string, unknown>); } catch { reject(new WatchRelayError('The watch relay returned an invalid response.', 'rejected')); }
        });
      });
      req.once('error', () => reject(new WatchRelayError(controller.signal.aborted ? signal?.aborted ? 'Watch publishing was cancelled.' : 'The watch relay timed out.' : 'The watch relay could not be reached.', controller.signal.aborted ? signal?.aborted ? 'cancelled' : 'timeout' : 'connection')));
      req.end(body);
    });
  } finally { clearTimeout(timeout); signal?.removeEventListener('abort', abort); }
}

export function createBroadcastRelay(options: WatchRelayOptions): WatchRelayAdapter {
  const base = validateOptions(options), route = `/api/push/${options.slug}`;
  const maxSegment = options.maxSegmentBytes ?? 8 * 1024 * 1024;
  let session: string | undefined, generation = 0, publishing = false;
  const uploaded = new Set<string>();
  return {
    configured: true, publicUrl: new URL(`/watch/${options.slug}`, base).href,
    async begin({ epoch, signal }) {
      const ownGeneration = ++generation; session = undefined; uploaded.clear();
      const response = await request(base, `${route}/sessions`, options.token, options, Buffer.from(JSON.stringify({ epoch })), signal);
      if (ownGeneration !== generation || signal?.aborted) throw new WatchRelayError('Watch publishing was cancelled.', 'cancelled');
      if (typeof response.sessionId !== 'string' || !SESSION.test(response.sessionId)) throw new WatchRelayError('The watch relay returned an invalid session.', 'rejected');
      session = response.sessionId;
    },
    async publish({ directory, playlist, signal }) {
      if (publishing) throw new WatchRelayError('A watch update is already in progress.', 'busy');
      if (!session) throw new WatchRelayError('The watch relay session has not started.', 'rejected');
      if (playlist !== 'index.m3u8') throw new WatchRelayError('The watch playlist name is invalid.', 'media');
      const ownSession = session, ownGeneration = generation; publishing = true;
      const assertCurrent = () => { if (ownGeneration !== generation || ownSession !== session || signal?.aborted) throw new WatchRelayError('Watch publishing was cancelled.', 'cancelled'); };
      try {
        const folder = path.resolve(directory), stat = await fs.lstat(path.join(folder, playlist));
        if (!stat.isFile() || stat.isSymbolicLink() || stat.size > MAX_PLAYLIST) throw new WatchRelayError('The watch playlist is invalid or too large.', 'media');
        const bytes = await fs.readFile(path.join(folder, playlist));
        const text = bytes.toString('utf8'), names = text.split(/\r?\n/).map(value => value.trim()).filter(value => value && !value.startsWith('#'));
        if (!text.startsWith('#EXTM3U\n') || text.includes('\0') || names.length < 1 || names.length > 12 || names.some(name => !SEGMENT.test(name)) || new Set(names).size !== names.length || /URI\s*=/.test(text)) throw new WatchRelayError('Only generated local HLS segments can be published.', 'media');
        for (const name of names) {
          assertCurrent(); if (uploaded.has(name)) continue;
          const filename = path.join(folder, name), segmentStat = await fs.lstat(filename);
          if (!segmentStat.isFile() || segmentStat.isSymbolicLink() || segmentStat.size < 1 || segmentStat.size > maxSegment) throw new WatchRelayError('A watch media segment is invalid or too large.', 'media');
          const segment = await fs.readFile(filename); if (segment.length > maxSegment) throw new WatchRelayError('A watch media segment exceeded its limit.', 'media');
          assertCurrent(); await request(base, `${route}/${ownSession}/${name}`, options.token, options, segment, signal, 'PUT'); assertCurrent(); uploaded.add(name);
        }
        assertCurrent();
        // Even when unchanged, the server must validate the existing live window
        // after a connection failure; it never refreshes freshness for repeats.
        await request(base, `${route}/${ownSession}/index.m3u8`, options.token, options, bytes, signal, 'PUT'); assertCurrent();
        // Bound metadata for long services; a removed segment is never needed
        // again in the increasing FFmpeg live window.
        const minimum = BigInt(names[0].slice(8, -3)) - 12n;
        for (const name of uploaded) if (BigInt(name.slice(8, -3)) < minimum) uploaded.delete(name);
      } catch (error) { if (error instanceof WatchRelayError) throw error; throw new WatchRelayError('The local live picture is not ready for publishing.', 'media'); }
      finally { publishing = false; }
    },
    async finish({ signal } = {}) {
      const current = session; ++generation; session = undefined; uploaded.clear();
      if (current) await request(base, `${route}/${current}/end`, options.token, { ...options, timeoutMs: Math.min(options.timeoutMs ?? 10000, 2500) }, Buffer.from('{}'), signal);
    },
  };
}

export function createWatchRelayFromEnv(env: NodeJS.ProcessEnv = process.env): WatchRelayAdapter {
  const empty = (configurationError?: string): WatchRelayAdapter => ({ configured: false, ...(configurationError ? { configurationError } : {}), async begin() { throw new WatchRelayError(configurationError ?? 'The public watch relay has not been configured.', 'configuration'); }, async publish() { throw new WatchRelayError('The public watch relay has not been configured.', 'configuration'); }, async finish() {} });
  if (!env.LUMEN_WATCH_RELAY_URL && !env.LUMEN_WATCH_RELAY_TOKEN && !env.LUMEN_WATCH_RELAY_SLUG) return empty();
  try { return createBroadcastRelay({ baseUrl: env.LUMEN_WATCH_RELAY_URL ?? '', token: env.LUMEN_WATCH_RELAY_TOKEN ?? '', slug: env.LUMEN_WATCH_RELAY_SLUG ?? '' }); }
  catch (error) { return empty(error instanceof WatchRelayError ? error.message : 'The public watch relay configuration is invalid.'); }
}
