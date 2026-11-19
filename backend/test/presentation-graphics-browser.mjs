// Real authoring controls and output pixels against an isolated, disposable
// station. The installed operator's content and media are never modified.
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import net from 'node:net';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright-core';
import esbuild from '../../frontend/node_modules/esbuild/lib/main.js';

const root = process.env.LUMEN_GRAPHICS_TEST_ROOT
  ? path.resolve(process.env.LUMEN_GRAPHICS_TEST_ROOT)
  : path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'lumen-graphics-data-'));
const artifacts = process.env.LUMEN_GRAPHICS_ARTIFACTS
  ? path.resolve(process.env.LUMEN_GRAPHICS_ARTIFACTS)
  : await fs.mkdtemp(path.join(os.tmpdir(), 'lumen-graphics-report-'));
const port = Number(process.env.LUMEN_GRAPHICS_TEST_PORT ?? 3493), base = `http://127.0.0.1:${port}`;
const environment = Object.fromEntries(Object.entries(process.env).filter(([name]) =>
  !/^(LUMEN_|VPS_|MEDIA_ENGINE_|SUPABASE_|POWERSYNC_|VITE_|NODE_OPTIONS$|NODE_PATH$|ELECTRON_RUN_AS_NODE$)/i.test(name)));
const visualOnly = process.env.LUMEN_GRAPHICS_VISUAL_ONLY === '1';
const checks = [], measurements = [], errors = [];
let server, browser, page, logs = '', passed = false;
async function until(fn, label, timeout = 30000) {
  const end = Date.now() + timeout; let last;
  while (Date.now() < end) {
    try { const value = await fn(); if (value) return value; } catch (error) { last = error; }
    await new Promise(resolve => setTimeout(resolve, 100));
  }
  throw new Error(`Timed out: ${label}${last ? ` (${last.message})` : ''}`);
}
async function frame() { await page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)))); }

try {
  await fs.mkdir(artifacts, { recursive: true });
  await new Promise((resolve, reject) => { const probe = net.createServer(); probe.once('error', reject); probe.listen(port, '127.0.0.1', () => probe.close(resolve)); });
  server = spawn(process.execPath, ['backend/dist/server.js'], {
    cwd: root, env: { ...environment, NODE_ENV: 'production', PORT: String(port), HOST: '127.0.0.1', LUMEN_DATA_DIR: dir, LUMEN_RENDERER_URL: base },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  server.stdout.on('data', bytes => { logs += bytes; }); server.stderr.on('data', bytes => { logs += bytes; });
  await until(async () => (await fetch(base + '/api/studio', { signal: AbortSignal.timeout(1000) })).ok, 'isolated station startup');
  browser = await chromium.launch({ executablePath: process.env.LUMEN_CHROME_PATH ?? '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome', headless: true });
  const context = await browser.newContext({ viewport: { width: 1512, height: 982 } }), request = context.request;
  context.setDefaultTimeout(12000);
  assert.equal((await request.post(base + '/api/auth/login', { data: { username: 'admin', password: 'admin' } })).status(), 200);
  const fixture = {
    version: 2, updatedAt: new Date().toISOString(), settings: { transitionMs: 0, countdownAtMs: 10000 }, music: { mode: 'off' },
    channels: [{ id: 'alpha', name: 'Graphics presentation', kind: 'presentation', playlistId: 'deck', defaultMode: 'manual' }],
    playlists: [{ id: 'deck', name: 'Graphics presentation', items: [{ id: 'slide', type: 'text', title: 'Prayer for the nation', body: 'A shared Program picture', durationMs: 120000, background: { kind: 'color', color: '#102030' } }] }],
    sources: [{ id: 'alpha-source', kind: 'channel', ref: 'alpha' }], destinations: [], routes: [], program: { programSourceId: null, previewSourceId: null },
  };
  assert.equal((await request.put(base + '/api/content', { data: fixture })).status(), 200);
  const getContent = async () => (await request.get(base + '/api/content')).json();
  page = await context.newPage(); page.on('pageerror', error => errors.push(error.message));
  await page.goto(base); await page.getByRole('heading', { name: 'Graphics presentation', exact: true }).waitFor();
  await page.getByRole('button', { name: 'Open Production Studio', exact: true }).click();
  await page.waitForURL('**/studio'); await page.locator('.studio-app').waitFor({ state: 'visible' });
  await page.getByRole('button', { name: 'Graphics presentation — presentation', exact: true }).click();
  await page.getByRole('heading', { name: 'Graphics presentation', exact: true }).waitFor();
  const collapse = page.getByRole('button', { name: 'Collapse toolbar', exact: true });
  if (await collapse.isVisible()) await collapse.click();
  checks.push('Graphics opens after Studio has loaded its global styles');

  const dialog = page.getByRole('dialog', { name: 'Presentation graphics', exact: true });
  const choice = name => dialog.getByRole('button', { name, exact: true });
  const selected = async name => assert.equal(await choice(name).getAttribute('aria-pressed'), 'true', `${name} is exposed as selected`);
  async function openGraphics() { await page.getByRole('button', { name: 'Graphics', exact: true }).click(); await dialog.waitFor(); await frame(); }
  async function cancel() { await choice('Cancel').click(); await dialog.waitFor({ state: 'hidden' }); }
  const preview = () => dialog.locator('canvas[aria-label="Presentation graphics preview"]');
  const previewImage = () => preview().evaluate(canvas => canvas.toDataURL());
  async function selectAndSee(name) {
    const before = await previewImage(); await choice(name).click(); await selected(name);
    await until(async () => (await previewImage()) !== before, `${name} changes the actual audience preview`);
  }
  async function assertDrawnThumbnail(name) {
    const canvas = choice(name).locator('canvas');
    assert.equal(await canvas.count(), 1, `${name} has a visual canvas preview`);
    await until(() => canvas.evaluate(canvas => {
      const pixels = canvas.getContext('2d').getImageData(0, 0, canvas.width, canvas.height).data;
      let painted = 0;
      for (let i = 3; i < pixels.length; i += 4) if (pixels[i] > 0) painted++;
      return painted > 20 && painted < canvas.width * canvas.height;
    }), `${name} thumbnail paints actual graphics`);
  }

  if (!visualOnly) {
    await openGraphics();
    await selected('Original flame');
    await selected('Original glow');
    await selected('Original spectrum');
    const templates = ['Original flame', 'Minimal line', 'Broadcast lower third', 'Segmented progress', 'Ember glow'];
    const thumbnailImages = [];
    for (const name of templates) {
      await assertDrawnThumbnail(name);
      thumbnailImages.push(await choice(name).locator('canvas').evaluate(canvas => canvas.toDataURL()));
    }
    assert.equal(new Set(thumbnailImages).size, templates.length, 'Every style preview is visually distinct');
    checks.push('All five bar styles show distinct, rendered previews; original flame stays the default');
    for (const name of templates.slice(1)) await selectAndSee(name);
    checks.push('Every bar style changes the audience preview immediately');
    await dialog.getByRole('checkbox', { name: 'Timer', exact: true }).uncheck();
    assert.equal((await getContent()).channels[0].presentationGraphics, undefined, 'Draft does not write to live channel');
    await cancel();
    await openGraphics();
    await selected('Original flame');
    assert.equal(await dialog.getByRole('checkbox', { name: 'Timer', exact: true }).isChecked(), true);
    checks.push('Cancel discards style and audience visibility changes without changing Program');

    await selectAndSee('Segmented progress');
    await choice('Use Gold accent').click();
    assert.equal(await dialog.getByLabel('Graphics accent colour').inputValue(), '#fbbf24', 'Visual accent palette updates the custom colour control');
    await dialog.getByLabel('Graphics accent colour').fill('#ff00ff');
    await choice('Bottom').click();
    await dialog.getByLabel('Progress thickness').fill('9');
    for (const name of ['Original glow', 'Plain dot', 'Icon', 'None']) {
      await assertDrawnThumbnail(name);
      await selectAndSee(name);
    }
    await selectAndSee('Icon');
    for (const name of ['Flame', 'Star', 'Cross', 'Diamond', 'Heart']) {
      await assertDrawnThumbnail(name);
      if (await choice(name).getAttribute('aria-pressed') !== 'true') await selectAndSee(name);
    }
    await selectAndSee('Star');
    checks.push('Glow, dot, no tip and all five icons have rendered previews and update the audience picture');
    await selectAndSee('Custom gradient');
    for (const name of ['Flame', 'Sunset', 'Ocean', 'Emerald', 'Royal', 'Sunrise']) {
      const control = choice(`${name} gradient`);
      assert.match(await control.locator('span').first().evaluate(element => getComputedStyle(element).backgroundImage), /^linear-gradient/, `${name} palette displays its gradient`);
      if (await control.getAttribute('aria-pressed') !== 'true') await selectAndSee(`${name} gradient`);
    }
    await selectAndSee('Flame gradient');
    assert.match(await choice('Original spectrum').locator('.graphics-colour-strip').evaluate(element => getComputedStyle(element).backgroundImage), /^linear-gradient/, 'Original spectrum has a colour preview');
    assert.equal(await choice('Solid colour').locator('.graphics-colour-strip').evaluate(element => getComputedStyle(element).backgroundColor), 'rgb(255, 0, 255)', 'Solid colour preview matches the custom accent');
    checks.push('Colour swatches and all six gradient palettes preview and update the selected colours');
    await choice('Remove last gradient colour').click();
    await dialog.getByLabel('Gradient colour 1', { exact: true }).fill('#1122ff');
    const beforeGradient = await previewImage();
    await dialog.getByLabel('Gradient colour 2', { exact: true }).fill('#ff7722');
    await until(async () => (await previewImage()) !== beforeGradient, 'Custom gradient colours update the actual audience preview');
    await dialog.getByRole('checkbox', { name: 'Slide caption', exact: true }).check();
    await dialog.getByLabel('Graphics preset name').fill('Prayer night');
    await choice('Save preset').click();
    await choice('Apply to Program').click(); await dialog.waitFor({ state: 'hidden' });
    await until(async () => (await getContent()).channels[0].presentationGraphics?.template === 'segments', 'graphics saved');
    let saved = await getContent();
    assert.equal(saved.channels[0].presentationGraphicPresets[0].name, 'Prayer night');
    assert.deepEqual(saved.channels[0].presentationGraphics.gradientColors, ['#1122ff', '#ff7722']);
    assert.equal(saved.channels[0].presentationGraphics.thickness, 9);
    assert.equal(saved.channels[0].presentationGraphics.tip, 'icon');
    assert.equal(saved.channels[0].presentationGraphics.tipIcon, 'star');
    assert.equal(saved.channels[0].presentationGraphics.caption, true);
    assert.equal(saved.channels[0].presentationGraphics.position, 'bottom');
    checks.push('Custom gradient, icon, thickness, position, caption and named preset save atomically');
    await page.reload(); await openGraphics();
    await selected('Segmented progress'); await selected('Star'); await selected('Custom gradient');
    assert.equal(await dialog.getByLabel('Progress thickness').inputValue(), '9');
    assert.equal(await dialog.getByLabel('Gradient colour 2', { exact: true }).inputValue(), '#ff7722');
    checks.push('Graphics selections persist after a full reload');
    await selectAndSee('Solid colour');
    await dialog.getByRole('checkbox', { name: 'Progress bar', exact: true }).uncheck();
    await dialog.getByRole('checkbox', { name: 'Timer', exact: true }).uncheck();
    await dialog.getByRole('checkbox', { name: 'Final countdown', exact: true }).uncheck();
    await dialog.getByRole('checkbox', { name: 'Slide caption', exact: true }).uncheck();
    await choice('Apply to Program').click(); await dialog.waitFor({ state: 'hidden' });
    await until(async () => (await getContent()).channels[0].presentationGraphics?.progress === false, 'graphics hidden');
    const live = await context.newPage(); await live.goto(base + '/live/alpha');
    await live.locator('canvas.presentation-graphics').waitFor();
    await live.getByText('A shared Program picture', { exact: true }).waitFor();
    await live.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
    assert.equal(await live.locator('canvas.presentation-graphics').evaluate(canvas => {
      const pixels = canvas.getContext('2d').getImageData(0, 0, canvas.width, canvas.height).data;
      return pixels.some((value, index) => index % 4 === 3 && value > 0);
    }), false, 'Live output has no hidden audience graphics');
    checks.push('Audience graphics can all be hidden without hiding the presentation');
    // Exercise the actual Program compositor + SourceBank sampling, independently
    // of a GPU/WebRTC decoder, so pixel assertions can be exact.
    const bundle=await esbuild.build({absWorkingDir:path.join(root,'frontend'),stdin:{contents:'export {paintScene} from "./src/lib/studio/compositor.ts"; export {SourceBank} from "./src/lib/studio/sources.ts";',resolveDir:path.join(root,'frontend')},tsconfig:'tsconfig.json',bundle:true,write:false,format:'iife',globalName:'LumenGraphicsTest',platform:'browser',define:{'process.env.NODE_ENV':'"production"'}});
    await page.addScriptTag({content:bundle.outputFiles[0].text});
    const studio=await(await request.get(base+'/api/studio')).json();
    saved=await getContent();
    const result=await page.evaluate(({content,baseLayer})=>{
      const {SourceBank,paintScene}=window.LumenGraphicsTest;
      const bank=Object.create(SourceBank.prototype), input={source:{id:'deck',kind:'channel',channelId:'alpha'},element:null};
      bank.channelItem=input=>SourceBank.prototype.channelItem.call(bank,input,false);
      bank.content=content;bank.inputs=new Map([['deck',input]]);bank.channelStates=new Map([['alpha',{channelId:'alpha',playlistId:'deck',index:0,mode:'manual',playing:false,blanked:false,durationMs:120000,elapsedMs:60000}]]);bank.channelClocks=new Map([['alpha',{elapsedMs:60000,receivedAt:performance.now()}]]);
      const scene={id:'test',name:'Test',background:'#000000',layers:[{...baseLayer,kind:'source',sourceId:'deck',channelStyle:'slide',x:0,y:0,width:100,height:100,opacity:1,radius:0,visible:true}]};
      const canvas=document.createElement('canvas');canvas.width=1920;canvas.height=1080;
      const count=()=>{paintScene(canvas,scene,bank);const p=canvas.getContext('2d').getImageData(0,0,1920,1080).data;let n=0;for(let i=0;i<p.length;i+=4)if(p[i]===255&&p[i+1]===0&&p[i+2]===255)n++;return n;};
      const hidden=count();content.channels[0].presentationGraphics.progress=true;const shown=count();
      const frame=bank.channelGraphics(input);bank.channelStates.get('alpha').blanked=true;const blank=count();
      return{hidden,shown,blank,elapsed:frame.elapsedMs};
    },{content:saved,baseLayer:studio.scenes[0].layers[0]});
    assert.equal(result.hidden,0);assert(result.shown>3000,'Program paints the configured progress colour');assert.equal(result.blank,0);assert.equal(result.elapsed,60000);

    measurements.push({ name: 'program-pixels', ...result });
    checks.push('Program compositor paints configured colour, keeps manual time and respects blank output');
    await openGraphics();
    await dialog.getByLabel('Saved presets').selectOption('Prayer night');
    assert.equal(await dialog.getByRole('checkbox', { name: 'Progress bar', exact: true }).isChecked(), true);
    await selected('Custom gradient');
    assert.equal(await dialog.getByLabel('Gradient colour 1', { exact: true }).inputValue(), '#1122ff');
    assert.equal(await dialog.getByRole('checkbox', { name: 'Slide caption', exact: true }).isChecked(), true);
    checks.push('Saved preset restores its appearance and audience visibility');
    await cancel();
    // Let success notifications finish their normal timeout before assessing the
    // finished dialog. They intentionally float over every workspace while shown.
    await page.bringToFront();
    await page.mouse.move(20, 20);
    await until(async () => await page.locator('[data-sonner-toast]').count() === 0, 'success notifications dismiss');

  }

  async function geometry(name, target) {
    await target.scrollIntoViewIfNeeded(); await frame();
    const targetRect = await target.boundingBox();
    const result = await dialog.evaluate(element => {
      const rect = el => { const r = el.getBoundingClientRect(); return { x: r.x, y: r.y, right: r.right, bottom: r.bottom, width: r.width, height: r.height }; };
      const footer = element.querySelector('.graphics-footer'), body = element.querySelector('.graphics-layout');
      return { viewport: { width: innerWidth, height: innerHeight }, dialog: rect(element), footer: footer && rect(footer), body: body && rect(body),
        horizontalOverflow: document.documentElement.scrollWidth > innerWidth + 1, dialogOverflow: element.scrollWidth > element.clientWidth + 1 };
    });
    result.name = name; result.target = targetRect; measurements.push(result);
    assert.ok(result.footer && result.body, 'Graphics has a bounded scrolling body and separate footer');
    assert.ok(result.dialog.y >= -1 && result.dialog.bottom <= result.viewport.height + 1, `${name}: dialog stays inside the viewport`);
    assert.ok(result.body.bottom <= result.footer.y + 1, `${name}: scroll area ends before the footer`);
    assert.ok(targetRect.y >= result.body.y - 1 && targetRect.y + targetRect.height <= result.footer.y + 1, `${name}: final control is fully visible above footer`);
    assert.ok(!result.horizontalOverflow && !result.dialogOverflow, `${name}: no horizontal overflow`);
    const apply = choice('Apply to Program');
    const unobstructed = await apply.evaluate(element => {
      const r = element.getBoundingClientRect();
      return { rect: { top: r.top, bottom: r.bottom }, corners: [[r.left + 3, r.top + 3], [r.right - 3, r.top + 3], [r.left + 3, r.bottom - 3], [r.right - 3, r.bottom - 3]].every(([x,y]) => element.contains(document.elementFromPoint(x,y))) };
    });
    assert.ok(unobstructed.rect.top >= result.footer.y && unobstructed.rect.bottom <= result.dialog.bottom, `${name}: Apply is visible in footer`);
    assert.ok(unobstructed.corners, `${name}: all Apply corners are unobstructed`);
    assert.ok(await target.evaluate(element => { const r = element.getBoundingClientRect(); return element.contains(document.elementFromPoint(r.x + r.width / 2, r.y + r.height / 2)); }), `${name}: final control is clickable`);
    await page.screenshot({ path: path.join(artifacts, `${name}.png`) });
    checks.push(`${name}: final controls and footer remain reachable and unobstructed`);
  }
  for (const viewport of [{ width: 1512, height: 982 }, { width: 1280, height: 650 }, { width: 375, height: 812 }]) {
    await page.setViewportSize(viewport); await frame();
    const toolbar = page.locator('.presentation-editor-actions');
    const toolbarGeometry = await toolbar.evaluate(element => {
      const rect = element.getBoundingClientRect();
      const header = element.closest('.presentation-editor-heading'), title = header.querySelector('.presentation-editor-title');
      const h = header.getBoundingClientRect(), t = title.getBoundingClientRect();
      return { x: rect.x, right: rect.right, top: rect.top, bottom: rect.bottom, width: rect.width, horizontalOverflow: element.scrollWidth > element.clientWidth + 1,
        header: { left: h.left, right: h.right, bottom: h.bottom, overflow: header.scrollWidth > header.clientWidth + 1 }, title: { right: t.right, top: t.top, bottom: t.bottom },
        buttons: [...element.querySelectorAll('button')].map(button => { const r = button.getBoundingClientRect(), svg = button.querySelector('svg'); return { name: button.getAttribute('aria-label') || button.textContent.trim(), width: r.width, height: r.height, icon: !!svg, iconWidth: svg?.getBoundingClientRect().width, stroke: svg?.getAttribute('stroke-width') }; }) };
    });
    assert.ok(!toolbarGeometry.horizontalOverflow && toolbarGeometry.x >= 0 && toolbarGeometry.right <= viewport.width + 1, `${viewport.width}px: toolbar fits`);
    assert.ok(!toolbarGeometry.header.overflow && toolbarGeometry.right <= toolbarGeometry.header.right + 1 && toolbarGeometry.bottom <= toolbarGeometry.header.bottom + 1, `${viewport.width}px: tools remain inside the header`);
    assert.ok(toolbarGeometry.title.right <= toolbarGeometry.x + 1 || toolbarGeometry.title.bottom <= toolbarGeometry.top + 1, `${viewport.width}px: title and controls do not collide`);
    assert.ok(toolbarGeometry.buttons.every(button => button.icon), `${viewport.width}px: every toolbar action has a consistent icon`);
    const visibleButtons = toolbarGeometry.buttons.filter(button => button.width > 0);
    assert.ok(new Set(visibleButtons.map(button => button.iconWidth)).size === 1, `${viewport.width}px: visible toolbar icons share the same size`);
    await page.screenshot({ path: path.join(artifacts, `toolbar-${viewport.width}x${viewport.height}.png`) });
    measurements.push({ name: `toolbar-${viewport.width}`, ...toolbarGeometry });
    await openGraphics();
    await dialog.getByRole('checkbox', { name: 'Progress bar', exact: true }).check();
    await dialog.getByRole('checkbox', { name: 'Timer', exact: true }).check();
    await choice('Original flame').click();
    await choice('Original flame').scrollIntoViewIfNeeded(); await frame();
    await page.screenshot({ path: path.join(artifacts, `styles-${viewport.width}x${viewport.height}.png`) });
    await choice('Icon').click(); await choice('Flame').click();
    await choice('Flame').scrollIntoViewIfNeeded(); await frame();
    const tipFits = await dialog.locator('canvas[data-preview-kind=tip], canvas[data-preview-kind=icon]').evaluateAll(elements => elements.map(element => getComputedStyle(element).objectFit));
    assert.equal(tipFits.length, 9, 'All tip and icon previews are present');
    assert.ok(tipFits.every(fit => fit === 'contain'), `${viewport.width}px: tip and icon previews preserve their actual proportions`);
    await page.screenshot({ path: path.join(artifacts, `tips-${viewport.width}x${viewport.height}.png`) });
    await choice('Custom gradient').click();
    await dialog.getByLabel('Gradient colour 1', { exact: true }).scrollIntoViewIfNeeded(); await frame();
    await page.screenshot({ path: path.join(artifacts, `colours-${viewport.width}x${viewport.height}.png`) });
    await dialog.getByLabel('Graphics preset name').fill('Draft preview');
    await geometry(`footer-${viewport.width}x${viewport.height}`, choice('Save preset'));
    await cancel();
  }
  assert.deepEqual(errors, [], 'No application errors');
  passed = true;
  console.log(`PASS: ${checks.length} graphics checks. Artifacts: ${artifacts}`);
} catch (error) {
  if (page) await page.screenshot({ path: path.join(artifacts, 'failure.png') }).catch(() => {});
  console.error(logs.slice(-4000)); console.error(`Artifacts: ${artifacts}`); throw error;
} finally {
  await fs.writeFile(path.join(artifacts, 'report.json'), JSON.stringify({ passed, visualOnly, checks, errors, measurements }, null, 2));
  await browser?.close();
  if (server && server.exitCode === null && server.signalCode === null) {
    const exited = new Promise(resolve => server.once('exit', resolve)); server.kill('SIGTERM'); await exited;
  }
  await fs.rm(dir, { recursive: true, force: true });
}
