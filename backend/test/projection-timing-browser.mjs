// Exercise the built audience views with generated slides and an in-memory station.
// No operator login, physical devices, station data or external network required.
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { chromium } from 'playwright-core';

const dist = process.env.LUMEN_PROJECTION_DIST ?? fileURLToPath(new URL('../../frontend/dist', import.meta.url));
const browser = await chromium.launch({ channel: 'chrome', executablePath: process.env.LUMEN_CHROME_PATH, headless: true });
const content = {
  settings: { warningAtMs: 2000, countdownAtMs: 1000 }, channels: [{ id: 'slides', kind: 'presentation', playlistId: 'deck' }],
  playlists: [{ id: 'deck', items: ['First slide', 'Next slide'].map((body, i) => ({ id: 'slide' + i, type: 'text', body, durationMs: 10000 })) }],
  program: { programSourceId: 'slide-source' }, sources: [{ id: 'slide-source', kind: 'channel', ref: 'slides' }], routes: [],
};
try {
  const context = await browser.newContext({ viewport: { width: 1920, height: 1080 } });
  await context.routeWebSocket('**/ws', socket => { socket.onMessage(() => {}); });
  await context.route('**/*', async route => {
    const url = new URL(route.request().url());
    if (url.hostname !== 'localhost') return route.abort();
    if (url.pathname === '/api/content') return route.fulfill({ json: content });
    if (url.pathname.startsWith('/api/')) return route.fulfill({ status: 401, json: {} });
    if (url.pathname.startsWith('/assets/')) return route.fulfill({ body: await readFile(path.join(dist, url.pathname)),
      contentType: url.pathname.endsWith('.css') ? 'text/css' : 'text/javascript' });
    return route.fulfill({ body: await readFile(path.join(dist, 'index.html')), contentType: 'text/html' });
  });
  await context.addInitScript(() => {
    window.frameCallbacks = 0;
    const schedule = requestAnimationFrame.bind(window);
    window.requestAnimationFrame = callback => schedule(time => { window.frameCallbacks++; callback(time); });
    window.cueMeasurements = 0;
    const height = Object.getOwnPropertyDescriptor(Element.prototype, 'scrollHeight');
    Object.defineProperty(Element.prototype, 'scrollHeight', { ...height, get() {
      if (this.classList.contains('cue-body')) window.cueMeasurements++;
      return height.get.call(this);
    } });
  });
  for (const url of ['/live/slides', '/out/display']) {
    const page = await context.newPage(), errors = [];
    page.on('pageerror', error => errors.push(error.message));
    await page.goto('http://localhost' + url);
    await page.locator('.firey-fill').waitFor({ state: 'attached' });
    const send = msg => page.evaluate(msg => {
      const channel = new BroadcastChannel('lumen-state'); channel.postMessage(msg); channel.close();
    }, msg);
    const state = patch => send({ t: 'state', channel: 'slides', payload: {
      channelId: 'slides', playlistId: 'deck', index: 0, mode: 'auto', playing: false, blanked: false,
      durationMs: 10000, startedAt: null, ...patch,
    } });
    const tick = ms => send({ t: 'tick', channel: 'slides', elapsedMs: ms, remainingMs: 10000 - ms });
    const cdp = await context.newCDPSession(page);
    await cdp.send('Performance.enable');
    async function measure() {
      const stats = async () => ({
        raf: await page.evaluate(() => window.frameCallbacks),
        layouts: (await cdp.send('Performance.getMetrics')).metrics.find(metric => metric.name === 'LayoutCount').value,
      });
      const before = await stats(); await page.waitForTimeout(1000); const after = await stats();
      return { raf: after.raf - before.raf, layouts: after.layouts - before.layouts };
    }
    await state({ mode: 'manual' });
    await page.getByText('First slide', { exact: true }).waitFor();
    await page.waitForTimeout(1400);
    const manual = await measure();
    await state({ playing: true }); await tick(3000);
    await page.waitForTimeout(160);
    const bar = page.locator('.firey-tip');
    const progress = () => bar.evaluate(el => (el.getBoundingClientRect().left + el.offsetWidth / 2) / innerWidth);
    const start = await progress();
    await page.evaluate(start => {
      const channel = new BroadcastChannel('lumen-state'), since = performance.now();
      const id = setInterval(() => {
        const elapsedMs = Math.round(start * 10000 + performance.now() - since);
        channel.postMessage({ t: 'tick', channel: 'slides', elapsedMs, remainingMs: 10000 - elapsedMs });
      }, 125);
      window.stopTicks = () => { clearInterval(id); channel.close(); };
    }, start);
    const playing = await measure();
    await page.evaluate(() => window.stopTicks());
    const end = await progress();
    assert.ok(start >= .3 && start < .45 && end >= start + .08 && end < start + .2, 'Timed progress follows elapsed time between ticks');
    await tick(7800); await page.waitForTimeout(100);
    assert.ok(await progress() > .77, 'Progress corrects to authoritative tick');
    await state({ playing: true, blanked: true });
    await bar.waitFor({ state: 'detached' });
    await tick(8000);
    await state({ playing: true });
    await bar.waitFor();
    assert.ok(await progress() >= .8, 'Restoring a blanked projection resumes at the live clock');
    await state({}); await tick(4400); await page.waitForTimeout(100);
    assert.ok(Math.abs(await progress() - .44) < .015);
    await state({}); // A repeated paused state must not erase the final tick.
    const paused = await measure();
    assert.ok(Math.abs(await progress() - .44) < .015, 'Paused bar holds its last position');
    await state({ index: 1, playing: true }); await tick(0);
    await page.getByText('Next slide', { exact: true }).waitFor();
    assert.ok(await progress() < .20, 'New slide restarts its timer');
    await tick(10000); await page.waitForTimeout(80);
    assert.ok(await progress() >= .99, 'Elapsed clock stops at the end of the slide');
    await tick(2500); await page.waitForTimeout(220);
    assert.ok(await progress() > .26 && await progress() < .32, 'An authoritative seek restarts a completed animation');
    const cue = body => state({ mode: 'manual', cue: { id: 'cue_verse', type: 'scripture', body, typography: { size: 'lg' } } });
    await cue('Sing a new song'); await page.locator('.cue-body').waitFor();
    await page.waitForTimeout(800);
    const shortReads = await page.evaluate(() => window.cueMeasurements);
    const long = 'Sing to the Lord a new song. '.repeat(52);
    await cue(long); await page.getByText(long.trim(), { exact: true }).waitFor();
    await page.waitForTimeout(100);
    const longReads = await page.evaluate(() => window.cueMeasurements) - shortReads;
    const fits = () => page.locator('.cue-body').evaluate(el => el.scrollHeight <= el.parentElement.clientHeight + 1 && el.scrollWidth <= el.clientWidth + 1);
    assert.ok(await fits(), 'Long cue fits the projector');
    await page.setViewportSize({ width: 900, height: 600 }); await page.waitForTimeout(200);
    assert.ok(await fits(), 'Cue refits on a projector resize');
    assert.deepEqual(errors, []);
    console.log(JSON.stringify({ url, manual, playing, paused, shortReads, longReads }));
    for (const sample of [manual, playing, paused]) {
      assert.ok(sample.raf <= 2 && sample.layouts <= 2, 'No display-rate JS or layouts for the projection clock');
    }
    assert.ok(shortReads > 0 && shortReads <= 2 && longReads > 0 && longReads < 12, 'Text measurements follow actual fit');
    await page.close();
  }
} finally { await browser.close(); }
