// Isolated station and generated camera: navigation must preserve both the
// operator's monitors and the picture delivered to a separate live output.
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import net from 'node:net';
import { spawn, execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright-core';
import ffmpeg from 'ffmpeg-static';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'lumen-studio-navigation-'));
const artifacts = await fs.mkdtemp(path.join(os.tmpdir(), 'lumen-studio-navigation-report-'));
const performanceProfile = process.env.LUMEN_OUTPUT_PERFORMANCE_PROFILE ?? 'continuity';
assert.ok(['continuity', '1080p30'].includes(performanceProfile), 'LUMEN_OUTPUT_PERFORMANCE_PROFILE must be continuity or 1080p30.');
const report = { artifacts, performanceProfile, ok: false, cameraNavigation: null, worship: null };
const port = Number(process.env.LUMEN_NAVIGATION_TEST_PORT ?? 3487), base = `http://127.0.0.1:${port}`;
const executablePath = process.env.LUMEN_CHROME_PATH ?? '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
const environment = Object.fromEntries(Object.entries(process.env).filter(([name]) =>
  !/^(LUMEN_|VPS_|MEDIA_ENGINE_|SUPABASE_|POWERSYNC_|VITE_|NODE_OPTIONS$|NODE_PATH$|ELECTRON_RUN_AS_NODE$)/i.test(name)));
await new Promise((resolve, reject) => {
  const probe = net.createServer(); probe.once('error', reject);
  probe.listen(port, '127.0.0.1', () => probe.close(resolve));
});
let server, browser, request, logs = '';
const errors = [];
async function until(fn, label, timeout = 30000) {
  const end = Date.now() + timeout; let last;
  while (Date.now() < end) {
    try { if (await fn()) return; } catch (error) { last = error; }
    await new Promise(resolve => setTimeout(resolve, 100));
  }
  throw new Error(`Timed out: ${label}${last ? ` (${last.message})` : ''}`);
}
try {
  const videoName = 'navigation-worship-loop.mp4', loopSeconds = 6;
  await fs.mkdir(path.join(dir, 'media/backgrounds'), { recursive: true });
  await promisify(execFile)(ffmpeg, ['-hide_banner', '-loglevel', 'error', '-f', 'lavfi',
    '-i', 'testsrc2=size=1920x1080:rate=30,hue=h=60*t:s=0.65', '-t', String(loopSeconds), '-an',
    '-c:v', 'libx264', '-preset', 'ultrafast', '-crf', '24', '-pix_fmt', 'yuv420p', '-movflags', '+faststart',
    path.join(dir, 'media/backgrounds', videoName)], { timeout: 60000 });
  server = spawn(process.execPath, ['backend/dist/server.js'], { cwd: root,
    env: { ...environment, NODE_ENV: 'production', PORT: String(port), HOST: '127.0.0.1', LUMEN_DATA_DIR: dir, LUMEN_RENDERER_URL: base, LUMEN_CHROME_PATH: executablePath },
    stdio: ['ignore', 'pipe', 'pipe'] });
  server.stdout.on('data', b => { logs += b; }); server.stderr.on('data', b => { logs += b; });
  await until(async () => (await fetch(`${base}/api/studio`, { signal: AbortSignal.timeout(1000) })).ok, 'station start');
  browser = await chromium.launch({ executablePath,
    headless: true, args: ['--autoplay-policy=no-user-gesture-required'] });
  const context = await browser.newContext({ viewport: { width: 1512, height: 982 } });
  const page = await context.newPage(); page.on('pageerror', e => errors.push(e.message));
  // Start signed out so the same store must acquire authenticated signaling.
  await page.addInitScript(() => {
    window.__publisherCloses = 0;
    const Native = window.WebSocket;
    window.WebSocket = class extends Native {
      send(data) {
        if (JSON.parse(data).t === 'publish') this.publishing = true;
        super.send(data);
      }
      constructor(...args) {
        super(...args);
        this.addEventListener('close', () => { if (this.publishing) window.__publisherCloses++; });
      }
    };
    navigator.mediaDevices.getUserMedia = async () => {
      const canvas = document.createElement('canvas'); canvas.width = 640; canvas.height = 360;
      const ctx = canvas.getContext('2d');
      let tick = 0;
      const paint = () => {
        ctx.fillStyle = '#20c060'; ctx.fillRect(0, 0, 640, 360);
        // Real movement prevents codecs from legitimately suppressing duplicate
        // solid-color frames; the whole picture remains recognizably green.
        ctx.fillStyle = '#40e080'; ctx.fillRect((tick++ * 7) % 560, 120, 80, 80);
        window.__cameraTickCount = tick;
      };
      paint(); window.__cameraTimer = setInterval(paint, 33);
      return canvas.captureStream(30);
    };
  });
  await page.goto(`${base}/studio`);
  await page.getByLabel('Username', { exact: true }).fill('admin');
  await page.getByLabel('Password', { exact: true }).fill('admin');
  await page.getByRole('button', { name: 'Sign in', exact: true }).click();
  await page.getByRole('heading', { name: 'Production Studio', exact: true }).waitFor();
  request = context.request;
  const kinds = ['presentation', 'scripture', 'lyrics'];
  const content = await request.put(`${base}/api/content`, { data: {
    version: 2, updatedAt: new Date().toISOString(), settings: { transitionMs: 0 }, music: { mode: 'off' },
    channels: kinds.map(kind => ({ id: kind, name: kind, kind, playlistId: `p_${kind}`, defaultMode: 'manual' })),
    playlists: kinds.map(kind => ({ id: `p_${kind}`, name: kind, items: kind === 'presentation'
      ? [{ id: 'slide', type: 'text', title: 'Navigation test', body: 'Keep this presentation live', background: { kind: 'color', color: '#2244cc' } }] : [] })),
  } }); assert.equal(content.status(), 200, await content.text());
  const get = async () => (await request.get(`${base}/api/studio`)).json();
  const state = await get();
  state.sources = [{ id: 'camera', name: 'Generated camera', kind: 'camera', loop: false, audio: { volume: 0, muted: true, mode: 'follow', delayMs: 0 } }];
  state.scenes = [{ id: 'live', name: 'Live camera', background: '#000000', layers: [{
    id: 'camera_layer', name: 'Camera', kind: 'source', sourceId: 'camera', visible: true, locked: false,
    x: 0, y: 0, width: 100, height: 100, opacity: 1, fit: 'cover', text: '', color: '#ffffff',
    background: '#00000000', fontSize: 54, fontWeight: 500, align: 'left', radius: 0,
  }] }, { id: 'other', name: 'Other scene', background: '#2244cc', layers: [] }];
  state.previewSceneId = 'live';
  const saved = await request.put(`${base}/api/studio`, { data: state }); assert.equal(saved.status(), 200, await saved.text());
  const take = await request.post(`${base}/api/studio/command`, { data: { revision: (await get()).revision, command: { type: 'take', sceneId: 'live' } } });
  assert.equal(take.status(), 200, await take.text());
  // Content writes made by the fixture bypass the UI's update broadcast.
  await page.getByRole('link', { name: 'Lumen home', exact: true }).click();
  await page.getByRole('button', { name: 'presentation — presentation', exact: true }).waitFor();
  await page.getByRole('button', { name: 'Open Production Studio', exact: true }).click();
  await page.locator('.source-row').filter({ hasText: 'Generated camera' }).getByRole('button', { name: 'Connect', exact: true }).click();
  const started = await request.post(`${base}/api/studio/engine/start`, { timeout: 60000 }); assert.equal(started.status(), 200, await started.text());
  await until(() => page.evaluate(() => ['.preview-panel video', '.program-panel video'].every(selector => {
    const video = document.querySelector(selector); return video?.readyState >= 2 && video.classList.contains('is-ready');
  })), 'both Studio monitors ready');
  const output = await context.newPage(); output.on('pageerror', e => errors.push(e.message));
  await output.addInitScript(() => {
    const NativePeer = window.RTCPeerConnection;
    window.__outputPeers = [];
    window.RTCPeerConnection = class extends NativePeer {
      constructor(...args) { super(...args); window.__outputPeers.push(this); }
    };
  });
  await output.goto(`${base}/studio/output/program`);
  await until(() => output.locator('video').evaluate(v => v.readyState >= 2), 'live output ready');
  // Begin the navigation check after the initial decoder/encoder ramp rather
  // than on its first frame. The subsequent no-blank and frame-count assertions
  // remain unchanged and measure the round trips themselves.
  await until(() => output.locator('video').evaluate(video => video.getVideoPlaybackQuality().totalVideoFrames >= 60), 'camera output warmup frames', 45000);
  await output.locator('video').evaluate(video => {
    const canvas = document.createElement('canvas'); canvas.width = 1; canvas.height = 1;
    const ctx = canvas.getContext('2d', { willReadFrequently: true });
    window.__frames = { total: 0, blank: 0, startedAt: performance.now() };
    window.__cameraFrameSampling = true;
    const sample = () => {
      if (!window.__cameraFrameSampling) return;
      ctx.drawImage(video, 0, 0, 1, 1); const [r, g, b] = ctx.getImageData(0, 0, 1, 1).data;
      window.__frames.total++; if (!(g > 100 && g > r * 2 && g > b * 1.5)) window.__frames.blank++;
      video.requestVideoFrameCallback(sample);
    }; video.requestVideoFrameCallback(sample);
  });
  await page.evaluate(() => {
    window.__monitors = ['.preview-panel video', '.program-panel video'].map(selector => {
      const video = document.querySelector(selector); return { video, stream: video.srcObject };
    });
    window.__publisherCloses = 0;
  });
  const results = [];
  await page.getByTitle('Monitor audio — use headphones', { exact: true }).click();
  for (const kind of [...kinds, ...kinds]) {
    await page.getByRole('button', { name: `${kind} — ${kind}`, exact: true }).click();
    await page.waitForURL(`${base}/`);
    assert.equal(await page.evaluate(() => window.__monitors[1].video.muted), true, 'Hidden Studio never keeps headphone monitoring audible');
    // Space in a channel must never reach a cached Studio's Cut handler.
    const before = await get();
    await page.locator('body').click({ position: { x: 1, y: 1 } });
    await page.keyboard.press('Space');
    await page.getByRole('button', { name: 'Open Production Studio', exact: true }).click();
    await page.waitForURL(`${base}/studio`);
    results.push(await page.evaluate(() => window.__monitors.map(({ video, stream }) => ({
      retained: video.isConnected && video.srcObject === stream,
      ready: video.readyState >= 2 && video.classList.contains('is-ready'),
    }))));
    assert.equal((await get()).revision, before.revision, 'Channel keyboard and navigation do not take or edit Studio scenes');
    const previousTime = await page.locator('.program-panel video').evaluate(video => video.currentTime);
    await until(() => page.locator('.program-panel video').evaluate((video, time) => !video.paused && video.currentTime > time, previousTime), 'retained monitor keeps playing');
  }
  // Allow a forced reconnect and its missing-input frames to arrive, if present.
  await output.waitForTimeout(1500);
  const frames = await output.evaluate(() => {
    const quality = document.querySelector('video').getVideoPlaybackQuality();
    return { ...window.__frames, elapsedMs: performance.now() - window.__frames.startedAt,
      quality: { totalVideoFrames: quality.totalVideoFrames, droppedVideoFrames: quality.droppedVideoFrames }, visibility: document.visibilityState };
  });
  const closes = await page.evaluate(() => window.__publisherCloses);
  report.cameraNavigation = { results, frames, publisherDisconnects: closes,
    cameraTicks: await page.evaluate(() => window.__cameraTickCount),
    diagnostics: await (await request.get(`${base}/api/studio/diagnostics`)).json(),
    receiverStats: await output.evaluate(async () => Promise.all(window.__outputPeers.map(async peer =>
      [...(await peer.getStats()).values()].filter(stat => ['inbound-rtp', 'outbound-rtp', 'codec'].includes(stat.type))))) };
  await fs.writeFile(path.join(artifacts, 'report.json'), JSON.stringify(report, null, 2));
  console.log(JSON.stringify({ results, frames, publisherDisconnects: closes }));
  assert.equal(closes, 0, 'Returning from channels must not disconnect live inputs');
  assert.ok(results.flat().every(result => result.retained && result.ready), 'Preview and Program stay ready across every channel round trip');
  assert.ok(frames.total > 30, 'Observed live output throughout navigation');
  assert.equal(frames.blank, 0, 'No blank camera frames reach the live output');
  // A browser Back can leave Studio while a portalled dialog is still open.
  await page.getByRole('button', { name: 'Program health', exact: true }).click();
  await page.getByRole('dialog').waitFor();
  await page.goBack(); await page.waitForURL(`${base}/`);
  await page.getByRole('dialog').waitFor({ state: 'hidden' });
  await page.getByRole('button', { name: 'Open Production Studio', exact: true }).click();
  await page.waitForURL(`${base}/studio`);
  assert.equal(await page.getByRole('dialog').count(), 0, 'Cached Studio dialogs stay dismissed on return');
  await page.getByRole('button', { name: /^Account menu for / }).click();
  await page.getByRole('menu').waitFor();
  await page.goBack(); await page.waitForURL(`${base}/`);
  await page.getByRole('menu').waitFor({ state: 'hidden' });
  await page.getByRole('button', { name: 'Open Production Studio', exact: true }).click();
  await page.waitForURL(`${base}/studio`);
  assert.equal(await page.getByRole('menu').count(), 0, 'Cached Studio menus stay dismissed on return');

  // Reproduce the service workflow: independently updated Scripture and Lyrics
  // channels, with a per-layer 1080p video background behind the live lyrics.
  const songId = 'navigation_song';
  const sections = [{ id: 'verse', label: 'Verse', text: 'Morning light across the room\nEvery voice joins in the song' },
    { id: 'chorus', label: 'Chorus', text: 'Let the song continue\nThrough the changing seasons' }];
  const song = await request.post(`${base}/api/worship/songs`, { data: { id: songId, title: 'Navigation worship fixture', sections } });
  assert.equal(song.status(), 201, await song.text());
  const publish = async (channel, selection) => {
    const before = await (await request.get(`${base}/api/worship/channels/${channel}`)).json();
    const response = await request.post(`${base}/api/worship/channels/${channel}/command`, { data: { revision: before.revision, command: { type: 'take', selection } } });
    assert.equal(response.status(), 200, await response.text());
    const after = await response.json();
    assert.deepEqual(after.live.selection, selection, 'The requested cue actually becomes live');
    return { channel, revision: after.revision, selection };
  };
  const scripture = verse => ({ kind: 'scripture', versionId: 'KJV', book: 43, chapter: 3, verse });
  await publish('scripture', scripture(16));
  await publish('lyrics', { kind: 'lyrics', songId, sectionId: 'verse' });
  const worshipState = await get();
  worshipState.sources.push(...['scripture', 'lyrics'].map(kind => ({ id: `worship_${kind}`, name: `Live ${kind}`, kind: 'channel', channelId: kind,
    loop: false, audio: { muted: true, volume: 1, mode: 'follow', delayMs: 0 } })));
  const worshipLayer = (kind, patch = {}) => ({ id: `worship_${kind}_layer`, name: `Live ${kind}`, kind: 'source', sourceId: `worship_${kind}`,
    visible: true, locked: false, x: 0, y: 0, width: 100, height: 100, opacity: 1, fit: 'cover', text: '', color: '#ffffff',
    background: '#00000000', fontSize: 54, fontWeight: 500, align: 'center', radius: 0, channelStyle: 'overlay', ...patch });
  worshipState.scenes.push({ id: 'worship_loop', name: 'Scripture and looped lyrics', background: '#000000', layers: [
    worshipLayer('lyrics', { mediaBackground: { kind: 'video', url: `media/backgrounds/${videoName}`, fit: 'cover', dim: 0.15, loop: true } }),
    worshipLayer('scripture', { x: 5, y: 5, width: 90, height: 25, fontSize: 32 }),
  ] });
  worshipState.previewSceneId = 'worship_loop';
  const savedWorship = await request.put(`${base}/api/studio`, { data: worshipState });
  assert.equal(savedWorship.status(), 200, await savedWorship.text());
  const takenWorship = await request.post(`${base}/api/studio/command`, { data: { revision: (await get()).revision, command: { type: 'take', sceneId: 'worship_loop', transition: 'cut' } } });
  assert.equal(takenWorship.status(), 200, await takenWorship.text());
  await output.evaluate(() => { window.__cameraFrameSampling = false; });
  // Exclude asset preparation and initial stream adaptation. Require decoded
  // motion in the text-free border; a ready but frozen old camera is insufficient.
  // The strict profile must reach full HD before its sustained measurement starts.
  const warmingStarted = Date.now();
  let previousWarmup, movingWarmupSamples = 0;
  await until(async () => {
    const sample = await output.locator('video').evaluate(video => {
      if (video.readyState < 2 || video.paused || !video.videoWidth) return null;
      const canvas = document.createElement('canvas'); canvas.width = 16; canvas.height = 32;
      const context = canvas.getContext('2d', { willReadFrequently: true });
      context.drawImage(video, video.videoWidth * 0.965, video.videoHeight * 0.1, video.videoWidth * 0.03, video.videoHeight * 0.8, 0, 0, 16, 32);
      return { width: video.videoWidth, height: video.videoHeight, decoded: video.getVideoPlaybackQuality().totalVideoFrames,
        pixels: Array.from(context.getImageData(0, 0, 16, 32).data) };
    });
    let moving = false;
    if (sample && previousWarmup && sample.width === previousWarmup.width && sample.height === previousWarmup.height && sample.decoded > previousWarmup.decoded
      && (performanceProfile !== '1080p30' || sample.width === 1920 && sample.height === 1080)) {
      let difference = 0;
      for (let i = 0; i < sample.pixels.length; i++) if (i % 4 !== 3) difference += Math.abs(sample.pixels[i] - previousWarmup.pixels[i]);
      moving = difference / (16 * 32 * 3) > 2;
    }
    movingWarmupSamples = moving ? movingWarmupSamples + 1 : 0;
    previousWarmup = sample;
    report.worshipWarmup = { elapsedMs: Date.now() - warmingStarted, movingSamples: movingWarmupSamples,
      width: sample?.width, height: sample?.height, decodedFrames: sample?.decoded };
    return movingWarmupSamples >= 3;
  }, performanceProfile === '1080p30' ? 'moving full-HD worship output before sustained measurement' : 'moving worship background before measurement', 45000);
  const warmupMs = Date.now() - warmingStarted;
  await output.locator('video').evaluate(video => {
    const canvas = document.createElement('canvas'); canvas.width = 16; canvas.height = 32;
    const context = canvas.getContext('2d', { willReadFrequently: true });
    const started = performance.now(), quality = video.getVideoPlaybackQuality(), initialStream = video.srcObject;
    const initialPeers = [...window.__outputPeers], resolutions = new Map(), transitions = [], gaps = [];
    let callback, poll, count = 0, previousFrameAt = started, sampledAt = -Infinity, previousPixels;
    let lastMotionAt = started, longestMotionHoldMs = 0, motionChanges = 0, blackSince = 0, longestBlackMs = 0;
    let resolution, resolutionSince = started, streamResets = 0, observedStream = initialStream;
    const observeResolution = now => {
      const key = `${video.videoWidth}x${video.videoHeight}`;
      if (resolution?.key === key) return;
      if (resolution) resolution.elapsedMs += now - resolutionSince;
      resolution = resolutions.get(key);
      if (!resolution) { resolution = { key, width: video.videoWidth, height: video.videoHeight, elapsedMs: 0, frames: 0 }; resolutions.set(key, resolution); }
      resolutionSince = now;
      if (transitions.length < 256) transitions.push({ atMs: now - started, width: video.videoWidth, height: video.videoHeight });
    };
    observeResolution(started);
    const frame = now => {
      gaps.push(now - previousFrameAt); previousFrameAt = now; count++;
      observeResolution(now); resolution.frames++;
      if (now - sampledAt >= 100) {
        // The right border is outside both cue text regions. Text changes must
        // never masquerade as a moving video background in this measurement.
        context.drawImage(video, video.videoWidth * 0.965, video.videoHeight * 0.1, video.videoWidth * 0.03, video.videoHeight * 0.8, 0, 0, 16, 32);
        const pixels = context.getImageData(0, 0, 16, 32).data;
        let brightness = 0, difference = 0;
        for (let i = 0; i < pixels.length; i += 4) {
          brightness += pixels[i] + pixels[i + 1] + pixels[i + 2];
          if (previousPixels) difference += Math.abs(pixels[i] - previousPixels[i]) + Math.abs(pixels[i + 1] - previousPixels[i + 1]) + Math.abs(pixels[i + 2] - previousPixels[i + 2]);
        }
        if (!previousPixels || difference / (16 * 32 * 3) > 2) {
          longestMotionHoldMs = Math.max(longestMotionHoldMs, now - lastMotionAt);
          lastMotionAt = now; motionChanges++; previousPixels = pixels;
        }
        if (brightness / (16 * 32 * 3) < 12) blackSince ||= now;
        else if (blackSince) { longestBlackMs = Math.max(longestBlackMs, now - blackSince); blackSince = 0; }
        sampledAt = now;
      }
      callback = video.requestVideoFrameCallback(frame);
    };
    callback = video.requestVideoFrameCallback(frame);
    poll = setInterval(() => { if (video.srcObject !== observedStream) { streamResets++; observedStream = video.srcObject; } }, 50);
    window.__finishWorshipMeasurement = () => {
      video.cancelVideoFrameCallback(callback); clearInterval(poll);
      const now = performance.now(), elapsedMs = now - started, finalQuality = video.getVideoPlaybackQuality();
      gaps.push(now - previousFrameAt); gaps.sort((a, b) => a - b); resolution.elapsedMs += now - resolutionSince;
      return { elapsedMs, presentedFrames: count, presentedFps: count * 1000 / elapsedMs,
        longestFrameGapMs: gaps.at(-1), p95FrameGapMs: gaps[Math.floor((gaps.length - 1) * 0.95)],
        decodedFrames: finalQuality.totalVideoFrames - quality.totalVideoFrames, droppedFrames: finalQuality.droppedVideoFrames - quality.droppedVideoFrames,
        motionChanges, longestMotionHoldMs: Math.max(longestMotionHoldMs, now - lastMotionAt),
        longestBlackMs: Math.max(longestBlackMs, blackSince ? now - blackSince : 0), streamResets,
        newPeers: window.__outputPeers.length - initialPeers.length, closedPeers: initialPeers.filter(peer => peer.connectionState === 'closed').length,
        streamRetained: video.srcObject === initialStream, resolutions: [...resolutions.values()], resolutionTransitions: transitions };
    };
  });
  const cueChanges = [];
  await page.getByRole('button', { name: 'Open Multiview', exact: true }).click();
  const floating = page.getByTestId('floating-multiview');
  await floating.waitFor();
  await until(() => floating.locator('video').evaluateAll(videos => videos.length >= 2 && videos.every(video => video.readyState >= 2)), 'floating Multiview live buses');
  for (let cycle = 0; cycle < 6; cycle++) {
    await page.getByRole('button', { name: 'scripture — scripture', exact: true }).click();
    await page.getByLabel('Search scripture', { exact: true }).waitFor();
    // Returning to Studio deliberately collapses the floating panel. Reopen
    // it from the channel toolbar on the next round, as an operator would.
    if (!await floating.isVisible()) {
      await page.getByRole('button', { name: 'Open Multiview', exact: true }).click();
      await floating.waitFor();
      await until(() => floating.locator('video').evaluateAll(videos => videos.length >= 2 && videos.every(video => video.readyState >= 2)), 'reopened Multiview live buses');
    }
    cueChanges.push(await publish('scripture', scripture(16 + cycle)));
    await page.getByTestId('live-cue').getByText(`John 3:${16 + cycle}`, { exact: false }).waitFor();
    await page.getByRole('button', { name: 'lyrics — lyrics', exact: true }).click();
    await page.getByLabel('Search songs', { exact: true }).waitFor();
    const section = sections[cycle % sections.length];
    cueChanges.push(await publish('lyrics', { kind: 'lyrics', songId, sectionId: section.id }));
    await page.getByTestId('live-cue').getByText(section.label, { exact: true }).waitFor();
    assert.equal(await floating.isVisible(), true, 'Floating Multiview survives channel changes');
    await output.waitForTimeout(5000);
    await page.getByRole('button', { name: 'Open Production Studio', exact: true }).click();
    await page.waitForURL(`${base}/studio`);
    await floating.waitFor({ state: 'hidden' });
    assert.equal((await get()).program.id, 'worship_loop', 'Channel cues and navigation preserve the chosen Program scene');
  }
  const worshipFrames = await output.evaluate(() => window.__finishWorshipMeasurement());
  worshipFrames.fullHdFraction = worshipFrames.resolutions.filter(value => value.width === 1920 && value.height === 1080)
    .reduce((total, value) => total + value.elapsedMs, 0) / worshipFrames.elapsedMs;
  const diagnostics = await (await request.get(`${base}/api/studio/diagnostics`)).json();
  report.worship = { loopSeconds, warmupMs, cueChanges, frames: worshipFrames, diagnostics };
  await fs.writeFile(path.join(artifacts, 'report.json'), JSON.stringify(report, null, 2));
  assert.ok(worshipFrames.elapsedMs >= 30000 && worshipFrames.elapsedMs >= loopSeconds * 2000, 'Observe at least 30 seconds and two complete background loop periods');
  assert.ok(worshipFrames.presentedFps >= 20, `Worship output presents ${worshipFrames.presentedFps.toFixed(1)} fps`);
  assert.ok(worshipFrames.longestFrameGapMs < 1000, 'Navigation never stops frame delivery for a second');
  assert.ok(worshipFrames.longestMotionHoldMs < 1000, 'The video background keeps changing independently of cue text');
  assert.ok(worshipFrames.longestBlackMs < 250, 'The live background never goes black for a prolonged interval');
  assert.ok(worshipFrames.motionChanges > 60, 'Observe moving background pixels across repeated loops');
  assert.equal(worshipFrames.streamResets, 0, 'Navigation never resets the audience video stream');
  assert.equal(worshipFrames.newPeers, 0, 'Navigation never renegotiates the audience output');
  assert.equal(worshipFrames.closedPeers, 0, 'The original audience peer remains connected');
  assert.equal(worshipFrames.streamRetained, true);
  if (performanceProfile === '1080p30') {
    assert.ok(worshipFrames.presentedFps >= 28, `1080p30 qualification: ${worshipFrames.presentedFps.toFixed(2)} fps is below 28`);
    assert.ok(worshipFrames.p95FrameGapMs <= 70, `1080p30 qualification: p95 frame gap ${worshipFrames.p95FrameGapMs.toFixed(1)} ms exceeds 70 ms`);
    assert.ok(worshipFrames.longestFrameGapMs < 250, `1080p30 qualification: longest frame gap ${worshipFrames.longestFrameGapMs.toFixed(1)} ms reaches 250 ms`);
    assert.ok(worshipFrames.fullHdFraction >= 0.95, `1080p30 qualification: full HD occupies ${(worshipFrames.fullHdFraction * 100).toFixed(1)}% of measured time, below 95%`);
  }
  assert.equal(await page.evaluate(() => window.__publisherCloses), 0, 'The existing camera input remains published through worship navigation');
  await page.getByRole('button', { name: 'lyrics — lyrics', exact: true }).click();
  await page.getByRole('button', { name: /^Account menu for / }).click();
  await page.getByRole('menuitem', { name: 'Sign out', exact: true }).click();
  await page.getByRole('dialog', { name: 'Sign out?', exact: true }).getByRole('button', { name: 'Sign out', exact: true }).click();
  await page.getByRole('heading', { name: 'Sign in to your station', exact: true }).waitFor();
  await until(() => page.evaluate(() => window.__monitors.every(({ video }) => !video.isConnected && video.srcObject === null)), 'sign-out releases cached monitors');
  assert.deepEqual(errors, []);
  report.ok = true;
  await fs.writeFile(path.join(artifacts, 'report.json'), JSON.stringify(report, null, 2));
  console.log(JSON.stringify({ result: 'PASS', performanceProfile, artifacts, worship: worshipFrames }));
  console.log('PASS: all channel types preserve Studio monitors, input publishing, live frames and keyboard isolation; Scripture/Lyrics cues and looped backgrounds remain continuous with floating Multiview.');
} catch (error) {
  report.error = error.stack;
  report.failureDiagnostics = await request?.get(`${base}/api/studio/diagnostics`, { timeout: 5000 }).then(response => response.json()).catch(() => null);
  await fs.writeFile(path.join(artifacts, 'report.json'), JSON.stringify(report, null, 2));
  await fs.writeFile(path.join(artifacts, 'server.log'), logs);
  console.error(`Navigation artifacts: ${artifacts}`);
  console.error(logs.slice(-6000)); throw error;
} finally {
  await browser?.close(); server?.kill('SIGTERM');
  if (server && server.exitCode === null) await new Promise(resolve => { server.once('exit', resolve); setTimeout(resolve, 5000).unref(); });
  await fs.rm(dir, { recursive: true, force: true });
}
