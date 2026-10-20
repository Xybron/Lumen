// Real operator Multiview regression against an isolated station. All media is
// generated; no physical devices, running station or operator data are touched.
// Run after the integrated build has finished.
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import net from 'node:net';
import { spawn, execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright-core';
import ffmpeg from 'ffmpeg-static';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'lumen-multiview-browser-'));
const port = Number(process.env.LUMEN_MULTIVIEW_TEST_PORT ?? 3437), base = `http://127.0.0.1:${port}`;
await new Promise((resolve, reject) => {
  const probe = net.createServer(); probe.once('error', reject);
  probe.listen(port, '127.0.0.1', () => probe.close(resolve));
});
await fs.mkdir(path.join(dir, 'media', 'music'), { recursive: true });
execFileSync(ffmpeg, ['-hide_banner', '-loglevel', 'error', '-f', 'lavfi', '-i', 'sine=frequency=440:sample_rate=48000',
  '-t', '20', '-c:a', 'pcm_s16le', path.join(dir, 'media', 'music', 'main.wav')]);
let logs = '', browser, page, request, output;
const checks = [], errors = [];
const server = spawn(process.execPath, ['backend/dist/server.js'], { cwd: root,
  env: { ...process.env, PORT: String(port), HOST: '127.0.0.1', LUMEN_DATA_DIR: dir, LUMEN_RENDERER_URL: base }, stdio: ['ignore', 'pipe', 'pipe'] });
server.stdout.on('data', data => { logs += data; }); server.stderr.on('data', data => { logs += data; });
async function until(fn, label, timeout = 30000) {
  const end = Date.now() + timeout; let last;
  while (Date.now() < end) {
    try { const value = await fn(); if (value) return value; } catch (error) { last = error; }
    await new Promise(resolve => setTimeout(resolve, 160));
  }
  throw new Error(`Timed out: ${label}${last ? ` (${last.message})` : ''}`);
}
async function settled(target = page) {
  await target.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
}
async function sample(video, points = [[.5, .5]]) {
  return video.evaluate((element, points) => {
    const canvas = document.createElement('canvas'); canvas.width = element.videoWidth; canvas.height = element.videoHeight;
    const context = canvas.getContext('2d'); context.drawImage(element, 0, 0);
    return points.map(([x, y]) => [...context.getImageData(Math.floor(canvas.width * x), Math.floor(canvas.height * y), 1, 1).data].slice(0, 3));
  }, points);
}
const dominant = (rgb, channel) => rgb[channel] > 100 && rgb[channel] > rgb[(channel + 1) % 3] * 1.5 && rgb[channel] > rgb[(channel + 2) % 3] * 1.5;
async function renderedScenePixel(target, id) {
  return target.evaluate((board, id) => {
    const canvas = board.querySelector('[data-testid="multiview-scene-canvas"]');
    const tile = [...board.querySelectorAll('[data-scene-id]')].find(element => element.dataset.sceneId === id);
    if (!canvas || !tile || !canvas.width || !canvas.height) return null;
    const frame = canvas.getBoundingClientRect(), rect = tile.getBoundingClientRect();
    // Sample above the caption and below the bus badges. This checks the actual
    // client-side crop/reflow, not just the unchanged two-column source atlas.
    const x = Math.floor((rect.x + rect.width * .5 - frame.x) * canvas.width / frame.width);
    const y = Math.floor((rect.y + rect.height * .45 - frame.y) * canvas.height / frame.height);
    return [...canvas.getContext('2d').getImageData(x, y, 1, 1).data].slice(0, 3);
  }, id);
}
async function centerLayout(target, label, { columns = 4, scrollFree = true, nativeAspect = true } = {}) {
  await settled(target.page());
  const layout = await target.evaluate(board => {
    const rect = element => { const r = element.getBoundingClientRect(); return { x: r.x, y: r.y, width: r.width, height: r.height, right: r.right, bottom: r.bottom }; };
    const scroll = board.querySelector('.multiview-scenes-scroll');
    return {
      board: rect(board), preview: rect(board.querySelector('[data-testid="multiview-preview"] .multiview-monitor')),
      program: rect(board.querySelector('[data-testid="multiview-program"] .multiview-monitor')),
      controls: rect(board.querySelector('.multiview-transitions')),
      slots: [...board.querySelectorAll('.multiview-scene')].map(rect),
      columns: getComputedStyle(board.querySelector('.multiview-scene-grid')).gridTemplateColumns.split(' ').length,
      horizontalOverflow: board.scrollWidth - board.clientWidth,
      gridOverflow: scroll.scrollHeight - scroll.clientHeight,
      shelfHeight: scroll.clientHeight,
    };
  });
  assert.equal(layout.columns, columns, `${label}: scene grid has ${columns} columns`);
  assert.ok(layout.horizontalOverflow <= 2, `${label}: no horizontal board overflow`);
  assert.ok(Math.abs(layout.preview.y - layout.program.y) <= 2, `${label}: the two main monitors share the top row`);
  assert.ok(Math.abs(layout.preview.width - layout.program.width) <= 2, `${label}: Preview and Program have equal prominence`);
  assert.ok(layout.preview.width >= layout.board.width * .39, `${label}: main monitors are large relative to the full board`);
  if (nativeAspect) assert.ok(Math.abs(layout.preview.width / layout.preview.height - 16 / 9) < .03, `${label}: ordinary display shapes preserve the 16:9 monitor frame`);
  assert.ok(layout.preview.x - layout.board.x <= 20 && layout.board.right - layout.program.right <= 20, `${label}: buses use the full available width`);
  assert.ok(layout.controls.x >= layout.preview.right - 2 && layout.controls.right <= layout.program.x + 2, `${label}: Cut, Fade and duration sit between the main monitors`);
  assert.ok(layout.controls.y >= layout.preview.y && layout.controls.bottom <= layout.preview.bottom + 2, `${label}: the center control rail fits beside the pictures`);
  assert.ok(layout.slots.every(tile => tile.y >= layout.preview.bottom && tile.width < layout.preview.width * .56), `${label}: scene thumbnails sit below and are substantially smaller than the main monitors`);
  if (scrollFree) assert.ok(layout.gridOverflow <= 2, `${label}: the current scene grid fits without scrolling`);
  return layout;
}
async function measureAudio(target) {
  return target.locator('video').evaluate(async video => {
    const context = new AudioContext(); await context.resume();
    const source = context.createMediaStreamSource(video.srcObject), analyser = context.createAnalyser(), silence = context.createGain();
    analyser.fftSize = 2048; silence.gain.value = 0;
    source.connect(analyser); analyser.connect(silence); silence.connect(context.destination);
    const samples = new Float32Array(analyser.fftSize); let peak = 0;
    for (let index = 0; index < 6; index++) {
      await new Promise(resolve => setTimeout(resolve, 60)); analyser.getFloatTimeDomainData(samples);
      for (const value of samples) peak = Math.max(peak, Math.abs(value));
    }
    source.disconnect(); analyser.disconnect(); silence.disconnect(); await context.close(); return peak;
  });
}
try {
  await until(async () => (await fetch(`${base}/api/studio`, { signal: AbortSignal.timeout(1500) })).ok, 'station ready');
  browser = await chromium.launch({ executablePath: process.env.LUMEN_CHROME_PATH ?? '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
    headless: true, args: ['--autoplay-policy=no-user-gesture-required'] });
  const context = await browser.newContext({ viewport: { width: 1512, height: 982 } }); request = context.request;
  await context.addInitScript(() => {
    const NativePeer = window.RTCPeerConnection;
    window.__multiviewPeers = [];
    window.RTCPeerConnection = class extends NativePeer {
      constructor(...args) { super(...args); window.__multiviewPeers.push(this); }
    };
  });
  assert.equal((await request.post(`${base}/api/auth/login`, { data: { username: 'admin', password: 'admin' } })).status(), 200);
  const get = async () => (await request.get(`${base}/api/studio`)).json();
  const status = async () => (await request.get(`${base}/api/studio/status`)).json();
  const save = async mutate => {
    const state = await get(); mutate(state);
    const response = await request.put(`${base}/api/studio`, { data: state });
    assert.equal(response.status(), 200, await response.text()); return response.json();
  };
  const command = async command => {
    const state = await get(), response = await request.post(`${base}/api/studio/command`, { data: { revision: state.revision, command } });
    assert.equal(response.status(), 200, await response.text()); return response.json();
  };
  const kinds = ['presentation', 'scripture', 'lyrics'];
  const seeded = await request.put(`${base}/api/content`, { data: { version: 2, updatedAt: new Date().toISOString(), settings: { transitionMs: 0 }, music: { mode: 'off' },
    channels: kinds.map(kind => ({ id: kind, name: kind[0].toUpperCase() + kind.slice(1), kind, playlistId: `playlist_${kind}`, defaultMode: 'manual' })),
    playlists: kinds.map(kind => ({ id: `playlist_${kind}`, name: kind, items: kind === 'presentation' ? [
      { id: 'announcement_one', type: 'text', title: 'First announcement', body: 'Welcome to the service', durationMs: 60000, background: { kind: 'color', color: '#142522' } },
      { id: 'announcement_two', type: 'text', title: 'Second announcement', body: 'The next gathering', durationMs: 60000, background: { kind: 'color', color: '#23283a' } },
    ] : [] })) } });
  assert.equal(seeded.status(), 200, await seeded.text());
  await save(state => {
    state.sources = [{ id: 'main', name: 'Service mixer', kind: 'audio', url: 'media/music/main.wav', loop: true,
      audio: { volume: .6, muted: true, mode: 'follow', delayMs: 0 } }];
    state.scenes = [
      { id: 'red', name: 'Red scene', background: '#d52a30', layers: [] },
      { id: 'green', name: 'Green scene', background: '#20b66a', layers: [] },
      { id: 'blue', name: 'Blue scene', background: '#245cdb', layers: [] },
    ];
    state.previewSceneId = 'green'; state.masterMuted = false; state.masterVolume = 1;
    state.outputs = [{ id: 'pinned', name: 'Pinned blue', mode: 'program', scene: null, blanked: false, audioEnabled: true }];
  });
  await command({ type: 'take', sceneId: 'red' });
  await command({ type: 'route', outputId: 'pinned', sceneId: 'blue' });
  await command({ type: 'set-main-audio', sourceId: 'main' });
  const baseline = await get();
  assert.equal((await request.post(`${base}/api/studio/engine/start`, { timeout: 55000 })).status(), 200);
  await until(async () => (await status()).state === 'running' && (await status()).levels.master > .02, 'generated Main is audible', 50000);
  page = await context.newPage(); page.on('pageerror', error => errors.push(error.message));
  const takeRequests = [], channelTakeRequests = [];
  const observeTakes = target => target.on('request', request => {
    if (request.method() === 'POST' && request.url().endsWith('/api/studio/command')) {
      const payload = request.postDataJSON(); if (payload?.command?.type === 'take') takeRequests.push(payload.command);
    }
    if (request.method() === 'POST' && /\/api\/worship\/channels\/[^/]+\/command$/.test(request.url())) {
      const payload = request.postDataJSON(); if (payload?.command?.type === 'take') channelTakeRequests.push(payload.command);
    }
  });
  observeTakes(page);
  await page.goto(base);
  const toolbar = page.getByRole('navigation', { name: 'Channel toolbar' }); await toolbar.waitFor();
  await page.evaluate(() => {
    localStorage.setItem('lumen.studio.scene-shortcuts.v1', JSON.stringify([
      { sceneId: 'blue', code: 'Digit1', alt: false, transition: 'cut', durationMs: 300 },
      { sceneId: 'green', code: 'Digit2', alt: false, transition: 'fade', durationMs: 650 },
    ]));
  });
  await page.reload(); await toolbar.waitFor();
  await page.getByRole('button', { name: 'Presentation — presentation', exact: true }).click();
  const floating = page.getByTestId('floating-multiview'), board = page.getByTestId('studio-multiview');
  await page.getByRole('button', { name: 'Open Multiview', exact: true }).click(); await floating.waitFor();
  const scene = id => board.getByTestId(`multiview-scene-${id}`);
  const atlas = board.locator('.multiview-atlas > video');
  const preview = board.getByTestId('multiview-preview').locator('video'), program = board.getByTestId('multiview-program').locator('video');
  const readyVideo = video => until(() => video.evaluate(element => element.readyState >= 2 && element.videoWidth > 0 && element.srcObject?.getVideoTracks().length === 1), 'real Multiview stream');
  await readyVideo(atlas); await readyVideo(preview); await readyVideo(program);
  await until(() => page.evaluate(() => window.__multiviewPeers.filter(peer => peer.connectionState === 'connected').length === 3), 'only Preview, Program and one shared atlas transport');
  assert.equal(await board.locator('[data-scene-id]').count(), 3);
  assert.equal(await board.getByTestId('multiview-empty-slot').count(), 1, 'Three scenes occupy a balanced four-slot grid');
  assert.equal(await board.getByTestId('multiview-empty-slot').evaluate(element => element.matches('button, a, [tabindex]')), false, 'Empty slot is not an interactive scene');
  assert.equal(await board.locator('.multiview-scene-grid').evaluate(element => getComputedStyle(element).gridTemplateColumns.split(' ').length), 2,
    'The ordinary floating window retains its compact two-column scene grid');
  assert.equal(await atlas.count(), 1, 'Every thumbnail uses the same atlas video, not per-scene streams');
  assert.deepEqual(await atlas.evaluate(element => ({ muted: element.muted, audio: element.srcObject.getAudioTracks().length, video: element.srcObject.getVideoTracks().length })),
    { muted: true, audio: 0, video: 1 }, 'Atlas is one muted video-only stream');
  for (const video of [preview, program]) assert.equal(await video.evaluate(element => element.muted), true, 'Multiview bus monitors stay muted');
  assert.equal(await program.evaluate(element => {
    const rect = element.getBoundingClientRect();
    return !!document.elementFromPoint(rect.x + rect.width / 2, rect.y + rect.height / 2)?.closest('[data-testid="floating-multiview"]');
  }), true, 'The floating Program monitor sits above channel panels, not behind them');
  const atlasPixels = await until(async () => {
    const pixels = await sample(atlas, [[.25, .25], [.75, .25], [.25, .75], [.75, .75]]);
    return dominant(pixels[0], 0) && dominant(pixels[1], 1) && dominant(pixels[2], 2) ? pixels : null;
  }, 'real atlas paints all current draft scene colors');
  assert.ok(Math.max(...atlasPixels[3]) < 70, 'The empty atlas slot is blank');
  await save(state => { state.scenes.find(scene => scene.id === 'blue').background = '#df3930'; });
  await until(async () => dominant((await sample(atlas, [[.25, .75]]))[0], 0), 'atlas follows a draft edit without taking the scene');
  assert.equal((await get()).program.id, 'red', 'Live thumbnail refresh never changes Program');
  await save(state => { state.scenes.find(scene => scene.id === 'blue').background = '#245cdb'; });
  await until(async () => dominant((await sample(atlas, [[.25, .75]]))[0], 2), 'atlas returns to the edited blue draft');
  await until(async () => /is-preview/.test(await scene('green').getAttribute('class')) && /is-program/.test(await scene('red').getAttribute('class')), 'Preview and Program tile indicators');
  await page.screenshot({ path: path.join(dir, 'multiview-desktop.png') });
  checks.push('floating toolbar entry, real single silent atlas, Preview/Program streams, balanced empty slot and distinct bus indicators');

  // Keep a separate audible Program receiver to verify that operator switching
  // and silent Multiview monitoring never affect the service audio.
  output = await context.newPage(); await output.goto(`${base}/studio/output/program`);
  await readyVideo(output.locator('video'));
  await until(() => output.locator('video').evaluate(element => element.srcObject.getAudioTracks().length === 1), 'Program audio track');
  assert.ok(await measureAudio(output) > .02, 'Program receives the real generated Main audio');
  await page.bringToFront();
  const takeAndVerify = async (trigger, expected, transition) => {
    const before = await get(); await trigger();
    const after = await until(async () => {
      const state = await get(); return state.programTransition.id !== before.programTransition.id && state.program.id === expected && state;
    }, `${transition} takes ${expected}`);
    assert.equal(after.previewSceneId, before.program.id, 'Every Take returns the previous Program scene to Preview');
    assert.equal(after.programTransition.kind, transition);
    assert.equal(takeRequests.at(-1)?.swapPreview, true, 'UI sends an atomic bus-swap command');
    for (const field of ['mainAudioSourceId', 'masterVolume', 'masterMuted', 'sources', 'outputs', 'scenes']) assert.deepEqual(after[field], baseline[field], `Take preserves ${field}`);
    assert.ok((await status()).levels.master > .02, 'Main audio stays audible across the transition');
    await until(async () => /is-program/.test(await scene(expected).getAttribute('class')) && /is-preview/.test(await scene(before.program.id).getAttribute('class')), 'tile bus indicators follow the swap');
    return after;
  };
  const repeatTakeKeys = async (target, readyButton, label, keys = Array(6).fill('Space')) => {
    for (const [index, key] of keys.entries()) {
      await until(() => readyButton.isEnabled(), `${label}: Take controls settled before key ${index + 1}`);
      const before = await get(), requestCount = takeRequests.length;
      const focus = await target.evaluate(() => ({ tag: document.activeElement?.tagName, text: document.activeElement?.textContent?.trim().slice(0, 100) }));
      // Deliberately do not focus anything between physical key presses.
      await target.keyboard.press(key);
      const after = await until(async () => {
        const state = await get(); return state.programTransition.id !== before.programTransition.id && state;
      }, `${label}: ${key} ${index + 1} switches after prior interaction, focus ${JSON.stringify(focus)}`);
      assert.equal(after.program.id, before.previewSceneId, `${label}: key Takes the selected Preview`);
      assert.equal(after.previewSceneId, before.program.id, `${label}: key swaps previous Program back to Preview`);
      assert.equal(after.programTransition.kind, key === 'Shift+Space' ? 'fade' : 'cut', `${label}: intended transition type`);
      assert.equal(takeRequests.at(-1)?.swapPreview, true, `${label}: key requests an atomic bus swap`);
      await until(() => readyButton.isEnabled(), `${label}: Take controls settled after key ${index + 1}`);
      await target.waitForTimeout(200);
      assert.equal(takeRequests.length, requestCount + 1, `${label}: one physical press issues exactly one Take, without refocusing`);
      assert.equal((await get()).programTransition.id, after.programTransition.id, `${label}: keyup causes no second native-button Take`);
      for (const field of ['mainAudioSourceId', 'masterVolume', 'masterMuted', 'sources', 'outputs', 'scenes']) assert.deepEqual(after[field], baseline[field], `${label}: repeated keys preserve ${field}`);
    }
  };
  const beforeSelection = await get();
  await scene('blue').click();
  await until(async () => (await get()).previewSceneId === 'blue', 'scene click updates Preview');
  assert.equal((await get()).program.id, beforeSelection.program.id, 'Selecting a tile never Takes it');
  await takeAndVerify(() => board.getByRole('button', { name: 'Cut in Multiview', exact: true }).click(), 'blue', 'cut');
  await until(async () => dominant((await sample(program))[0], 2), 'Program decodes the blue scene');
  // A real operator does not refocus the board between Takes. In particular,
  // Chromium blurs a focused native button as soon as an in-flight Take disables
  // it. Keep using real physical key presses here: board.focus() would hide that
  // regression and leave subsequent Space presses going to the channel below.
  const cutButton = board.getByRole('button', { name: 'Cut in Multiview', exact: true });
  await repeatTakeKeys(page, cutButton, 'Floating Multiview after clicking Cut');
  const duration = board.getByLabel('Multiview fade duration', { exact: true });
  await duration.fill('420'); await duration.press('Tab');
  const faded = await takeAndVerify(() => board.getByRole('button', { name: 'Fade in Multiview', exact: true }).click(), 'red', 'fade');
  assert.equal(faded.programTransition.durationMs, 420);
  await repeatTakeKeys(page, cutButton, 'Floating Multiview after clicking Fade', ['Shift+Space', 'Space', 'Shift+Space', 'Space', 'Shift+Space', 'Space']);
  await scene('green').click();
  await until(async () => (await get()).previewSceneId === 'green', 'scene selection settles without keyboard refocus');
  await repeatTakeKeys(page, cutButton, 'Floating Multiview after clicking a scene');
  await scene('blue').click(); await until(async () => (await get()).previewSceneId === 'blue', 'restore blue Preview for shortcut checks');
  const boardKey = async key => { await board.focus(); await page.keyboard.press(key); };
  await takeAndVerify(() => boardKey('Space'), 'blue', 'cut');
  await takeAndVerify(() => boardKey('Shift+Space'), 'red', 'fade');
  await board.focus(); await page.keyboard.press('2');
  await until(async () => (await get()).previewSceneId === 'green', 'board digit selects Preview only');
  assert.equal((await get()).program.id, 'red');
  await takeAndVerify(() => { return page.keyboard.press('Control+Shift+1'); }, 'blue', 'cut');
  await cutButton.focus();
  const heldBefore = await get(), heldRequests = takeRequests.length;
  await page.keyboard.down('Space');
  await until(async () => (await get()).programTransition.id !== heldBefore.programTransition.id, 'first held Space begins exactly one Take');
  await until(() => cutButton.isEnabled(), 'first held Space Take settles');
  await page.keyboard.down('Space'); // Real repeat=true keydown, not a synthetic event.
  await page.keyboard.up('Space'); await page.waitForTimeout(200);
  assert.equal(takeRequests.length, heldRequests + 1, 'Holding Space and releasing it never repeats or native-clicks a transition button');
  assert.equal((await get()).program.id, heldBefore.previewSceneId, 'Only the initial held Space switches Program');
  await repeatTakeKeys(page, cutButton, 'Floating Multiview resumes after held Space', ['Space']);
  // Force a genuinely slow in-flight request. Repeated physical presses while
  // busy must be swallowed, not queued, duplicated, or sent to Presentation.
  let releaseDelayedTake;
  const delayedTake = new Promise(resolve => { releaseDelayedTake = resolve; });
  const delayTakeRoute = async route => {
    if (route.request().postDataJSON()?.command?.type === 'take') await delayedTake;
    await route.continue();
  };
  const delayedBefore = await get(), delayedRequestCount = takeRequests.length;
  await page.route('**/api/studio/command', delayTakeRoute);
  try {
    await page.keyboard.press('Space');
    await until(() => cutButton.isDisabled(), 'deliberately delayed Take disables controls');
    await page.keyboard.press('Space'); await page.keyboard.press('Shift+Space');
    await page.waitForTimeout(100);
    assert.equal(takeRequests.length, delayedRequestCount + 1, 'Busy Space presses do not enqueue extra Takes');
  } finally {
    releaseDelayedTake();
  }
  await until(async () => (await get()).programTransition.id !== delayedBefore.programTransition.id, 'delayed Take completes');
  await until(() => cutButton.isEnabled(), 'controls recover after delayed Take');
  await page.unroute('**/api/studio/command', delayTakeRoute);
  await repeatTakeKeys(page, cutButton, 'Floating Multiview recovers after busy key suppression', ['Space']);
  assert.equal(await page.getByRole('button', { name: 'Pause presentation', exact: true }).count(), 0, 'Repeated and busy Multiview Space never starts the underlying Presentation');
  assert.ok(await measureAudio(output) > .02, 'Main audio still reaches Program after button and keyboard switching');
  checks.push('scene click and plain digits select Preview only; Cut/Fade/Space/Shift+Space and configured shortcuts atomically swap buses; repeated physical Space after scene/Cut/Fade clicks needs no refocus, held keys never native-click again, and Main/pinned output stay intact');

  const stable = async (revision, label) => { await page.waitForTimeout(200); assert.equal((await get()).revision, revision, label); };
  const typing = await get(); await duration.focus();
  await page.keyboard.press('Space'); await page.keyboard.press('Control+Shift+2');
  await stable(typing.revision, 'Typing into the duration field cannot Take a scene');
  await board.focus();
  await board.evaluate(element => element.dispatchEvent(new KeyboardEvent('keydown', { key: ' ', code: 'Space', repeat: true, bubbles: true })));
  await stable(typing.revision, 'Held Space cannot repeatedly Take');
  await page.getByRole('button', { name: 'Scripture — scripture', exact: true }).click();
  await page.getByLabel('Search scripture', { exact: true }).waitFor(); await floating.waitFor();
  const search = page.getByLabel('Search scripture', { exact: true }); await search.focus();
  await page.keyboard.press('Control+Shift+2'); await stable(typing.revision, 'Scripture search cannot trigger a configured Take');
  await search.fill('John 3:16'); await until(() => page.locator('.w-verse-result').count(), 'Scripture reference results');
  // The overlay covers the right side, so prepare from the real search result
  // via its keyboard activation rather than bypassing the channel UI.
  await page.locator('.w-verse-result').first().focus(); await page.keyboard.press('Enter');
  await until(() => page.getByTestId('prepared-cue').textContent().then(text => text.includes('For God so loved')), 'Scripture is prepared behind Multiview');
  assert.equal((await (await request.get(`${base}/api/worship/channels/scripture`)).json()).live, null);
  const beforeOverlayKeys = await get();
  for (const target of [board, duration, page.getByRole('button', { name: 'Move Multiview', exact: true })]) {
    for (const chord of ['Control+Enter', 'Meta+Enter']) {
      await target.focus(); await page.keyboard.press(chord);
    }
  }
  await stable(beforeOverlayKeys.revision, 'Multiview Ctrl/Cmd+Enter cannot Take a Studio scene');
  assert.equal(channelTakeRequests.length, 0, 'Board, duration input and header grip never leak Ctrl/Cmd+Enter into Scripture Send live');
  assert.equal((await (await request.get(`${base}/api/worship/channels/scripture`)).json()).live, null, 'Prepared Scripture remains private when using Multiview controls');
  await board.focus();
  const globalFade = await takeAndVerify(() => page.keyboard.press('Control+Shift+2'), 'green', 'fade');
  assert.equal(globalFade.programTransition.durationMs, 650, 'Configured shortcuts keep their configured duration');
  checks.push('typing and key-repeat safety in overlay controls and Scripture search; overlay Ctrl/Cmd+Enter cannot publish a prepared Scripture; valid configured shortcuts still operate directly from a channel');

  await floating.getByRole('button', { name: 'Fullscreen Multiview', exact: true }).click();
  await until(() => page.evaluate(() => document.fullscreenElement?.getAttribute('data-testid') === 'floating-multiview'), 'floating window fullscreen');
  await centerLayout(board, 'Floating fullscreen with three scenes');
  for (const [id, color] of [['red', 0], ['green', 1], ['blue', 2]]) {
    await until(async () => { const pixel = await renderedScenePixel(board, id); return pixel && dominant(pixel, color); }, `fullscreen client canvas reflows ${id} into the correct four-column tile`);
  }
  await page.screenshot({ path: path.join(dir, 'multiview-fullscreen-center-controls.png') });
  await repeatTakeKeys(page, cutButton, 'Floating Multiview after clicking fullscreen', ['Space', 'Shift+Space']);
  await page.evaluate(() => document.exitFullscreen()); await until(() => page.evaluate(() => !document.fullscreenElement), 'floating window exits fullscreen');
  await page.getByRole('button', { name: 'Presentation — presentation', exact: true }).click();
  const presentationChip = page.getByRole('button', { name: 'Presentation — presentation', exact: true });
  const slideCounter = await presentationChip.textContent();
  await page.getByRole('button', { name: 'Play presentation', exact: true }).first().waitFor();
  await page.getByRole('button', { name: 'Move Multiview', exact: true }).press('ArrowRight');
  await floating.focus(); await page.keyboard.press('Space'); await page.waitForTimeout(200);
  assert.equal(await presentationChip.textContent(), slideCounter, 'Multiview header arrows never advance the underlying Presentation');
  assert.equal(await page.getByRole('button', { name: 'Pause presentation', exact: true }).count(), 0, 'Space on the window shell never plays the underlying Presentation');
  await page.getByRole('button', { name: 'Scripture — scripture', exact: true }).click();

  const grip = page.getByRole('button', { name: 'Move Multiview', exact: true });
  const drag = async (dx, dy) => {
    const rect = await grip.boundingBox(); const start = { x: rect.x + rect.width / 2, y: rect.y + rect.height / 2 };
    await page.mouse.move(start.x, start.y); await page.mouse.down(); await page.mouse.move(start.x + dx, start.y + dy, { steps: 8 }); await page.mouse.up(); await settled();
  };
  const beforeMove = await floating.boundingBox();
  const dx = beforeMove.x > 170 ? -110 : 110, dy = beforeMove.y > 110 ? -60 : 60;
  await drag(dx, dy); const moved = await floating.boundingBox();
  assert.ok(Math.abs(moved.x - beforeMove.x - dx) < 3 && Math.abs(moved.y - beforeMove.y - dy) < 3, 'Mouse grip moves the floating window');
  await grip.press('ArrowRight'); const nudged = await floating.boundingBox();
  assert.equal(nudged.x, moved.x + 10, 'Keyboard grip nudges the floating window');
  const preference = await page.evaluate(() => JSON.parse(localStorage.getItem('lumen.multiview.v1')));
  assert.equal(preference?.open, true, 'Expanded window is saved locally');
  assert.deepEqual([preference.box.x, preference.box.y], [nudged.x, nudged.y], 'The draggable box is saved locally');
  await page.getByRole('button', { name: 'Lyrics — lyrics', exact: true }).click(); await floating.waitFor(); await settled();
  const lyricsBounds = await floating.boundingBox();
  assert.deepEqual([lyricsBounds.x, lyricsBounds.y], [nudged.x, nudged.y], 'Position stays the same on Lyrics');
  await page.getByRole('button', { name: 'Presentation — presentation', exact: true }).click(); await floating.waitFor();
  await page.reload(); await floating.waitFor(); await readyVideo(atlas); await readyVideo(preview); await readyVideo(program); await settled();
  const reloaded = await floating.boundingBox();
  assert.deepEqual([reloaded.x, reloaded.y], [nudged.x, nudged.y], 'Open state and position survive a reload');
  await page.setViewportSize({ width: 390, height: 844 });
  await until(async () => { const rect = await floating.boundingBox(); return rect.x >= 0 && rect.y >= 0 && rect.x + rect.width <= 390 && rect.y + rect.height <= 844; }, 'floating window fits a narrow viewport');
  assert.ok(await floating.evaluate(element => element.scrollWidth <= element.clientWidth), 'Floating Multiview has no horizontal overflow');
  await page.getByRole('button', { name: 'Reset Multiview position', exact: true }).click(); await settled();
  const touchBounds = await floating.boundingBox(), touchGrip = await grip.boundingBox();
  const cdp = await context.newCDPSession(page), point = { x: touchGrip.x + touchGrip.width / 2, y: touchGrip.y + touchGrip.height / 2 };
  const touchDy = touchBounds.y > 65 ? -35 : 35;
  await cdp.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [point] });
  await cdp.send('Input.dispatchTouchEvent', { type: 'touchMove', touchPoints: [{ x: point.x, y: point.y + touchDy }] });
  await cdp.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] }); await cdp.detach(); await settled();
  assert.ok(Math.abs((await floating.boundingBox()).y - touchBounds.y - touchDy) < 3, 'Touch grip moves the floating window');
  await page.screenshot({ path: path.join(dir, 'multiview-mobile.png') });
  await page.setViewportSize({ width: 1512, height: 982 }); await settled();
  await page.getByRole('button', { name: 'Collapse Multiview', exact: true }).click(); await floating.waitFor({ state: 'hidden' });
  await page.getByRole('button', { name: 'Open Multiview', exact: true }).click(); await floating.waitFor();
  await page.getByRole('button', { name: 'Open Production Studio', exact: true }).click();
  await page.getByRole('heading', { name: 'Production Studio', exact: true }).waitFor();
  await floating.waitFor({ state: 'hidden' });
  const studioCut = page.getByRole('button', { name: 'Cut', exact: true }), studioFade = page.getByRole('button', { name: 'Fade', exact: true });
  await until(() => studioCut.isEnabled(), 'Studio Take buttons ready');
  await page.locator('.scene-card').filter({ hasText: 'Red scene' }).click();
  await until(async () => (await get()).previewSceneId === 'red', 'Studio scene selection settles');
  await repeatTakeKeys(page, studioCut, 'Studio after clicking a scene');
  await studioCut.click();
  await repeatTakeKeys(page, studioCut, 'Studio after clicking Cut', ['Space', 'Shift+Space', 'Space', 'Shift+Space', 'Space', 'Shift+Space']);
  await studioFade.click();
  await repeatTakeKeys(page, studioCut, 'Studio after clicking Fade', ['Shift+Space', 'Space', 'Shift+Space', 'Space', 'Shift+Space', 'Space']);
  checks.push('floating fullscreen, header/window keys stay isolated from the underlying Presentation, mouse/touch/keyboard movement, responsive bounds, persistent channel/reload position, explicit collapse and automatic collapse on returning to Studio');

  const standalone = await context.newPage(); standalone.on('pageerror', error => errors.push(error.message)); observeTakes(standalone);
  await standalone.goto(`${base}/studio/multiview`);
  const fullBoard = standalone.getByTestId('studio-multiview'); await fullBoard.waitFor();
  await readyVideo(fullBoard.locator('.multiview-atlas > video'));
  await centerLayout(fullBoard, 'Standalone full station with three scenes');
  assert.ok(await fullBoard.locator('.multiview-scenes-scroll').evaluate(element => element.scrollHeight <= element.clientHeight + 2), 'All four scene slots fit the standalone view without scrolling');
  assert.equal(await standalone.getByTestId('floating-multiview').count(), 0, 'Standalone view does not duplicate the floating overlay');
  const standaloneCut = fullBoard.getByRole('button', { name: 'Cut in Multiview', exact: true });
  await fullBoard.getByTestId('multiview-scene-blue').click();
  await until(async () => (await get()).previewSceneId === 'blue', 'standalone scene click selects Preview');
  await repeatTakeKeys(standalone, standaloneCut, 'Standalone Multiview after clicking a scene');
  await standaloneCut.click();
  await repeatTakeKeys(standalone, standaloneCut, 'Standalone Multiview after clicking Cut');
  await fullBoard.getByRole('button', { name: 'Fade in Multiview', exact: true }).click();
  await repeatTakeKeys(standalone, standaloneCut, 'Standalone Multiview after clicking Fade', ['Shift+Space', 'Space', 'Shift+Space', 'Space', 'Shift+Space', 'Space']);
  const standaloneBefore = await get();
  await fullBoard.focus(); await standalone.keyboard.press('Control+Shift+1');
  await until(async () => { const state = await get(); return state.program.id === 'blue' && state.programTransition.id !== standaloneBefore.programTransition.id && state.previewSceneId === standaloneBefore.program.id; }, 'global configured shortcut works on standalone route');
  const fullscreenButton = standalone.getByRole('button', { name: 'Fullscreen Multiview', exact: true });
  await fullscreenButton.click(); await until(() => standalone.evaluate(() => !!document.fullscreenElement), 'standalone fullscreen button enters fullscreen');
  await centerLayout(fullBoard, 'Standalone fullscreen with three scenes');
  await repeatTakeKeys(standalone, standaloneCut, 'Standalone Multiview after clicking fullscreen', ['Space', 'Shift+Space']);
  await standalone.evaluate(() => document.exitFullscreen()); await until(() => standalone.evaluate(() => !document.fullscreenElement), 'exit fullscreen');
  await fullscreenButton.waitFor(); // Wait for the fullscreenchange/Vue state too.
  await fullBoard.focus(); await standalone.keyboard.press('f');
  await until(() => standalone.evaluate(() => !!document.fullscreenElement), 'F enters fullscreen in standalone');
  await standalone.evaluate(() => document.exitFullscreen());
  await fullscreenButton.waitFor();
  await standalone.screenshot({ path: path.join(dir, 'multiview-standalone.png') });

  // Fullscreen is a control station rather than a larger floating card. Keep
  // the main buses edge-to-edge and the smaller scene grid beneath them at
  // common display sizes; only the narrow layout returns to compact columns.
  for (const viewport of [{ width: 1920, height: 1080 }, { width: 1280, height: 720 }]) {
    await standalone.setViewportSize(viewport); await settled(standalone);
    await fullscreenButton.click(); await until(() => standalone.evaluate(() => !!document.fullscreenElement), 'resized standalone enters fullscreen');
    await centerLayout(fullBoard, `Fullscreen ${viewport.width}×${viewport.height}`);
    await standalone.screenshot({ path: path.join(dir, `multiview-fullscreen-${viewport.width}x${viewport.height}.png`) });
    await standalone.evaluate(() => document.exitFullscreen()); await fullscreenButton.waitFor();
  }
  await standalone.setViewportSize({ width: 2560, height: 720 }); await settled(standalone);
  await fullscreenButton.click(); await until(() => standalone.evaluate(() => !!document.fullscreenElement), 'wide short standalone enters fullscreen');
  const wideLayout = await centerLayout(fullBoard, 'Fullscreen wide/short 2560×720', { nativeAspect: false });
  assert.ok(wideLayout.shelfHeight >= 100, 'A wide/short display reserves a usable scene shelf instead of letting the main buses consume the entire height');
  assert.ok(wideLayout.board.bottom <= 722, 'Wide/short fullscreen station stays within the display height');
  await standalone.screenshot({ path: path.join(dir, 'multiview-fullscreen-wide-short.png') });
  await standalone.evaluate(() => document.exitFullscreen()); await fullscreenButton.waitFor();
  await standalone.setViewportSize({ width: 1512, height: 982 });
  const extraScenes = [
    { id: 'yellow', name: 'Yellow scene', background: '#d5ac20', layers: [] },
    { id: 'magenta', name: 'Magenta scene', background: '#a940ba', layers: [] },
    { id: 'cyan', name: 'Cyan scene', background: '#2fb9c4', layers: [] },
  ];
  const expectedColors = { red: [213, 42, 48], green: [32, 182, 106], blue: [36, 92, 219], yellow: [213, 172, 32], magenta: [169, 64, 186], cyan: [47, 185, 196] };
  for (const added of [2, 3]) {
    await save(state => { state.scenes = [...baseline.scenes, ...extraScenes.slice(0, added)]; });
    const count = 3 + added;
    await until(async () => await fullBoard.locator('[data-scene-id]').count() === count, `${count} scenes arrive in standalone`);
    assert.equal(await fullBoard.getByTestId('multiview-empty-slot').count(), count % 2, 'Odd scene counts keep exactly one non-interactive paired slot');
    await centerLayout(fullBoard, `Standalone ${count} scenes`, { scrollFree: false });
    for (const [id, rgb] of Object.entries(expectedColors).slice(0, count)) {
      await until(async () => { const pixel = await renderedScenePixel(fullBoard, id); return pixel && pixel.every((value, index) => Math.abs(value - rgb[index]) < 25); }, `${count}-scene reflow preserves the ${id} source crop without stretching a different atlas tile`);
    }
    await standalone.screenshot({ path: path.join(dir, `multiview-standalone-${count}-scenes.png`) });
  }
  assert.equal(await fullBoard.locator('.multiview-atlas > video').count(), 1, 'The four-column six-scene grid still uses one shared two-column transport');
  assert.deepEqual(await fullBoard.locator('.multiview-atlas > video').evaluate(element => ({ muted: element.muted, audio: element.srcObject.getAudioTracks().length })),
    { muted: true, audio: 0 }, 'Client scene-grid reflow does not create audio playback');
  await standalone.setViewportSize({ width: 390, height: 844 }); await settled(standalone);
  assert.equal(await fullBoard.locator('.multiview-scene-grid').evaluate(element => getComputedStyle(element).gridTemplateColumns.split(' ').length), 2, 'A narrow standalone display keeps two readable scene columns');
  assert.ok(await standalone.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 2), 'Narrow standalone controls and scene grid never overflow horizontally');
  assert.ok(await fullBoard.getByRole('button', { name: 'Cut in Multiview', exact: true }).isVisible(), 'Cut remains available on narrow screens');
  assert.ok(await fullBoard.getByRole('button', { name: 'Fade in Multiview', exact: true }).isVisible(), 'Fade remains available on narrow screens');
  await standalone.screenshot({ path: path.join(dir, 'multiview-standalone-narrow.png') });
  await save(state => { state.scenes = baseline.scenes; });
  await standalone.close();
  checks.push('fullscreen and standalone Center controls span the width with equal large buses, center Cut/Fade rail and smaller four-column scene grid; 1080p/720p and narrow layouts, five/six scene padding, and real client canvas crops verified with one silent atlas transport');

  const anonymous = await browser.newContext(), anonymousPage = await anonymous.newPage();
  await anonymousPage.goto(`${base}/studio/multiview`);
  await anonymousPage.getByRole('heading', { name: 'Sign in to your station', exact: true }).waitFor();
  assert.equal(await anonymousPage.getByTestId('studio-multiview').count(), 0, 'Anonymous standalone visitors see sign-in, not private operator feeds');
  await anonymous.close();
  const created = await request.post(`${base}/api/users`, { data: { username: 'multiview-viewer', password: 'test-password', displayName: 'Multiview viewer' } });
  assert.equal(created.status(), 200, await created.text());
  const viewer = await browser.newContext();
  assert.equal((await viewer.request.post(`${base}/api/auth/login`, { data: { username: 'multiview-viewer', password: 'test-password' } })).status(), 200);
  const viewerPage = await viewer.newPage(); await viewerPage.goto(`${base}/studio/multiview`);
  await until(async () => await viewerPage.getByText(/author or owner|Studio access|Multiview access/).count() > 0, 'unauthorized account sees access explanation');
  assert.equal(await viewerPage.getByTestId('studio-multiview').count(), 0, 'Non-authors cannot access the scene switcher');
  const unauthorizedBefore = await get(); await viewerPage.keyboard.press('Control+Shift+1'); await stable(unauthorizedBefore.revision, 'Unauthorized keyboard input cannot Take');
  await viewer.close();
  checks.push('Studio and standalone repeated physical Space after scene/Cut/Fade/fullscreen clicks need no refocus; independent URL, configured shortcut parity, fullscreen button/F, anonymous sign-in and non-author access protection');

  assert.ok(await measureAudio(output) > .02, 'Main audio reaches final Program after the complete workflow');
  assert.deepEqual((await get()).outputs, baseline.outputs, 'Pinned output routing and snapshot remain untouched end to end');
  assert.deepEqual(errors, [], 'No browser runtime errors');
  assert.equal((await request.post(`${base}/api/studio/engine/stop`)).status(), 200);
  console.log(JSON.stringify({ ok: true, checks, artifacts: dir }, null, 2));
} catch (error) {
  if (page && !page.isClosed()) await page.screenshot({ path: path.join(dir, 'multiview-failure.png'), fullPage: true }).catch(() => {});
  console.error(JSON.stringify({ artifacts: dir, completed: checks }, null, 2));
  console.error(logs); throw error;
} finally {
  await browser?.close();
  if (server.exitCode === null && server.signalCode === null) {
    const exited = new Promise(resolve => server.once('exit', resolve)); server.kill('SIGTERM'); await exited;
  }
}
