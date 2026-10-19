// Isolated service-audio test: generated tones only, no physical devices or
// operator data. Run after the integrated build has finished.
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
const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'lumen-main-audio-browser-'));
const port = Number(process.env.LUMEN_MAIN_AUDIO_TEST_PORT ?? 3428), base = `http://127.0.0.1:${port}`;
await new Promise((resolve, reject) => { const probe = net.createServer(); probe.once('error', reject); probe.listen(port, '127.0.0.1', () => probe.close(resolve)); });
await fs.mkdir(path.join(dir, 'media', 'music'), { recursive: true });
for (const [name, frequency] of [['main', 440], ['backup', 660]]) {
  execFileSync(ffmpeg, ['-hide_banner', '-loglevel', 'error', '-f', 'lavfi', '-i', `sine=frequency=${frequency}:sample_rate=48000`, '-t', '20', '-c:a', 'pcm_s16le', path.join(dir, 'media', 'music', `${name}.wav`)]);
}
let logs = '', browser, page, request;
const server = spawn(process.execPath, ['backend/dist/server.js'], { cwd: root, env: { ...process.env, PORT: String(port), HOST: '127.0.0.1', LUMEN_DATA_DIR: dir }, stdio: ['ignore', 'pipe', 'pipe'] });
server.stdout.on('data', data => { logs += data; }); server.stderr.on('data', data => { logs += data; });
async function until(fn, label, timeout = 30000) {
  const started = Date.now(); let last;
  while (Date.now() - started < timeout) {
    try { const value = await fn(); if (value) return value; } catch (error) { last = error; }
    await new Promise(resolve => setTimeout(resolve, 180));
  }
  throw new Error(`Timed out: ${label}${last ? ` (${last.message})` : ''}`);
}
async function measure(target) {
  return target.locator('video').evaluate(async video => {
    const context = new AudioContext({ sampleRate: 48000 }); await context.resume();
    const input = context.createMediaStreamSource(video.srcObject), analyser = context.createAnalyser(), silence = context.createGain();
    analyser.fftSize = 2048; silence.gain.value = 0;
    input.connect(analyser); analyser.connect(silence); silence.connect(context.destination);
    const samples = new Float32Array(2048); let peak = 0;
    for (let index = 0; index < 8; index++) {
      await new Promise(resolve => setTimeout(resolve, 50)); analyser.getFloatTimeDomainData(samples);
      for (const value of samples) peak = Math.max(peak, Math.abs(value));
    }
    input.disconnect(); analyser.disconnect(); silence.disconnect(); await context.close(); return peak;
  });
}
try {
  await until(async () => (await fetch(`${base}/api/studio`, { signal: AbortSignal.timeout(2000) })).ok, 'server start');
  browser = await chromium.launch({ executablePath: process.env.LUMEN_CHROME_PATH ?? '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome', headless: true, args: ['--autoplay-policy=no-user-gesture-required'] });
  const context = await browser.newContext({ viewport: { width: 1512, height: 982 } }); request = context.request;
  await context.addInitScript(() => {
    const NativePeer = window.RTCPeerConnection;
    window.__audioTestPeers = [];
    window.RTCPeerConnection = class extends NativePeer {
      constructor(...args) { super(...args); window.__audioTestPeers.push(this); }
    };
  });
  assert.equal((await request.post(`${base}/api/auth/login`, { data: { username: 'admin', password: 'admin' } })).status(), 200);
  const get = async () => (await request.get(`${base}/api/studio`)).json();
  const status = async () => (await request.get(`${base}/api/studio/status`)).json();
  const command = async command => { const state = await get(); const response = await request.post(`${base}/api/studio/command`, { data: { revision: state.revision, command } }); assert.equal(response.status(), 200, await response.text()); return response.json(); };
  const save = async mutator => { const state = await get(); mutator(state); const response = await request.put(`${base}/api/studio`, { data: state }); assert.equal(response.status(), 200, await response.text()); return response.json(); };
  const fixtureKinds = ['scripture', 'lyrics', 'presentation'];
  const contentResponse = await request.put(`${base}/api/content`, { data: { version: 2, updatedAt: new Date().toISOString(), settings: { transitionMs: 0 }, music: { mode: 'off' },
    channels: fixtureKinds.map(kind => ({ id: `channel_${kind}`, name: kind, kind, playlistId: `playlist_${kind}`, defaultMode: 'manual' })),
    playlists: fixtureKinds.map(kind => ({ id: `playlist_${kind}`, name: kind, items: [] })) } });
  assert.equal(contentResponse.status(), 200, await contentResponse.text());
  const audio = id => ({ id, name: id === 'main' ? 'Service mixer' : 'Backup feed', kind: 'audio', url: `media/music/${id}.wav`, loop: true, audio: { volume: .6, muted: true, mode: 'follow', delayMs: 0 } });
  await save(state => {
    state.sources = [audio('main'), audio('backup'), { id: 'disconnected', name: 'Disconnected microphone', kind: 'microphone', loop: false, audio: { volume: 1, muted: true, mode: 'follow', delayMs: 0 } },
      ...fixtureKinds.map(kind => ({ id: `source_${kind}`, name: `${kind} channel`, kind: 'channel', channelId: `channel_${kind}`, loop: false, audio: { volume: 1, muted: true, mode: 'follow', delayMs: 0 } }))];
    state.scenes = [{ id: 'camera', name: 'Camera scene', background: '#123d33', layers: [] }, { id: 'scripture', name: 'Scripture scene', background: '#25244b', layers: [] }];
    state.previewSceneId = 'camera'; state.masterMuted = false; state.masterVolume = 1;
    state.outputs[0].audioEnabled = false; state.outputs[1].audioEnabled = true;
  });
  await command({ type: 'take', sceneId: 'camera' });
  await command({ type: 'route', outputId: 'screen_broadcast', sceneId: 'scripture' });
  // A station may already have selected a channel before it became text-only.
  // Keep the choice visible as a disabled warning, not a silent auto-fallback.
  await command({ type: 'set-main-audio', sourceId: 'source_scripture' });
  page = await context.newPage(); const errors = []; page.on('pageerror', error => errors.push(error.message));
  await page.goto(`${base}/studio`); await page.getByTestId('output-audio-control').waitFor();
  const sourceRow = id => page.locator(`.source-list .source-row[data-source-id="${id}"]`);
  async function checkSourcesMain(sourceId, { state = 'ready', returnToMixer = true } = {}) {
    await page.getByRole('button', { name: /^Sources/ }).click();
    await until(async () => await page.getByTestId('source-main-audio-badge').count() === (sourceId ? 1 : 0), 'Sources show exactly the selected Main badge');
    if (sourceId) {
      const badge = sourceRow(sourceId).getByTestId('source-main-audio-badge');
      const labels = { ready: 'Main', muted: 'Main · Muted', disconnected: 'Main · Disconnected', error: 'Main · Error', offline: 'Main · Offline', loading: 'Main · Connecting', paused: 'Main · Paused', 'no-audio': 'Main · No audio' };
      await until(async () => await badge.getAttribute('data-state') === state && (await badge.textContent()).trim() === labels[state], `Sources Main badge shows ${state}`);
      assert.equal(await badge.evaluate(element => element.tagName), 'SPAN', 'Main status is a read-only badge, not a button');
    }
    assert.equal(await page.getByRole('button', { name: /^Set .+ as Main audio$/ }).count(), 0, 'Source rows never contain Main selection controls');
    assert.equal(await page.getByRole('button', { name: 'Clear Main audio', exact: true }).count(), 0, 'Sources badge is read-only, not a duplicate clear control');
    if (returnToMixer) await page.getByRole('button', { name: 'Audio mixer', exact: true }).click();
  }
  assert.equal(await page.getByLabel('Main audio source', { exact: true }).count(), 0, 'The bulky Main audio selector is removed');
  assert.equal(await page.getByTestId('main-audio-control').count(), 0, 'Sources do not lose space to a Main audio block');
  assert.equal(await page.getByRole('button', { name: /^Set .+ as Main audio$/ }).count(), 0, 'Main selection belongs only to the mixer');
  const footerHeight = (await page.getByTestId('output-audio-control').boundingBox()).height;
  assert.ok(footerHeight < 64, `Output footer stays compact (${footerHeight}px)`);
  const sourceListHeight = (await page.locator('.source-audio-panel .source-list').boundingBox()).height;
  assert.ok(sourceListHeight >= 165, `Sources reclaim the removed selector's space (${sourceListHeight}px)`);
  await page.locator('.source-audio-panel').scrollIntoViewIfNeeded();
  await checkSourcesMain('source_scripture', { state: 'no-audio' });
  await page.getByRole('button', { name: 'Audio mixer', exact: true }).click();
  await page.getByTestId('main-audio-status').getByText('scripture channel is text-only. Choose an audio input as Main.', { exact: true }).waitFor();
  assert.equal((await get()).mainAudioSourceId, 'source_scripture');
  assert.equal(await page.getByRole('button', { name: 'Set scripture channel as Main audio', exact: true }).count(), 0, 'Scripture cannot be chosen as audio');
  assert.equal(await page.getByRole('button', { name: 'Set lyrics channel as Main audio', exact: true }).count(), 0, 'Lyrics cannot be chosen as audio');
  assert.equal(await page.getByRole('button', { name: 'Set presentation channel as Main audio', exact: true }).count(), 1, 'Presentation media remains eligible');
  await page.getByRole('button', { name: 'Clear Main audio', exact: true }).click();
  await until(async () => (await get()).mainAudioSourceId === null && await page.getByTestId('main-audio-status').count() === 0, 'Explicitly clear legacy text-only choice');
  await checkSourcesMain(null);
  await page.getByRole('button', { name: 'Start engine', exact: true }).click();
  await until(async () => (await status()).state === 'running', 'engine start');
  await until(async () => (await status()).levels.master === 0, 'all new sources silent');
  await page.getByRole('button', { name: 'Set Service mixer as Main audio', exact: true }).click();
  await until(async () => (await get()).mainAudioSourceId === 'main' && (await status()).levels.master > .02, 'selecting main routes follow-scene audio outside the picture');
  const mixerRow = id => page.locator(`[data-testid="audio-mixer-source"][data-source-id="${id}"]`);
  await mixerRow('main').getByTestId('main-audio-badge').waitFor();
  await page.getByRole('button', { name: /^Sources/ }).click();
  assert.equal(await page.getByRole('button', { name: /^Set .+ as Main audio$/ }).count(), 0, 'Source rows stay free of duplicate main selectors');
  assert.equal(await page.getByTestId('output-audio-control').isVisible(), true, 'Output volume and mute remain available in Sources');
  assert.equal((await get()).mainAudioSourceId, 'main', 'Selection survives tab switching');
  await checkSourcesMain('main', { returnToMixer: false });
  await page.screenshot({ path: path.join(dir, 'main-audio-sources.png'), fullPage: true });
  await page.getByRole('button', { name: 'Audio mixer', exact: true }).click();
  await mixerRow('main').getByTestId('main-audio-badge').waitFor();
  const baseline = (await status()).levels.master;
  // Hold the replacement command while the old feed is muted. The old
  // source-specific Unmute control must not queue a stale unmute behind it.
  await page.getByRole('button', { name: 'Mute Service mixer', exact: true }).click();
  await until(async () => (await get()).sources.find(source => source.id === 'main').audio.muted && await page.getByRole('button', { name: 'Unmute Service mixer', exact: true }).isEnabled(), 'main input muted before handoff');
  await checkSourcesMain('main', { state: 'muted', returnToMixer: false });
  await page.screenshot({ path: path.join(dir, 'main-audio-sources-muted.png'), fullPage: true });
  await page.getByRole('button', { name: 'Audio mixer', exact: true }).click();
  await page.getByRole('button', { name: 'Unmute Service mixer', exact: true }).click();
  await until(async () => !(await get()).sources.find(source => source.id === 'main').audio.muted && (await status()).levels.master > .02, 'Main recovers after source unmute');
  await checkSourcesMain('main');
  await page.getByRole('button', { name: 'Mute Service mixer', exact: true }).click();
  await until(async () => (await get()).sources.find(source => source.id === 'main').audio.muted && await page.getByRole('button', { name: 'Unmute Service mixer', exact: true }).isEnabled(), 'main muted again for guarded handoff');
  let releaseReplacement;
  const replacementGate = new Promise(resolve => { releaseReplacement = resolve; });
  let replacementHeld = false;
  const replacementRoute = async route => {
    const data = route.request().postDataJSON();
    if (data.command?.type === 'set-main-audio' && data.command.sourceId === 'backup') { replacementHeld = true; await replacementGate; }
    await route.continue();
  };
  await page.route('**/api/studio/command', replacementRoute);
  await page.getByRole('button', { name: 'Set Backup feed as Main audio', exact: true }).click();
  await until(() => replacementHeld, 'replacement held in flight');
  const previousUnmute = page.getByRole('button', { name: 'Unmute Service mixer', exact: true });
  assert.equal(await previousUnmute.isDisabled(), true, 'Mute controls disable during feed replacement');
  await previousUnmute.evaluate(button => button.dispatchEvent(new MouseEvent('click', { bubbles: true }))); // Also exercise the handler guard.
  releaseReplacement();
  await until(async () => (await get()).mainAudioSourceId === 'backup' && await page.getByRole('button', { name: 'Set Service mixer as Main audio', exact: true }).isEnabled(), 'replacement committed');
  assert.equal((await get()).sources.find(source => source.id === 'main').audio.muted, true, 'Previous main cannot be re-unmuted by a stale control');
  await page.unroute('**/api/studio/command', replacementRoute);
  await checkSourcesMain('backup');
  await page.getByRole('button', { name: 'Set Service mixer as Main audio', exact: true }).click();
  await until(async () => (await get()).mainAudioSourceId === 'main' && (await status()).levels.master > .02, 'main restored after guarded handoff');
  const outputPage = async outputId => { const output = await context.newPage(); await output.goto(`${base}/studio/output/${outputId}`); await until(() => output.locator('video').evaluate(video => video.readyState >= 2 && video.videoWidth > 0 && video.srcObject?.getAudioTracks().length > 0), `${outputId} video and audio stream`); return output; };
  const program = await outputPage('program'), pinned = await outputPage('screen_broadcast'), projector = await outputPage('screen_main'), preview = await outputPage('preview');
  // A running compositor/audio meter does not prove an output is connected.
  // Check actual ICE transport and received packets, without granting capture
  // permissions or changing the ordinary viewer's mDNS/privacy settings.
  const outputTransport = target => target.evaluate(async () => {
    const peer = window.__audioTestPeers.findLast(peer => peer.connectionState === 'connected');
    if (!peer) return null;
    const stats = await peer.getStats(), received = [], pairs = [];
    stats.forEach(stat => { if (stat.type === 'inbound-rtp') received.push(stat); if (stat.type === 'candidate-pair' && stat.state === 'succeeded') pairs.push(stat); });
    return { connection: peer.connectionState, received: received.map(stat => ({ kind: stat.kind, bytes: stat.bytesReceived, frames: stat.framesDecoded })),
      candidates: pairs.map(pair => ({ local: stats.get(pair.localCandidateId)?.address, remote: stats.get(pair.remoteCandidateId)?.address })),
      offeredHostnames: peer.remoteDescription?.sdp.match(/^a=candidate:.*\.local.*$/gm) ?? [] };
  });
  const transports = {};
  for (const [id, output] of [['program', program], ['screen_broadcast', pinned], ['screen_main', projector], ['preview', preview]]) {
    transports[id] = await until(async () => {
      const data = await outputTransport(output);
      return data?.candidates.length && data.received.some(track => track.kind === 'audio' && track.bytes > 0)
        && data.received.some(track => track.kind === 'video' && track.frames > 0) ? data : null;
    }, `${id} succeeds ICE and decodes real video/audio packets`);
    assert.deepEqual(transports[id].offeredHostnames, [], 'Managed renderer offers directly reachable host candidates, not unresolved mDNS names');
  }
  await fs.writeFile(path.join(dir, 'output-transports.json'), JSON.stringify(transports, null, 2));
  assert.ok(await measure(program) > .02, 'Program receives actual main audio');
  assert.ok(await measure(pinned) > .02, 'Pinned picture receives main audio without a source layer');
  assert.ok(await measure(projector) < .0001, 'Silent projector remains silent');
  assert.ok(await measure(preview) < .0001, 'Preview remains silent');
  for (const [sceneId, transition] of [['scripture', 'cut'], ['camera', 'fade'], ['scripture', 'fade']]) {
    const outgoingId = (await get()).program.id;
    await command({ type: 'take', sceneId, transition, durationMs: 700, swapPreview: true });
    for (let sample = 0; sample < 4; sample++) { assert.ok((await status()).levels.master > .02, 'Scene transitions retain service audio'); await new Promise(resolve => setTimeout(resolve, 100)); }
    assert.equal((await get()).mainAudioSourceId, 'main', 'Scene switching never changes the selected Main audio');
    assert.equal((await get()).previewSceneId, outgoingId, 'Swapping returns the outgoing scene to Preview without interrupting Main');
    await mixerRow('main').getByTestId('main-audio-badge').waitFor();
  }
  // Adding the selected main as a scene layer must not sum a second audio copy.
  await save(state => { state.scenes[0].layers.push({ id: 'audio_layer', name: 'Same main feed', kind: 'source', sourceId: 'main', visible: true, locked: false, x: 0, y: 0, width: 100, height: 100, opacity: 1, fit: 'cover', text: '', color: '#ffffff', background: '#00000000', fontSize: 48, fontWeight: 500, align: 'left', radius: 0 }); });
  await command({ type: 'take', sceneId: 'camera' });
  await until(async () => Math.abs((await status()).levels.master - baseline) < .006, 'Main routed once even when also present as a scene layer');
  // Add through the operator UI; the new music source must remain muted.
  await page.getByRole('button', { name: 'Add production source', exact: true }).click();
  await page.getByRole('button', { name: 'Audio file', exact: true }).click();
  await page.getByLabel('Upload media').setInputFiles(path.join(dir, 'media', 'music', 'backup.wav'));
  await until(() => page.getByRole('button', { name: 'Add to Studio', exact: true }).isEnabled(), 'uploaded audio ready');
  await page.getByLabel('Name', { exact: true }).fill('Added while preaching');
  await page.getByRole('button', { name: 'Add to Studio', exact: true }).click();
  const added = await until(async () => (await get()).sources.find(source => source.name === 'Added while preaching'), 'new audio saved');
  assert.equal(added.audio.muted, true);
  assert.ok(Math.abs((await status()).levels.master - baseline) < .006, 'Uploading media does not disrupt service audio');
  await page.getByRole('button', { name: 'Audio mixer', exact: true }).click();
  // Master mute is independent, and is retained while the main feed switches.
  await page.getByRole('button', { name: 'Toggle master mute', exact: true }).click();
  await until(async () => (await status()).levels.master === 0, 'final output mute');
  await page.getByRole('button', { name: 'Set Backup feed as Main audio', exact: true }).click();
  await until(async () => (await get()).mainAudioSourceId === 'backup', 'replacement selection');
  let state = await get(); assert.equal(state.masterMuted, true); assert.equal(state.sources.find(source => source.id === 'main').audio.muted, true); assert.equal(state.sources.find(source => source.id === 'backup').audio.muted, false);
  assert.equal((await status()).levels.master, 0);
  await checkSourcesMain('backup');
  await page.getByRole('button', { name: 'Toggle master mute', exact: true }).click();
  await until(async () => (await status()).levels.master > .02, 'replacement audible after explicit master unmute');
  await page.getByRole('button', { name: 'Set Disconnected microphone as Main audio', exact: true }).click();
  await until(() => page.getByTestId('main-audio-status').getByText(/Main input disconnected\. No automatic fallback\./).isVisible(), 'disconnected feed warning');
  assert.equal((await get()).mainAudioSourceId, 'disconnected');
  await until(async () => (await status()).levels.master === 0, 'no automatic fallback');
  await checkSourcesMain('disconnected', { state: 'disconnected', returnToMixer: false });
  await page.screenshot({ path: path.join(dir, 'main-audio-sources-disconnected.png'), fullPage: true });
  // Disconnected is more important than an input's saved mute setting.
  await save(state => { state.sources.find(source => source.id === 'disconnected').audio.muted = true; });
  await checkSourcesMain('disconnected', { state: 'disconnected' });
  await page.getByRole('button', { name: 'Set Service mixer as Main audio', exact: true }).click();
  await until(async () => (await status()).levels.master > .02, 'manual reconnect selection');
  await checkSourcesMain('main');
  const recordingResponse = await request.post(`${base}/api/studio/recordings`, { data: { name: 'Persistent service audio' } });
  assert.equal(recordingResponse.status(), 201, await recordingResponse.text());
  const recording = await recordingResponse.json();
  await until(async () => (await status()).recording?.bytes > 10000, 'recording receives chunks');
  await command({ type: 'take', sceneId: 'scripture', transition: 'fade', durationMs: 700 });
  await new Promise(resolve => setTimeout(resolve, 1200));
  assert.equal((await request.post(`${base}/api/studio/recordings/${recording.id}/stop`)).status(), 200);
  await until(async () => (await (await request.get(`${base}/api/studio/recordings`)).json()).find(item => item.id === recording.id && item.status === 'complete'), 'recording finalized');
  const pcm = execFileSync(ffmpeg, ['-v', 'error', '-i', path.join(dir, 'recordings', recording.id, 'recording.webm'), '-vn', '-ac', '1', '-ar', '16000', '-f', 'f32le', 'pipe:1']);
  let peak = 0; for (let offset = 0; offset + 4 <= pcm.length; offset += 4) peak = Math.max(peak, Math.abs(pcm.readFloatLE(offset)));
  assert.ok(peak > .02, `Recording must include real main audio (peak ${peak})`);
  await page.getByRole('button', { name: 'Audio mixer', exact: true }).click();
  await mixerRow('main').scrollIntoViewIfNeeded();
  await mixerRow('main').getByTestId('main-audio-badge').waitFor();
  await page.screenshot({ path: path.join(dir, 'main-audio-desktop.png'), fullPage: true });
  await page.setViewportSize({ width: 390, height: 844 });
  const collapseInspector = page.getByRole('button', { name: 'Collapse inspector', exact: true });
  if (await collapseInspector.isVisible()) await collapseInspector.click();
  await mixerRow('main').scrollIntoViewIfNeeded();
  await page.getByRole('button', { name: 'Clear Main audio', exact: true }).click({ trial: true });
  const bounds = await mixerRow('main').boundingBox(); assert.ok(bounds.x >= 0 && bounds.x + bounds.width <= 390, 'Main mixer row fits narrow layout');
  await page.getByRole('button', { name: 'Set Backup feed as Main audio', exact: true }).click({ trial: true });
  assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth), true, 'Mixer does not add horizontal page overflow');
  await page.screenshot({ path: path.join(dir, 'main-audio-mobile.png'), fullPage: true });
  await page.getByRole('button', { name: 'Clear Main audio', exact: true }).click();
  await until(async () => { const state = await get(); return state.mainAudioSourceId === null && state.sources.find(source => source.id === 'main').audio.muted && (await status()).levels.master === 0; }, 'Clearing Main explicitly removes and mutes the selected feed');
  assert.equal(await page.getByTestId('main-audio-badge').count(), 0);
  await checkSourcesMain(null);
  await page.getByRole('button', { name: 'Set Service mixer as Main audio', exact: true }).click();
  await until(async () => (await get()).mainAudioSourceId === 'main' && (await status()).levels.master > .02, 'Main can be selected from its row on narrow screens');
  await save(state => { state.sources.find(source => source.id === 'main').name = 'Service mixer · Broadcast desk microphone with a deliberately long input name'; });
  await checkSourcesMain('main', { returnToMixer: false });
  await sourceRow('main').scrollIntoViewIfNeeded();
  const sourceBounds = await sourceRow('main').boundingBox(), badgeBounds = await sourceRow('main').getByTestId('source-main-audio-badge').boundingBox();
  assert.ok(sourceBounds.x >= 0 && sourceBounds.x + sourceBounds.width <= 390, 'Long-named source row fits narrow screens');
  assert.ok(badgeBounds.width > 15 && badgeBounds.x >= sourceBounds.x && badgeBounds.x + badgeBounds.width <= sourceBounds.x + sourceBounds.width, 'Main badge remains visible beside a truncated long name');
  assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth), true, 'Long source names and badges never introduce horizontal page overflow');
  await page.screenshot({ path: path.join(dir, 'main-audio-sources-mobile.png'), fullPage: true });
  await page.getByRole('button', { name: 'Audio mixer', exact: true }).click();
  await mixerRow('main').getByRole('button', { name: /^Mute / }).click();
  await until(async () => (await get()).sources.find(source => source.id === 'main').audio.muted, 'Long-named Main input muted on mobile');
  await checkSourcesMain('main', { state: 'muted', returnToMixer: false });
  await sourceRow('main').scrollIntoViewIfNeeded();
  await page.screenshot({ path: path.join(dir, 'main-audio-sources-muted-mobile.png'), fullPage: true });
  await save(state => { state.sources.find(source => source.id === 'disconnected').name = 'Broadcast desk · Deliberately long disconnected microphone input name'; });
  await command({ type: 'set-main-audio', sourceId: 'disconnected' });
  await checkSourcesMain('disconnected', { state: 'disconnected', returnToMixer: false });
  await sourceRow('disconnected').scrollIntoViewIfNeeded();
  const disconnectedBounds = await sourceRow('disconnected').boundingBox(), disconnectedBadgeBounds = await sourceRow('disconnected').getByTestId('source-main-audio-badge').boundingBox();
  assert.ok(disconnectedBounds.x >= 0 && disconnectedBounds.x + disconnectedBounds.width <= 390, 'Disconnected source fits narrow screens');
  assert.ok(disconnectedBadgeBounds.width > 80 && disconnectedBadgeBounds.x >= disconnectedBounds.x && disconnectedBadgeBounds.x + disconnectedBadgeBounds.width <= disconnectedBounds.x + disconnectedBounds.width, 'Long disconnected status stays fully readable beside truncated input name');
  assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth), true, 'Long disconnected badge introduces no horizontal overflow');
  await page.screenshot({ path: path.join(dir, 'main-audio-sources-disconnected-mobile.png'), fullPage: true });
  await command({ type: 'set-main-audio', sourceId: 'main' });
  await until(async () => (await status()).levels.master > .02, 'Recover selected Main audio before stopping engine');
  await checkSourcesMain('main');
  assert.equal((await request.post(`${base}/api/studio/engine/stop`)).status(), 200);
  await until(() => program.locator('video').evaluate(video => video.srcObject === null), 'open output clears its stopped renderer');
  await page.reload(); await page.getByTestId('output-audio-control').waitFor();
  await checkSourcesMain('main', { state: 'offline' });
  await page.getByRole('button', { name: 'Audio mixer', exact: true }).click();
  await mixerRow('main').getByTestId('main-audio-badge').waitFor();
  assert.equal((await get()).mainAudioSourceId, 'main', 'Main selection persists across controller reload and engine stop');
  assert.equal((await request.post(`${base}/api/studio/engine/start`)).status(), 200);
  for (const [id, output] of [['program', program], ['screen_broadcast', pinned], ['screen_main', projector], ['preview', preview]]) {
    await until(async () => {
      const data = await outputTransport(output);
      return data?.candidates.length && data.received.some(track => track.kind === 'video' && track.frames > 0);
    }, `${id} reconnects to a restarted engine without reloading the output`);
  }
  assert.ok(await measure(program) > .02, 'Main audio recovers on the existing Program output after engine restart');
  assert.ok(await measure(pinned) > .02, 'Pinned output recovers persistent Main audio after engine restart');
  assert.ok(await measure(projector) < .0001, 'Restart keeps projector audio disabled');
  assert.ok(await measure(preview) < .0001, 'Restart keeps Preview silent');
  assert.equal((await get()).mainAudioSourceId, 'main');
  for (const output of [program, pinned, projector, preview]) await output.close();
  assert.equal((await request.post(`${base}/api/studio/engine/stop`)).status(), 200);
  assert.deepEqual(errors, []);
  console.log(JSON.stringify({ result: 'PASS', artifacts: dir, baseline, recordingPeak: peak, checks: ['compact Output footer on both tabs', 'per-source mixer Main actions with tab and scene persistence', 'read-only Sources Main badge follows replacement and clear', 'Main badge states: ready, muted, disconnected, offline and text-only', 'input status independent of final output mute', 'badge recovers after unmute and healthy input selection', 'disconnected badge takes priority over saved input mute', 'single persistent route through Cut/Fade', 'Program, pinned output and recording audio', 'all outputs succeed ICE and receive actual RTP without capture permissions or mDNS resolution', 'silent Preview and projector', 'muted new uploads', 'replacement and master mute', 'in-flight switch/mute safety', 'text-only channels excluded with legacy warning', 'no fallback on disconnect', '390px mixer and long-named source status badges without overflow', 'selection persists after reload and engine stop', 'all open outputs automatically reconnect and recover correct audio after engine restart'] }, null, 2));
} catch (error) {
  await page?.screenshot({ path: path.join(dir, 'failure.png'), fullPage: true }).catch(() => {});
  const diagnostics = {
    renderer: await request?.get(`${base}/api/studio/diagnostics`).then(response => response.json()).catch(() => null),
    pages: await Promise.all((browser?.contexts().flatMap(context => context.pages()) ?? []).map(async target => ({
      url: target.url(),
      media: await target.evaluate(async () => ({
        videos: [...document.querySelectorAll('video')].map(video => ({ readyState: video.readyState, width: video.videoWidth, paused: video.paused, tracks: video.srcObject?.getTracks().map(track => ({ kind: track.kind, muted: track.muted, state: track.readyState })) })),
        peers: await Promise.all((window.__audioTestPeers ?? []).map(async peer => {
          const stats = []; (await peer.getStats()).forEach(stat => { if (['inbound-rtp', 'candidate-pair', 'transport'].includes(stat.type)) stats.push(stat); });
          return { connection: peer.connectionState, ice: peer.iceConnectionState, signaling: peer.signalingState, local: peer.localDescription, remote: peer.remoteDescription, stats };
        })),
      })).catch(() => null),
    }))),
  };
  await fs.writeFile(path.join(dir, 'failure-diagnostics.json'), JSON.stringify(diagnostics, null, 2));
  console.error(error); console.error(logs); console.error(`Artifacts: ${dir}`); process.exitCode = 1;
} finally {
  await browser?.close(); server.kill('SIGTERM');
  await Promise.race([new Promise(resolve => server.once('exit', resolve)), new Promise(resolve => setTimeout(resolve, 6000))]);
}
