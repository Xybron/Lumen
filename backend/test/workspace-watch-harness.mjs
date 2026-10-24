// Disposable local stations and relay only. Workspace IDs come from the caller's
// real QA memberships; credentials never come from a production station.
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import net from 'node:net';
import { randomBytes } from 'node:crypto';
import { spawn, execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import ffmpeg from 'ffmpeg-static';
import { createWatchRelay } from '../../watch-relay/server.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const canonical = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const reservePort = () => new Promise((resolve, reject) => {
  const server = net.createServer(); server.once('error', reject);
  server.listen(0, '127.0.0.1', () => { const port = server.address().port; server.close(error => error ? reject(error) : resolve(port)); });
});
async function until(fn, label, timeout = 45000) {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) { if (await fn()) return; await new Promise(resolve => setTimeout(resolve, 150)); }
  throw new Error(`Timed out: ${label}`);
}
async function stopChild(child) {
  if (!child || child.exitCode !== null || child.signalCode !== null) return;
  const finished = new Promise(resolve => child.once('exit', resolve)); child.kill('SIGTERM');
  let timer; await Promise.race([finished, new Promise(resolve => { timer = setTimeout(resolve, 8000); })]); clearTimeout(timer);
  if (child.exitCode === null && child.signalCode === null) { child.kill('SIGKILL'); await finished; }
}
const colorIs = (bytes, index) => index === 0 ? bytes[0] > bytes[2] * 2 && bytes[0] > 100 : bytes[2] > bytes[0] * 2 && bytes[2] > 100;
async function decodedColor(page, index) {
  return page.locator('video').evaluate((video, index) => {
    if (video.readyState < 2 || !video.videoWidth || video.paused) return false;
    const canvas = document.createElement('canvas'); canvas.width = canvas.height = 1;
    const context = canvas.getContext('2d'); context.drawImage(video, 0, 0, 1, 1);
    const [r, g, b] = context.getImageData(0, 0, 1, 1).data;
    return index === 0 ? r > b * 2 && r > 100 : b > r * 2 && b > 100;
  }, index);
}
async function audioFrequency(page) {
  return page.locator('video').evaluate(async video => {
    const audio = new AudioContext(), source = audio.createMediaElementSource(video), analyser = audio.createAnalyser(), silent = audio.createGain();
    analyser.fftSize = 8192; silent.gain.value = 0; source.connect(analyser); analyser.connect(silent); silent.connect(audio.destination);
    video.muted = false; await audio.resume(); await video.play();
    const bins = new Float32Array(analyser.frequencyBinCount); let frequency = 0, loudest = -Infinity;
    for (let frame = 0; frame < 8; frame++) {
      await new Promise(resolve => setTimeout(resolve, 100)); analyser.getFloatFrequencyData(bins);
      for (let at = 1; at < bins.length; at++) if (bins[at] > loudest) { loudest = bins[at]; frequency = at * audio.sampleRate / analyser.fftSize; }
    }
    video.muted = true; source.disconnect(); analyser.disconnect(); silent.disconnect(); await audio.close();
    return { frequency, loudest };
  });
}

export async function createWorkspaceWatchHarness({ workspaceIds, browser }) {
  assert.ok(Array.isArray(workspaceIds) && workspaceIds.length === 2 && workspaceIds.every(id => canonical.test(id)) && workspaceIds[0] !== workspaceIds[1], 'Two distinct canonical QA workspace IDs are required.');
  assert.ok(browser, 'Pass the isolated test browser.');
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'lumen-real-workspace-watch-'));
  const tenants = workspaceIds.map(workspaceId => ({ workspaceId, pushToken: randomBytes(48).toString('hex'), viewerToken: randomBytes(48).toString('hex'), allowedSlugs: ['live', 'program'], privateSlugs: ['program'] }));
  const contexts = [], children = [], stations = [], logs = [];
  let relay, closed = false;
  async function close() {
    if (closed) return; closed = true;
    for (const station of stations) {
      await station.request.post(`${station.base}/api/studio/broadcast/stop`, { data: {} }).catch(() => {});
      await station.request.post(`${station.base}/api/studio/engine/stop`, { data: {} }).catch(() => {});
    }
    for (const child of children) await stopChild(child);
    for (const context of contexts) await context.close().catch(() => {});
    await relay?.close().catch(() => {});
    await fs.rm(directory, { recursive: true, force: true });
  }
  try {
    relay = await createWatchRelay({ dataDir: path.join(directory, 'relay'), tenants, allowInsecureLocalhostForTests: true });
    await new Promise(resolve => relay.server.listen(0, '127.0.0.1', resolve));
    const relayBase = `http://127.0.0.1:${relay.server.address().port}`;
    for (let index = 0; index < 2; index++) {
      const tenant = tenants[index], stationDirectory = path.join(directory, `station-${index}`), port = await reservePort();
      const base = `http://127.0.0.1:${port}`;
      await fs.mkdir(path.join(stationDirectory, 'media', 'music'), { recursive: true });
      execFileSync(ffmpeg, ['-hide_banner', '-loglevel', 'error', '-f', 'lavfi', '-i', `sine=frequency=${index === 0 ? 440 : 660}:sample_rate=48000`, '-t', '20', '-c:a', 'pcm_s16le', path.join(stationDirectory, 'media', 'music', 'main.wav')]);
      const env = { ...process.env };
      for (const key of Object.keys(env)) if (/^(?:LUMEN_|VITE_|SUPABASE_|POWERSYNC_)/.test(key)) delete env[key];
      Object.assign(env, { NODE_ENV: 'test', HOST: '127.0.0.1', PORT: String(port), LUMEN_DATA_DIR: stationDirectory, LUMEN_WORKSPACE_ID: tenant.workspaceId, LUMEN_TEAM_LOCAL_TEST: 'true' });
      // All keys enter over private child IPC, never argv/environment or logs.
      const bootstrap = `
        const config = await new Promise(resolve => process.once('message', resolve));
        const {startLumenServer} = await import(${JSON.stringify(new URL('../dist/server.js', import.meta.url).href)});
        const {createBroadcastRelay,createProtectedOutputRelay,createWatchRelayFanout} = await import(${JSON.stringify(new URL('../dist/broadcast-relay.js', import.meta.url).href)});
        const options={baseUrl:config.relayBase,workspaceId:config.workspaceId,token:config.pushToken,allowLocalhostForTests:true,timeoutMs:3000};
        const primary=createBroadcastRelay({...options,slug:'live'});
        const secondary=createProtectedOutputRelay({...options,slug:'program',viewerToken:config.viewerToken});
        const server=await startLumenServer({port:config.port,host:'127.0.0.1',development:false,productionDependencies:{watchRelay:createWatchRelayFanout(primary,secondary)}});
        let closing=false;const stop=()=>{if(closing)return;closing=true;void server.close().finally(()=>process.exit(0));setTimeout(()=>process.exit(1),7000).unref();};
        process.once('SIGTERM',stop);process.once('SIGINT',stop);process.once('disconnect',stop);process.send?.({ready:true});
      `;
      const child = spawn(process.execPath, ['--input-type=module', '-e', bootstrap], { cwd: root, env, stdio: ['ignore', 'pipe', 'pipe', 'ipc'] }); children.push(child);
      const log = { text: '' }; logs.push(log);
      for (const stream of [child.stdout, child.stderr]) stream.on('data', bytes => { if (log.text.length < 24000) log.text += bytes.toString(); });
      child.send({ relayBase, workspaceId: tenant.workspaceId, pushToken: tenant.pushToken, viewerToken: tenant.viewerToken, port });
      await until(async () => { if (child.exitCode !== null) throw new Error('Disposable workspace station stopped during startup.'); try { return (await fetch(`${base}/api/workspace`)).ok; } catch { return false; } }, 'disposable provisioned station startup');
      const operator = await browser.newContext(); contexts.push(operator); const request = operator.request;
      assert.equal((await request.post(`${base}/api/auth/login`, { data: { username: 'admin', password: 'admin' } })).status(), 200);
      const identity = await (await request.get(`${base}/api/workspace`)).json(); assert.equal(identity.id, tenant.workspaceId); assert.equal(identity.mode, 'provisioned');
      const state = await (await request.get(`${base}/api/studio`)).json();
      state.sources = [{ id: 'main', name: `QA Main ${index + 1}`, kind: 'audio', url: 'media/music/main.wav', loop: true, audio: { volume: .6, muted: true, mode: 'follow', delayMs: 0 } }];
      state.scenes = [{ id: 'program_scene', name: `QA Workspace ${index + 1}`, background: index === 0 ? '#bb202b' : '#204fbb', layers: [] }];
      state.previewSceneId = 'program_scene'; state.program = null; state.mainAudioSourceId = null; state.masterVolume = 1; state.masterMuted = false;
      assert.equal((await request.put(`${base}/api/studio`, { data: state })).status(), 200);
      const command = async command => { const document = await (await request.get(`${base}/api/studio`)).json(); const response = await request.post(`${base}/api/studio/command`, { data: { revision: document.revision, command } }); assert.equal(response.status(), 200); };
      await command({ type: 'set-main-audio', sourceId: 'main' }); await command({ type: 'take', sceneId: 'program_scene' });
      const station = { workspaceId: tenant.workspaceId, base, request, watchUrl: `${relayBase}/watch/${tenant.workspaceId}/live`, privateUrl: `${relayBase}/output/${tenant.workspaceId}/program#key=${tenant.viewerToken}` };
      stations.push(station);
    }
    async function runChecks() {
      const checks = [], viewers = [];
      for (let index = 0; index < stations.length; index++) {
        const station = stations[index];
        assert.equal((await station.request.post(`${station.base}/api/studio/engine/start`, { data: {} })).status(), 200);
        await until(async () => { const status = await (await station.request.get(`${station.base}/api/studio/status`)).json(); return status.state === 'running' && status.fps > 0 && status.levels.master > .02; }, `workspace ${index + 1} actual Program/Main renderer`);
        assert.equal((await station.request.put(`${station.base}/api/studio/broadcast/config`, { data: { profile: '720p', recordOnStart: false, destinations: [{ id: 'facebook', enabled: false }, { id: 'youtube', enabled: false }], watch: { enabled: true } } })).status(), 200);
        const configuration = await (await station.request.get(`${station.base}/api/studio/broadcast`)).json();
        assert.equal(configuration.config.watch.publicUrl, station.watchUrl);
        assert.equal((await station.request.post(`${station.base}/api/studio/broadcast/start`, { data: { record: false } })).status(), 202);
        await until(async () => (await (await fetch(`${relayBase}/api/watch/${station.workspaceId}/live`)).json()).status === 'live', `workspace ${index + 1} real Program reaches own Watch relay`, 60000);
        const context = await browser.newContext({ viewport: { width: 960, height: 540 } }); contexts.push(context);
        const page = await context.newPage(); await page.goto(station.watchUrl);
        await until(() => decodedColor(page, index), `workspace ${index + 1} Watch decodes its own Program color`);
        const audio = await audioFrequency(page); assert.ok(audio.loudest > -70 && Math.abs(audio.frequency - (index === 0 ? 440 : 660)) < 30, 'Each Watch feed must carry its own generated Main tone, not another workspace audio.');
        const privatePage = await context.newPage(); await privatePage.goto(station.privateUrl);
        await until(() => decodedColor(privatePage, index), `workspace ${index + 1} private Program decodes its own picture`);
        assert.equal(new URL(privatePage.url()).hash, '');
        assert.equal(await privatePage.evaluate(() => document.cookie), '', 'Viewer cookie remains HttpOnly.');
        viewers.push({ context, page, privatePage });
        await page.screenshot({ path: `/private/tmp/lumen-real-workspace-watch-${index + 1}.png` });
        checks.push(`Workspace ${index + 1}: real Program and distinct Main audio reach its own public Watch link; protected Program plays its own picture.`);
      }
      assert.notEqual(stations[0].watchUrl, stations[1].watchUrl);
      for (let index = 0; index < 2; index++) {
        const other = 1 - index, wrong = tenants[index], target = tenants[other];
        const publishing = await fetch(`${relayBase}/api/push/${target.workspaceId}/live/sessions`, { method: 'POST', headers: { Authorization: `Bearer ${wrong.pushToken}` }, body: JSON.stringify({ epoch: 'cross-workspace-publish-denied' }) }); assert.equal(publishing.status, 401);
        assert.equal((await fetch(`${relayBase}/api/output/${target.workspaceId}/program/info`, { headers: { Authorization: `Bearer ${wrong.viewerToken}` } })).status, 401);
        assert.equal((await viewers[index].context.request.get(`${relayBase}/api/output/${target.workspaceId}/program/info`)).status(), 401, 'Workspace A viewer cookie cannot authorize workspace B.');
        assert.equal((await viewers[index].context.request.get(`${relayBase}/api/watch/${target.workspaceId}/program`)).status(), 401);
      }
      checks.push('Publishing keys, protected-viewer keys and real browser viewer cookies cannot authorize the other workspace.');
      const privateState = await viewers[1].context.request.get(`${relayBase}/api/watch/${stations[1].workspaceId}/program`).then(response => response.json());
      assert.equal((await viewers[0].context.request.get(relayBase + privateState.playlistUrl)).status(), 401);
      const manifest = await viewers[1].context.request.get(relayBase + privateState.playlistUrl).then(response => response.text());
      const segment = manifest.split(/\r?\n/).find(line => /^segment-/.test(line)); assert.ok(segment);
      assert.equal((await viewers[0].context.request.get(new URL(segment, relayBase + privateState.playlistUrl).href)).status(), 401);
      checks.push('Private HLS playlists and video/audio segments cannot be fetched with another workspace’s viewer session.');
      await stations[0].request.post(`${stations[0].base}/api/studio/broadcast/stop`, { data: {} });
      await until(async () => (await (await fetch(`${relayBase}/api/watch/${stations[0].workspaceId}/live`)).json()).status === 'offline', 'stopping only workspace A');
      assert.equal((await (await fetch(`${relayBase}/api/watch/${stations[1].workspaceId}/live`)).json()).status, 'live');
      assert.equal((await (await stations[1].request.get(`${stations[1].base}/api/studio/status`)).json()).state, 'running');
      assert.ok(await decodedColor(viewers[1].page, 1));
      checks.push('Ending workspace A’s stream leaves workspace B’s engine and Watch stream live.');
      for (const station of stations) {
        const state = await (await station.request.get(`${station.base}/api/studio`)).json(); assert.equal(state.mainAudioSourceId, 'main'); assert.equal(state.masterMuted, false);
        assert.equal((await (await station.request.get(`${station.base}/api/studio/status`)).json()).recording, null);
      }
      return checks;
    }
    return { relayBase, stations, runChecks, close };
  } catch (error) { await close(); throw error; }
}
