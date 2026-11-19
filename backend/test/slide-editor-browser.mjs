// Exercise the actual editor against a disposable station. No installed station
// settings, media or presentation content are read or modified by this test.
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import net from 'node:net';
import { spawn, execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright-core';
import ffmpeg from 'ffmpeg-static';

const root = process.env.LUMEN_SLIDE_EDITOR_TEST_ROOT
  ? path.resolve(process.env.LUMEN_SLIDE_EDITOR_TEST_ROOT)
  : path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'lumen-slide-editor-data-'));
const artifacts = process.env.LUMEN_SLIDE_EDITOR_ARTIFACTS
  ? path.resolve(process.env.LUMEN_SLIDE_EDITOR_ARTIFACTS)
  : await fs.mkdtemp(path.join(os.tmpdir(), 'lumen-slide-editor-report-'));
const port = Number(process.env.LUMEN_SLIDE_EDITOR_TEST_PORT || 3518);
const base = `http://127.0.0.1:${port}`;
const environment = Object.fromEntries(Object.entries(process.env).filter(([name]) =>
  !/^(LUMEN_|VPS_|MEDIA_ENGINE_|SUPABASE_|POWERSYNC_|VITE_|NODE_OPTIONS$|NODE_PATH$|ELECTRON_RUN_AS_NODE$)/i.test(name)));
const measurements = [], checks = [], errors = [];
let server, browser, page, logs = '';

async function until(check, label, timeout = 20000) {
  const end = Date.now() + timeout; let last;
  while (Date.now() < end) {
    try { const value = await check(); if (value) return value; } catch (error) { last = error; }
    await new Promise(resolve => setTimeout(resolve, 100));
  }
  throw new Error(`Timed out: ${label}${last ? ` (${last.message})` : ''}`);
}
async function frame() { await page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)))); }

try {
  await fs.mkdir(artifacts, { recursive: true });
  await new Promise((resolve, reject) => {
    const probe = net.createServer(); probe.once('error', reject);
    probe.listen(port, '127.0.0.1', () => probe.close(resolve));
  });
  await fs.mkdir(path.join(directory, 'media/backgrounds'), { recursive: true });
  browser = await chromium.launch({
    executablePath: process.env.LUMEN_CHROME_PATH || '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
    headless: true,
  });
  const context = await browser.newContext({ viewport: { width: 1512, height: 982 } });
  context.setDefaultTimeout(12000);
  page = await context.newPage(); page.on('pageerror', error => errors.push(error.message));
  const png = await page.evaluate(() => {
    const canvas = document.createElement('canvas'); canvas.width = 640; canvas.height = 400;
    const ctx = canvas.getContext('2d');
    const gradient = ctx.createLinearGradient(0, 0, 640, 400);
    gradient.addColorStop(0, '#113e4e'); gradient.addColorStop(1, '#56aeab');
    ctx.fillStyle = gradient; ctx.fillRect(0, 0, 640, 400);
    ctx.strokeStyle = '#c7e9d9'; ctx.lineWidth = 3; ctx.strokeRect(20, 20, 600, 360);
    ctx.fillStyle = '#ffffff'; ctx.font = 'bold 38px sans-serif'; ctx.fillText('PRAY TOGETHER', 52, 180);
    ctx.font = '22px sans-serif'; ctx.fillText('A community of faith and hope', 52, 224);
    return canvas.toDataURL('image/png').split(',')[1];
  });
  await Promise.all(Array.from({ length: 24 }, (_, i) => fs.writeFile(
    path.join(directory, `media/backgrounds/prayer-${String(i + 1).padStart(2, '0')}.png`), Buffer.from(png, 'base64'))));
  execFileSync(ffmpeg, ['-hide_banner', '-loglevel', 'error', '-f', 'lavfi', '-i', 'color=c=#225588:size=320x180:rate=10',
    '-t', '0.5', '-c:v', 'libx264', '-preset', 'ultrafast', path.join(directory, 'media/backgrounds/service-video.mp4')]);
  server = spawn(process.execPath, ['backend/dist/server.js'], {
    cwd: root, env: { ...environment, NODE_ENV: 'production', PORT: String(port), HOST: '127.0.0.1', LUMEN_DATA_DIR: directory, LUMEN_RENDERER_URL: base },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  server.stdout.on('data', bytes => { logs += bytes; }); server.stderr.on('data', bytes => { logs += bytes; });
  await until(async () => (await fetch(`${base}/api/studio`, { signal: AbortSignal.timeout(1000) })).ok, 'isolated station ready');
  const request = context.request;
  assert.equal((await request.post(`${base}/api/auth/login`, { data: { username: 'admin', password: 'admin' } })).status(), 200);
  const fixture = {
    version: 2, updatedAt: new Date().toISOString(), settings: { transitionMs: 0 }, music: { mode: 'off' },
    channels: [{ id: 'presentation', name: 'Editor design check', kind: 'presentation', playlistId: 'deck', defaultMode: 'manual' }],
    playlists: [{ id: 'deck', name: 'Editor design check', groups: [{ id: 'prayers', name: 'Prayer focus' }], items: [
      { id: 'prayer', type: 'prayer', title: 'Saviour of the World!', body: 'And we have seen and testify that the Father has sent his Son to be the Savior of the world.', reference: 'John 4:14', layout: 'general', durationMs: 30000,
        background: { kind: 'color', color: '#831843', overlayOpacity: 0 } },
      { id: 'image', type: 'image', title: 'Prayer gathering', durationMs: 30000,
        background: { kind: 'image', src: 'media/backgrounds/prayer-01.png', fit: 'cover', overlayOpacity: 0 } },
      { id: 'notes', type: 'notes', title: 'A life of prayer', body: 'Begin with gratitude\nMake time to listen\nPray for one another', layout: 'key-points', durationMs: 45000,
        background: { kind: 'color', color: '#123b45', overlayOpacity: 0 } },
      { id: 'video', type: 'video', title: 'Service film', durationMs: 500,
        background: { kind: 'video', src: 'media/backgrounds/service-video.mp4', fit: 'contain', overlayOpacity: 0, loop: false, muted: true, volume: .35 } },
      { id: 'document', type: 'image', title: 'Sunday message page 2', durationMs: 30000,
        background: { kind: 'image', src: 'media/backgrounds/prayer-02.png', fit: 'contain', overlayOpacity: 0 },
        document: { type: 'powerpoint', sourceName: 'Sunday message.pptx', page: 2, totalPages: 5 } },
    ] }], sources: [], destinations: [], routes: [], program: { programSourceId: null, previewSourceId: null },
  };
  const seeded = await request.put(`${base}/api/content`, { data: fixture }); assert.equal(seeded.status(), 200, await seeded.text());
  await page.goto(base);
  await page.getByRole('heading', { name: 'Editor design check', exact: true }).waitFor({ state: 'attached' });
  // Installed Lumen commonly starts in Studio. Its lazy-loaded global CSS must
  // not change editor controls after navigation back to a presentation channel.
  await page.getByRole('button', { name: 'Open Production Studio', exact: true }).click();
  await page.waitForURL('**/studio');
  await page.locator('.studio-app').waitFor({ state: 'visible' });
  const studioDurationRuleLoaded = await page.evaluate(() => {
    const probe = document.createElement('div'); probe.className = 'duration-field'; document.body.appendChild(probe);
    const loaded = getComputedStyle(probe).display === 'flex'; probe.remove(); return loaded;
  });
  assert.ok(studioDurationRuleLoaded, 'Studio global duration-field styles are loaded before opening the editor');
  await page.getByRole('button', { name: 'Editor design check — presentation', exact: true }).click();
  await page.getByRole('heading', { name: 'Editor design check', exact: true }).waitFor({ state: 'visible' });
  checks.push('Editor opens after Studio has loaded its global stylesheet');
  const collapse = page.getByRole('button', { name: 'Collapse toolbar', exact: true });
  if (await collapse.isVisible()) await collapse.click();
  const list = page.getByRole('button', { name: 'List view', exact: true });
  if (await list.isVisible()) await list.click();
  const dialog = page.getByRole('dialog', { name: 'Edit slide', exact: true });
  async function openSlide(title) {
    const card = page.locator('.presentation-slide-card').filter({ hasText: title }).first();
    if (page.viewportSize().width < 768) {
      await card.getByTitle('More actions', { exact: true }).click();
      await page.getByRole('button', { name: 'Edit', exact: true }).click();
      // The action sheet exits over 200ms, while the editor enters over 100ms.
      // Measure the finished handoff rather than its deliberately overlapping animation.
      await page.locator('[role="dialog"]').filter({ hasText: 'Jump to this slide' }).waitFor({ state: 'detached' });
    } else {
      await card.hover(); await card.getByTitle('Edit', { exact: true }).click();
    }
    await dialog.waitFor();
    await dialog.evaluate(async element => {
      await Promise.all(element.getAnimations().filter(animation => animation.effect?.getTiming().iterations !== Infinity).map(animation => animation.finished.catch(() => {})));
    });
    await frame();
  }
  const savedItem = async id => (await (await request.get(`${base}/api/content`)).json()).playlists[0].items.find(item => item.id === id);
  function visualChoice(name) {
    return dialog.getByRole('button', { name, exact: true });
  }
  async function assertSelected(control) {
    const state = await control.evaluate(element => element.getAttribute('aria-pressed') ?? element.getAttribute('aria-checked'));
    assert.equal(state, 'true', 'Selected visual choice is exposed to assistive technology');
  }
  async function saveAndReopen(id, title, expected) {
    await dialog.getByRole('button', { name: 'Save', exact: true }).click();
    await dialog.waitFor({ state: 'hidden' });
    await until(async () => expected(await savedItem(id)), `${id} changes persisted`);
    await openSlide(title);
  }

  await openSlide('Saviour of the World!');
  for (const [label, value] of [['General', 'general'], ['One thought', 'statement'], ['Quote', 'quote'], ['Key points', 'key-points']]) {
    const control = visualChoice(label).first(); await control.click(); await assertSelected(control);
    await saveAndReopen('prayer', 'Saviour of the World!', item => item.layout === value);
    await assertSelected(visualChoice(label).first());
    checks.push(`Layout ${value} saves and reopens selected`);
  }
  await dialog.getByLabel('Place in group').selectOption('prayers');
  await dialog.getByLabel('Duration in seconds', { exact: true }).fill('45');
  await saveAndReopen('prayer', 'Saviour of the World!', item => item.groupId === 'prayers' && item.durationMs === 45000);
  assert.equal((await savedItem('prayer')).reference, fixture.playlists[0].items[0].reference, 'Reference is retained when layout changes');
  assert.equal((await savedItem('prayer')).body, fixture.playlists[0].items[0].body, 'Prayer content is retained when layout changes');
  checks.push('Grouping and duration controls persist without changing prayer content');
  await visualChoice('General').first().click();
  await dialog.getByRole('button', { name: 'Save', exact: true }).click();
  await dialog.waitFor({ state: 'hidden' });
  await openSlide('Prayer gathering');
  for (const [label, value] of [['Contain', 'contain'], ['Fill', 'fill'], ['Cover', 'cover']]) {
    const control = visualChoice(label).first(); await control.click(); await assertSelected(control);
    await saveAndReopen('image', 'Prayer gathering', item => item.background.fit === value);
    await assertSelected(visualChoice(label).first());
    checks.push(`Fit ${value} saves and reopens selected`);
  }
  await visualChoice('Fill').first().click();
  await dialog.getByRole('button', { name: 'Cancel', exact: true }).click();
  assert.equal((await savedItem('image')).background.fit, 'cover', 'Cancel does not save draft fit changes');
  checks.push('Cancel leaves the saved media settings unchanged');
  for (const id of ['video', 'document']) {
    const original = fixture.playlists[0].items.find(item => item.id === id);
    await openSlide(original.title);
    const media = dialog.getByRole('button', { name: 'Media', exact: true });
    await assertSelected(media); await media.click();
    const response = page.waitForResponse(res => res.url() === `${base}/api/content` && res.request().method() === 'PUT');
    await dialog.getByRole('button', { name: 'Save', exact: true }).click();
    assert.equal((await response).status(), 200);
    await dialog.waitFor({ state: 'hidden' });
    const saved = await savedItem(id);
    assert.equal(saved.type, original.type, `Active Media tab keeps ${id} type`);
    assert.deepEqual(saved.background, original.background, `Active Media tab keeps ${id} asset and playback settings`);
    assert.deepEqual(saved.document, original.document, 'Imported document metadata is preserved');
    checks.push(`Active Media choice preserves ${id} source and settings`);
  }

  async function geometry(name, target) {
    await target.scrollIntoViewIfNeeded(); await frame();
    const targetRect = await target.boundingBox();
    const result = await dialog.evaluate(element => {
      const rect = el => { const r = el.getBoundingClientRect(); return { x: r.x, y: r.y, right: r.right, bottom: r.bottom, width: r.width, height: r.height }; };
      const footer = element.querySelector('.slide-edit-footer');
      const body = element.querySelector('.slide-edit-body');
      const preview = element.querySelector('.slide-edit-preview');
      const duration = element.querySelector('.editor-duration-field');
      const durationStyle = duration && getComputedStyle(duration);
      return { viewport: { width: innerWidth, height: innerHeight }, dialog: rect(element), footer: footer && rect(footer), body: body && rect(body), preview: preview && rect(preview),
        duration: duration && { display: durationStyle.display, border: parseFloat(durationStyle.borderTopWidth), field: rect(duration), label: rect(duration.querySelector('label')), input: rect(duration.querySelector('input')) },
        horizontalOverflow: document.documentElement.scrollWidth > innerWidth + 1,
        dialogOverflow: element.scrollWidth > element.clientWidth + 1 };
    });
    result.name = name; result.target = targetRect; measurements.push(result);
    assert.ok(result.footer, 'Editor has a dedicated footer');
    assert.ok(result.body, 'Editor has a dedicated scrolling body');
    assert.ok(result.dialog.y >= -1 && result.dialog.bottom <= result.viewport.height + 1, `${name}: dialog stays inside the viewport`);
    assert.ok(result.footer.bottom <= result.dialog.bottom + 1 && result.footer.y > result.dialog.y, `${name}: footer remains inside the dialog`);
    assert.ok(result.body.bottom <= result.footer.y + 1, `${name}: scroll area stops before the footer`);
    assert.ok(targetRect.y >= result.body.y - 1 && targetRect.y + targetRect.height <= result.footer.y + 1, `${name}: final control is completely visible above the footer`);
    assert.ok(!result.horizontalOverflow && !result.dialogOverflow, `${name}: no horizontal overflow`);
    assert.ok(result.duration, `${name}: editor duration control exists`);
    assert.equal(result.duration.display, 'grid', `${name}: Studio CSS does not turn duration into a horizontal row`);
    assert.equal(result.duration.border, 0, `${name}: Studio CSS does not add an outer duration border`);
    assert.ok(result.duration.input.width > 50, `${name}: duration input is not squeezed into Studio's 36px field`);
    assert.ok(result.duration.label.bottom <= result.duration.input.y - 5, `${name}: duration label remains above the input with spacing`);
    const save = await dialog.getByRole('button', { name: 'Save', exact: true }).boundingBox();
    assert.ok(save.y >= result.footer.y && save.y + save.height <= result.viewport.height, `${name}: Save is always visible`);
    const saveHitTargets = await dialog.getByRole('button', { name: 'Save', exact: true }).evaluate(element => {
      const r = element.getBoundingClientRect();
      return [[r.x + 5, r.y + 5], [r.right - 5, r.y + 5], [r.x + 5, r.bottom - 5], [r.right - 5, r.bottom - 5]].map(([x, y]) => {
        const target = document.elementFromPoint(x, y);
        return { owned: element.contains(target), x, y, target: target?.outerHTML.slice(0, 500) };
      });
    });
    result.saveHitTargets = saveHitTargets;
    assert.ok(saveHitTargets.every(hit => hit.owned), `${name}: no overlay intercepts any Save button corner`);
    const heading = await dialog.getByRole('heading', { name: 'Edit slide', exact: true }).boundingBox();
    assert.ok(heading.y >= result.dialog.y && heading.y + heading.height <= result.body.y + 1, `${name}: editor heading stays above the scrolling content`);
    if (result.viewport.width > 760) {
      assert.ok(result.preview && result.preview.y >= result.body.y - 1 && result.preview.bottom <= result.footer.y + 1, `${name}: audience preview remains visible beside the inspector`);
    }
    const centerIsTarget = await target.evaluate(element => {
      const r = element.getBoundingClientRect(); return element.contains(document.elementFromPoint(r.x + r.width / 2, r.y + r.height / 2));
    });
    assert.ok(centerIsTarget, `${name}: footer does not intercept final control pointer events`);
    await page.screenshot({ path: path.join(artifacts, `${name}.png`) });
    checks.push(`${name}: lower controls, footer and horizontal bounds are accessible`);
  }
  for (const viewport of [{ width: 1512, height: 982 }, { width: 1280, height: 650 }, { width: 375, height: 812 }]) {
    await page.setViewportSize(viewport);
    await openSlide('Prayer gathering');
    const rows = await dialog.locator('.media-grid button').evaluateAll(elements => elements.map(element => {
      const r = element.getBoundingClientRect(); return { y: r.y, bottom: r.bottom };
    }).filter((rect, i, all) => !i || Math.abs(rect.y - all[i - 1].y) > 1));
    assert.ok(rows.length > 2, 'Fixture includes enough media for a scrolling gallery');
    for (let i = 1; i < rows.length; i++) assert.ok(rows[i].y >= rows[i - 1].bottom + 1, `${viewport.width}px: media rows do not overlap`);
    await geometry(`media-${viewport.width}x${viewport.height}`, visualChoice('Fill').first());
    await dialog.getByRole('button', { name: 'Cancel', exact: true }).click();
    await openSlide('Saviour of the World!');
    if (viewport.width === 1512) await page.screenshot({ path: path.join(artifacts, 'prayer-content-1512x982.png') });
    await visualChoice('General').first().scrollIntoViewIfNeeded();
    await page.screenshot({ path: path.join(artifacts, `prayer-${viewport.width}x${viewport.height}.png`) });
    // A media backdrop exposes both Fit and the final readability slider.
    await dialog.getByRole('button', { name: /^Use prayer-01\.png$/ }).click();
    const slider = dialog.getByRole('slider').last();
    await geometry(`prayer-background-${viewport.width}x${viewport.height}`, slider);
    await dialog.getByRole('button', { name: 'Cancel', exact: true }).click();
  }
  assert.deepEqual(errors, [], 'No application errors');
  console.log(`PASS: ${checks.length} slide editor checks. Artifacts: ${artifacts}`);
} catch (error) {
  if (page) await page.screenshot({ path: path.join(artifacts, 'failure.png') }).catch(() => {});
  console.error(logs.slice(-3000)); console.error(`Artifacts: ${artifacts}`); throw error;
} finally {
  await fs.writeFile(path.join(artifacts, 'report.json'), JSON.stringify({ checks, errors, measurements }, null, 2));
  await browser?.close();
  if (server && server.exitCode === null && server.signalCode === null) {
    const exited = new Promise(resolve => server.once('exit', resolve)); server.kill('SIGTERM'); await exited;
  }
  await fs.rm(directory, { recursive: true, force: true });
}
