// Explicit local-browser integration: the standalone relay's default suite
// does not require the parent application's Chromium/FFmpeg dependencies.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';
import { randomBytes } from 'node:crypto';
import { spawn } from 'node:child_process';
import { createWatchRelay } from '../server.mjs';

for (const workspaceId of [null, '11111111-1111-4111-8111-111111111111']) {
test(`clean private output decodes real HLS through an HttpOnly session without leaking its fragment capability${workspaceId ? ' (workspace scoped)' : ''}`, { skip: process.env.LUMEN_TEST_OUTPUT_BROWSER !== '1', timeout: 45000 }, async () => {
  const require = createRequire(new URL('../../backend/package.json', import.meta.url));
  const { chromium } = require('playwright-core'), ffmpeg = require('ffmpeg-static');
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'lumen-output-browser-'));
  const media = path.join(directory, 'hls'); await fs.mkdir(media);
  const pushToken = randomBytes(48).toString('hex'), viewerToken = randomBytes(48).toString('hex');
  let relay, browser;
  const until = async (fn, label) => { const started = Date.now(); while (Date.now() - started < 25000) { if (await fn()) return; await new Promise(resolve => setTimeout(resolve, 100)); } throw new Error(`Timed out: ${label}`); };
  try {
    await new Promise((resolve, reject) => {
      const child = spawn(ffmpeg, ['-hide_banner', '-loglevel', 'error', '-y', '-f', 'lavfi', '-i', 'testsrc2=size=640x360:rate=24', '-f', 'lavfi', '-i', 'sine=frequency=440:sample_rate=48000', '-t', '6', '-threads', '2', '-c:v', 'libx264', '-preset', 'ultrafast', '-pix_fmt', 'yuv420p', '-g', '24', '-sc_threshold', '0', '-c:a', 'aac', '-b:a', '96k', '-f', 'hls', '-hls_time', '1', '-hls_list_size', '6', '-hls_flags', 'independent_segments+discont_start', '-hls_segment_filename', path.join(media, 'segment-%08d.ts'), path.join(media, 'index.m3u8')], { stdio: ['ignore', 'ignore', 'pipe'] });
      let error = ''; child.stderr.on('data', bytes => { if (error.length < 8192) error += bytes.toString(); });
      child.once('error', reject); child.once('exit', code => code === 0 ? resolve() : reject(new Error(error || 'FFmpeg failed.')));
    });
    const registration = { pushToken, viewerToken, allowedSlugs: ['live', 'program'], privateSlugs: ['program'] };
    relay = await createWatchRelay({ dataDir: path.join(directory, 'relay'), ...(workspaceId ? { tenants: [{ workspaceId, ...registration }] } : registration), allowInsecureLocalhostForTests: true });
    await new Promise(resolve => relay.server.listen(0, '127.0.0.1', resolve));
    const base = `http://127.0.0.1:${relay.server.address().port}`;
    const prefix = workspaceId ? `${workspaceId}/` : '', privateScope = `${prefix}program`;
    for (const slug of ['program', 'live']) {
      const push = (suffix, method = 'POST', body = '{}') => fetch(`${base}/api/push/${prefix}${slug}/${suffix}`, { method, headers: { Authorization: `Bearer ${pushToken}` }, body });
      const begin = await push('sessions', 'POST', '{"epoch":"protected-browser-fixture-0001"}');
      assert.equal(begin.status, 201); const session = (await begin.json()).sessionId;
      for (const name of (await fs.readdir(media)).filter(name => /^segment-\d{8,20}\.ts$/.test(name))) assert.equal((await push(`${session}/${name}`, 'PUT', await fs.readFile(path.join(media, name)))).status, 201);
      assert.equal((await push(`${session}/index.m3u8`, 'PUT', await fs.readFile(path.join(media, 'index.m3u8')))).status, 200);
    }
    browser = await chromium.launch({ executablePath: process.env.LUMEN_CHROME_PATH ?? '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome', headless: true, args: ['--autoplay-policy=no-user-gesture-required'] });
    const context = await browser.newContext({ viewport: { width: 1280, height: 720 } }), page = await context.newPage();
    const errors = [], urls = [], writes = [];
    page.on('pageerror', error => errors.push(error.message));
    page.on('request', request => { urls.push(request.url()); if (!['GET', 'HEAD'].includes(request.method())) writes.push(new URL(request.url()).pathname); });
    await page.goto(`${base}/output/${privateScope}#key=${viewerToken}`);
    await until(() => page.locator('video').evaluate(video => video.videoWidth === 640 && video.videoHeight === 360 && video.readyState >= 2 && video.currentTime > 0.1 && !video.paused), 'real authorized HLS playback');
    await until(() => page.locator('#placeholder').isVisible().then(visible => !visible), 'clean player hides its connecting state after decoding');
    const variance = await page.locator('video').evaluate(video => { const canvas = document.createElement('canvas'); canvas.width = 16; canvas.height = 9; const context = canvas.getContext('2d'); context.drawImage(video, 0, 0, 16, 9); const bytes = context.getImageData(0, 0, 16, 9).data; return Math.max(...bytes) - Math.min(...bytes); });
    assert.ok(variance > 100, 'The authorized player decodes an actual nonblank Program picture.');
    assert.equal(new URL(page.url()).hash, '');
    assert.equal(await page.evaluate(() => document.cookie), '', 'Script cannot read the HttpOnly viewer session.');
    assert.equal(await page.locator('video').evaluate(video => video.muted), true);
    assert.equal(await page.locator('#placeholder').isVisible(), false);
    assert.equal(await page.locator('header,footer,[role=toolbar]').count(), 0);
    assert.deepEqual(writes, [`/api/output/${privateScope}/session`]);
    assert.ok(urls.every(url => !url.includes(viewerToken) && !url.includes(pushToken) && !new URL(url).search));
    const info = await page.evaluate(async scope => { const response = await fetch(`/api/output/${scope}/info`); return { status: response.status, data: await response.json() }; }, privateScope);
    assert.equal(info.status, 200); assert.equal(info.data.protected, true);
    if (workspaceId) assert.equal(info.data.workspaceId, workspaceId);
    assert.ok(urls.some(url => new URL(url).pathname.startsWith(`/hls/${privateScope}/`)), 'Media requests retain their workspace and stream namespace.');
    await page.screenshot({ path: workspaceId ? '/private/tmp/lumen-tenant-program-output.png' : '/private/tmp/lumen-secure-program-output.png' });
    const publicContext = await browser.newContext(), publicPage = await publicContext.newPage();
    await publicPage.goto(`${base}/watch/${prefix}live`);
    await until(() => publicPage.locator('video').evaluate(video => video.videoWidth === 640 && video.readyState >= 2 && video.currentTime > .1 && !video.paused), 'actual public Watch video decode');
    assert.equal((await publicContext.cookies()).length, 0, 'Public Watch does not need a private-output viewer session.');
    await publicContext.close();
    await context.clearCookies();
    await page.reload();
    await until(() => page.locator('#headline').textContent().then(text => text === 'Output access required'), 'access denied after removing viewer session');
    assert.equal(await page.locator('video').evaluate(video => video.paused && !video.getAttribute('src')), true);
    assert.deepEqual(errors, []);
    console.log('PASS: private clean Program HLS decode, cookie auth, fragment removal, no secret URLs, muted autoplay and denied reload without session.');
  } finally { await browser?.close(); await relay?.close(); await fs.rm(directory, { recursive: true, force: true }); }
});
}
