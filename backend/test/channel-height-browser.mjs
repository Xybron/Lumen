// Responsive channel layout regression. Uses only a disposable station and never
// starts its production engine, opens an input, or touches operator content.
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import net from 'node:net';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright-core';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'lumen-channel-height-'));
const port = Number(process.env.LUMEN_CHANNEL_HEIGHT_TEST_PORT ?? 3442);
const base = `http://127.0.0.1:${port}`;
await new Promise((resolve, reject) => {
  const probe = net.createServer(); probe.once('error', reject);
  probe.listen(port, '127.0.0.1', () => probe.close(resolve));
});
let logs = '', browser, page;
const errors = [], checks = [], measurements = [];
const server = spawn(process.execPath, ['backend/dist/server.js'], {
  cwd: root,
  env: { ...process.env, PORT: String(port), HOST: '127.0.0.1', LUMEN_DATA_DIR: dir, LUMEN_RENDERER_URL: base },
  stdio: ['ignore', 'pipe', 'pipe'],
});
server.stdout.on('data', value => { logs += value; });
server.stderr.on('data', value => { logs += value; });
async function until(fn, label, timeout = 15000) {
  const end = Date.now() + timeout; let last;
  while (Date.now() < end) {
    try { const result = await fn(); if (result) return result; } catch (error) { last = error; }
    await new Promise(resolve => setTimeout(resolve, 60));
  }
  throw new Error(`Timed out: ${label}${last ? ` (${last.message})` : ''}`);
}
const settle = () => page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
try {
  await until(async () => (await fetch(`${base}/api/studio`, { signal: AbortSignal.timeout(1000) })).ok, 'temporary station startup', 30000);
  browser = await chromium.launch({
    executablePath: process.env.LUMEN_CHROME_PATH ?? '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
    headless: true,
  });
  const context = await browser.newContext({ viewport: { width: 1512, height: 982 } });
  const request = context.request;
  assert.equal((await request.post(`${base}/api/auth/login`, { data: { username: 'admin', password: 'admin' } })).status(), 200);
  const content = {
    version: 2, updatedAt: new Date().toISOString(), settings: { transitionMs: 0 }, music: { mode: 'off' },
    channels: ['scripture', 'lyrics'].map(kind => ({ id: kind, name: kind === 'scripture' ? 'Scripture' : 'Lyrics', kind, playlistId: `p_${kind}`, defaultMode: 'manual' })),
    playlists: ['scripture', 'lyrics'].map(kind => ({ id: `p_${kind}`, name: `${kind} archive`, items: [] })),
  };
  const saved = await request.put(`${base}/api/content`, { data: content });
  assert.equal(saved.status(), 200, await saved.text());
  async function command(channel, value) {
    const state = await (await request.get(`${base}/api/worship/channels/${channel}`)).json();
    const response = await request.post(`${base}/api/worship/channels/${channel}/command`, { data: { revision: state.revision, command: value } });
    assert.equal(response.status(), 200, await response.text());
    return response.json();
  }
  for (let verse = 1; verse <= 8; verse++) await command('scripture', { type: 'take', selection: { kind: 'scripture', versionId: 'KJV', book: 43, chapter: 3, verse } });
  const songIds = [];
  for (let index = 0; index < 12; index++) {
    const song = await request.post(`${base}/api/worship/songs`, { data: {
      id: `layout_song_${index}`, title: `Service song ${String(index + 1).padStart(2, '0')}`, author: 'Local test library',
      sections: Array.from({ length: 12 }, (_, section) => ({ id: `section_${section}`, label: section === 0 ? 'Verse' : `Chorus ${section}`, text: 'Together in this place\nLet every voice sing out with joy\nA song for this moment\nHope for every heart' })),
    } });
    assert.equal(song.status(), 201, await song.text()); songIds.push((await song.json()).id);
  }
  await command('lyrics', { type: 'setlist', songIds });
  await command('lyrics', { type: 'take', selection: { kind: 'lyrics', songId: songIds[0], sectionId: 'section_0' } });
  const initialStudio = await (await request.get(`${base}/api/studio`)).json();
  const initialWorship = await Promise.all(['scripture', 'lyrics'].map(async id => (await request.get(`${base}/api/worship/channels/${id}`)).json()));
  page = await context.newPage(); page.on('pageerror', error => errors.push(error.message));
  await page.goto(base); await page.getByRole('heading', { name: 'Find a passage', exact: true }).waitFor();
  await page.evaluate(() => document.fonts.ready);
  const dock = page.getByRole('navigation', { name: 'Channel toolbar', exact: true });
  async function expandDock() {
    const expand = dock.getByRole('button', { name: 'Expand toolbar', exact: true });
    if (await expand.isVisible()) await expand.click();
  }
  async function openChannel(kind) {
    await expandDock();
    await dock.getByRole('button', { name: `${kind === 'scripture' ? 'Scripture' : 'Lyrics'} — ${kind}`, exact: true }).click();
    await page.getByRole('heading', { name: kind === 'scripture' ? 'Find a passage' : 'Find a song', exact: true }).waitFor();
    await page.getByTestId('live-cue').getByText(kind === 'scripture' ? 'John 3:8 · KJV' : 'Verse', { exact: true }).waitFor();
    if (kind === 'scripture') {
      await page.getByLabel('Search scripture', { exact: true }).fill('John 3');
      await page.locator('.w-verse-result').first().waitFor();
      await page.locator('.w-verse-result').first().click();
    } else {
      await page.locator('.w-song-select').first().waitFor();
      await page.locator('.w-song-select').first().click();
      await page.locator('.w-section-cue').first().waitFor();
    }
    await until(() => page.getByRole('button', { name: 'Send live', exact: true }).isEnabled(), `${kind} prepared content`);
    await settle();
  }
  async function resetAndTop() {
    await expandDock();
    await dock.getByRole('button', { name: 'Reset toolbar position', exact: true }).click();
    await page.locator('.w-workspace').evaluate(element => { element.scrollTop = 0; });
    await page.locator('.w-library,.w-search-panel,.w-song-panel,.w-song-cues,.w-setlist-content,.w-setlist-list,.w-cue-panel,.w-results').evaluateAll(elements => elements.forEach(element => { element.scrollTop = 0; }));
    await settle();
  }
  async function geometry(kind, size) {
    const result = await page.evaluate(() => {
      const workspace = document.querySelector('.w-workspace'), layout = document.querySelector('.w-layout');
      const box = element => { const r = element.getBoundingClientRect(); return { top: r.top, bottom: r.bottom, left: r.left, right: r.right, height: r.height }; };
      return {
        workspace: box(workspace), layout: box(layout),
        panels: [...layout.children].map(box),
        search: box(layout.querySelector('.w-search-panel')),
        song: layout.querySelector('.w-song-panel') ? box(layout.querySelector('.w-song-panel')) : null,
        setlist: layout.querySelector('.w-setlist-panel') ? box(layout.querySelector('.w-setlist-panel')) : null,
        cue: box(layout.querySelector('.w-cue-panel')),
        listenerCount: layout.querySelectorAll('.w-listener').length,
        listenerInSetlist: !!layout.querySelector('.w-setlist-panel .w-listener'),
        listenerAfterSetlist: !!layout.querySelector('.w-setlist-content') && !!(layout.querySelector('.w-setlist-content').compareDocumentPosition(layout.querySelector('.w-listener')) & Node.DOCUMENT_POSITION_FOLLOWING),
        outerBottomPadding: parseFloat(getComputedStyle(workspace).paddingBottom),
        panelTopPadding: parseFloat(getComputedStyle(workspace).paddingTop),
        horizontalFits: document.documentElement.scrollWidth <= innerWidth,
        documentFits: document.documentElement.scrollHeight <= innerHeight,
        scrollable: workspace.scrollHeight > workspace.clientHeight,
      };
    });
    measurements.push({ channel: kind, ...size, ...result });
    assert.ok(result.horizontalFits, `${kind} has no horizontal page overflow at ${size.width}×${size.height}`);
    assert.ok(result.outerBottomPadding <= 24, `${kind} uses a normal outer bottom gutter, not a reserved toolbar-sized empty row`);
    const fullHeightColumns = kind === 'lyrics' ? size.width >= 1280 : size.width > 1024;
    if (fullHeightColumns && size.height >= 720) {
      assert.ok(result.documentFits, `${kind} stays inside the viewport on desktop`);
      assert.ok(Math.abs(result.workspace.bottom - size.height) < 1, `${kind} workspace fills the viewport below the header`);
      for (const [index, panel] of result.panels.entries()) {
        assert.ok(Math.abs(size.height - panel.bottom - result.outerBottomPadding) < 2,
          `${kind} panel ${index + 1} reaches the normal bottom gutter (${size.height - panel.bottom}px gap)`);
      }
      assert.ok(Math.abs(result.outerBottomPadding - result.panelTopPadding) < 1, `${kind} top and bottom panel gutters match`);
    } else if (!fullHeightColumns) {
      assert.ok(result.scrollable, `${kind} stacked panels remain vertically scrollable`);
    }
    if (kind === 'lyrics') {
      assert.equal(result.listenerCount, 1, 'Lyrics has one listening instance at every breakpoint');
      assert.ok(result.listenerInSetlist && result.listenerAfterSetlist, 'Local listening stays below the service setlist');
      assert.ok(result.song, 'Selected song has its own panel');
      if (size.width > 650) {
        assert.ok(Math.abs(result.search.top - result.song.top) < 2, `Song sections align beside Find a song at ${size.width}px`);
        assert.ok(result.song.left >= result.search.right, `Song sections do not cover the search column at ${size.width}px`);
        if (size.width >= 1280) {
          assert.ok(result.setlist.right <= result.search.left && result.song.right <= result.cue.left, 'Desktop columns follow setlist, search, selected song, prepared/live order');
        } else {
          assert.ok(result.cue.top >= result.search.bottom, 'Prepared/live controls move below the working columns on narrower screens');
        }
      } else {
        assert.ok(result.song.top >= result.search.bottom && result.cue.top >= result.song.bottom && result.setlist.top >= result.cue.bottom,
          'Phone layout keeps search, selected song, prepared/live, then setlist/listening in reading order');
      }
    }
  }
  async function reachable(locator, label) {
    // Native focus/scroll can move every nested overflow container. This checks
    // the actual hit-tested target, not only an element's "visible" CSS state.
    await locator.evaluate(element => element.scrollIntoView({ block: 'center', inline: 'nearest' }));
    await settle();
    const hit = await locator.evaluate(element => {
      const r = element.getBoundingClientRect(), x = r.left + r.width / 2, y = r.top + r.height / 2;
      const top = document.elementFromPoint(x, y);
      const clipped = (() => {
        for (let ancestor = element.parentElement; ancestor; ancestor = ancestor.parentElement) {
          const style = getComputedStyle(ancestor);
          if (['auto', 'scroll', 'hidden', 'clip'].includes(style.overflowY)) {
            const a = ancestor.getBoundingClientRect(); if (y < a.top || y > a.bottom) return true;
          }
        }
        return false;
      })();
      return { reachable: x >= 0 && x <= innerWidth && y >= 0 && y <= innerHeight && !clipped && (top === element || element.contains(top)),
        center: { x, y }, top: top?.outerHTML.slice(0, 160) };
    });
    assert.ok(hit.reachable, `${label} is scroll-reachable and not covered by the floating toolbar: ${JSON.stringify(hit)}`);
  }

  async function independentLyricsScroll(size) {
    const scrolls = () => page.evaluate(() => ({
      workspace: document.querySelector('.w-workspace').scrollTop,
      search: document.querySelector('.w-lyrics-results').scrollTop,
      song: document.querySelector('.w-song-panel').scrollTop + document.querySelector('.w-song-cues').scrollTop,
    }));
    const before = await scrolls();
    await page.locator('.w-song-cues .w-section-cue').last().evaluate(element => element.scrollIntoView({ block: 'end', inline: 'nearest' }));
    await settle();
    const after = await scrolls();
    assert.ok(after.song > before.song, `The long song has its own scroll area at ${size.width}×${size.height}`);
    assert.equal(after.workspace, before.workspace, 'Reading later sections does not move the workspace');
    assert.equal(after.search, before.search, 'Reading later sections preserves the song-search position');
    await resetAndTop();
  }

  for (const kind of ['scripture', 'lyrics']) {
    await openChannel(kind);
    for (const size of [{ width: 1512, height: 982 }, { width: 2048, height: 1287 }, { width: 1280, height: 720 }, { width: 1280, height: 600 }, { width: 1100, height: 768 }, { width: 1024, height: 768 }, { width: 800, height: 900 }, { width: 390, height: 844 }]) {
      await page.setViewportSize(size); await resetAndTop(); await geometry(kind, size);
      if (kind === 'lyrics' && size.width >= 1280 && size.height >= 720) await independentLyricsScroll(size);
      await page.screenshot({ path: path.join(dir, `${kind}-${size.width}x${size.height}.png`), fullPage: false });
      for (const collapsed of [false, true]) {
        if (collapsed) await dock.getByRole('button', { name: 'Collapse toolbar', exact: true }).click();
        const label = `${kind} ${size.width}×${size.height}, toolbar ${collapsed ? 'collapsed' : 'expanded'}`;
        await reachable(page.getByRole('button', { name: 'Listen', exact: true }), `${label}: Listen`);
        await reachable(page.getByLabel('Listening mode', { exact: true }), `${label}: Listening mode`);
        await reachable(page.getByRole('button', { name: 'Send live', exact: true }), `${label}: Send live`);
        await reachable(page.getByRole('button', { name: 'Next', exact: true }), `${label}: Next`);
        await reachable(page.getByRole('button', { name: kind === 'scripture' ? 'Manage versions' : 'Add a song', exact: true }), `${label}: Library action`);
        if (kind === 'lyrics') {
          await reachable(page.locator('.w-song-cues .w-section-cue').last(), `${label}: Last song section`);
          await reachable(page.locator('.w-song-select').last(), `${label}: Last search result`);
          await reachable(page.locator('.w-setlist-song').last().locator('button').first(), `${label}: Last setlist song`);
        }
      }
      if (size.width <= 1024 || kind === 'lyrics' && size.width < 1280) {
        await page.locator('.w-workspace').evaluate(element => { element.scrollTop = element.scrollHeight; }); await settle();
        const bottom = await page.evaluate(() => {
          const workspace = document.querySelector('.w-workspace'), layout = document.querySelector('.w-layout');
          return workspace.getBoundingClientRect().bottom - layout.getBoundingClientRect().bottom;
        });
        assert.ok(bottom >= 0 && bottom <= 24, `${kind} stacked layout ends at its normal gutter, not an empty external toolbar row (${bottom}px)`);
      }
    }
    checks.push(`${kind}: eight responsive sizes, expanded/collapsed toolbar, nested-scroll action reachability${kind === 'lyrics' ? ', adjacent song sections and setlist listening' : ''}`);
  }
  assert.deepEqual(await (await request.get(`${base}/api/studio`)).json(), initialStudio, 'Layout-only interactions preserve scenes, Program, outputs and audio');
  for (const [index, id] of ['scripture', 'lyrics'].entries()) assert.deepEqual(await (await request.get(`${base}/api/worship/channels/${id}`)).json(), initialWorship[index], 'Preparing content and checking layout never publishes or changes channel state');
  assert.equal((await (await request.get(`${base}/api/studio/status`)).json()).state, 'offline', 'Layout checks never start the engine or capture inputs');
  assert.deepEqual(errors, [], `Unexpected browser errors: ${errors.join('\n')}`);
  await fs.writeFile(path.join(dir, 'measurements.json'), JSON.stringify(measurements, null, 2));
  console.log(JSON.stringify({ result: 'PASS', artifacts: dir, checks }, null, 2));
} catch (error) {
  await page?.screenshot({ path: path.join(dir, 'channel-height-failure.png'), fullPage: true }).catch(() => {});
  await fs.writeFile(path.join(dir, 'measurements.json'), JSON.stringify(measurements, null, 2));
  console.error(error); console.error(logs); console.error(`Artifacts: ${dir}`); process.exitCode = 1;
} finally {
  await browser?.close();
  if (server.exitCode === null) {
    const exited = new Promise(resolve => server.once('exit', resolve)); server.kill('SIGTERM');
    await Promise.race([exited, new Promise(resolve => setTimeout(resolve, 6000))]);
  }
}
