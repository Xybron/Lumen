// UI checks use simulated transcript events, not a recognition accuracy benchmark.
// Lyrics search/keyboard regression on a disposable offline station. This never
// opens the operator's data, engine, microphone, capture devices, or recordings.
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import net from 'node:net';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright-core';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'lumen-shared-lyrics-ui-'));
const port = Number(process.env.LUMEN_SHARED_LYRICS_TEST_PORT ?? 3457);
const base = `http://127.0.0.1:${port}`;
await new Promise((resolve, reject) => {
  const probe = net.createServer(); probe.once('error', reject);
  probe.listen(port, '127.0.0.1', () => probe.close(resolve));
});
let logs = '', browser, page, server;
const errors = [], checks = [], takes = [], previews = [], listeningWrites = [];
async function until(fn, label, timeout = 15000) {
  const end = Date.now() + timeout; let last;
  while (Date.now() < end) {
    try { const result = await fn(); if (result) return result; } catch (error) { last = error; }
    await new Promise(resolve => setTimeout(resolve, 60));
  }
  throw new Error(`Timed out: ${label}${last ? ` (${last.message})` : ''}`);
}

try {
  server = spawn(process.execPath, ['backend/dist/server.js'], { cwd: root,
    env: { ...process.env, PORT: String(port), HOST: '127.0.0.1', LUMEN_DATA_DIR: dir, LUMEN_RENDERER_URL: base }, stdio: ['ignore', 'pipe', 'pipe'] });
  server.stdout.on('data', chunk => logs += chunk); server.stderr.on('data', chunk => logs += chunk);
  await until(async () => (await fetch(base + '/api/workspace')).ok, 'temporary station');
  browser = await chromium.launch({ executablePath: '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome', headless: true });
  const context = await browser.newContext({ viewport: { width: 1512, height: 982 } }), request = context.request;
  context.setDefaultTimeout(15000);
  await request.post(base + '/api/auth/login', {data:{username:'admin',password:'admin'}});
  const identity=await (await request.get(base+'/api/auth/me')).json();
  await request.put(base+'/api/content',{data:{version:2,updatedAt:new Date().toISOString(),settings:{},music:{mode:'off'},
    channels:['lyrics','notes','scripture'].map(kind=>({id:kind,name:kind==='lyrics'?'Lyrics':kind==='notes'?'Notes':'Scripture',kind,playlistId:'p_'+kind,defaultMode:'manual'})),
    playlists:['lyrics','notes','scripture'].map(kind=>({id:'p_'+kind,name:kind,items:[]}))}});
  const song=await(await request.post(base+'/api/worship/songs',{data:{title:'Morning Light',sections:[{id:'chorus',label:'Chorus',text:'Morning light surrounds us with a joyful song of hope'}]}})).json();
  const workspace=await(await request.get(base+'/api/worship/channels/lyrics')).json();
  const studio=await(await request.get(base+'/api/studio')).json();
  const candidate=await(await request.post(base+'/api/worship/preview',{data:{kind:'lyrics',songId:song.id,sectionId:'chorus'}})).json();
  const result={transcript:song.sections[0].text,candidate,workspace,elapsedMs:0,match:'lyrics',score:1,switched:false,decision:'prepared',reason:'Possible song and section. Prepare it to review; nothing has changed live.'};
  const snapshot={session:{id:'fixture-session',channelId:'scripture',source:'scripture',ownerId:identity.user.id,provider:'assemblyai',mode:'automatic',startedAt:Date.now(),state:'listening',linkedNotes:0},result:{...result,candidate:null},final:true,turn:1};
  await context.addInitScript(snapshot=>{
    window.__micRequests=0;
    Object.defineProperty(navigator.mediaDevices,'getUserMedia',{value:async()=>{window.__micRequests++;throw Error('No physical microphone allowed in this test');}});
    const Native=window.EventSource; window.__sharedEvents=[];
    window.EventSource=class extends EventTarget{
      constructor(url,options){super();if(!String(url).endsWith('/api/listening/shared/events'))return new Native(url,options);window.__sharedEvents.push(this);setTimeout(()=>{if(!this.closed){this.onopen?.(new Event('open'));this.onmessage?.(new MessageEvent('message',{data:JSON.stringify(snapshot)}));}},20);}
      close(){this.closed=true;}
    };
    window.__emitShared=value=>window.__sharedEvents.filter(e=>!e.closed).forEach(e=>e.onmessage?.(new MessageEvent('message',{data:JSON.stringify(value)})));
  },snapshot);
  let lookups=0;
  await context.route('**/api/worship/channels/lyrics/listening/shared-result?*',route=>{lookups++;return route.fulfill({json:{sessionId:'fixture-session',turn:1,result}});});
  await context.route('**/api/listening/shared',route=>route.fulfill({json:snapshot}));
  page=await context.newPage();page.on('pageerror',error=>errors.push(error.message));
  await page.goto(base);await page.getByRole('heading',{name:'Find a song',exact:true}).waitFor();
  await page.getByText('Suggested song',{exact:true}).waitFor();
  assert(lookups>0);assert.equal(await page.evaluate(()=>window.__micRequests),0,'Shared consumers never open another microphone');
  assert.equal(await page.getByLabel('Listening mode',{exact:true}).inputValue(),'assisted','Scripture Auto publish never arms Lyrics');
  assert.equal(await page.getByLabel('Listening mode',{exact:true}).locator('option[value="automatic"]').count(),0);
  assert.equal(await page.getByTestId('channel-send-live').isEnabled(),false,'A suggestion is not yet an operator draft');
  await page.getByRole('button',{name:'Prepare song',exact:true}).click();
  await until(()=>page.getByTestId('channel-send-live').isEnabled(),'song prepared');
  assert.deepEqual(await(await request.get(base+'/api/worship/channels/lyrics')).json(),workspace);
  assert.deepEqual((await(await request.get(base+'/api/studio')).json()).program,studio.program);
  await page.screenshot({path:path.join(dir,'shared-lyrics.png')});
  await page.getByRole('button',{name:'Notes — notes',exact:true}).click();
  await page.getByLabel('New note',{exact:true}).click();
  const notes=page.getByRole('dialog',{name:'Notes workspace',exact:true});
  await notes.getByLabel('Notes draft text',{exact:true}).fill('Selected control preview');
  const selected=notes.getByRole('button',{name:'Key points layout',exact:true});await selected.click();
  const style=await selected.evaluate(el=>({color:getComputedStyle(el).color,background:getComputedStyle(el).backgroundColor,shadow:getComputedStyle(el).boxShadow}));
  assert.equal(style.color,'rgb(221, 251, 115)');assert.match(style.shadow,/0px 0px 0px 1px inset/);assert(!style.shadow.includes('-2px'));
  await page.screenshot({path:path.join(dir,'notes-selected-controls.png')});
  await notes.getByRole('button',{name:'Close',exact:true}).click();
  await page.getByRole('button',{name:'Lyrics — lyrics',exact:true}).click();
  await page.getByRole('button',{name:'Prepare song',exact:true}).waitFor();
  await page.evaluate(()=>window.__emitShared({session:null,result:null,final:false,turn:-1}));
  await until(async()=>await page.getByRole('button',{name:'Prepare song',exact:true}).count()===0,'suggestion cleared on shared stop');
  assert.equal(await page.evaluate(()=>window.__micRequests),0);assert.deepEqual(errors,[]);
  console.log('PASS: shared Lyrics suggestions, manual Prepare, no microphone duplication, no publication, navigation, Stop and selected Notes styling. Artifacts: '+dir);
} catch(error) { console.error(logs.slice(-2000)); await page?.screenshot({path:path.join(dir,'failure.png')}).catch(()=>{});console.error('Artifacts: '+dir);throw error; }
finally { await browser?.close();if(server&&server.exitCode===null){const exited=new Promise(resolve=>server.once('exit',resolve));server.kill('SIGTERM');await exited;} }
