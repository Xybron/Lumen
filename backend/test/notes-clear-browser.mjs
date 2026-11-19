// Real authoring UI + private Notes DB. Speech segments are seeded test data;
// local recognizer accuracy is covered separately, not claimed by this test.
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright-core';
import { NotesStore } from '../dist/notes-store.js';

const root=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'../..');
const directory=await fs.mkdtemp(path.join(os.tmpdir(),'lumen-notes-ui-data-'));
const artifacts=await fs.mkdtemp(path.join(os.tmpdir(),'lumen-notes-ui-report-'));
const port=Number(process.env.LUMEN_NOTES_TEST_PORT||3506),base=`http://127.0.0.1:${port}`;
const environment=Object.fromEntries(Object.entries(process.env).filter(([name])=>!/^(LUMEN_|VPS_|MEDIA_ENGINE_|SUPABASE_|POWERSYNC_|VITE_|NODE_OPTIONS$|NODE_PATH$|ELECTRON_RUN_AS_NODE$)/i.test(name)));
let server,browser,page,logs='';const errors=[],listeningStarts=[];
async function until(fn,label,timeout=20000){const end=Date.now()+timeout;let last;while(Date.now()<end){try{if(await fn())return;}catch(error){last=error;}await new Promise(resolve=>setTimeout(resolve,100));}throw new Error(`Timed out: ${label} ${last?.message||''}`);}
try {
  server=spawn(process.execPath,['backend/dist/server.js'],{cwd:root,env:{...environment,PORT:String(port),HOST:'127.0.0.1',LUMEN_DATA_DIR:directory,LUMEN_RENDERER_URL:base},stdio:['ignore','pipe','pipe']});
  server.stdout.on('data',bytes=>logs+=bytes);server.stderr.on('data',bytes=>logs+=bytes);
  await until(async()=>(await fetch(`${base}/api/studio`)).ok,'isolated station');
  browser=await chromium.launch({executablePath:process.env.LUMEN_CHROME_PATH||'/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',headless:true});
  const context=await browser.newContext({viewport:{width:1512,height:982},permissions:['clipboard-read','clipboard-write']});context.setDefaultTimeout(12000);
  const request=context.request;assert.equal((await request.post(`${base}/api/auth/login`,{data:{username:'admin',password:'admin'}})).status(),200);
  const fixture={version:2,updatedAt:new Date().toISOString(),settings:{transitionMs:0},music:{mode:'off'},
    channels:[{id:'prayer',name:'Notes rehearsal',kind:'notes',playlistId:'deck',defaultMode:'manual'}],
    playlists:[{id:'deck',name:'Notes rehearsal',groups:[{id:'message',name:'Message notes'}],items:[{id:'live-cue',type:'text',title:'Current audience cue',body:'Stay on this live cue',durationMs:120000},{id:'separate-note',type:'notes',title:'Separate note',body:'Keep this unrelated note',layout:'quote',groupId:'message'}]}],
    sources:[{id:'prayer-source',kind:'channel',ref:'prayer'}],destinations:[],routes:[],program:{programSourceId:'prayer-source',previewSourceId:null}};
  const seeded=await request.put(`${base}/api/content`,{data:fixture});assert.equal(seeded.status(),200,await seeded.text());
  const content=async()=>(await request.get(`${base}/api/content`)).json(),studioBefore=await(await request.get(`${base}/api/studio`)).json();
  page=await context.newPage();page.on('pageerror',error=>errors.push(error.message));page.on('request',request=>{if(request.method()==='POST'&&/\/listening$/.test(new URL(request.url()).pathname))listeningStarts.push(request.url());});await page.goto(base);
  const notes=new NotesStore(path.join(directory,'notes.db'));
  notes.get('prayer','separate-note',{body:'Keep this unrelated note',title:'Separate note',layout:'quote'});
  notes.append('prayer','separate-note','fixture',0,'Clear this captured phrase',true);notes.close();
  const card=page.getByRole('article',{name:/Slide \d+: Separate note/});await card.hover();await card.getByRole('button',{name:'Edit',exact:true}).click();
  const dialog=page.getByRole('dialog',{name:'Notes workspace',exact:true});
  await dialog.getByRole('button',{name:'Show transcript',exact:true}).click();
  const transcript=dialog.getByLabel('Private transcript text',{exact:true}),body=dialog.getByLabel('Notes draft text',{exact:true});
  await until(async()=>await transcript.inputValue()==='Clear this captured phrase','seeded transcript');
  await dialog.getByRole('button',{name:'Clear transcript',exact:true}).click();
  await page.getByRole('button',{name:'Cancel',exact:true}).click();assert.equal(await transcript.inputValue(),'Clear this captured phrase');
  await dialog.getByRole('button',{name:'Clear transcript',exact:true}).click();
  await page.getByRole('dialog',{name:'Clear transcript?',exact:true}).getByRole('button',{name:'Clear transcript',exact:true}).click();
  await until(async()=>await transcript.inputValue()==='','cleared transcript');
  assert.equal(await body.inputValue(),'Keep this unrelated note');
  const saved=await(await request.get(base+'/api/notes/channels/prayer/items/separate-note')).json();assert.deepEqual(saved.segments,[]);assert.equal(saved.draft.body,'Keep this unrelated note');
  assert.equal((await content()).playlists[0].items.find(i=>i.id==='separate-note').body,'Keep this unrelated note');
  assert.deepEqual(errors,[]);assert.deepEqual(listeningStarts,[]);
  console.log('PASS: clear confirmation, cancellation, durable transcript removal, draft/slide preservation; no microphone started.');
}catch(error){console.error(logs.slice(-1000));throw error;}
finally{await browser?.close();if(server&&server.exitCode===null){const exited=new Promise(r=>server.once('exit',r));server.kill('SIGTERM');await exited;}await fs.rm(directory,{recursive:true,force:true});}
