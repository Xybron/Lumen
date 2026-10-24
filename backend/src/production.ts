import { Router, raw, type Request, type Response, type NextFunction } from 'express';
import { randomBytes, timingSafeEqual } from 'node:crypto';
import type { IncomingMessage } from 'node:http';
import type { ConnectionOptions, TLSSocket } from 'node:tls';
import fs from 'node:fs/promises';
import path from 'node:path';
import { chromium, type Browser, type Page } from 'playwright-core';
import { z } from 'zod';
import { DATA_DIR } from './paths.js';
import { parseCookie, readSession, requireSession, userCan } from './auth.js';
import { ProductionError, ProductionStore } from './production-store.js';
import { ProductionSchema, CommandSchema } from './production-schema.js';
import { RecordingStore } from './production-recordings.js';
import { createClips } from './clips.js';
import { createBroadcast, type BroadcastWatchRelay } from './broadcast.js';
import type { BroadcastSpawn } from './broadcast-process.js';
import { createWatchRelayFromEnv } from './broadcast-relay.js';
import { ProductionHub } from './production-hub.js';
import { createOutputDelivery } from './output-delivery.js';
import { createExternalOutput } from './output-external.js';
import { rendererFailureMessage, RendererStartupError, resolveRendererOrigin, waitForStationEngine, type RendererAttempt, type RendererOriginOptions } from './renderer-startup.js';
import type { ProductionState, StudioStatus } from '../../shared/production.js';
import type { BroadcastSnapshot } from '../../shared/broadcast.js';

const ENGINE_COOKIE = 'lumen_renderer';
const asyncRoute = (fn: (req: Request, res: Response) => Promise<unknown>) =>
  (req: Request, res: Response, next: NextFunction) => { void fn(req, res).catch(next); };

function operator(req: Request, res: Response, next: NextFunction) {
  const user = readSession(req);
  if (!user) return res.status(401).json({ error: 'Sign in to control Studio.' });
  if (!userCan(user, '*', 'author')) return res.status(403).json({ error: 'Studio requires an administrator or an author/owner role for all channels.' });
  next();
}

export async function createProduction(rendererOptions: Pick<RendererOriginOptions, 'backendUrl' | 'configuredUrl' | 'development'>,
  cueGates?: (channelIds:string[]) => Promise<NonNullable<ProductionState['programCueGates']>>,
  dependencies: { watchRelay?: BroadcastWatchRelay | null; broadcastDirectory?: string; localWatch?: boolean; broadcastSpawn?: BroadcastSpawn; broadcastConnectTls?: (options: ConnectionOptions) => TLSSocket } = {}) {
  if (dependencies.localWatch) {
    const canonical = async (directory: string) => fs.realpath(directory).catch(() => path.resolve(directory));
    if (!dependencies.broadcastDirectory || await canonical(dependencies.broadcastDirectory) === await canonical(path.join(DATA_DIR, 'broadcast'))) throw new ProductionError(422, 'Local Watch requires a separate temporary settings workspace.');
  }
  const secret = randomBytes(32).toString('hex');
  const stationId = randomBytes(24).toString('hex');
  function isEngine(req: IncomingMessage) {
    try {
      const value = parseCookie(req.headers.cookie, ENGINE_COOKIE) ?? '';
      return value.length === secret.length && timingSafeEqual(Buffer.from(value), Buffer.from(secret));
    } catch { return false; }
  }
  const requireEngine = (req: Request, res: Response, next: NextFunction) => {
    if (!isEngine(req)) return res.status(401).json({ error: 'Renderer authorization required.' });
    next();
  };
  let browser: Browser | null = null;
  let rendererPage: Page | null = null;
  let launchTask: Promise<void> | null = null;
  let stopping = false;
  let recoveryRequests = 0;
  let startup: { startedAt: string; phase: string; origin?: string; attempts: RendererAttempt[]; error?: string } | null = null;
  let lastHeartbeat = 0;
  let status: StudioStatus = { state: 'offline', fps: 0, levels: {}, sources: {}, sourceErrors: {}, recording: null };
  let broadcast: Awaited<ReturnType<typeof createBroadcast>> | null = null;
  let broadcastChanging = false;
  const store = new ProductionStore(DATA_DIR, state => hub.broadcast({ t: 'state', state }), cueGates);
  const recordings = new RecordingStore(path.join(DATA_DIR, 'recordings'), () => publishStatus());
  const snapshot = (): StudioStatus => {
    const session = broadcast?.snapshot().session;
    return { ...status, recording: recordings.active(), ...(session ? { broadcast: { id: session.id, state: session.state } } : {}) };
  };
  const hub = new ProductionHub(isEngine, () => store.get(), snapshot);
  function publishStatus() { hub.broadcast({ t: 'status', status: snapshot() }); }
  function interruptRecording(reason: string) {
    void recordings.interruptActive(reason).catch(error => console.error('[studio] Could not persist recording interruption:', error));
  }
  await store.init(); await recordings.init();
  const externalOutput = createExternalOutput();
  const outputDelivery = await createOutputDelivery({ directory: path.join(DATA_DIR, 'outputs'), hub, getState: () => store.get() }).catch(() => {
    console.error('[outputs] Output sharing is unavailable; saved settings were preserved.');
    const router = Router();
    router.use((_req, res) => res.status(503).json({ error: 'Output sharing is unavailable. Check the private output settings and station storage; existing files were preserved.' }));
    return { router, async close() {} };
  });
  const clips = await createClips({
    dir: path.join(DATA_DIR, 'clips'), recordings,
    // Keep heavy post-production work out of the live renderer's resource
    // budget, including startup, a stranded renderer and recording recovery.
    isLive: () => !!browser || !!launchTask || recoveryRequests > 0 || status.state === 'starting' || status.state === 'running'
      || recordings.list().some(item => ['starting', 'recording', 'stopping', 'finalizing'].includes(item.status)),
  }).catch(error => {
    // Post-production is optional to live production. A damaged Clips index or
    // an unavailable export disk must never prevent Studio from starting, nor
    // be "repaired" by replacing the user's saved drafts with an empty index.
    console.error('[clips] Workspace unavailable; existing files preserved:', (error as Error).message);
    const router = Router();
    router.use('/clips', requireSession, (_req, res) => res.status(503).json({
      error: 'The Clips workspace is unavailable. Existing recordings and drafts are preserved; Studio remains available. Check station storage and restart the backend after repair.',
    }));
    return { router, pauseForLive: async () => {}, close: async () => {} };
  });
  broadcast = await createBroadcast({
    dir: dependencies.broadcastDirectory ?? path.join(DATA_DIR, 'broadcast'), watchRelay: dependencies.watchRelay === undefined ? createWatchRelayFromEnv() : dependencies.watchRelay,
    localWatch: dependencies.localWatch,
    initialConfigPath: dependencies.localWatch ? path.join(DATA_DIR, 'broadcast', 'broadcast-private.json') : undefined,
    spawn: dependencies.broadcastSpawn,
    connectTls: dependencies.broadcastConnectTls,
    onStatus: () => publishStatus(),
    onFatal: id => hub.engineSend({ t: 'broadcast-stop', broadcast: { id, profile: broadcast?.snapshot().config.profile ?? '720p' } }),
  }).catch(async error => {
    // Broken broadcast settings must not stop local production or overwrite
    // stored credentials. The isolated Broadcast panel can report unavailable.
    console.error('[broadcast] Broadcast is unavailable. Check its private settings and station storage.');
    if (dependencies.localWatch) { await clips.close(); hub.close(); throw error; }
    return null;
  });
  const broadcasting = () => ['starting', 'live', 'stopping'].includes(broadcast?.snapshot().session?.state ?? '');
  function broadcastService() {
    if (!broadcast) throw new ProductionError(503, 'Go Live is unavailable. Existing settings are preserved. Check station storage and relay configuration.');
    return broadcast;
  }
  function broadcastSnapshot(): BroadcastSnapshot {
    const value = broadcastService().snapshot(), production = store.get();
    const main = production.sources.find(source => source.id === production.mainAudioSourceId);
    const warning = production.masterMuted || main?.audio.muted;
    const checks = [...value.preflight.checks,
      { id: 'program', ok: !!production.program, message: production.program ? `Program: ${production.program.name}` : 'Take a scene to Program before going live.', severity: 'error' as const },
      { id: 'engine', ok: status.state === 'running', message: status.state === 'running' ? 'Production engine is running.' : 'The production engine will start when you go live.', severity: 'info' as const },
      { id: 'audio', ok: !warning, message: warning ? 'Main or output audio is muted. Check that this is intentional.' : main ? `Using the existing audio mix. Main: ${main.name}.` : 'Using the existing Program audio mix.', severity: 'warning' as const },
    ];
    if (main && status.state === 'running' && ['missing', 'error'].includes(status.sources[main.id] ?? 'missing')) checks.push({ id: 'main-connection', ok: false, message: 'Main audio is disconnected. Check the input before going live.', severity: 'warning' });
    return { ...value, preflight: { ...value.preflight, ready: value.preflight.ready && !!production.program, checks },
      production: { engineState: status.state, programName: production.program?.name, mainAudioName: main?.name, masterMuted: production.masterMuted, recording: recordings.active() } };
  }
  async function startRecording(name: string) {
    const recording = await recordings.create(name);
    hub.engineSend({ t: 'record-start', recording });
    setTimeout(() => {
      if (recordings.active()?.id === recording.id && recordings.active()?.status === 'starting') {
        void recordings.setStatus(recording.id, 'interrupted', 'No recording data arrived from the renderer.').catch(() => {});
      }
    }, 15000).unref();
    return recording;
  }
  async function stopRecording() {
    const recording = recordings.active();
    if (!recording || recording.status === 'stopping') return;
    await recordings.setStatus(recording.id, 'stopping');
    hub.engineSend({ t: 'record-stop', recording });
  }
  function interruptBroadcast() {
    const active = broadcast?.snapshot().session;
    if (active && broadcasting()) void broadcast?.error(active.id, 'The production renderer disconnected. Local recording chunks are retained.').catch(() => {});
  }

  hub.onEngineGone = () => {
    if (!stopping && status.state === 'running') {
      status = { ...status, state: 'error', error: 'The renderer disconnected. Restart the engine to restore outputs.', levels: {}, fps: 0 };
      interruptRecording('Renderer disconnected. Recover the saved chunks from Recordings.');
      interruptBroadcast();
      publishStatus();
    }
  };

  async function findChromium() {
    const candidates = [process.env.LUMEN_CHROME_PATH, chromium.executablePath(),
      '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
      '/Applications/Chromium.app/Contents/MacOS/Chromium',
      '/usr/bin/google-chrome', '/usr/bin/chromium', '/usr/bin/chromium-browser',
      process.env.PROGRAMFILES ? path.join(process.env.PROGRAMFILES, 'Google/Chrome/Application/chrome.exe') : '',
      process.env['PROGRAMFILES(X86)'] ? path.join(process.env['PROGRAMFILES(X86)'], 'Google/Chrome/Application/chrome.exe') : '',
      process.env.LOCALAPPDATA ? path.join(process.env.LOCALAPPDATA, 'Google/Chrome/Application/chrome.exe') : '',
    ].filter((p): p is string => !!p);
    for (const candidate of candidates) { try { await fs.access(candidate); return candidate; } catch { /* next */ } }
    throw new RendererStartupError('Chrome/Chromium was not found. Install Chrome or set LUMEN_CHROME_PATH to its executable.');
  }
  async function start(req: Request) {
    if (status.state === 'running' && hub.hasEngine()) return;
    if (launchTask) return launchTask;
    launchTask = (async () => {
      status = { ...status, state: 'starting', error: undefined }; publishStatus();
      await clips.pauseForLive();
      stopping = true; await browser?.close().catch(() => {}); browser = null; stopping = false;
      rendererPage = null;
      startup = { startedAt: new Date().toISOString(), phase: 'selecting', attempts: [] };
      try {
        startup.phase = 'launching';
        browser = await chromium.launch({ executablePath: await findChromium(), headless: true,
          // The managed station has no microphone permission. Obfuscating its
          // host ICE candidates with mDNS can leave same-machine/LAN outputs
          // unable to resolve any route (especially headless Chrome on macOS).
          // Only this private renderer exposes host candidates; viewer browser
          // privacy settings are unchanged and no public STUN service is used.
          args: ['--autoplay-policy=no-user-gesture-required', '--disable-background-timer-throttling', '--disable-renderer-backgrounding', '--disable-backgrounding-occluded-windows', '--disable-features=WebRtcHideLocalIpsWithMdns'],
        });
        browser.on('disconnected', () => {
          if (!stopping) {
            status = { ...status, state: 'error', error: 'The renderer stopped. Restart the engine; saved recording chunks are retained.', fps: 0, levels: {} };
            interruptRecording('Renderer stopped unexpectedly.'); publishStatus();
            interruptBroadcast();
          }
        });
        startup.phase = 'selecting';
        const resolved = await resolveRendererOrigin({ ...rendererOptions, requestOrigin: req.get('origin'), requestReferer: req.get('referer'), requestHost: req.get('host') }, stationId, async rendererUrl => {
          startup!.origin = rendererUrl;
          const context = await browser!.newContext({ viewport: { width: 1920, height: 1080 } });
          try {
            await context.addCookies([{ name: ENGINE_COOKIE, value: secret, url: rendererUrl, httpOnly: true, sameSite: 'Strict' }]);
            const page = await context.newPage();
            rendererPage = page;
            page.on('pageerror', e => console.error('[studio renderer]', e.message));
            startup!.phase = 'loading';
            await page.goto(`${rendererUrl}/studio/engine`, { waitUntil: 'domcontentloaded', timeout: 20000 });
            startup!.phase = 'ready';
            await page.waitForFunction(() => (window as unknown as { __lumenRendererReady?: boolean }).__lumenRendererReady === true, undefined, { timeout: 20000 });
            startup!.phase = 'signaling';
            await waitForStationEngine(() => hub.hasEngine());
          } catch (error) {
            // Closing the failed context also tears down its renderer socket;
            // never let stale pages keep reconnecting while a fallback starts.
            await context.close().catch(() => {});
            rendererPage = null;
            const deadline = Date.now() + 2000;
            while (hub.hasEngine() && Date.now() < deadline) await new Promise(resolve => setTimeout(resolve, 25));
            throw error;
          }
        });
        startup.attempts = resolved.attempts;
        startup.origin = resolved.origin;
        startup.phase = 'running';
        lastHeartbeat = Date.now(); status = { ...status, state: 'running', error: undefined }; publishStatus();
      } catch (e) {
        const message = rendererFailureMessage(e, startup.phase);
        startup = { ...startup, phase: 'failed', attempts: e instanceof RendererStartupError ? e.attempts : startup.attempts, error: e instanceof Error ? e.stack ?? e.message : String(e) };
        console.error('[studio] Renderer startup failed:', startup);
        stopping = true; await browser?.close().catch(() => {}); browser = null; stopping = false;
        rendererPage = null;
        status = { ...status, state: 'error', error: message, fps: 0, levels: {} }; publishStatus();
        throw new ProductionError(503, message);
      }
    })().finally(() => { launchTask = null; });
    return launchTask;
  }
  const watchdog = setInterval(() => {
    if (status.state === 'running' && Date.now() - lastHeartbeat > 12000) {
      status = { ...status, state: 'error', error: 'Renderer is not responding. Restart the engine.', fps: 0, levels: {} };
      interruptRecording('Renderer heartbeat lost. Saved chunks can be recovered.'); publishStatus();
      interruptBroadcast();
    }
  }, 5000);
  watchdog.unref();

  const router = Router();
  router.use(clips.router);
  const outputControl = (req: Request, res: Response, next: NextFunction) => {
    res.set({ 'Cache-Control': 'private, no-store', 'Referrer-Policy': 'no-referrer' });
    if (!['GET', 'HEAD'].includes(req.method)) {
      const origin = req.get('origin');
      let sameOrigin = !origin;
      try { if (origin) sameOrigin = ['http:', 'https:'].includes(new URL(origin).protocol) && new URL(origin).host === req.get('host'); } catch { /* Reject malformed origins. */ }
      const site = req.get('sec-fetch-site');
      if (!sameOrigin || site && !['same-origin', 'none'].includes(site) || ['POST', 'PUT', 'PATCH'].includes(req.method) && !req.is('application/json')) {
        res.status(403).json({ error: 'Open output setup on this station to change sharing.' }); return;
      }
    }
    next();
  };
  router.get('/studio/output-delivery/external', operator, outputControl, (_req, res) => res.json(externalOutput.status()));
  router.post('/studio/output-delivery/external/verify', operator, outputControl, asyncRoute(async (_req, res) => { res.json(await externalOutput.verify()); }));
  router.use('/studio/output-delivery', operator, outputControl, outputDelivery.router);
  router.get('/studio/broadcast', operator, (_req, res, next) => {
    try { res.set('Cache-Control', 'private, no-store').json(broadcastSnapshot()); } catch (error) { next(error); }
  });
  router.get('/studio/broadcast/preflight', operator, (_req, res, next) => {
    try { res.set('Cache-Control', 'private, no-store').json(broadcastSnapshot().preflight); } catch (error) { next(error); }
  });
  router.put('/studio/broadcast/config', operator, asyncRoute(async (req, res) => {
    if (!readSession(req)?.isAdmin) throw new ProductionError(403, 'Only an administrator can change stream destinations and stream keys.');
    if (broadcastChanging) throw new ProductionError(409, 'Streaming is changing. Wait a moment and try again.');
    await broadcastService().configure(req.body);
    res.json(broadcastSnapshot());
  }));
  router.post('/studio/broadcast/start', operator, asyncRoute(async (req, res) => {
    const input = z.object({ record: z.boolean().optional(), title: z.string().trim().min(1).max(100).optional() }).strict().parse(req.body ?? {});
    if (broadcastChanging || broadcasting()) throw new ProductionError(409, 'A stream is already active or starting.');
    const service = broadcastService();
    if (!broadcastSnapshot().preflight.ready) throw new ProductionError(409, 'Complete the required Go Live checks before going live.');
    broadcastChanging = true;
    try {
      await start(req);
      const shouldRecord = input.record ?? service.snapshot().config.recordOnStart;
      if (shouldRecord && !recordings.active()) {
        const disk = await fs.statfs(DATA_DIR);
        if (disk.bavail * disk.bsize < 512 * 1024 * 1024) throw new ProductionError(507, 'Free at least 512 MB before starting a local recording.');
        await startRecording(input.title ?? `Service ${new Date().toLocaleString('en-GB').replace(/[/,:]/g, '-')}`);
      }
      const session = await service.start();
      hub.engineSend({ t: 'broadcast-start', broadcast: { id: session.id, profile: session.profile } });
      res.status(202).json(broadcastSnapshot());
    } finally { broadcastChanging = false; }
  }));
  router.post('/studio/broadcast/stop', operator, asyncRoute(async (req, res) => {
    const input = z.object({ stopRecording: z.boolean().optional() }).strict().parse(req.body ?? {});
    if (broadcastChanging) throw new ProductionError(409, 'Streaming is changing. Wait a moment and try again.');
    broadcastChanging = true;
    try {
      const service = broadcastService(), session = service.snapshot().session;
      if (session) hub.engineSend({ t: 'broadcast-stop', broadcast: { id: session.id, profile: session.profile } });
      await service.stop();
      if (input.stopRecording) await stopRecording();
      res.json(broadcastSnapshot());
    } finally { broadcastChanging = false; }
  }));
  for (const action of ['retry', 'stop'] as const) router.post(`/studio/broadcast/destinations/:id/${action}`, operator, asyncRoute(async (req, res) => {
    const id = z.enum(['facebook', 'youtube', 'watch']).parse(req.params.id);
    if (action === 'retry') await broadcastService().retryDestination(id);
    else await broadcastService().stopDestination(id);
    res.json(broadcastSnapshot());
  }));
  router.put('/studio/engine/broadcast/:id/chunks/:sequence', requireEngine, raw({ type: 'application/octet-stream', limit: '8mb' }), asyncRoute(async (req, res) => {
    const sequence = z.coerce.number().int().min(0).max(99999999).parse(req.params.sequence);
    if (!Buffer.isBuffer(req.body) || !req.body.length) throw new ProductionError(400, 'Empty stream chunk.');
    await broadcastService().chunk(String(req.params.id), sequence, req.body); res.json({ ok: true });
  }));
  router.post('/studio/engine/broadcast/:id/error', requireEngine, asyncRoute(async (req, res) => {
    const input = z.object({ error: z.string().max(500) }).strict().parse(req.body);
    await broadcastService().error(String(req.params.id), input.error); res.json({ ok: true });
  }));
  router.get('/studio', (_req, res) => res.json(store.get()));
  router.get('/studio/status', (_req, res) => res.json(snapshot()));
  router.get('/studio/engine/probe', (_req, res) => res.set('Cache-Control', 'no-store').json({ station: stationId }));
  router.get('/studio/diagnostics', operator, asyncRoute(async (_req, res) => {
    const details = rendererPage && !rendererPage.isClosed() ? await rendererPage.evaluate(async () => {
      const inspect = (window as unknown as { __lumenDiagnostics?: () => Promise<unknown> }).__lumenDiagnostics;
      return inspect ? inspect() : null;
    }).catch(() => null) : null;
    res.json({ status: snapshot(), renderer: details, startup });
  }));
  router.put('/studio', operator, asyncRoute(async (req, res) => {
    const parsed = ProductionSchema.safeParse(req.body);
    if (!parsed.success) throw new ProductionError(422, parsed.error.issues[0].message);
    res.json(await store.save(parsed.data));
  }));
  router.post('/studio/command', operator, asyncRoute(async (req, res) => {
    const parsed = z.object({ revision: z.number().int().nonnegative(), command: CommandSchema }).safeParse(req.body);
    if (!parsed.success) throw new ProductionError(422, 'Invalid Studio command.');
    res.json(await store.command(parsed.data.revision, parsed.data.command));
  }));
  // Retired: channel publication must never acquire Studio routing authority.
  // Keep a clear response for older controller tabs without changing either
  // document or the current Program picture.
  router.post(['/studio/channel-program', '/studio/channel-program/return'], requireSession, (_req, res) => {
    res.status(410).json({ error: 'Publish content with Send live in its channel. Switch Program using a Studio scene or a configured scene shortcut.' });
  });
  router.post('/studio/engine/start', operator, asyncRoute(async (req, res) => { await start(req); res.json(snapshot()); }));
  router.post('/studio/engine/stop', operator, asyncRoute(async (_req, res) => {
    if (recordings.active()) throw new ProductionError(409, 'Stop the recording before stopping the engine.');
    if (broadcasting() || broadcastChanging) throw new ProductionError(409, 'Stop streaming before stopping the engine.');
    if (launchTask) throw new ProductionError(409, 'Engine is still starting.');
    stopping = true; await browser?.close(); browser = null;
    status = { state: 'offline', fps: 0, levels: {}, sources: {}, sourceErrors: {}, recording: null };
    stopping = false; publishStatus(); res.json(snapshot());
  }));

  const heartbeatSchema = z.object({
    fps: z.number().finite().min(0).max(240),
    levels: z.record(z.number().finite().min(0).max(1)),
    sources: z.record(z.enum(['ready', 'missing', 'loading', 'error'])),
    sourceErrors: z.record(z.string().max(500)),
  });
  router.post('/studio/engine/heartbeat', requireEngine, asyncRoute(async (req, res) => {
    const data = heartbeatSchema.parse(req.body); lastHeartbeat = Date.now();
    status = { ...status, ...data }; publishStatus(); res.json({ ok: true });
  }));
  router.get('/studio/engine/bootstrap', requireEngine, (_req, res) => res.json(store.get()));
  router.get('/studio/recordings', requireSession, (_req, res) => res.json(recordings.list()));
  router.post('/studio/recordings', operator, asyncRoute(async (req, res) => {
    if (status.state !== 'running' || !hub.hasEngine()) throw new ProductionError(409, 'Start the engine before recording.');
    if (!store.get().program) throw new ProductionError(409, 'Take a scene to Program before recording.');
    const name = z.string().trim().min(1).max(100).parse(req.body.name);
    const recording = await startRecording(name);
    res.status(201).json(recording);
  }));
  router.post('/studio/recordings/:id/stop', operator, asyncRoute(async (req, res) => {
    if (recordings.active()?.id !== req.params.id) throw new ProductionError(409, 'No matching active recording.');
    await stopRecording();
    res.json({ ok: true });
  }));
  router.post('/studio/recordings/:id/recover', operator, asyncRoute(async (req, res) => {
    const r = recordings.list().find(r => r.id === req.params.id);
    if (!r || !['interrupted', 'error'].includes(r.status)) throw new ProductionError(409, 'Only interrupted or failed recordings can be recovered.');
    recoveryRequests++;
    try { await clips.pauseForLive(); await recordings.finish(String(req.params.id)); }
    finally { recoveryRequests--; }
    res.status(202).json({ ok: true });
  }));
  router.get('/studio/recordings/:id/download', requireSession, (req, res, next) => {
    try { const file = recordings.download(String(req.params.id)); res.download(file.path, file.name); } catch (e) { next(e); }
  });
  router.put('/studio/engine/recordings/:id/chunks/:sequence', requireEngine, raw({ type: 'application/octet-stream', limit: '16mb' }), asyncRoute(async (req, res) => {
    const sequence = z.coerce.number().int().min(0).max(99999999).parse(req.params.sequence);
    if (!Buffer.isBuffer(req.body) || !req.body.length) throw new ProductionError(400, 'Empty recording chunk.');
    await recordings.chunk(String(req.params.id), sequence, req.body); res.json({ ok: true });
  }));
  router.post('/studio/engine/recordings/:id/finish', requireEngine, asyncRoute(async (req, res) => {
    const durationMs = z.number().finite().min(0).max(7 * 86400000).parse(req.body.durationMs);
    await recordings.finish(String(req.params.id), durationMs); res.json({ ok: true });
  }));
  router.post('/studio/engine/recordings/:id/error', requireEngine, asyncRoute(async (req, res) => {
    const error = z.string().max(500).parse(req.body.error);
    await recordings.setStatus(String(req.params.id), 'interrupted', error); res.json({ ok: true });
  }));
  router.use((error: Error, _req: Request, res: Response, _next: NextFunction) => {
    const safeStatus = (error as Error & { status?: number }).status;
    const code = error instanceof ProductionError ? error.status : error instanceof z.ZodError ? 422 : safeStatus && [400, 401, 403, 404, 409, 413, 422, 429, 500, 503, 507].includes(safeStatus) ? safeStatus : 500;
    if (code === 500) console.error('[studio]', 'The operation could not be completed.');
    res.status(code).json({ error: error instanceof z.ZodError ? error.issues[0].message : error.message });
  });
  return { router, wss: hub.wss,
    mobile: {
      get: () => store.get(), status: snapshot,
      attachProgramViewer: (ws: import('ws').WebSocket) => hub.attachMobileProgramViewer(ws),
      select: (revision: number, sceneId: string, authorize: () => void) => store.mobileControls(revision, { sceneId }, authorize),
      take: (revision: number, sceneId: string, transition: 'cut' | 'fade', durationMs: number, authorize: () => void) => store.command(revision, { type: 'take', sceneId, transition, durationMs, swapPreview: true }, authorize),
      audio: (revision: number, patch: { muted?: boolean; volume?: number }, authorize: () => void) => store.mobileControls(revision, patch, authorize),
    }, async close() {
    clearInterval(watchdog); stopping = true;
    try { await outputDelivery.close(); await broadcast?.close(); await clips.close(); }
    finally {
      try { await recordings.interruptActive('Station shut down during recording.'); }
      finally { try { await browser?.close(); } finally { hub.close(); } }
    }
  } };
}
