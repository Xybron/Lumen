// Disposable-station integration of capture -> local ASR protocol -> Scripture
// publication -> public channel mirror. The only audio is a generated oscillator;
// the worker is deterministic and never loads a real model or physical input.
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import net from 'node:net';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright-core';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'lumen-scripture-auto-'));
const port = Number(process.env.LUMEN_SCRIPTURE_AUTO_TEST_PORT ?? 3458), base = `http://127.0.0.1:${port}`;
await new Promise((resolve, reject) => { const probe = net.createServer(); probe.once('error', reject); probe.listen(port, '127.0.0.1', () => probe.close(resolve)); });
let server, browser, page, logs = '';
const checks = [], errors = [], results = [], changes = [], nativeDialogs = [];
const phrase = 'The faithful shepherd guides the gathered people beside the peaceful river and restores their weary souls with enduring kindness.';
const verses = [
  { book: 43, chapter: 3, verse: 16, text: 'The people gathered in the quiet valley where the messenger prepared generous gifts and a lasting promise of peace.' },
  { book: 43, chapter: 3, verse: 17, text: 'The messenger carried words of mercy across distant mountains and brought each village a promise of renewed hope.' },
  { book: 43, chapter: 3, verse: 18, text: 'Every morning the watchman opened the eastern gate and called the waiting travellers to enter the city in peace.' },
  { book: 45, chapter: 8, verse: 28, text: 'The patient gardener waited through the gentle rain until a new harvest filled the fields with golden grain.' },
  { book: 19, chapter: 23, verse: 1, text: phrase },
  { book: 19, chapter: 23, verse: 2, text: 'The pilgrim found a shaded garden where clear water flowed beside flowering trees beneath the peaceful evening sky.' },
];
async function until(fn, label, timeout = 18000) {
  const end = Date.now() + timeout; let last;
  while (Date.now() < end) {
    try { const value = await fn(); if (value) return value; } catch (error) { last = error; }
    await new Promise(resolve => setTimeout(resolve, 60));
  }
  throw new Error(`Timed out: ${label}${last ? ` (${last.message})` : ''}`);
}
const layer = (id, patch = {}) => ({ id, name: id, kind: 'shape', visible: true, locked: false, x: 0, y: 0, width: 100, height: 100,
  opacity: 1, fit: 'cover', text: '', color: '#ffffff', background: '#00000000', fontSize: 48, fontWeight: 500, align: 'left', radius: 0, ...patch });

try {
  const modelDirectory = path.join(dir, 'ai', 'models'), worker = path.join(dir, 'fake-whisper.cjs');
  const responseFile = path.join(dir, 'worker-response.json'), workerCalls = path.join(dir, 'worker-calls.jsonl');
  await fs.mkdir(modelDirectory, { recursive: true });
  await fs.writeFile(path.join(modelDirectory, 'ggml-base.en.bin'), 'Temporary test placeholder, not a speech model.');
  await fs.writeFile(responseFile, JSON.stringify({ text: '' }));
  await fs.writeFile(worker, `#!${process.execPath}
const http=require('node:http'),fs=require('node:fs');
const args=process.argv.slice(2),port=Number(args[args.indexOf('--port')+1]);
fs.writeFileSync(${JSON.stringify(path.join(dir, 'worker-args.json'))},JSON.stringify(args));
const server=http.createServer(async(req,res)=>{
  if(req.url==='/health'){res.setHeader('content-type','application/json');res.end('{"status":"ok"}');return;}
  if(req.url!=='/inference'){res.writeHead(404).end();return;}
  const chunks=[];for await(const chunk of req)chunks.push(chunk);
  const form=await new Request('http://127.0.0.1/inference',{method:'POST',headers:req.headers,body:Buffer.concat(chunks)}).formData();
  const wav=Buffer.from(await form.get('file').arrayBuffer());
  fs.appendFileSync(${JSON.stringify(workerCalls)},JSON.stringify({fields:Object.fromEntries([...form.entries()].filter(([key])=>key!=='file')),rate:wav.readUInt32LE(24),channels:wav.readUInt16LE(22),bits:wav.readUInt16LE(34),bytes:wav.length})+'\\n');
  let response={text:''};try{response=JSON.parse(fs.readFileSync(${JSON.stringify(responseFile)},'utf8'));}catch{}
  res.setHeader('content-type','application/json');res.end(JSON.stringify({text:response.text,segments:[{text:response.text,avg_logprob:-.2,no_speech_prob:.01}]}));
});server.listen(port,'127.0.0.1');process.on('SIGTERM',()=>server.close(()=>process.exit()));
`, { mode: 0o700 });
  server = spawn(process.execPath, ['backend/dist/server.js'], { cwd: root,
    env: { ...process.env, PORT: String(port), HOST: '127.0.0.1', LUMEN_DATA_DIR: dir, LUMEN_RENDERER_URL: base, LUMEN_WHISPER_SERVER: worker, LUMEN_WHISPER_MODEL: '' }, stdio: ['ignore', 'pipe', 'pipe'] });
  server.stdout.on('data', value => { logs += value; }); server.stderr.on('data', value => { logs += value; });
  await until(async () => (await fetch(`${base}/api/studio`, { signal: AbortSignal.timeout(1500) })).ok, 'isolated station startup', 30000);
  browser = await chromium.launch({ executablePath: process.env.LUMEN_CHROME_PATH ?? '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome', headless: true,
    args: ['--autoplay-policy=no-user-gesture-required'] });
  const context = await browser.newContext({ viewport: { width: 1512, height: 982 } }), request = context.request;
  await context.addInitScript(() => {
    localStorage.setItem('lumen.listening-input.v1', JSON.stringify({ deviceId: 'synthetic', label: 'Synthetic preaching feed', processing: 'mixer' }));
    const media = navigator.mediaDevices, captures = [];
    const nativeQuery = navigator.permissions.query.bind(navigator.permissions);
    navigator.permissions.query = descriptor => descriptor.name === 'microphone' ? Promise.resolve(Object.assign(new EventTarget(), { state: 'granted' })) : nativeQuery(descriptor);
    Object.defineProperty(media, 'enumerateDevices', { value: async () => [{ deviceId: 'synthetic', groupId: 'synthetic', kind: 'audioinput', label: 'Synthetic preaching feed' }] });
    Object.defineProperty(media, 'getUserMedia', { value: async constraints => {
      const audio = new AudioContext(), oscillator = audio.createOscillator(), gain = audio.createGain(), output = audio.createMediaStreamDestination();
      oscillator.frequency.value = 173; gain.gain.value = .15; oscillator.connect(gain); gain.connect(output); oscillator.start(); await audio.resume();
      const stream = output.stream, track = stream.getAudioTracks()[0], stop = track.stop.bind(track);
      Object.defineProperty(track, 'label', { value: 'Synthetic preaching feed' });
      track.getSettings = () => ({ deviceId: 'synthetic', channelCount: 1, sampleRate: audio.sampleRate });
      track.stop = () => { if (track.readyState === 'ended') return; stop(); oscillator.stop(); void audio.close(); };
      captures.push({ track, constraints }); return stream;
    } });
    window.__scriptureAutoMedia = { active: () => captures.filter(capture => capture.track.readyState === 'live').length, calls: () => captures.map(capture => capture.constraints) };
  });
  const login = await request.post(`${base}/api/auth/login`, { data: { username: 'admin', password: 'admin' } }); assert.equal(login.status(), 200, await login.text());
  const manifest = await request.put(`${base}/api/content`, { data: { version: 2, updatedAt: new Date().toISOString(), settings: { transitionMs: 0 }, music: { mode: 'off' },
    channels: [{ id: 'scripture', name: 'Scripture', kind: 'scripture', playlistId: 'scripture_list', defaultMode: 'manual' }],
    playlists: [{ id: 'scripture_list', name: 'Scripture', items: [] }] } }); assert.equal(manifest.status(), 200, await manifest.text());
  const imported = await request.post(`${base}/api/worship/versions/import`, { data: { version: { id: 'TEST', name: 'Disposable auto-flow fixture', language: 'en', attribution: 'Synthetic test text, not an edition of Scripture.' }, verses } });
  assert.equal(imported.status(), 200, await imported.text());
  const workspace = async () => (await request.get(`${base}/api/worship/channels/scripture`)).json();
  const production = async () => (await request.get(`${base}/api/studio`)).json();
  const status = async () => (await request.get(`${base}/api/studio/status`)).json();
  const recordings = async () => (await request.get(`${base}/api/studio/recordings`)).json();
  const current = await workspace();
  const version = await request.post(`${base}/api/worship/channels/scripture/command`, { data: { revision: current.revision, command: { type: 'version', versionId: 'TEST' } } }); assert.equal(version.status(), 200, await version.text());
  const studio = await production();
  studio.sources = [
    { id: 'main', name: 'Persistent preacher feed', kind: 'microphone', loop: false, audio: { volume: .73, muted: false, mode: 'always', delayMs: 80 } },
    { id: 'camera', name: 'Camera placeholder', kind: 'camera', loop: false, audio: { volume: .4, muted: true, mode: 'follow', delayMs: 0 } },
    { id: 'scripture_feed', name: 'Scripture text', kind: 'channel', channelId: 'scripture', loop: false, audio: { volume: 0, muted: true, mode: 'follow', delayMs: 0 } },
  ];
  studio.scenes = [
    { id: 'camera_scripture', name: 'Camera with Scripture', background: '#152f2c', layers: [layer('camera', { kind: 'source', sourceId: 'camera' }), layer('scripture', { kind: 'source', sourceId: 'scripture_feed', x: 8, y: 68, width: 84, height: 25, background: '#10131bd9', color: '#80cfff' }), layer('logo', { x: 89, y: 4, width: 7, height: 8, background: '#dd6644' })] },
    { id: 'announcement', name: 'Independent announcement', background: '#302820', layers: [] },
  ];
  studio.previewSceneId = 'announcement'; studio.mainAudioSourceId = 'main'; studio.masterVolume = .81; studio.masterMuted = false;
  const saved = await request.put(`${base}/api/studio`, { data: studio }); assert.equal(saved.status(), 200, await saved.text());
  const beforeMain = await production();
  const selectedMain = await request.post(`${base}/api/studio/command`, { data: { revision: beforeMain.revision, command: { type: 'set-main-audio', sourceId: 'main' } } }); assert.equal(selectedMain.status(), 200, await selectedMain.text());
  const beforeTake = await production();
  const take = await request.post(`${base}/api/studio/command`, { data: { revision: beforeTake.revision, command: { type: 'take', sceneId: 'camera_scripture', transition: 'cut' } } }); assert.equal(take.status(), 200, await take.text());
  const routed = await production();
  if (routed.outputs.some(output => output.id === 'screen_main')) {
    const route = await request.post(`${base}/api/studio/command`, { data: { revision: routed.revision, command: { type: 'route', outputId: 'screen_main', sceneId: 'announcement' } } }); assert.equal(route.status(), 200, await route.text());
  }
  const initialStudio = await production(), initialStatus = await status(), initialRecordings = await recordings();
  assert.equal(initialStudio.program.id, 'camera_scripture'); assert.equal(initialStudio.mainAudioSourceId, 'main'); assert.equal(initialStatus.state, 'offline');
  const unchangedStudio = async label => {
    assert.deepEqual(await production(), initialStudio, `${label}: scene drafts, committed Program/Preview, geometry, camera/overlays, routes and main/master audio remain unchanged`);
    assert.deepEqual(await status(), initialStatus, `${label}: publishing does not start/stop the production engine or recording`);
    assert.deepEqual(await recordings(), initialRecordings, `${label}: recording metadata remains unchanged`);
  };
  page = await context.newPage(); page.setDefaultTimeout(15000);
  page.on('pageerror', error => errors.push(error.message));
  page.on('dialog', async dialog => { nativeDialogs.push(dialog.message()); await dialog.dismiss(); });
  page.on('request', req => { if (['POST', 'PUT', 'DELETE'].includes(req.method())) changes.push({ path: new URL(req.url()).pathname, method: req.method() }); });
  page.on('response', async response => {
    if (new URL(response.url()).pathname !== '/api/worship/channels/scripture/listening/audio') return;
    try { const result = await response.json(); if (response.ok()) results.push(result); else errors.push(`Audio ${response.status()}: ${JSON.stringify(result)}`); } catch {}
  });
  await page.goto(base); await page.getByRole('heading', { name: 'Find a passage', exact: true }).waitFor();
  const publicContext = await browser.newContext(), live = await publicContext.newPage();
  live.on('pageerror', error => errors.push(error.message)); await live.goto(`${base}/live/scripture`);
  const stop = () => page.getByRole('button', { name: 'Stop listening', exact: true });
  const listen = () => page.getByRole('button', { name: 'Listen', exact: true });
  const decision = () => page.getByTestId('listening-decision');
  const setSpeech = async text => { const temporary = `${responseFile}.tmp`; await fs.writeFile(temporary, JSON.stringify({ text })); await fs.rename(temporary, responseFile); };
  const heard = async (text, expectedDecision, label) => {
    const from = results.length; await setSpeech(text);
    const result = await until(() => results.slice(from).find(item => item.transcript === text && item.decision === expectedDecision), label);
    await until(async () => await decision().getAttribute('data-decision') === expectedDecision, `${label} visible decision`);
    await unchangedStudio(label); return result;
  };
  const expectLive = async (book, chapter, verse, label) => {
    const state = await workspace(); assert.deepEqual(state.live.selection, { kind: 'scripture', versionId: 'TEST', book, chapter, verse }, label);
    const expected = verses.find(item => item.book === book && item.chapter === chapter && item.verse === verse).text;
    await live.getByText(expected, { exact: true }).waitFor(); return state;
  };
  await page.getByLabel('Listening mode', { exact: true }).selectOption('automatic');
  await page.getByRole('checkbox', { name: 'Enable “Lumen next / previous” voice commands', exact: true }).check();
  await listen().click();
  const confirmation = page.getByRole('dialog', { name: 'Enable Auto publish?', exact: true }); await confirmation.waitFor();
  assert.equal(await page.evaluate(() => window.__scriptureAutoMedia.active()), 0, 'Confirmation must precede capture');
  await confirmation.getByRole('button', { name: 'Enable Auto publish', exact: true }).click(); await stop().waitFor({ timeout: 30000 });
  const initialRevision = (await workspace()).revision;
  const first = await heard('John chapter three verse sixteen', 'sent-live', 'a clear reference publishes on its first recognized window');
  assert.equal(first.switched, true); assert.equal(first.workspace.revision, initialRevision + 1); assert.equal(await decision().getByText('Sent live', { exact: true }).count(), 1);
  let onAir = await expectLive(43, 3, 16, 'first reference reaches the public channel without a Send live click');
  checks.push('One clear, installed reference sends live on the first audio window and reaches the anonymous public channel; Studio remains manual');

  await heard('The preacher is greeting everyone in the congregation today.', 'listening', 'unmatched speech keeps the existing cue live');
  assert.equal((await workspace()).revision, onAir.revision);
  await heard('John chapter three', 'partial', 'an incomplete citation waits for its verse');
  assert.equal(await decision().getByText('Waiting for a verse', { exact: true }).count(), 1); assert.equal((await workspace()).revision, onAir.revision);
  await heard('The faithful shepherd guides', 'review', 'a short quote prepares a review-only candidate');
  assert.equal(await decision().getByText('Needs review', { exact: true }).count(), 1);
  await until(() => page.getByTestId('prepared-cue').innerText().then(text => text.includes('Psalms 23:1')), 'short quote private prepared proof');
  assert.equal((await workspace()).revision, onAir.revision);
  await heard(phrase.replace('guides', 'leads'), 'review', 'an approximate quote is review-only even with a long exact suffix');
  assert.equal((await workspace()).revision, onAir.revision); await expectLive(43, 3, 16, 'uncertainty never replaces the current live cue');
  await page.screenshot({ path: path.join(dir, 'scripture-auto-review.png'), fullPage: true });
  await heard(`John0:16. ${phrase}`, 'review', 'a distinctive quote cannot bypass an invalid citation in the same window');
  assert.equal((await workspace()).revision, onAir.revision);
  await heard('John 3:16,17', 'review', 'a verse list never silently publishes its truncated first verse');
  assert.equal((await workspace()).revision, onAir.revision);
  await heard('not John chapter three verse eighteen', 'review', 'an explicitly negated citation stays review-only');
  assert.equal((await workspace()).revision, onAir.revision);
  checks.push('Unmatched speech never undoes live content; partial citations wait for a verse, short/approximate quotes remain prepared, and malformed references cannot bypass review through a quotation');

  const exact = await heard(phrase, 'sent-live', 'a long distinctive exact quotation publishes once');
  assert.equal(exact.match, 'phrase'); assert.equal(exact.switched, true); assert.equal(exact.workspace.revision, onAir.revision + 1);
  onAir = await expectLive(19, 23, 1, 'exact unique quotation reaches channel live');
  await heard(phrase, 'already-live', 'the same quotation is idempotent across overlapping windows');
  assert.equal((await workspace()).revision, onAir.revision); assert.equal(await decision().getByText('Already live', { exact: true }).count(), 1);
  checks.push('Long unique exact quotations publish automatically; overlapping/repeated windows show Already live and do not add revisions');

  await heard('John chapter three verse eighteen. John chapter three verse eighteen.', 'sent-live', 'duplicate identical references are one clear citation');
  onAir = await expectLive(43, 3, 18, 'duplicate reference keeps its intended canonical identity');
  await heard('John chapter three verse sixteen and Romans chapter eight verse twenty eight', 'conflict', 'different references do not publish an arbitrary passage');
  assert.equal((await workspace()).revision, onAir.revision); assert.equal(await decision().getByText('Conflicting references', { exact: true }).count(), 1);
  await heard('John chapter three. John chapter three verse sixteen.', 'sent-live', 'a matching partial lead-in does not invent 3 John or block the complete reference');
  onAir = await expectLive(43, 3, 16, 'agreeing partial and complete citations publish the intended verse');
  await heard('Lumen next verse', 'sent-live', 'first armed voice command works immediately after automatic publication');
  await expectLive(43, 3, 17, 'voice next changes only the channel verse');
  await heard('John chapter three verse sixteen', 'sent-live', 'a current reference may return to an earlier automatically published verse');
  onAir = await expectLive(43, 3, 16, 'returning to a previous verse is not blocked by historical deduplication');
  await heard('John chapter three verse sixteen', 'already-live', 'repeating the currently live reference does not publish twice');
  assert.equal((await workspace()).revision, onAir.revision);
  checks.push('Duplicate citations deduplicate, conflicting citations stay private, agreeing partials resolve, and voice next can be followed by a return to the prior verse');
  await page.screenshot({ path: path.join(dir, 'scripture-auto-live.png'), fullPage: true });

  await stop().click(); await until(async () => await page.evaluate(() => window.__scriptureAutoMedia.active()) === 0 && await listen().isEnabled(), 'Stop listening releases synthetic capture');
  await setSpeech(''); await page.getByLabel('Listening mode', { exact: true }).selectOption('assisted'); await listen().click(); await stop().waitFor();
  const assisted = await heard('John chapter three verse eighteen', 'prepared', 'assisted mode stays private even for a clear complete reference');
  assert.equal(assisted.switched, false); assert.equal((await workspace()).revision, onAir.revision);
  await until(() => page.getByTestId('prepared-cue').innerText().then(text => text.includes('John 3:18')), 'assisted private prepared verse');
  await expectLive(43, 3, 16, 'assisted preparation leaves the public cue alone');
  await stop().click(); await until(() => page.evaluate(() => window.__scriptureAutoMedia.active() === 0), 'final capture shutdown');
  await unchangedStudio('end-to-end final snapshot');
  assert.equal(changes.filter(change => /\/command$/.test(change.path)).length, 0, 'No browser Send live, scene switch or production command was needed');
  assert.equal(changes.filter(change => change.path.startsWith('/api/studio')).length, 0, 'Listening never writes Studio/audio/output/recording APIs');
  const protocol = (await fs.readFile(workerCalls, 'utf8')).trim().split('\n').map(line => JSON.parse(line));
  assert.ok(protocol.length >= 14);
  assert.ok(protocol.every(call => call.fields.prompt === '' && call.rate === 16000 && call.channels === 1 && call.bits === 16 && call.bytes > 3244), 'Actual browser worklet WAVs use empty ASR prompt and supported local PCM transport');
  const args = JSON.parse(await fs.readFile(path.join(dir, 'worker-args.json'), 'utf8'));
  assert.equal(args[args.indexOf('--max-context') + 1], '0', 'Prompt/history conditioning remains disabled for the worker');
  assert.deepEqual(errors, []); assert.deepEqual(nativeDialogs, []);
  checks.push('Prepare only remains private; no browser take/Studio/audio/recording writes occur, and real captured WAVs use empty prompts with disabled history');
  await page.screenshot({ path: path.join(dir, 'scripture-assisted-review.png'), fullPage: true });
  await publicContext.close(); console.log(JSON.stringify({ checks, windows: results.length, artifacts: dir }, null, 2));
} catch (error) {
  await page?.screenshot({ path: path.join(dir, 'failure.png'), fullPage: true }).catch(() => {});
  console.error(error); console.error(JSON.stringify(results.slice(-4), null, 2)); console.error(logs.slice(-7000)); console.error(`Artifacts: ${dir}`); process.exitCode = 1;
} finally {
  await browser?.close();
  if (server && server.exitCode === null && !server.signalCode) { const exited = new Promise(resolve => server.once('exit', resolve)); server.kill('SIGTERM'); await exited; }
}
