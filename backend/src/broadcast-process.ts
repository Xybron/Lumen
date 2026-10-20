import { spawn, type ChildProcess, type SpawnOptions } from 'node:child_process';
import type { Writable, Readable } from 'node:stream';
import ffmpeg from 'ffmpeg-static';
import type { BroadcastProfile } from '../../shared/broadcast.js';

export const BROADCAST_INPUT_LIMIT = 16 * 1024 * 1024;
export const BROADCAST_CHUNK_LIMIT = 8 * 1024 * 1024;
export const BROADCAST_SINK_LIMIT = 2 * 1024 * 1024;
export type BroadcastSpawn = (file: string, args: readonly string[], options: SpawnOptions) => ChildProcess;
export type BroadcastEncoder = 'videotoolbox' | 'software';
export type BroadcastFailureCode = 'protocol' | 'certificate' | 'publish-rejected' | 'network' | 'encoder' | 'input' | 'storage' | 'backpressure' | 'unknown';
/** Fixed-token streaming classifier: only integer match positions and a code
 * survive a callback. No diagnostic line, URL, key or query is retained. */
export function createBroadcastFailureClassifier() {
  const patterns: Array<[BroadcastFailureCode, string]> = [
    ['protocol', 'not on whitelist'], ['protocol', 'protocol not found'], ['protocol', 'unrecognized option'], ['protocol', 'option not found'],
    ['certificate', 'certificate verify failed'], ['certificate', 'certificate verification failed'], ['certificate', 'certificate is not trusted'], ['certificate', 'certificate has expired'], ['certificate', 'unable to get local issuer'], ['certificate', 'certificate hostname mismatch'],
    ['publish-rejected', 'netstream.publish.badname'], ['publish-rejected', 'netstream.publish.rejected'], ['publish-rejected', 'authentication failed'], ['publish-rejected', 'access denied'], ['publish-rejected', 'invalid stream key'], ['publish-rejected', 'publish denied'], ['publish-rejected', 'already publishing'], ['publish-rejected', 'server error:'], ['publish-rejected', '403 forbidden'], ['publish-rejected', '401 unauthorized'],
    ['encoder', 'cannot create compression session'], ['encoder', 'error while opening encoder'], ['encoder', 'error initializing output stream'], ['encoder', 'hardware encoder may be busy'], ['encoder', 'unknown encoder'],
    ['input', 'invalid data found'], ['input', 'could not find codec parameters'], ['storage', 'no space left on device'],
    ['network', 'connection refused'], ['network', 'connection timed out'], ['network', 'connection reset'], ['network', 'network is unreachable'], ['network', 'failed to resolve'], ['network', 'could not resolve'], ['network', 'cannot read rtmp handshake response'], ['network', 'input/output error'], ['network', 'broken pipe'], ['network', 'i/o error'],
  ];
  const rank: Record<BroadcastFailureCode, number> = { unknown: 0, backpressure: 1, network: 2, input: 3, encoder: 4, storage: 5, 'publish-rejected': 6, certificate: 7, protocol: 8 };
  const positions = patterns.map(() => 0); let result: BroadcastFailureCode = 'unknown';
  return { code: () => result, push(bytes: Buffer | string) {
    const text = String(bytes).toLowerCase();
    for (let i = 0; i < patterns.length; i++) {
      const [code, pattern] = patterns[i]; if (rank[code] <= rank[result]) continue;
      let at = positions[i];
      for (const character of text) {
        at = character === pattern[at] ? at + 1 : character === pattern[0] ? 1 : 0;
        if (at === pattern.length) { result = code; at = 0; break; }
      }
      positions[i] = at;
    }
  } };
}
export function broadcastFailureMessage(code: BroadcastFailureCode): string {
  return ({ protocol: 'Streaming transport is unavailable in this encoder build. Check the Lumen update before retrying.',
    certificate: 'The secure destination certificate could not be verified. Check the station clock, network inspection and trusted certificates.',
    'publish-rejected': 'The platform rejected publishing. Check its stream key, event settings and whether another encoder is already live.',
    network: 'The destination connection failed. Check internet access, firewall and the platform ingest service.',
    encoder: 'The stream encoder could not initialize. Try 720p or restart only the stream.',
    input: 'The stream media could not be read. Restart only the stream; Studio and recording are unchanged.',
    storage: 'Watch packaging stopped because station storage is full. Free some storage before retrying.',
    backpressure: 'The destination could not keep up. Check available upload bandwidth before retrying.',
    unknown: 'The destination stopped without a confirmed connection. Check its live dashboard and stream setup before retrying.' })[code];
}
export function broadcastFailureCanRetry(code: BroadcastFailureCode, failures: number) {
  return !['protocol', 'certificate', 'publish-rejected', 'storage'].includes(code) && failures < 5;
}
export interface BroadcastProcess {
  child: ChildProcess;
  input: Writable;
  output: Readable;
  done: Promise<number | null>;
  failure(): BroadcastFailureCode;
  terminate(): Promise<void>;
}
export function broadcastEncoderArguments(profile: BroadcastProfile, encoder: BroadcastEncoder = 'software'): string[] {
  const [width, height, bitrate] = profile === '1080p' ? [1920, 1080, 4500] : [1280, 720, 2500];
  return ['-hide_banner', '-nostdin', '-loglevel', 'error', '-threads', '2', '-fflags', '+genpts',
    '-protocol_whitelist', 'pipe', '-format_whitelist', 'matroska,webm', '-probesize', '1048576', '-analyzeduration', '1000000', '-i', 'pipe:0',
    '-map', '0:v:0', '-map', '0:a:0', '-sn', '-dn', '-filter_threads', '1',
    '-vf', `scale=${width}:${height}:force_original_aspect_ratio=decrease:force_divisible_by=2,pad=${width}:${height}:(ow-iw)/2:(oh-ih)/2,setsar=1`,
    ...(encoder === 'videotoolbox' ? ['-c:v', 'h264_videotoolbox', '-allow_sw', '0', '-realtime', '1', '-constant_bit_rate', '1', '-bf', '0'] : ['-c:v', 'libx264', '-preset', 'veryfast', '-tune', 'zerolatency', '-x264-params', 'nal-hrd=cbr:force-cfr=1']),
    '-profile:v', 'high', '-pix_fmt', 'yuv420p', '-r', '30', '-b:v', `${bitrate}k`, '-minrate', `${bitrate}k`, '-maxrate', `${bitrate}k`, '-bufsize', `${bitrate * 2}k`, '-g', '60', '-keyint_min', '60', '-sc_threshold', '0',
    '-c:a', 'aac', '-b:a', '160k', '-ar', '48000', '-ac', '2', '-max_muxing_queue_size', '128', '-threads', '2',
    '-map_metadata', '-1', '-progress', 'pipe:3', '-stats_period', '0.5', '-nostats', '-mpegts_flags', '+resend_headers',
    '-muxdelay', '0', '-muxpreload', '0', '-flush_packets', '1', '-f', 'mpegts', 'pipe:1'];
}
export const broadcastRemuxInput = () => ['-hide_banner', '-nostdin', '-loglevel', 'error', '-y', '-threads', '1',
  '-protocol_whitelist', 'pipe', '-format_whitelist', 'mpegts', '-probesize', '1048576', '-analyzeduration', '1000000', '-f', 'mpegts', '-i', 'pipe:0',
  '-map', '0:v:0', '-map', '0:a:0', '-sn', '-dn', '-c', 'copy', '-map_metadata', '-1', '-max_muxing_queue_size', '128',
  '-progress', 'pipe:3', '-stats_period', '0.5', '-nostats'];
export function broadcastRtmpsArguments(target: string): string[] {
  // The input remains pipe-only; the output gets its own minimal transport
  // allowlist. Do not permit arbitrary HTTP/file/network output protocols.
  return [...broadcastRemuxInput(), '-protocol_whitelist', 'rtmps,tls,tcp', '-rw_timeout', '8000000', '-flvflags', 'no_duration_filesize', '-f', 'flv', target];
}
export function broadcastRtmpBridgeArguments(local: string, secureTcUrl: string): string[] {
  const destination = new URL(local), upstream = new URL(secureTcUrl);
  if (destination.protocol !== 'rtmp:' || destination.hostname !== '127.0.0.1' || !destination.port || destination.username || destination.password || destination.hash
    || upstream.protocol !== 'rtmps:' || !['a.rtmps.youtube.com', 'live-api-s.facebook.com'].includes(upstream.hostname) || upstream.port && upstream.port !== '443' || upstream.username || upstream.password || upstream.search || upstream.hash) throw new Error('Invalid private streaming connection.');
  return [...broadcastRemuxInput(), '-protocol_whitelist', 'rtmp,tcp', '-rw_timeout', '8000000', '-rtmp_tcurl', secureTcUrl, '-flvflags', 'no_duration_filesize', '-f', 'flv', local];
}
export function broadcastHlsArguments(directory: string): string[] {
  return [...broadcastRemuxInput(), '-f', 'hls', '-hls_time', '2', '-hls_list_size', '6', '-hls_delete_threshold', '2', '-hls_start_number_source', 'epoch_us',
    '-hls_flags', 'delete_segments+temp_file+independent_segments+discont_start', '-hls_segment_type', 'mpegts',
    '-hls_segment_filename', `${directory}/segment-%08d.ts`, `${directory}/index.m3u8`];
}
export function timeout<T>(promise: Promise<T>, ms: number, message = 'The operation timed out.'): Promise<T> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(message)), ms);
    promise.then(value => { clearTimeout(timer); resolve(value); }, error => { clearTimeout(timer); reject(error); });
  });
}
/** Diagnostics are reduced immediately to finite codes, never retained/logged:
 * FFmpeg can include the complete private URL and query credentials. */
export function spawnBroadcastProcess(args: string[], progress: (value: Record<string, string>) => void,
  factory: BroadcastSpawn = spawn): BroadcastProcess {
  if (!ffmpeg) throw new Error('The stream encoder is unavailable.');
  const child = factory(ffmpeg, args, { stdio: ['pipe', 'pipe', 'pipe', 'pipe'], windowsHide: true });
  const input = child.stdin!, output = child.stdout!;
  let finished = false, stopping: Promise<void> | null = null, tail = '', fields: Record<string, string> = {};
  const classifier = createBroadcastFailureClassifier();
  const done = new Promise<number | null>(resolve => {
    const finish = (code: number | null) => { if (finished) return; finished = true; resolve(code); };
    child.once('error', () => finish(-1)); child.once('close', finish);
  });
  // Always consume child errors, even if the destination is stopped between a
  // write and its callback. No EPIPE may escape into the live backend process.
  input.on('error', () => {}); output.on('error', () => {}); child.stderr?.on('data', bytes => classifier.push(bytes));
  const status = child.stdio[3] as Readable | null;
  status?.on('data', chunk => {
    tail = (tail + chunk.toString()).slice(-8192);
    const lines = tail.split(/\r?\n/); tail = lines.pop() ?? '';
    for (const line of lines) {
      const at = line.indexOf('='); if (at < 0) continue;
      fields[line.slice(0, at)] = line.slice(at + 1);
      if (line.startsWith('progress=')) { progress(fields); fields = {}; }
    }
  });
  return { child, input, output, done, failure: classifier.code, terminate() {
    if (stopping) return stopping;
    stopping = (async () => {
      if (finished) return;
      input.destroy(); child.kill('SIGTERM');
      try { await timeout(done, 1200); }
      catch { child.kill('SIGKILL'); await timeout(done, 1200).catch(() => {}); }
    })();
    return stopping;
  } };
}

const encoderProbes = new Map<BroadcastProfile, { at: number; result: Promise<BroadcastEncoder> }>();
/** Codec names alone do not prove hardware access (sandboxing/busy devices can
 * deny a session). Require real encoded packets with software fallback disabled. */
export function selectBroadcastEncoder(profile: BroadcastProfile): Promise<BroadcastEncoder> {
  if (process.platform !== 'darwin') return Promise.resolve('software');
  const cached = encoderProbes.get(profile); if (cached && Date.now() - cached.at < 300_000) return cached.result;
  const result = (async (): Promise<BroadcastEncoder> => {
    let probe: BroadcastProcess | undefined;
    try {
      const [size, bitrate] = profile === '1080p' ? ['1920x1080', '4500k'] : ['1280x720', '2500k'];
      let encodedBytes = 0;
      probe = spawnBroadcastProcess(['-hide_banner', '-nostdin', '-loglevel', 'error', '-f', 'lavfi', '-i', `color=c=black:s=${size}:r=30`, '-frames:v', '8', '-an',
        '-c:v', 'h264_videotoolbox', '-allow_sw', '0', '-realtime', '1', '-constant_bit_rate', '1', '-profile:v', 'high', '-pix_fmt', 'yuv420p', '-b:v', bitrate, '-g', '60', '-bf', '0',
        '-progress', 'pipe:3', '-nostats', '-f', 'mpegts', 'pipe:1'], () => {});
      probe.output.on('data', bytes => { encodedBytes += bytes.length; }); probe.input.end();
      return await timeout(probe.done, 4000) === 0 && encodedBytes > 188 ? 'videotoolbox' : 'software';
    } catch { return 'software'; }
    finally { await probe?.terminate(); }
  })();
  encoderProbes.set(profile, { at: Date.now(), result }); return result;
}
export function disableBroadcastHardware(profile: BroadcastProfile) {
  encoderProbes.set(profile, { at: Date.now(), result: Promise.resolve('software') });
}

/** Non-blocking fanout: a slow sink is discarded rather than backpressuring the
 * shared encoder. The parent can reconnect it at a later MPEG-TS keyframe. */
export function writeBroadcastSink(input: Writable, bytes: Buffer): boolean {
  if (input.destroyed || input.writableEnded || input.writableLength + bytes.length > BROADCAST_SINK_LIMIT) return false;
  try { input.write(bytes, () => {}); return true; } catch { return false; }
}
