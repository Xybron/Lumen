// Disposable station, generated media and simulated status events. No physical
// microphone, paid recognition requests or operator library is touched.
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import net from 'node:net';
import { spawn, execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright-core';
import ffmpeg from 'ffmpeg-static';
import sharp from 'sharp';

const root = fileURLToPath(new URL('../../', import.meta.url));
const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'lumen-header-memory-'));
const output = path.join(root, 'artifacts/listening-header-memory'); await fs.mkdir(output, { recursive: true });
const baseline = process.env.LUMEN_BASELINE_FRONTEND;
const port = await new Promise(resolve => { const s = net.createServer(); s.listen(0, '127.0.0.1', () => { const p = s.address().port; s.close(() => resolve(p)); }); });
const base = `http://127.0.0.1:${port}`;
const environment = Object.fromEntries(Object.entries(process.env).filter(([key]) => !/^(LUMEN_|VPS_|MEDIA_ENGINE_|NODE_OPTIONS$|NODE_PATH$|ELECTRON_RUN_AS_NODE$)/i.test(key)));
let browser, logs = '', page;
const server = spawn(process.execPath, ['backend/dist/server.js'], { cwd: root,
  env: { ...environment, HOST: '127.0.0.1', PORT: String(port), LUMEN_DATA_DIR: directory }, stdio: ['ignore', 'pipe', 'pipe'] });
for (const pipe of [server.stdout, server.stderr]) pipe.on('data', data => { logs = (logs + data).slice(-6000); });
async function until(fn, label, timeout = 20000) {
  const end = Date.now() + timeout; let last;
  while (Date.now() < end) { try { if (await fn()) return; } catch (error) { last = error; } await new Promise(r => setTimeout(r, 100)); }
  throw Error(`Timed out: ${label} ${last?.message ?? ''}`);
}
async function json(response) { assert.ok(response.ok(), await response.text()); return response.json(); }
try {
  await until(async () => (await fetch(base + '/api/workspace')).ok, 'station');
  const motion = path.join(directory, 'fixture.mp4');
  execFileSync(ffmpeg, ['-v', 'error', '-f', 'lavfi', '-i', 'testsrc2=size=1920x1080:rate=30', '-t', '2', '-an', '-c:v', 'libx264', '-preset', 'ultrafast', '-pix_fmt', 'yuv420p', '-movflags', '+faststart', motion]);
  const results = [];
  for (const variant of [...(baseline ? [{ name: 'before', dist: baseline }] : []), { name: 'after', dist: null }]) {
    browser = await chromium.launch({ executablePath: process.env.LUMEN_CHROME_PATH || '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome', headless: true, args: ['--autoplay-policy=no-user-gesture-required'] });
    const context = await browser.newContext({ viewport: { width: 1512, height: 982 } }), request = context.request;
    await json(await request.post(base + '/api/auth/login', { data: { username: 'admin', password: 'admin' } }));
    const identity = await json(await request.get(base + '/api/auth/me'));
    let media;
    if (variant.name === 'before' || !results.length) {
      media = await json(await request.post(base + '/api/media/backgrounds', { multipart: { file: { name: 'fixture.mp4', mimeType: 'video/mp4', buffer: await fs.readFile(motion) } } }));
      const image = await sharp({ create: { width: 1920, height: 1080, channels: 3, background: '#234553' } }).png().toBuffer();
      await json(await request.post(base + '/api/media/backgrounds', { multipart: { file: { name: 'image.png', mimeType: 'image/png', buffer: image } } }));
      const items = Array.from({ length: 30 }, (_, i) => ({ id: `point_${i}`, type: 'notes', title: `Point ${i + 1}`, body: 'Faith comes by hearing. Keep learning, keep growing.', durationMs: 120000,
        background: { kind: 'video', src: media.path, loop: true, muted: true, overlayOpacity: .35 }, notesLayout: 'key-points' }));
      await json(await request.put(base + '/api/content', { data: { version: 2, updatedAt: new Date().toISOString(), settings: {}, music: { mode: 'off' },
        channels: [{ id: 'presentation', name: 'Presentation', kind: 'presentation', playlistId: 'deck', defaultMode: 'manual' }], playlists: [{ id: 'deck', name: 'Memory fixture', items }] } }));
    }
    if (variant.dist) await context.route(base + '/**', async route => {
      const pathname = new URL(route.request().url()).pathname;
      if (/^\/(api|media|ws)(\/|$)/.test(pathname)) return route.continue();
      const file = path.join(variant.dist, pathname.startsWith('/assets/') ? pathname : 'index.html');
      try { await route.fulfill({ path: file }); } catch { await route.continue(); }
    });
    await context.addInitScript(() => localStorage.setItem('lumen.slideView', 'grid'));
    page = await context.newPage(); const errors = []; page.on('pageerror', e => errors.push(e.message));
    await page.goto(base); await page.locator('.presentation-grid-card').first().waitFor();
    await until(() => page.locator('.cue-current video').evaluate(v => v.videoWidth === 1920 && v.currentTime > .1), 'full-quality active preview');
    // Same warmup and traversal for both builds, without forcing garbage collection.
    await page.waitForTimeout(8000);
    await page.locator('.presentation-grid-card').last().scrollIntoViewIfNeeded(); await page.waitForTimeout(1500);
    await page.locator('.presentation-grid-card').first().scrollIntoViewIfNeeded(); await page.waitForTimeout(1500);
    const cdp = await browser.newBrowserCDPSession(), samples = [];
    for (let i = 0; i < 5; i++) {
      const { processInfo } = await cdp.send('SystemInfo.getProcessInfo'), ids = new Set(processInfo.map(p => p.id));
      const rss = execFileSync('ps', ['-axo', 'pid=,rss='], { encoding: 'utf8' }).trim().split('\n').map(line => line.trim().split(/\s+/).map(Number))
        .filter(([pid]) => ids.has(pid)).reduce((sum, [, kb]) => sum + kb * 1024, 0);
      samples.push(rss); await page.waitForTimeout(1000);
    }
    const state = await page.evaluate(() => ({ gridPlayers: document.querySelectorAll('.presentation-grid-card video').length,
      queuePlayers: document.querySelectorAll('.cue-queue video').length, textCanvases: document.querySelectorAll('.presentation-grid-card canvas').length,
      loadedPosters: [...document.querySelectorAll('.presentation-grid-card img')].filter(i => i.complete && i.naturalWidth > 0).length,
      current: [...document.querySelectorAll('.cue-current video')].map(v => ({ width: v.videoWidth, height: v.videoHeight, paused: v.paused })) }));
    results.push({ name: variant.name, rssSamplesBytes: samples, medianRssMB: Math.round([...samples].sort((a, b) => a - b)[2] / 1024 ** 2), ...state });
    console.log(JSON.stringify(results.at(-1)));
    await fs.writeFile(path.join(output, 'memory-samples.json'), JSON.stringify(results, null, 2));
    if (variant.name === 'after') {
      assert.equal(state.gridPlayers, 0); assert.equal(state.queuePlayers, 0); assert.ok(state.textCanvases < 30); assert.ok(state.loadedPosters > 0);
      assert.deepEqual(state.current, [{ width: 1920, height: 1080, paused: false }]);
      await page.getByRole('button', { name: 'List view', exact: true }).click();
      assert.equal(await page.locator('.presentation-list-card video').count(), 0);
      // Status UI fixture only; the real listening store still owns the session.
      const snapshot = { session: { id: 'fixture', channelId: 'scripture', source: 'scripture', ownerId: identity.user.id, provider: 'assemblyai', mode: 'automatic', startedAt: Date.now(), state: 'listening', linkedNotes: 2 }, result: null, final: false, turn: -1 };
      await context.addInitScript(snapshot => {
        const Native = window.EventSource;
        window.EventSource = class extends EventTarget {
          constructor(url, options) {
            super(); if (!String(url).endsWith('/api/listening/shared/events')) return new Native(url, options);
            this.closed = false;
            setTimeout(() => { if (!this.closed) { this.onopen?.(new Event('open')); this.onmessage?.(new MessageEvent('message', { data: JSON.stringify(snapshot) })); } }, 20);
          }
          close() { this.closed = true; }
        };
      }, snapshot);
      await context.route('**/api/listening/shared?*', route => { snapshot.session = null; return route.fulfill({ json: snapshot }); });
      await context.route('**/api/listening/shared', route => route.fulfill({ json: snapshot }));
      await page.reload();
      const status = () => page.getByRole('button', { name: 'Listening on — session controls', exact: true });
      await status().waitFor();
      assert.equal(await page.locator('.lumen-header .listening-status').count(), 1);
      assert.equal(await page.locator('.shared-listening-bar').count(), 0);
      await status().click();
      await page.getByText('2 linked', { exact: true }).waitFor(); await page.getByText('Auto publish', { exact: true }).waitFor();
      await page.screenshot({ path: path.join(output, 'header-popover.png') });
      await page.keyboard.press('Escape');
      await page.getByRole('button', { name: 'Open Production Studio', exact: true }).click();
      await status().waitFor(); await status().click();
      await page.getByRole('button', { name: 'Stop shared listening', exact: true }).waitFor();
      await page.keyboard.press('Escape');
      await page.screenshot({ path: path.join(output, 'studio-header.png') });
      await page.setViewportSize({ width: 390, height: 844 }); await status().click();
      await page.getByRole('button', { name: 'Stop shared listening', exact: true }).waitFor();
      const bounds = await page.locator('.listening-session-popover').boundingBox(); assert.ok(bounds.x >= 0 && bounds.x + bounds.width <= 391);
      await page.getByRole('button', { name: 'Stop shared listening', exact: true }).click(); await until(() => status().count().then(n => n === 0), 'stopped status dismissed');
      assert.deepEqual(errors, []);
    }
    await browser.close(); browser = null;
  }
  const report = { passed: true, fixture: '30 slide cards sharing a generated 1080p30 video, 1512 × 982, grid, identical warmup/scrolls', results,
    checks: ['Full-resolution current preview continues playing', 'No card/queue video decoders', 'Offscreen thumbnail canvases released', 'List uses stored posters', 'Header status and details across channel/Studio', 'Popover keyboard dismissal, mobile bounds and Stop'],
    limitation: 'Synthetic browser workload; RSS includes shared pages. Not a whole-service Mac memory guarantee. No recognition pipeline changed.' };
  await fs.writeFile(path.join(output, 'comparison.json'), JSON.stringify(report, null, 2)); console.log(JSON.stringify(report, null, 2));
} catch (error) { if (page) await page.screenshot({ path: path.join(output, 'failure.png') }).catch(() => {}); console.error(logs); throw error; }
finally { await browser?.close(); server.kill('SIGTERM'); }
