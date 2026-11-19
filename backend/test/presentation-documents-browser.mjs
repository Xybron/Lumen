// End-to-end static document import against an isolated station. No operator
// files, live streams, recording devices or installed station are touched.
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import net from 'node:net';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright-core';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'lumen-documents-browser-'));
const port = Number(process.env.LUMEN_DOCUMENT_TEST_PORT || 3515), base = `http://127.0.0.1:${port}`;
const converter = process.env.LUMEN_SOFFICE_PATH || path.join(root, 'desktop/build/resources/documents/LibreOffice.app/Contents/MacOS/soffice');
await fs.access(converter);
await new Promise((resolve, reject) => { const probe = net.createServer(); probe.once('error', reject); probe.listen(port, '127.0.0.1', () => probe.close(resolve)); });
let server, browser, page, logs = ''; const errors = [], checks = [];
async function until(fn, label, timeout = 30_000) { const end = Date.now() + timeout; let last; while (Date.now() < end) { try { const result = await fn(); if (result) return result; } catch (error) { last = error; } await new Promise(resolve => setTimeout(resolve, 100)); } throw new Error(`Timed out: ${label}${last ? ` (${last.message})` : ''}`); }
try {
  server = spawn(process.execPath, ['backend/dist/server.js'], { cwd: root, env: { ...process.env, HOST: '127.0.0.1', PORT: String(port), LUMEN_DATA_DIR: directory, LUMEN_SOFFICE_PATH: converter }, stdio: ['ignore', 'pipe', 'pipe'] });
  server.stdout.on('data', data => { logs += data; }); server.stderr.on('data', data => { logs += data; });
  await until(async () => (await fetch(`${base}/api/studio`, { signal: AbortSignal.timeout(1500) })).ok, 'station ready');
  browser = await chromium.launch({ executablePath: process.env.LUMEN_CHROME_PATH || '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome', headless: true });
  const context = await browser.newContext({ viewport: { width: 1512, height: 982 } }), request = context.request;
  assert.equal((await request.post(`${base}/api/auth/login`, { data: { username: 'admin', password: 'admin' } })).status(), 200);
  const fixture = { version: 2, updatedAt: new Date().toISOString(), settings: {}, music: { mode: 'off' }, channels: [{ id: 'documents', name: 'Document presentation', kind: 'presentation', playlistId: 'deck', defaultMode: 'manual' }], playlists: [{ id: 'deck', name: 'Document presentation', items: [] }] };
  assert.equal((await request.put(`${base}/api/content`, { data: fixture })).status(), 200);
  const content = async () => (await (await request.get(`${base}/api/content`)).json()).playlists[0];
  const untouchedProgram = await (await request.get(`${base}/api/studio`)).json();
  const pdfPage = await context.newPage();
  await pdfPage.setContent('<style>@page{size:1280px 720px;margin:0}body{margin:0}section{height:720px;box-sizing:border-box;padding:80px;color:white;background:#8b2a68;font:48px Arial;break-after:page}section:last-child{background:#214c66;break-after:auto}</style><section>Prayer focus<br><h1>We gather together</h1></section><section><h1>Closing reflection</h1>We move forward with purpose.</section>');
  const pdf = await pdfPage.pdf({ preferCSSPageSize: true, printBackground: true }); await pdfPage.close();
  page = await context.newPage(); page.on('pageerror', error => errors.push(error.message)); page.setDefaultTimeout(15000);
  await page.goto(base); await page.getByRole('main', { name: 'Slide editor' }).waitFor();
  const openImport = async label => { await page.getByRole('button', { name: 'New slide', exact: true }).first().click(); await page.locator('.content-chooser').getByRole('button', { name: new RegExp(`^${label}`) }).click(); await page.getByRole('heading', { name: `Import ${label}`, exact: true }).waitFor(); };
  await openImport('PowerPoint');
  await page.getByLabel('Choose PowerPoint document').setInputFiles(path.join(root, 'backend/test/fixtures/presentation-static.pptx'));
  await page.getByRole('button', { name: 'Page 2', exact: true }).waitFor({ timeout: 60_000 });
  await until(() => page.locator('.document-import-page img').evaluateAll(images => images.length === 2 && images.every(image => image.complete && image.naturalWidth === 3840)), 'PowerPoint preview decoding');
  await page.screenshot({ path: path.join(directory, 'powerpoint-review.png') });
  await page.getByRole('button', { name: 'Page 1', exact: true }).click();
  await page.getByRole('button', { name: 'Import 1 page', exact: true }).click();
  await page.getByRole('heading', { name: 'Import PowerPoint', exact: true }).waitFor({ state: 'hidden' });
  const ppt = await until(async () => { const value = await content(); return value.items.length === 1 && value; }, 'selected PowerPoint slide saved');
  assert.equal(ppt.groups.length, 1); assert.equal(ppt.items[0].document.page, 2); assert.equal(ppt.items[0].document.totalPages, 2); assert.equal(ppt.items[0].document.type, 'powerpoint'); assert.equal(ppt.items[0].background.fit, 'contain');
  checks.push('PowerPoint imported through UI with two decoded previews; only selected page2 saved in a group');
  await page.getByLabel('Destination group').selectOption('');
  await openImport('PDF'); await page.getByLabel('Choose PDF document').setInputFiles({ name: 'Prayer focus.pdf', mimeType: 'application/pdf', buffer: pdf });
  await page.getByRole('button', { name: 'Page 2', exact: true }).waitFor({ timeout: 60_000 });
  await until(() => page.locator('.document-import-page img').evaluateAll(images => images.length === 2 && images.every(image => image.complete && image.naturalWidth === 3840)), 'PDF preview decoding');
  await page.getByRole('button', { name: 'Import 2 pages', exact: true }).click();
  await page.getByRole('heading', { name: 'Import PDF', exact: true }).waitFor({ state: 'hidden' });
  const imported = await until(async () => { const value = await content(); return value.items.length === 3 && value; }, 'PDF group saved');
  assert.equal(imported.groups.length, 2); assert.equal(imported.items.filter(item => item.document.type === 'pdf').length, 2);
  assert.ok(imported.items.every(item => item.groupId && imported.groups.some(group => group.id === item.groupId)));
  const decode = await page.evaluate(async items => Promise.all(items.map(async item => { const image = new Image(); image.src = '/' + item.background.src; await image.decode(); return { width: image.naturalWidth, height: image.naturalHeight }; })), imported.items);
  assert.ok(decode.every(size => size.width === 3840 && size.height === 2160));
  checks.push('PDF pages imported as a second group; all promoted source images decode at 3840×2160');
  await page.reload(); await page.getByRole('main', { name: 'Slide editor' }).waitFor();
  await page.getByRole('button', { name: 'Collapse presentation-static', exact: true }).waitFor();
  await page.getByRole('button', { name: 'Collapse Prayer focus', exact: true }).waitFor();
  assert.deepEqual(await content(), imported); assert.equal(await page.locator('.slide-outline-row').count(), 3);
  const afterProgram = await (await request.get(`${base}/api/studio`)).json();
  assert.equal(afterProgram.programSceneId, untouchedProgram.programSceneId);
  await page.screenshot({ path: path.join(directory, 'document-groups.png') });
  checks.push('Groups and document provenance persist after reload; import does not take over Program');
  assert.deepEqual(errors, []);
  await fs.writeFile(path.join(directory, 'report.json'), JSON.stringify({ ok: true, checks, decodedImages: decode, errors }, null, 2));
  console.log(JSON.stringify({ ok: true, directory, checks }, null, 2));
} catch (error) { if (page) await page.screenshot({ path: path.join(directory, 'failure.png') }).catch(() => {}); console.error(JSON.stringify({ directory, error: error.message, errors, logs: logs.slice(-6000) }, null, 2)); process.exitCode = 1; }
finally { await browser?.close(); if (server && server.exitCode === null) { server.kill('SIGTERM'); await Promise.race([new Promise(resolve => server.once('exit', resolve)), new Promise(resolve => setTimeout(resolve, 7000))]); if (server.exitCode === null) server.kill('SIGKILL'); } }
