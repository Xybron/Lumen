// A real graphics deck and a long music filename exercise the responsive
// presentation grid. Temporary media/station data are always removed.
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import net from 'node:net';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright-core';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'lumen-presentation-layout-data-'));
const artifacts = await fs.mkdtemp(path.join(os.tmpdir(), 'lumen-presentation-layout-report-'));
const port = Number(process.env.LUMEN_PRESENTATION_LAYOUT_TEST_PORT || 3504), base = `http://127.0.0.1:${port}`;
const environment = Object.fromEntries(Object.entries(process.env).filter(([name]) =>
  !/^(LUMEN_|VPS_|MEDIA_ENGINE_|SUPABASE_|POWERSYNC_|VITE_|NODE_OPTIONS$|NODE_PATH$|ELECTRON_RUN_AS_NODE$)/i.test(name)));
const trackName = 'Prayer_marathon_instrumental_worship_background_music_for_the_complete_evening_service_and_intercession_session_extended_recording.wav';
const measurements = [], failures = [], errors = [];
let server, browser, page, logs = '';
async function until(check, label, timeout = 20000) {
  const end = Date.now() + timeout; let last;
  while (Date.now() < end) {
    try { if (await check()) return; } catch (error) { last = error; }
    await new Promise(resolve => setTimeout(resolve, 100));
  }
  throw new Error(`Timed out: ${label}${last ? ` (${last.message})` : ''}`);
}
function check(condition, description) { if (!condition) failures.push(description); }
try {
  await new Promise((resolve, reject) => { const probe = net.createServer(); probe.once('error', reject); probe.listen(port, '127.0.0.1', () => probe.close(resolve)); });
  await fs.mkdir(path.join(directory, 'media/backgrounds'), { recursive: true });
  await fs.mkdir(path.join(directory, 'media/music'), { recursive: true });
  // A quarter-second silent WAV is sufficient for metadata; playback stays off.
  const audio = Buffer.alloc(44 + 4000);
  audio.write('RIFF'); audio.writeUInt32LE(audio.length - 8, 4); audio.write('WAVEfmt ', 8); audio.writeUInt32LE(16, 16);
  audio.writeUInt16LE(1, 20); audio.writeUInt16LE(1, 22); audio.writeUInt32LE(8000, 24); audio.writeUInt32LE(16000, 28);
  audio.writeUInt16LE(2, 32); audio.writeUInt16LE(16, 34); audio.write('data', 36); audio.writeUInt32LE(4000, 40);
  await fs.writeFile(path.join(directory, 'media/music', trackName), audio);
  server = spawn(process.execPath, ['backend/dist/server.js'], { cwd: root,
    env: { ...environment, NODE_ENV: 'production', PORT: String(port), HOST: '127.0.0.1', LUMEN_DATA_DIR: directory, LUMEN_RENDERER_URL: base },
    stdio: ['ignore', 'pipe', 'pipe'] });
  server.stdout.on('data', bytes => { logs += bytes; }); server.stderr.on('data', bytes => { logs += bytes; });
  await until(async () => (await fetch(`${base}/api/studio`, { signal: AbortSignal.timeout(1000) })).ok, 'isolated station ready');
  browser = await chromium.launch({ executablePath: process.env.LUMEN_CHROME_PATH || '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome', headless: true });
  const context = await browser.newContext({ viewport: { width: 1512, height: 982 } });
  context.setDefaultTimeout(10000);
  page = await context.newPage(); page.on('pageerror', error => errors.push(error.message));
  const png = await page.evaluate(() => {
    const canvas = document.createElement('canvas'); canvas.width = 640; canvas.height = 360;
    const ctx = canvas.getContext('2d'); ctx.fillStyle = '#123a45'; ctx.fillRect(0, 0, 640, 360);
    ctx.fillStyle = '#51b9a7'; ctx.fillRect(32, 32, 10, 296); ctx.fillStyle = '#ffffff';
    ctx.font = 'bold 36px sans-serif'; ctx.fillText('PRAYER MARATHON', 65, 160);
    ctx.font = '22px sans-serif'; ctx.fillText('A time to pray together', 65, 206);
    return canvas.toDataURL('image/png').split(',')[1];
  });
  await fs.writeFile(path.join(directory, 'media/backgrounds/prayer-layout.png'), Buffer.from(png, 'base64'));
  const request = context.request;
  assert.equal((await request.post(`${base}/api/auth/login`, { data: { username: 'admin', password: 'admin' } })).status(), 200);
  const fixture = { version: 2, updatedAt: new Date().toISOString(), settings: { transitionMs: 0 },
    music: { mode: 'off', current: `music/${trackName}`, queue: [`music/${trackName}`] },
    channels: [{ id: 'graphics', name: 'Prayer marathon graphics', kind: 'presentation', playlistId: 'graphics-deck', defaultMode: 'manual' },
      { id: 'notices', name: 'Sunday announcements', kind: 'announcement', playlistId: 'notices-deck', defaultMode: 'manual' }],
    playlists: [{ id: 'graphics-deck', name: 'Prayer marathon graphics', items: Array.from({ length: 12 }, (_, index) => ({
      id: `graphic-${index + 1}`, type: 'image', title: `Prayer graphic ${index + 1}`, durationMs: 120000,
      background: { kind: 'image', src: 'media/backgrounds/prayer-layout.png', fit: 'contain', overlayOpacity: 0 },
    })) }, { id: 'notices-deck', name: 'Sunday announcements', items: [{ id: 'welcome', type: 'text', title: 'Welcome', body: 'Sunday service', durationMs: 30000 }] }],
    sources: [{ id: 'graphics-source', kind: 'channel', ref: 'graphics' }], destinations: [], routes: [], program: { programSourceId: null, previewSourceId: null } };
  const seeded = await request.put(`${base}/api/content`, { data: fixture }); assert.equal(seeded.status(), 200, await seeded.text());
  await page.goto(base); await page.getByRole('heading', { name: 'Prayer marathon graphics', exact: true }).waitFor({ state: 'attached' });
  assert.equal(await page.getByRole('button', { name: 'Manual', exact: true }).getAttribute('aria-pressed'), 'true', 'Presentation starts in Manual');
  const collapse = page.getByRole('button', { name: 'Collapse toolbar', exact: true });
  if (await collapse.isVisible()) await collapse.click();
  const grid = page.getByRole('button', { name: 'Grid view', exact: true });
  // The broken layout can completely collapse the editor. Capture that failure
  // instead of timing out before its geometry and duplicate players are checked.
  if (await grid.isVisible()) await grid.click();
  await until(() => page.locator('.presentation-editor img').evaluateAll(images => images.length > 0 && images.every(image => image.complete && image.naturalWidth > 0)), 'actual graphics previews decoded');
  async function measure(width) {
    await page.setViewportSize({ width, height: width < 768 ? 844 : 982 });
    await page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
    const layout = await page.evaluate(() => {
      const rect = selector => { const element = document.querySelector(selector), r = element.getBoundingClientRect();
        return { x: r.x, y: r.y, width: r.width, height: r.height, right: r.right, bottom: r.bottom, scrollWidth: element.scrollWidth, clientWidth: element.clientWidth }; };
      const visiblePlayers = [...document.querySelectorAll('.music-mini-player')].filter(element => element.getBoundingClientRect().width > 0 && getComputedStyle(element).visibility !== 'hidden');
      return { width: innerWidth, overflow: document.documentElement.scrollWidth > innerWidth + 1,
        workspace: rect('.presentation-workspace'), transport: rect('.presentation-controls'), editor: rect('.presentation-editor'),
        playlists: rect('.playlist-rail'), cues: rect('.presentation-cues'), list: rect('.presentation-slide-list'),
        music: visiblePlayers.map(element => { const r = element.getBoundingClientRect(); return { x: r.x, y: r.y, width: r.width, right: r.right, bottom: r.bottom }; }),
        auto: [...document.querySelectorAll('.music-mini-player button[aria-label="Music Auto"]')].filter(element => element.getBoundingClientRect().width > 0).map(element => element.getAttribute('aria-pressed')),
      };
    });
    measurements.push(layout);
    check(layout.music.length === 0, `${width}px: Presentation has no music player (found ${layout.music.length})`);
    check(!layout.overflow, `${width}px: long music name does not cause page overflow`);
    check(layout.editor.scrollWidth <= layout.editor.clientWidth + 1, `${width}px: editor contents fit its width`);
    check(layout.transport.scrollWidth <= layout.transport.clientWidth + 1, `${width}px: transport contents fit its width`);
    check(layout.editor.height >= layout.workspace.height * (width < 768 ? 0.55 : 0.7), `${width}px: slide editor fills the main working area`);
    check(layout.editor.bottom <= innerHeightFor(width) + 1, `${width}px: editor remains inside the viewport`);
    check(layout.list.height >= 200, `${width}px: graphics deck has usable scrolling space`);
    check(layout.auto.every(value => value === 'false'), `${width}px: music remains manual after resizing`);
    if (width >= 768) {
      check(Math.abs(layout.editor.y - layout.cues.y) <= 2, `${width}px: editor and Channel output share a top edge`);
      check(Math.abs(layout.editor.bottom - layout.cues.bottom) <= 2, `${width}px: editor and Channel output share a bottom edge`);
      check(layout.cues.x >= layout.editor.right, `${width}px: Channel output is to the right of the editor`);
      check(layout.editor.width >= width * 0.4, `${width}px: editor receives the main column width`);
      check(layout.music.every(player => player.bottom <= layout.transport.bottom + 1), `${width}px: desktop music stays in the transport`);
      check(layout.music.every(player => player.width <= 330 + 1), `${width}px: long music title stays within the 330px player limit`);
      if (width >= 1024) {
        check(Math.abs(layout.playlists.y - layout.editor.y) <= 2, `${width}px: playlist, editor and output occupy one row`);
        check(layout.playlists.right <= layout.editor.x, `${width}px: playlists are to the left of the editor`);
      } else check(layout.playlists.right <= 1, `${width}px: playlist drawer is offscreen when closed`);
    } else {
      check(layout.playlists.right <= 1 && layout.cues.x >= width - 1, `${width}px: closed drawers do not consume editor space`);
      check(layout.editor.x >= 0 && layout.editor.right <= width && layout.editor.width >= width - 24, `${width}px: mobile editor fills available width`);
      check(layout.music.every(player => player.x >= 0 && player.right <= width && player.bottom <= layout.editor.y + 1), `${width}px: phone music is contained above the editor`);
    }
    if (width === 1512 || width === 375) await page.screenshot({ path: path.join(artifacts, `presentation-${width}.png`) });
  }
  function innerHeightFor(width) { return width < 768 ? 844 : 982; }
  for (const width of [1512, 1280, 1024, 768, 767, 375]) await measure(width);
  // Report all layout failures together, retaining screenshots even on the old bug.
  assert.deepEqual(failures, [], 'Responsive presentation layout');
  await page.setViewportSize({ width: 1512, height: 982 });
  await page.getByRole('button', { name: 'List view', exact: true }).click();
  assert.equal(await page.locator('.presentation-slide-card').count(), 12, 'All graphics remain present in list view');
  await measure(1280);
  assert.deepEqual(failures, [], 'Music media picker and list view preserve layout');
  await page.getByRole('button', {name:'New slide',exact:true}).click();
  for (const kind of ['Prayer','Media','PDF','PowerPoint','Notes']) assert.equal(await page.locator('.content-chooser').getByRole('button',{name:new RegExp(kind)}).count(),1,kind+' content choice');
  await page.getByRole('button', {name:'New slide',exact:true}).click();
  await page.getByRole('button', {name:'New group',exact:true}).click();
  let groupDialog=page.getByRole('dialog');
  await groupDialog.getByLabel('Group name').fill('Prayer focus');
  await groupDialog.getByRole('button',{name:'Save group',exact:true}).click();
  await page.getByRole('button',{name:'Edit group Prayer focus',exact:true}).waitFor();
  await page.getByRole('button', {name:'New group',exact:true}).click();
  await groupDialog.getByLabel('Group name').fill('Intercession');
  await groupDialog.getByRole('button',{name:'Save group',exact:true}).click();
  await page.getByRole('button',{name:'Edit group Intercession',exact:true}).waitFor();
  const first=page.locator('.presentation-slide-card').first();
  await first.hover(); await first.getByTitle('Edit',{exact:true}).click();
  const edit=page.getByRole('dialog');
  await edit.getByLabel('Place in group').selectOption({label:'— Intercession'});
  await edit.getByRole('button',{name:'Save',exact:true}).click();
  await until(async()=> {const state=await(await request.get(`${base}/api/content`)).json(); return !!state.playlists[0].items.find(item=>item.id==='graphic-1')?.groupId;},'slide saved in nested group');
  const state=await(await request.get(`${base}/api/content`)).json();
  assert.equal(state.playlists[0].groups.length,2);
  const parent=state.playlists[0].groups.find(group=>group.name==='Prayer focus');
  assert.equal(state.playlists[0].groups.find(group=>group.name==='Intercession').parentId,parent.id,'New nested group points to selected parent');
  await page.getByRole('button',{name:'Collapse Prayer focus',exact:true}).click();
  assert.equal(await page.locator('.presentation-slide-card').count(),11,'Collapse hides only group descendants');
  await page.getByRole('button',{name:'Show first slide in Prayer focus',exact:true}).click();
  await page.getByRole('button',{name:'Expand Prayer focus',exact:true}).click();
  assert.match(await page.locator('.presentation-slide-card.is-current').getAttribute('aria-label'),/Prayer graphic 1/);
  await page.getByRole('button',{name:'Edit group Prayer focus',exact:true}).click();
  await groupDialog.getByRole('button',{name:'Ungroup slides',exact:true}).click();
  await until(async()=> (await(await request.get(`${base}/api/content`)).json()).playlists[0].groups.length===1,'ungroup saved');
  assert.equal(await page.locator('.presentation-slide-card').count(),12,'Ungroup keeps all slides');
  await page.reload(); await page.getByRole('heading',{name:'Prayer marathon graphics',exact:true}).waitFor();
  assert.equal(await page.getByRole('button',{name:'Edit group Intercession',exact:true}).count(),1,'Group persists after reload');
  assert.deepEqual(errors, [], 'No application errors');
  console.log(`PASS: graphics deck, music-free Presentation, full-height panes, five content types, nested groups, ungroup and manual defaults. Artifacts: ${artifacts}`);
} catch (error) {
  if (page) await page.screenshot({ path: path.join(artifacts, 'failure.png') }).catch(() => {});
  console.error(logs.slice(-3000)); console.error(`Artifacts: ${artifacts}`); throw error;
} finally {
  await fs.writeFile(path.join(artifacts, 'report.json'), JSON.stringify({ failures, errors, measurements }, null, 2));
  await browser?.close();
  if (server && server.exitCode === null && server.signalCode === null) {
    const exited = new Promise(resolve => server.once('exit', resolve)); server.kill('SIGTERM'); await exited;
  }
  await fs.rm(directory, { recursive: true, force: true });
}
