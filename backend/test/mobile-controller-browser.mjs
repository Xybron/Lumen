// Actual phone UI + station engine on disposable data and local test TLS only.
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import net from 'node:net';
import { createHash } from 'node:crypto';
import { spawn, execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright-core';
import ffmpeg from 'ffmpeg-static';
import { setupMobile, mobileAddresses } from '../../scripts/mobile-local.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const owned = await fs.mkdtemp(path.join(os.tmpdir(), 'lumen-mobile-browser-'));
const data = path.join(owned, 'station'), tls = path.join(owned, 'tls-settings');
async function port() { const server = net.createServer(); await new Promise(resolve => server.listen(0, '127.0.0.1', resolve)); const value = server.address().port; await new Promise(resolve => server.close(resolve)); return value; }
const backendPort = await port(), mobilePort = await port(), base = `http://127.0.0.1:${backendPort}`, mobile = `https://127.0.0.1:${mobilePort}`;
const privateValues = new Set();
const safe = value => { let result = value instanceof Error ? value.message : String(value); for (const secret of privateValues) result = result.split(secret).join('[redacted]'); return result.replace(/#pair=[^\s"']+/g, '#pair=[redacted]').slice(0, 2000); };
const protectedPaths = ['data/content.json', 'data/production.json', 'data/workspace.json', 'data/broadcast/broadcast-private.json', 'data/outputs/links-private.json'];
async function hashes() { return Object.fromEntries(await Promise.all(protectedPaths.map(async name => [name, await fs.readFile(path.join(root, name)).then(value => createHash('sha256').update(value).digest('hex')).catch(error => { if (error.code === 'ENOENT') return null; throw error; })]))); }
const before = await hashes();
let child, browser, desktop, phone, phone2, request, page, phase = 'setup', logs = '', failures = [];
async function until(fn, label, timeout = 35000) { const end = Date.now() + timeout; while (Date.now() < end) { if (await fn()) return; await new Promise(resolve => setTimeout(resolve, 150)); } throw new Error(`Timed out: ${label}`); }
function pass(label) { console.log(`PASS: ${label}`); }
try {
  const address = mobileAddresses()[0]; assert.ok(address, 'Connect a private local interface for isolated TLS setup checks.');
  const config = await setupMobile({ address, port: mobilePort }, tls);
  await fs.mkdir(path.join(data, 'media/music'), { recursive: true });
  execFileSync(ffmpeg, ['-hide_banner', '-loglevel', 'error', '-f', 'lavfi', '-i', 'sine=frequency=440:sample_rate=48000', '-t', '20', '-c:a', 'pcm_s16le', path.join(data, 'media/music/main.wav')]);
  const env = { ...process.env };
  for (const key of Object.keys(env)) if (/^(?:LUMEN_|VITE_|SUPABASE_|POWERSYNC_)/.test(key)) delete env[key];
  Object.assign(env, { NODE_ENV: 'test', HOST: '127.0.0.1', PORT: String(backendPort), LUMEN_DATA_DIR: data, LUMEN_MOBILE_ORIGIN: mobile, LUMEN_MOBILE_HOST: '127.0.0.1', LUMEN_MOBILE_PORT: String(mobilePort), LUMEN_MOBILE_TLS_KEY: config.key, LUMEN_MOBILE_TLS_CERT: config.cert });
  child = spawn(process.execPath, ['backend/dist/server.js'], { cwd: root, env, stdio: ['ignore', 'pipe', 'pipe'] });
  for (const stream of [child.stdout, child.stderr]) stream.on('data', bytes => { if (logs.length < 15000) logs += bytes.toString(); });
  await until(async () => { if (child.exitCode !== null) throw new Error('Disposable mobile station exited before startup.'); return fetch(`${base}/api/workspace`).then(response => response.ok).catch(() => false); }, 'disposable station startup');
  browser = await chromium.launch({ executablePath: process.env.LUMEN_CHROME_PATH ?? '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome', headless: true, args: ['--autoplay-policy=no-user-gesture-required'] });
  desktop = await browser.newContext({ viewport: { width: 1440, height: 960 } }); request = desktop.request;
  assert.equal((await request.post(`${base}/api/auth/login`, { data: { username: 'admin', password: 'admin' } })).status(), 200);
  const get = () => request.get(`${base}/api/studio`).then(response => response.json());
  const command = async value => { const state = await get(); const response = await request.post(`${base}/api/studio/command`, { data: { revision: state.revision, command: value } }); assert.equal(response.status(), 200); return response.json(); };
  const text = (id, value) => ({ id, name: value, kind: 'text', visible: true, locked: false, x: 8, y: 40, width: 84, height: 20, opacity: 1, fit: 'contain', text: value, color: '#ffffff', background: '#00000000', fontSize: 72, fontWeight: 500, align: 'center', radius: 0 });
  const state = await get();
  state.scenes = [{ id: 'a', name: 'Camera scene', background: '#b52030', layers: [text('a1', 'CAMERA')] }, { id: 'b', name: 'Scripture scene', background: '#204fbb', layers: [text('b1', 'SCRIPTURE')] }];
  state.sources = [{ id: 'main', name: 'Church Main', kind: 'audio', url: 'media/music/main.wav', loop: true, audio: { muted: true, volume: .7, mode: 'follow', delayMs: 0 } }, { id: 'other', name: 'Muted background', kind: 'audio', url: 'media/music/main.wav', loop: false, audio: { muted: true, volume: .5, mode: 'follow', delayMs: 0 } }];
  state.previewSceneId = 'a'; state.masterMuted = false; state.masterVolume = .8;
  const seed = await request.put(`${base}/api/studio`, { data: state }); assert.equal(seed.status(), 200, `Fixture Studio seed: ${await seed.text()}`);
  await command({ type: 'set-main-audio', sourceId: 'main' }); await command({ type: 'take', sceneId: 'a' });
  const prepare = await get(); prepare.previewSceneId = 'b'; await request.put(`${base}/api/studio`, { data: prepare });
  const content = { version: 2, updatedAt: new Date().toISOString(), settings: {}, music: { mode: 'off' }, channels: [
    { id: 'scripture', name: 'Main Scripture', kind: 'scripture', playlistId: 'ps', defaultMode: 'manual' }, { id: 'lyrics', name: 'Worship lyrics', kind: 'lyrics', playlistId: 'pl', defaultMode: 'manual' }, { id: 'slides', name: 'Announcements', kind: 'presentation', playlistId: 'pd', defaultMode: 'manual' }],
    playlists: [{ id: 'ps', name: 'Scripture', items: [] }, { id: 'pl', name: 'Lyrics', items: [] }, { id: 'pd', name: 'Announcements', items: [{ id: 'slide1', type: 'text', title: 'Welcome slide', body: 'Welcome everyone' }, { id: 'slide2', type: 'text', title: 'Closing slide', body: 'See you next week' }] }] };
  assert.equal((await request.put(`${base}/api/content`, { data: content })).status(), 200);
  const song = await request.post(`${base}/api/worship/songs`, { data: { title: 'Amazing Grace QA', author: '', copyright: '', sections: [{ id: 'verse', label: 'Verse', text: 'Amazing grace how sweet the sound' }, { id: 'chorus', label: 'Chorus', text: 'I once was lost but now am found' }] } });
  assert.equal(song.status(), 201);
  assert.equal((await request.post(`${base}/api/studio/engine/start`, { data: {} })).status(), 200);
  await until(async () => (await request.get(`${base}/api/studio/status`).then(response => response.json())).state === 'running', 'actual fixture renderer');
  const baseline = await get();
  const issue = async permissions => { const response = await request.post(`${base}/api/mobile/manage/pair`, { headers: { Origin: base }, data: { permissions } }); assert.equal(response.status(), 200); const value = await response.json(); privateValues.add(value.code); return value; };
  phase = 'secure pairing';
  phone = await browser.newContext({ viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true, deviceScaleFactor: 2, ignoreHTTPSErrors: true });
  page = await phone.newPage(); page.setDefaultTimeout(18000); page.on('pageerror', error => failures.push(safe(error)));
  const observed = []; page.on('request', value => { if (new URL(value.url()).origin === mobile) observed.push(new URL(value.url()).pathname); });
  const stationPage = await desktop.newPage(); await stationPage.goto(`${base}/studio`);
  await stationPage.getByRole('button', { name: 'Mobile control', exact: true }).click();
  const manageDialog = stationPage.getByRole('dialog');
  await manageDialog.getByRole('button', { name: 'Create one-time pairing', exact: true }).click();
  await manageDialog.getByLabel('Private pairing link', { exact: true }).waitFor();
  const pairing = { url: await manageDialog.getByLabel('Private pairing link', { exact: true }).inputValue(), code: await manageDialog.getByLabel('Pairing code', { exact: true }).inputValue() }; privateValues.add(pairing.code);
  await manageDialog.getByRole('button', { name: 'Close', exact: true }).click();
  await page.goto(pairing.url); await page.getByLabel('Device name', { exact: true }).fill('Emergency phone');
  assert.equal(new URL(page.url()).hash, '');
  await page.getByRole('button', { name: 'Pair this phone', exact: true }).click();
  await page.getByRole('button', { name: 'Take control', exact: true }).waitFor();
  assert.deepEqual(await get(), baseline, 'Pairing must not change Studio/audio settings.');
  const cookies = await phone.cookies(); const cookie = cookies.find(value => value.name === '__Host-lumen_mobile');
  assert.ok(cookie?.secure && cookie.httpOnly && cookie.sameSite === 'Strict'); privateValues.add(cookie.value);
  assert.equal(await page.evaluate(() => document.cookie), '');
  assert.ok(!observed.some(name => /\/api\/(?:auth|studio|content|clips|worship)|\/studio\/ws/.test(name)), 'Phone loads only its limited APIs.');
  await page.getByRole('button', { name: 'Take control', exact: true }).click();
  await page.getByText('You have phone control', { exact: true }).waitFor();
  pass('HTTPS pairing strips link secret, uses a Secure HttpOnly Strict session and changes no production settings.');
  const programVideo = page.getByLabel('Muted live Program monitor', { exact: true });
  async function pictureIs(expected) {
    return programVideo.evaluate((video, expected) => {
      if (video.readyState < 2 || video.paused || !video.videoWidth) return false;
      const canvas = document.createElement('canvas'); canvas.width = canvas.height = 1;
      const context = canvas.getContext('2d'); context.drawImage(video, 2, 2, 4, 4, 0, 0, 1, 1);
      const [r, , b] = context.getImageData(0, 0, 1, 1).data;
      return expected === 'red' ? r > 100 && r > b * 2 : b > 100 && b > r * 2;
    }, expected);
  }
  await until(() => pictureIs('red'), 'actual low-resolution mobile Program video');
  assert.deepEqual(await programVideo.evaluate(video => ({ width: video.videoWidth, height: video.videoHeight, muted: video.muted, audio: video.srcObject.getAudioTracks().length })), { width: 640, height: 360, muted: true, audio: 0 });
  pass('The HTTPS confidence monitor decodes actual Program at 640×360 with no audio tracks.');
  phase = 'responsive Cut Fade and scene controls';
  for (const [width, height] of [[320, 700], [390, 844], [844, 390], [768, 1024]]) {
    await page.setViewportSize({ width, height });
    assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1), `No horizontal overflow at ${width}px`);
    const cut = page.getByRole('button', { name: 'Cut', exact: true });
    const bounds = await cut.boundingBox(); assert.ok(bounds && bounds.width >= 44 && bounds.height >= 44);
  }
  await page.setViewportSize({ width: 390, height: 844 });
  await page.getByRole('button', { name: 'Cut', exact: true }).click();
  await until(async () => (await get()).program?.id === 'b' && (await get()).previewSceneId === 'a', 'Cut swaps both buses');
  await until(() => pictureIs('blue'), 'Cut updates real mobile picture');
  await page.getByLabel('Fade duration', { exact: true }).fill('450'); await page.getByLabel('Fade duration', { exact: true }).blur();
  await page.getByRole('button', { name: 'Fade', exact: true }).click();
  await until(async () => (await get()).program?.id === 'a' && (await get()).previewSceneId === 'b', 'Fade swaps both buses');
  assert.equal((await get()).programTransition.durationMs, 450);
  await until(() => pictureIs('red'), 'Fade updates real mobile picture');
  await page.screenshot({ path: '/private/tmp/lumen-mobile-live.png', fullPage: true });
  await page.getByRole('navigation', { name: 'Remote controls' }).getByRole('button', { name: 'Scenes', exact: true }).click();
  await page.getByRole('button', { name: 'Preview Camera scene', exact: true }).click();
  await until(async () => (await get()).previewSceneId === 'a', 'scene selection updates Preview');
  assert.equal((await get()).program.id, 'a');
  pass('Phone layouts fit portrait/landscape; Cut/Fade swap buses and scene taps only select Preview.');
  phase = 'channel controls';
  await page.getByRole('navigation', { name: 'Remote controls' }).getByRole('button', { name: 'Channels', exact: true }).click();
  const programBeforeChannels = await get();
  await page.getByLabel('Remote channel', { exact: true }).selectOption('scripture');
  await page.getByLabel('Search channel content', { exact: true }).fill('jn3 16');
  const verse = page.locator('.mobile-result').filter({ hasText: 'John 3:16' }); await verse.waitFor(); await verse.click();
  assert.equal((await request.get(`${base}/api/worship/channels/scripture`).then(response => response.json())).live, null);
  await page.getByRole('button', { name: 'Send live', exact: true }).click();
  await until(async () => (await request.get(`${base}/api/worship/channels/scripture`).then(response => response.json())).live?.selection.verse === 16, 'explicit Scripture Send live');
  await page.getByRole('button', { name: 'Next', exact: true }).click();
  await until(async () => (await request.get(`${base}/api/worship/channels/scripture`).then(response => response.json())).live?.selection.verse === 17, 'next Scripture verse');
  await page.getByRole('button', { name: 'Hide', exact: true }).click();
  await page.getByRole('dialog').getByRole('button', { name: 'Hide channel', exact: true }).click();
  await until(async () => (await request.get(`${base}/api/worship/channels/scripture`).then(response => response.json())).blanked, 'confirmed channel hide');
  await page.getByRole('button', { name: 'Show', exact: true }).click();
  await until(async () => !(await request.get(`${base}/api/worship/channels/scripture`).then(response => response.json())).blanked, 'show channel');
  await page.getByLabel('Remote channel', { exact: true }).selectOption('lyrics');
  await page.getByLabel('Search channel content', { exact: true }).fill('amazin grace');
  const lyric = page.locator('.mobile-result').filter({ hasText: 'Amazing grace how sweet' }); await lyric.waitFor(); await lyric.click();
  await page.getByRole('button', { name: 'Send live', exact: true }).click();
  await until(async () => (await request.get(`${base}/api/worship/channels/lyrics`).then(response => response.json())).live?.text.includes('Amazing grace'), 'lyrics Send live');
  await page.getByRole('button', { name: 'Next', exact: true }).click();
  await until(async () => (await request.get(`${base}/api/worship/channels/lyrics`).then(response => response.json())).live?.selection.sectionId === 'chorus', 'next lyric section');
  await page.getByLabel('Remote channel', { exact: true }).selectOption('slides');
  await page.locator('.mobile-result').filter({ hasText: 'Welcome slide' }).click(); await page.getByRole('button', { name: 'Send live', exact: true }).click();
  await page.locator('.mobile-channel-live').getByRole('heading', { name: 'Welcome slide', exact: true }).waitFor();
  await page.getByRole('button', { name: 'Next', exact: true }).click();
  await page.getByRole('heading', { name: 'Closing slide', exact: true }).waitFor();
  const slideViewer = await desktop.newPage(); await slideViewer.goto(`${base}/live/slides`);
  await slideViewer.getByText('See you next week', { exact: true }).waitFor();
  await slideViewer.close();
  assert.deepEqual(await get(), programBeforeChannels, 'Channel commands never take a Studio scene or change the mix.');
  pass('Scripture, lyrics and presentation controls update only their channel; preparation never publishes automatically.');
  phase = 'Main audio only';
  await page.getByRole('navigation', { name: 'Remote controls' }).getByRole('button', { name: 'Audio', exact: true }).click();
  await page.getByRole('button', { name: 'Mute Main', exact: true }).click();
  await until(async () => (await get()).sources.find(source => source.id === 'main').audio.muted, 'mute existing Main');
  await page.getByRole('button', { name: 'Unmute Main', exact: true }).click();
  await until(async () => !(await get()).sources.find(source => source.id === 'main').audio.muted, 'unmute existing Main');
  await page.locator('#remote-main-volume').dispatchEvent('pointerdown');
  await page.locator('#remote-main-volume').evaluate(input => { input.value = '42'; input.dispatchEvent(new Event('input', { bubbles: true })); input.dispatchEvent(new Event('change', { bubbles: true })); });
  await until(async () => (await get()).sources.find(source => source.id === 'main').audio.volume === .42, 'Main volume updates');
  const audio = await get(); assert.equal(audio.mainAudioSourceId, 'main'); assert.equal(audio.masterVolume, baseline.masterVolume); assert.equal(audio.masterMuted, baseline.masterMuted);
  assert.deepEqual(audio.sources.find(source => source.id === 'other'), baseline.sources.find(source => source.id === 'other'));
  const nav = await page.locator('.mobile-bottom-nav > button').evaluateAll(buttons => buttons.map(button => ({ text: button.innerText, visibility: getComputedStyle(button).visibility, opacity: getComputedStyle(button).opacity, width: button.getBoundingClientRect().width, height: button.getBoundingClientRect().height })));
  assert.deepEqual(nav.map(item => item.text), ['Live', 'Scenes', 'Channels', 'Audio']);
  assert.ok(nav.every(item => item.visibility === 'visible' && item.opacity === '1' && item.width >= 44 && item.height >= 44));
  await page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
  await page.screenshot({ path: '/private/tmp/lumen-mobile-audio.png', fullPage: true });
  pass('Main mute/volume work without selecting another source, unmuting other audio or changing output settings.');
  phase = 'offline, takeover and revocation';
  await page.getByRole('navigation', { name: 'Remote controls' }).getByRole('button', { name: 'Live', exact: true }).click();
  await phone.setOffline(true); await page.getByText('Controls paused', { exact: true }).waitFor();
  assert.equal(await page.getByRole('button', { name: 'Cut', exact: true }).isDisabled(), true);
  const offlineState = await get(); await phone.setOffline(false);
  await until(async () => !await page.getByRole('button', { name: 'Cut', exact: true }).isDisabled(), 'automatic fresh-state reconnect');
  assert.deepEqual(await get(), offlineState, 'Reconnect must not replay an action.');
  phone2 = await browser.newContext({ viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true, ignoreHTTPSErrors: true });
  const pairing2 = await issue({ studio: false, channels: false, audio: true });
  assert.equal((await phone2.request.post(`${mobile}/api/mobile/session`, { headers: { Origin: mobile }, data: { code: pairing2.code, name: 'Audio backup' } })).status(), 200);
  assert.equal((await phone2.request.post(`${mobile}/api/mobile/lease`, { headers: { Origin: mobile }, data: {} })).status(), 409);
  assert.equal((await phone2.request.post(`${mobile}/api/mobile/lease`, { headers: { Origin: mobile }, data: { takeover: true } })).status(), 200);
  await until(async () => await page.getByRole('button', { name: 'Cut', exact: true }).isDisabled(), 'another phone takeover disables old controller');
  const restricted = await phone2.request.get(`${mobile}/api/mobile/state`).then(response => response.json()); privateValues.add(restricted.ticket);
  assert.equal((await phone2.request.post(`${mobile}/api/mobile/control`, { headers: { Origin: mobile }, data: { ticket: restricted.ticket, leaseId: restricted.lease.id, action: { type: 'take', transition: 'cut' } } })).status(), 403);
  const session = await phone.request.get(`${mobile}/api/mobile/session`).then(response => response.json());
  assert.equal((await request.delete(`${base}/api/mobile/manage/devices/${session.device.id}`, { headers: { Origin: base } })).status(), 200);
  await page.getByRole('button', { name: 'Pair this phone', exact: true }).waitFor();
  pass('Disconnect pauses controls, reconnect replays nothing, explicit takeover transfers phone control and desktop revocation removes access.');
  assert.deepEqual(failures, []); assert.deepEqual(await hashes(), before);
  pass('Real station scenes, saved keys, workspace identity, Main audio and saved output links remain byte-for-byte unchanged.');
  console.log('Mobile controller browser regression passed; no real phone/network or public deployment is claimed.');
} catch (error) {
  if (page && !page.isClosed()) await page.screenshot({ path: '/private/tmp/lumen-mobile-failure.png', fullPage: true, mask: [page.locator('[data-team-private], [data-mobile-private]')] }).catch(() => {});
  console.error(`Mobile browser test failed at ${phase}: ${safe(error)}`); process.exitCode = 1;
} finally {
  if (request) { await request.post(`${base}/api/studio/engine/stop`, { data: {} }).catch(() => {}); }
  await browser?.close().catch(() => {});
  if (child && child.exitCode === null && child.signalCode === null) { const stopped = new Promise(resolve => child.once('exit', resolve)); child.kill('SIGTERM'); let timer; await Promise.race([stopped, new Promise(resolve => { timer = setTimeout(resolve, 8000); })]); clearTimeout(timer); if (child.exitCode === null && child.signalCode === null) { child.kill('SIGKILL'); await stopped; } }
  await fs.rm(owned, { recursive: true, force: true });
}
