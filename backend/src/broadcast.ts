import fs from 'node:fs/promises';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import ffmpeg from 'ffmpeg-static';
import type { BroadcastConfigInput, BroadcastDestinationId, BroadcastPreflight, BroadcastSession, BroadcastSinkStatus, BroadcastSnapshot } from '../../shared/broadcast.js';
import { BROADCAST_CHUNK_LIMIT, BROADCAST_INPUT_LIMIT, broadcastEncoderArguments, broadcastHlsArguments, broadcastRtmpBridgeArguments, broadcastFailureMessage, broadcastFailureCanRetry, selectBroadcastEncoder, disableBroadcastHardware, spawnBroadcastProcess, timeout, writeBroadcastSink, type BroadcastEncoder, type BroadcastFailureCode, type BroadcastProcess, type BroadcastSpawn } from './broadcast-process.js';
import { openBroadcastRtmpsTransport, type BroadcastRtmpsTransport, type BroadcastTlsConnect } from './broadcast-rtmps.js';

export class BroadcastError extends Error { constructor(public status: number, message: string) { super(message); } }
export interface BroadcastWatchRelay {
  configured: boolean;
  publicUrl?: string;
  begin(options: { epoch: string; signal?: AbortSignal }): Promise<unknown>;
  publish(options: { directory: string; playlist: string; signal?: AbortSignal }): Promise<unknown>;
  finish(options?: { signal?: AbortSignal }): Promise<unknown>;
}
const destinationId = z.enum(['youtube', 'facebook']);
const keySchema = z.string().trim().min(1).max(2048).regex(/^[\x21-\x7e]+$/);
const inputSchema = z.object({
  profile: z.enum(['720p', '1080p']).optional(), recordOnStart: z.boolean().optional(),
  destinations: z.array(z.object({ id: destinationId, enabled: z.boolean(), streamKey: keySchema.optional(), clearKey: z.boolean().optional() }).strict()).max(2).optional(),
  watch: z.object({ enabled: z.boolean() }).strict().optional(),
}).strict().superRefine((value, ctx) => {
  const ids = value.destinations?.map(d => d.id) ?? [];
  if (new Set(ids).size !== ids.length) ctx.addIssue({ code: z.ZodIssueCode.custom, message: 'Choose each destination only once.' });
  if (value.destinations?.some(d => d.clearKey && d.streamKey)) ctx.addIssue({ code: z.ZodIssueCode.custom, message: 'Save or clear a key, not both.' });
});
const configSchema = z.object({ version: z.literal(1), profile: z.enum(['720p', '1080p']), recordOnStart: z.boolean(),
  destinations: z.array(z.object({ id: destinationId, enabled: z.boolean(), key: keySchema.optional() }).strict()).length(2),
  watch: z.object({ enabled: z.boolean() }).strict(),
}).strict().refine(value => new Set(value.destinations.map(d => d.id)).size === 2);
type PrivateConfig = z.infer<typeof configSchema>;
const ENDPOINTS = { youtube: 'rtmps://a.rtmps.youtube.com:443/live2/', facebook: 'rtmps://live-api-s.facebook.com:443/rtmp/' } as const;
export function broadcastDestinationUrl(id: BroadcastDestinationId, key: string): string {
  const parsed = keySchema.safeParse(key);
  // A key is opaque publisher data, not a URL. It can contain the platform's
  // query suffix, but never replace the fixed RTMPS authority or protocol.
  if (!parsed.success || /^(?:[a-z]+:|\/\/)/i.test(parsed.data)) throw new BroadcastError(422, 'Enter a platform stream key, not a server URL.');
  return ENDPOINTS[id] + parsed.data;
}
const isRunning = (run: Run) => !run.stopping && ['starting', 'live'].includes(run.session.state);
interface Sink {
  status: BroadcastSinkStatus;
  process: BroadcastProcess | null;
  retry: ReturnType<typeof setTimeout> | null;
  stopped: boolean;
  starting: boolean;
  backpressureAt: number;
  failures: number;
  healthyAt: number;
  transport: BroadcastRtmpsTransport | null;
}
interface Run {
  session: BroadcastSession;
  config: PrivateConfig;
  directory: string;
  encoder: BroadcastProcess;
  encoderKind: BroadcastEncoder;
  sinks: Map<string, Sink>;
  nextChunk: number;
  queuedBytes: number;
  ingest: Promise<unknown>;
  stopping: boolean;
  stopTask: Promise<void> | null;
  encoded: boolean;
  inputAt: number;
  outputAt: number;
  startedAt: number;
  watchController: AbortController;
  watchBusy: boolean;
  relayStarted: boolean;
  relayEpoch: string;
  relayPublished: string;
  relayRetryAt: number;
}
async function relayCall<T>(parent: AbortSignal, call: (signal: AbortSignal) => Promise<T>, milliseconds: number) {
  const controller = new AbortController(), abort = () => controller.abort();
  parent.addEventListener('abort', abort, { once: true }); if (parent.aborted) abort();
  try { return await timeout(call(controller.signal), milliseconds); }
  finally { controller.abort(); parent.removeEventListener('abort', abort); }
}
export async function createBroadcast(options: {
  dir: string;
  watchRelay?: BroadcastWatchRelay | null;
  onStatus?: (snapshot: BroadcastSnapshot) => void;
  onFatal?: (sessionId: string) => void;
  /** Local relay marker; normal social destination controls remain available. */
  localWatch?: boolean;
  /** Read-only startup fallback granted by the local launcher integration. */
  initialConfigPath?: string;
  /** Dependency injection for isolated child-process tests, never HTTP input. */
  spawn?: BroadcastSpawn;
  connectTls?: BroadcastTlsConnect;
}) {
  const directory = path.resolve(options.dir), configPath = path.join(directory, 'broadcast-private.json');
  if (options.initialConfigPath && !options.localWatch) throw new BroadcastError(422, 'Saved settings can only be copied into the local Watch workspace.');
  if (options.localWatch && options.initialConfigPath) {
    const canonical = async (filename: string) => fs.realpath(filename).catch(async () => path.join(await fs.realpath(path.dirname(filename)).catch(() => path.resolve(path.dirname(filename))), path.basename(filename)));
    if (await canonical(configPath) === await canonical(path.resolve(options.initialConfigPath))) throw new BroadcastError(422, 'Local Watch requires a separate temporary settings workspace.');
  }
  await fs.mkdir(directory, { recursive: true, mode: 0o700 });
  await fs.chmod(directory, 0o700);
  let config: PrivateConfig = { version: 1, profile: '720p', recordOnStart: true,
    destinations: [{ id: 'youtube', enabled: false }, { id: 'facebook', enabled: false }], watch: { enabled: false } };
  let initialized = false;
  try { config = configSchema.parse(JSON.parse(await fs.readFile(configPath, 'utf8'))); await fs.chmod(configPath, 0o600); initialized = true; }
  catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw new BroadcastError(503, 'Go Live settings could not be read. The existing private settings file has been preserved.'); }
  if (options.localWatch && !initialized) {
    if (options.initialConfigPath) {
      try {
        const info = await fs.lstat(options.initialConfigPath);
        if (!info.isFile() || info.isSymbolicLink() || info.size > 16384) throw new Error();
        const file = await fs.open(options.initialConfigPath, 'r');
        try {
          // Bound the read even if the file grows after the initial stat. Do not
          // chmod, rename, rewrite or repair the station's private settings.
          const bytes = Buffer.alloc(16385), read = await file.read(bytes, 0, bytes.length, 0);
          if (read.bytesRead > 16384) throw new Error();
          config = configSchema.parse(JSON.parse(bytes.subarray(0, read.bytesRead).toString('utf8')));
        } finally { await file.close(); }
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw new BroadcastError(503, 'Saved Go Live settings could not be read. Existing settings are preserved; check the private settings before starting Local Watch.');
      }
    }
    config.watch.enabled = true;
    await saveConfig(config);
  }
  // Broadcast data is disposable and never shares a directory with recordings.
  // Only our own UUID-named session directories can be reclaimed at startup.
  for (const entry of await fs.readdir(directory, { withFileTypes: true })) {
    if (entry.isDirectory() && /^broadcast_[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(entry.name)) await fs.rm(path.join(directory, entry.name), { recursive: true, force: true });
    if (entry.isFile() && /^broadcast-private\.json\.[0-9a-f-]{36}\.tmp$/.test(entry.name)) await fs.unlink(path.join(directory, entry.name));
  }
  let current: Run | null = null, last: BroadcastSession | null = null, closed = false, lock: Promise<unknown> = Promise.resolve(), notifiedAt = 0;
  const relay = options.watchRelay;
  const serial = <T>(work: () => Promise<T>): Promise<T> => { const next = lock.then(work); lock = next.catch(() => {}); return next; };
  function preflight(): BroadcastPreflight {
    const selected = config.destinations.filter(d => d.enabled), watchSelected = config.watch.enabled;
    const checks: BroadcastPreflight['checks'] = [
      { id: 'encoder', ok: !!ffmpeg, message: ffmpeg ? 'Local H.264/AAC encoder is available.' : 'The local encoder is unavailable.' },
      { id: 'destinations', ok: selected.length + Number(watchSelected) > 0, message: selected.length + Number(watchSelected) > 0 ? 'Stream destinations selected.' : 'Enable at least one destination.' },
      ...selected.map(d => ({ id: d.id, ok: !!d.key, message: d.key ? `${d.id === 'youtube' ? 'YouTube' : 'Facebook'} stream key is configured.` : `Add the ${d.id === 'youtube' ? 'YouTube' : 'Facebook'} stream key.` })),
      ...(watchSelected ? [{ id: 'watch', ok: relay?.configured === true, message: relay?.configured ? 'Independent Watch relay is configured.' : 'The public Watch relay is not configured on this station.' }] : []),
    ];
    return { ready: !closed && checks.every(c => c.ok), checks, estimatedUploadKbps: Math.ceil((config.profile === '1080p' ? 4660 : 2660) * (selected.length + Number(watchSelected)) * 1.15) };
  }
  function snapshot(): BroadcastSnapshot {
    return { ...(options.localWatch ? { mode: 'local-watch' as const } : {}), config: { profile: config.profile, recordOnStart: config.recordOnStart,
      destinations: config.destinations.map(d => ({ id: d.id, enabled: d.enabled, configured: !!d.key })),
      watch: { enabled: config.watch.enabled, configured: relay?.configured === true, ...(relay?.publicUrl ? { publicUrl: relay.publicUrl } : {}) } },
      session: structuredClone(current?.session ?? last), preflight: preflight() };
  }
  function notify(force = false) {
    if (!force && Date.now() - notifiedAt < 500) return;
    notifiedAt = Date.now(); try { options.onStatus?.(snapshot()); } catch { /* UI callback cannot stop the media service. */ }
  }
  async function saveConfig(next: PrivateConfig) {
    const temporary = `${configPath}.${randomUUID()}.tmp`;
    try {
      const file = await fs.open(temporary, 'wx', 0o600);
      try { await file.writeFile(JSON.stringify(next)); await file.sync(); } finally { await file.close(); }
      await fs.rename(temporary, configPath);
    } catch { throw new BroadcastError(507, 'Go Live settings could not be saved. Check station storage and try again.'); }
    finally { await fs.unlink(temporary).catch(() => {}); }
  }
  async function configure(input: BroadcastConfigInput) {
    const parsed = inputSchema.safeParse(input);
    if (!parsed.success) throw new BroadcastError(422, 'Choose supported Go Live settings and valid stream keys.');
    return serial(async () => {
      if (closed) throw new BroadcastError(503, 'Streaming service is shutting down.');
      if (current) throw new BroadcastError(409, 'Stop streaming before changing this setup.');
      const next = structuredClone(config), value = parsed.data;
      if (value.profile) next.profile = value.profile;
      if (value.recordOnStart !== undefined) next.recordOnStart = value.recordOnStart;
      if (value.watch) next.watch = value.watch;
      for (const patch of value.destinations ?? []) {
        const target = next.destinations.find(d => d.id === patch.id)!;
        target.enabled = patch.enabled;
        if (patch.streamKey !== undefined) { broadcastDestinationUrl(patch.id, patch.streamKey); target.key = patch.streamKey; }
        if (patch.clearKey) delete target.key;
      }
      await saveConfig(next); config = next; notify(true); return snapshot();
    });
  }
  function updateLive(run: Run) {
    if (!isRunning(run)) return;
    const live = run.encoded && [...run.sinks.values()].some(sink => sink.status.state === 'live' && (sink.status.id !== 'watch' || run.session.watch.state === 'live'));
    run.session.state = live ? 'live' : 'starting'; notify();
  }
  async function stopRun(run: Run, failure?: string) {
    if (run.stopTask) return run.stopTask;
    run.stopping = true; run.session.state = failure ? 'error' : 'stopping'; if (failure) run.session.error = failure;
    run.watchController.abort();
    for (const sink of run.sinks.values()) { if (sink.retry) clearTimeout(sink.retry); sink.retry = null; }
    notify(true);
    run.stopTask = (async () => {
      // Finish the encoder first so all sinks can consume its buffered tail.
      run.encoder.input.end();
      await timeout(run.encoder.done, 2500).catch(() => run.encoder.terminate());
      await Promise.all([...run.sinks.values()].map(async sink => {
        sink.stopped = true;
        const child = sink.process; if (!child) { await sink.transport?.close(); sink.transport = null; return; }
        child.input.end(); await timeout(child.done, 2000).catch(() => child.terminate()); sink.process = null;
        await sink.transport?.close(); sink.transport = null;
      }));
      // Publish the final complete playlist before ending the public session.
      if (run.config.watch.enabled && relay?.configured && run.relayStarted) {
        const finalController = new AbortController();
        try { await timeout(relay.publish({ directory: run.directory, playlist: 'index.m3u8', signal: finalController.signal }), 2500); } catch { /* Last usable playlist remains public. */ }
        finally { finalController.abort(); }
        const endController = new AbortController();
        try { await timeout(relay.finish({ signal: endController.signal }), 2500); } catch { /* Relay has its own stale-session timeout. */ }
        finally { endController.abort(); }
      }
      for (const sink of run.sinks.values()) if (!['disabled', 'unconfigured'].includes(sink.status.state)) sink.status.state = failure ? 'error' : 'stopped';
      run.session.state = failure ? 'error' : 'stopped'; run.session.stoppedAt = new Date().toISOString(); last = structuredClone(run.session);
      if (current === run) current = null;
      await fs.rm(run.directory, { recursive: true, force: true }).catch(() => {});
      notify(true);
    })();
    return run.stopTask;
  }
  function fatal(run: Run, message: string) {
    if (!isRunning(run)) return;
    try { options.onFatal?.(run.session.id); } catch { /* Best-effort renderer notification. */ }
    void stopRun(run, message);
  }
  function stopIfNoDestination(run: Run) {
    const selected = [...run.sinks.values()].filter(sink => sink.status.state !== 'disabled');
    if (selected.length && selected.every(sink => sink.stopped && ['error', 'stopped'].includes(sink.status.state)) && selected.some(sink => sink.status.state === 'error')) {
      fatal(run, 'No selected destination remains connected. Stream encoding stopped to save resources; local recording and Studio are unchanged. Check the destination errors, then start again.');
    }
  }
  function retrySink(run: Run, sink: Sink, code: BroadcastFailureCode = 'unknown') {
    if (!isRunning(run) || sink.stopped || sink.retry) return;
    sink.healthyAt = 0; sink.failures++;
    if (!broadcastFailureCanRetry(code, sink.failures)) {
      sink.stopped = true; sink.status.state = 'error'; sink.status.error = `${broadcastFailureMessage(code)} Automatic retries paused.`;
      updateLive(run); notify(true); stopIfNoDestination(run); return;
    }
    sink.status.state = 'retrying'; sink.status.retries++; sink.status.error = `${broadcastFailureMessage(code)} Retrying independently.`;
    const delay = Math.min(30_000, 1000 * 2 ** Math.min(5, sink.status.retries - 1));
    sink.retry = setTimeout(() => { sink.retry = null; launchSink(run, sink); }, delay); sink.retry.unref(); updateLive(run); notify(true);
  }
  function healthySink(sink: Sink) {
    if (!sink.healthyAt) sink.healthyAt = Date.now();
    // A first accepted frame is not a stable connection: repeated short-lived
    // publishes must eventually pause rather than resetting the retry budget.
    if (Date.now() - sink.healthyAt >= 30_000) sink.failures = 0;
  }
  function loseSink(run: Run, sink: Sink, child: BroadcastProcess, code = child.failure()) {
    if (sink.process !== child) return;
    const transport = sink.transport; sink.transport = null;
    const transportCode = transport?.failure();
    const failure = transportCode && transportCode !== 'unknown' ? transportCode : code;
    void transport?.close(); sink.process = null; void child.terminate(); retrySink(run, sink, failure);
  }
  async function launchSink(run: Run, sink: Sink) {
    if (!isRunning(run) || sink.stopped || sink.process || sink.starting) return;
    sink.starting = true; sink.status.state = 'connecting'; sink.status.error = undefined; sink.backpressureAt = 0; sink.healthyAt = 0;
    try {
      if (sink.status.id === 'watch') {
        // A new packager has a fresh discontinuity and globally unique segment
        // counter. Remove only the previous packager's known generated files;
        // FFmpeg cannot retire them itself after its process has restarted.
        for (const entry of await fs.readdir(run.directory, { withFileTypes: true })) if (entry.isFile() && (/^segment-\d{8,20}\.ts(?:\.tmp)?$/.test(entry.name) || /^index\.m3u8(?:\.tmp)?$/.test(entry.name))) await fs.unlink(path.join(run.directory, entry.name)).catch(() => {});
        if (!isRunning(run) || sink.stopped) return;
      }
      const destination = run.config.destinations.find(d => d.id === sink.status.id);
      let args: string[];
      if (sink.status.id === 'watch') args = broadcastHlsArguments(run.directory);
      else {
        const transport = await openBroadcastRtmpsTransport(broadcastDestinationUrl(destination!.id, destination!.key!), {
          connectTls: options.connectTls, onFailure: code => {
            const child = sink.process;
            if (sink.transport === transport && child) loseSink(run, sink, child, code);
          },
        });
        if (!isRunning(run) || sink.stopped) { await transport.close(); return; }
        sink.transport = transport;
        args = broadcastRtmpBridgeArguments(transport.url, transport.tcUrl);
      }
      const child = spawnBroadcastProcess(args, value => {
        if (sink.process !== child || sink.stopped || !isRunning(run)) return;
        if (sink.status.id !== 'watch' && (Number(value.out_time_us) > 0 || Number(value.out_time_ms) > 0)) { healthySink(sink); sink.status.state = 'live'; sink.status.error = undefined; updateLive(run); }
      }, options.spawn);
      sink.process = child; child.output.resume();
      void child.done.then(() => loseSink(run, sink, child));
    } catch { await sink.transport?.close(); sink.transport = null; retrySink(run, sink); }
    finally { sink.starting = false; }
    notify(true);
  }
  async function publishWatch(run: Run) {
    if (!isRunning(run) || run.watchBusy || !run.config.watch.enabled || !relay?.configured || run.session.watch.state === 'stopped' || Date.now() < run.relayRetryAt) return;
    run.watchBusy = true;
    const controller = run.watchController;
    const valid = () => isRunning(run) && !controller.signal.aborted && controller === run.watchController && !run.sinks.get('watch')?.stopped;
    let beginning = false;
    try {
      if (!run.relayStarted) {
        beginning = true;
        await relayCall(controller.signal, signal => relay.begin({ epoch: run.relayEpoch, signal }), 8000);
        if (!valid()) return; run.relayStarted = true;
        beginning = false;
      }
      let playlist: string;
      try { playlist = await fs.readFile(path.join(run.directory, 'index.m3u8'), 'utf8'); } catch { return; }
      if (!/#EXTINF:/.test(playlist) || playlist === run.relayPublished) return;
      if (!valid()) return;
      await relayCall(controller.signal, signal => relay.publish({ directory: run.directory, playlist: 'index.m3u8', signal }), 8000);
      if (!valid()) return;
      run.relayPublished = playlist; run.session.watch.state = 'live'; run.session.watch.error = undefined; run.relayRetryAt = 0; healthySink(run.sinks.get('watch')!); updateLive(run); notify(true);
    } catch (error) {
      if (!valid()) return;
      if ((error as { httpStatus?: number }).httpStatus === 409) {
        // A failed publish can mean the relay restarted or lost its window.
        // First re-begin the SAME epoch to preserve unknown-outcome/idempotent
        // retries. Only a definitive begin409 proves that epoch was fenced.
        if (beginning) run.relayEpoch = randomUUID();
        run.relayStarted = false; run.relayPublished = '';
      }
      const watchSink = run.sinks.get('watch')!;
      watchSink.healthyAt = 0; watchSink.failures++;
      const rejected = [401, 403].includes((error as { httpStatus?: number }).httpStatus ?? 0);
      if (rejected || watchSink.failures >= 5) {
        watchSink.stopped = true; run.session.watch.state = 'error'; run.session.watch.error = rejected ? 'Watch publishing access was rejected. Check the relay credentials on this station.' : 'Public Watch is unreachable. Automatic retries paused; retry after checking the relay and network.';
        run.watchController.abort(); const child = watchSink.process; watchSink.process = null; if (child) void child.terminate();
        updateLive(run); notify(true); stopIfNoDestination(run); return;
      }
      run.session.watch.state = 'retrying'; run.session.watch.retries++; run.session.watch.error = 'Public Watch relay could not be reached. Retrying without interrupting production.';
      run.relayRetryAt = Date.now() + Math.min(30_000, 1000 * 2 ** Math.min(5, run.session.watch.retries - 1)); updateLive(run); notify(true);
    } finally { run.watchBusy = false; }
  }
  async function start() {
    return serial(async () => {
      if (closed) throw new BroadcastError(503, 'Streaming service is shutting down.');
      if (current) throw new BroadcastError(409, 'A stream is already in progress.');
      const checks = preflight(); if (!checks.ready) throw new BroadcastError(409, checks.checks.find(c => !c.ok)?.message ?? 'Complete Go Live setup first.');
      const encoderKind = await selectBroadcastEncoder(config.profile);
      const disk = await fs.statfs(directory); if (disk.bavail * disk.bsize < 256 * 1024 * 1024) throw new BroadcastError(507, 'Free some station storage before going live.');
      const id = `broadcast_${randomUUID()}`, startedAt = Date.now(), sessionDirectory = path.join(directory, id);
      await fs.mkdir(sessionDirectory, { mode: 0o700 });
      const destinations: BroadcastSinkStatus[] = config.destinations.map(d => ({ id: d.id, state: d.enabled ? 'connecting' : 'disabled', retries: 0, bytes: 0 }));
      const watch: BroadcastSession['watch'] = { id: 'watch', state: config.watch.enabled ? 'connecting' : 'disabled', retries: 0, bytes: 0, ...(relay?.publicUrl ? { publicUrl: relay.publicUrl } : {}) };
      const session: BroadcastSession = { id, profile: config.profile, state: 'starting', startedAt: new Date(startedAt).toISOString(), chunks: 0, bytes: 0, destinations, watch };
      let run: Run;
      try {
        const encoder = spawnBroadcastProcess(broadcastEncoderArguments(config.profile, encoderKind), value => {
          if (!run || !isRunning(run)) return;
          if (Number(value.frame) > 0) run.encoded = true; updateLive(run);
        }, options.spawn);
        run = { session, config: structuredClone(config), directory: sessionDirectory, encoder, encoderKind, sinks: new Map(), nextChunk: 0, queuedBytes: 0, ingest: Promise.resolve(),
          stopping: false, stopTask: null, encoded: false, inputAt: 0, outputAt: 0, startedAt, watchController: new AbortController(), watchBusy: false, relayStarted: false, relayEpoch: randomUUID(), relayPublished: '', relayRetryAt: 0 };
        current = run;
        for (const status of [...destinations, watch]) {
          const sink: Sink = { status, process: null, retry: null, stopped: status.state === 'disabled', starting: false, backpressureAt: 0, failures: 0, healthyAt: 0, transport: null }; run.sinks.set(status.id, sink);
          if (!sink.stopped) launchSink(run, sink);
        }
        encoder.output.on('data', (bytes: Buffer) => {
          if (current !== run) return;
          run.outputAt = Date.now();
          for (const sink of run.sinks.values()) {
            const child = sink.process; if (!child || sink.stopped) continue;
            if (!writeBroadcastSink(child.input, bytes)) { loseSink(run, sink, child, 'backpressure'); continue; }
            sink.status.bytes += bytes.length;
            if (child.input.writableNeedDrain) sink.backpressureAt ||= Date.now(); else sink.backpressureAt = 0;
          }
        });
        void encoder.done.then(() => {
          if (!isRunning(run)) return;
          if (run.encoderKind === 'videotoolbox') disableBroadcastHardware(run.session.profile);
          fatal(run, run.encoderKind === 'videotoolbox' ? 'The hardware encoder became unavailable. Restart only the stream to use compatible software; local recording and Studio are unchanged.' : 'The stream encoder stopped. Local recording and Studio remain independent.');
        });
        notify(true); return structuredClone(session);
      } catch {
        await fs.rm(sessionDirectory, { recursive: true, force: true }).catch(() => {});
        throw new BroadcastError(503, 'The local stream encoder could not start.');
      }
    });
  }
  async function chunk(id: string, sequence: number, bytes: Buffer) {
    const run = current;
    if (!run || id !== run.session.id || !isRunning(run)) throw new BroadcastError(409, 'This streaming session is not accepting media.');
    if (!Number.isInteger(sequence) || sequence < 0 || sequence > 2_147_483_647) throw new BroadcastError(422, 'Invalid stream chunk sequence.');
    if (!Buffer.isBuffer(bytes) || !bytes.length || bytes.length > BROADCAST_CHUNK_LIMIT) throw new BroadcastError(413, 'Choose a stream chunk between 1 byte and 8 MiB.');
    if (sequence < run.nextChunk) return { nextSequence: run.nextChunk };
    if (run.queuedBytes + bytes.length > BROADCAST_INPUT_LIMIT) { fatal(run, 'The stream input queue is full. Local recording continues independently.'); throw new BroadcastError(429, 'The stream input queue is full.'); }
    run.queuedBytes += bytes.length;
    const operation = run.ingest.then(async () => {
      if (!isRunning(run)) throw new BroadcastError(409, 'This streaming session has stopped.');
      if (sequence < run.nextChunk) return { nextSequence: run.nextChunk };
      if (sequence !== run.nextChunk) throw new BroadcastError(409, `Expected stream chunk ${run.nextChunk}.`);
      if (run.encoder.input.destroyed || run.encoder.input.writableLength + bytes.length > BROADCAST_INPUT_LIMIT) throw new BroadcastError(503, 'The stream encoder is not accepting media.');
      try {
        await timeout(new Promise<void>((resolve, reject) => { run.encoder.input.write(bytes, error => error ? reject(error) : resolve()); }), 8000);
      } catch {
        if (run.encoderKind === 'videotoolbox' && isRunning(run)) disableBroadcastHardware(run.session.profile);
        fatal(run, run.encoderKind === 'videotoolbox' ? 'The hardware encoder stopped accepting media. Restart only the stream to use compatible software; local recording is unchanged.' : 'The stream encoder could not keep up with its input. Local recording continues independently.');
        throw new BroadcastError(503, 'Stream media could not be accepted.');
      }
      run.nextChunk++; run.session.chunks++; run.session.bytes += bytes.length; run.inputAt = Date.now(); run.session.lastChunkAt = new Date(run.inputAt).toISOString(); notify();
      return { nextSequence: run.nextChunk };
    });
    run.ingest = operation.catch(() => {});
    try { return await operation; } finally { run.queuedBytes -= bytes.length; }
  }
  async function stop() { return serial(async () => { const run = current; if (run) await stopRun(run); return snapshot(); }); }
  async function error(id: string, _message?: string) { const run = current; if (run?.session.id === id) { fatal(run, 'The Program media connection was interrupted. Studio and local recording are unchanged.'); await run.stopTask; } return snapshot(); }
  function getSink(id: string) {
    const run = current, sink = run?.sinks.get(id);
    if (!run || !isRunning(run) || !sink) throw new BroadcastError(409, 'No active stream destination was found.');
    return { run, sink };
  }
  async function stopDestination(id: string) {
    return serial(async () => {
    const { run, sink } = getSink(id); sink.stopped = true; if (sink.retry) clearTimeout(sink.retry); sink.retry = null;
    const child = sink.process; sink.process = null; sink.status.state = 'stopped'; if (child) await child.terminate();
    await sink.transport?.close(); sink.transport = null;
    if (id === 'watch') {
      run.watchController.abort(); run.relayStarted = false;
      const controller = new AbortController();
      try { await timeout(relay?.finish({ signal: controller.signal }) ?? Promise.resolve(), 2500); }
      catch { /* Relay stale-session timeout also marks an interrupted upload offline. */ }
      finally { controller.abort(); }
    }
    updateLive(run); notify(true); return snapshot();
    });
  }
  async function retryDestination(id: string) {
    return serial(async () => {
    const { run, sink } = getSink(id);
    if (id === 'watch' ? !run.config.watch.enabled : !run.config.destinations.some(d => d.id === id && d.enabled && d.key)) throw new BroadcastError(409, 'This destination was not enabled for this stream.');
    const child = sink.process; sink.process = null; if (child) await child.terminate(); if (sink.retry) clearTimeout(sink.retry); sink.retry = null;
    await sink.transport?.close(); sink.transport = null;
    sink.stopped = false; sink.status.error = undefined; sink.failures = 0;
    if (id === 'watch') { run.watchController = new AbortController(); run.relayRetryAt = 0; run.relayStarted = false; run.relayEpoch = randomUUID(); run.relayPublished = ''; }
    launchSink(run, sink); notify(true); return snapshot();
    });
  }
  const watchdog = setInterval(() => {
    const run = current; if (!run || !isRunning(run)) return;
    if (Date.now() - (run.inputAt || run.startedAt) > 20_000) { fatal(run, 'No Program media arrived within 20 seconds. Local recording remains independent.'); return; }
    if (run.inputAt && Date.now() - (run.outputAt || run.startedAt) > 20_000) { fatal(run, 'The encoder stopped producing frames. Local recording remains independent.'); return; }
    for (const sink of run.sinks.values()) if (sink.process && sink.backpressureAt && Date.now() - sink.backpressureAt > 8000) loseSink(run, sink, sink.process, 'backpressure');
    if (run.config.watch.enabled) void publishWatch(run);
  }, 500); watchdog.unref();
  async function close() { closed = true; clearInterval(watchdog); await stop(); await lock; }
  return { snapshot, preflight, configure, start, chunk, error, stop, retryDestination, stopDestination, close };
}
