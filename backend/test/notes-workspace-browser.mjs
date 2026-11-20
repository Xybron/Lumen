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
  await page.getByRole('heading',{name:'Notes rehearsal',exact:true}).waitFor();
  const output=await context.newPage();await output.goto(`${base}/live/prayer`);await output.getByText('Stay on this live cue',{exact:true}).waitFor();
  await page.bringToFront();await page.getByLabel('Destination group',{exact:true}).selectOption('message');
  await page.getByRole('button',{name:'New note',exact:true}).click();
  const dialog=()=>page.getByRole('dialog',{name:'Notes workspace',exact:true});
  const body=()=>dialog().getByLabel('Notes draft text',{exact:true});
  const preview=()=>dialog().getByLabel('Slide preview',{exact:true});
  const update=()=>dialog().getByRole('button',{name:/^Update slides?$/});
  const closeNote=async()=>{await dialog().getByRole('button',{name:'Close',exact:true}).click();await dialog().waitFor({state:'hidden'});};
  const checkFooter=async label=>{
    const bounds=await dialog().evaluate(element=>{const r=element.getBoundingClientRect(),footer=element.querySelector('.notes-footer').getBoundingClientRect();return {dialog:{top:r.top,bottom:r.bottom},footer:{top:footer.top,bottom:footer.bottom},height:innerHeight};});
    const button=await update().boundingBox();
    assert(button&&bounds.footer.top>=bounds.dialog.top&&bounds.footer.bottom<=bounds.dialog.bottom+1&&button.y+button.height<=bounds.height&&button.y>=0,`${label}: Update remains visible without scrolling ${JSON.stringify({bounds,button})}`);
  };
  await body().waitFor();
  assert.equal(await dialog().getByLabel('Private transcript text',{exact:true}).count(),0,'New Notes opens for manual writing without a transcript');
  assert.equal(await dialog().getByLabel('Notes recognition provider',{exact:true}).count(),0,'Manual Notes does not ask for audio configuration');
  assert((await dialog().boundingBox()).width>=900,'Desktop editor has room for writing and its live preview');
  const created=(await content()).playlists[0].items.find(item=>item.type==='notes'&&item.title==='Untitled notes');assert(created);assert.equal(created.groupId,'message');assert.equal(created.body,'');
  const endpoint=`${base}/api/notes/channels/prayer/items/${created.id}`;
  const note=async()=>(await request.get(endpoint)).json();
  const series=async()=>(await content()).playlists[0].items.filter(item=>item.id===created.id||item.notesSourceId===created.id);
  assert.equal(await update().isDisabled(),true);
  assert.equal(await dialog().getByRole('button',{name:'Review slide',exact:true}).count(),0,'Live preview removes the separate review step');
  assert.equal(await dialog().getByRole('button',{name:'Slide appearance',exact:true}).count(),0,'Appearance stays inside the Notes editor');
  await dialog().getByLabel('Notes slide title',{exact:true}).fill('A message of hope');
  await body().fill('PRIVATE rough thought that must not go live.');
  await preview().getByRole('img',{name:/PRIVATE rough thought/}).waitFor();
  await until(async()=>(await note()).draft.body==='PRIVATE rough thought that must not go live.','draft automatically persisted');
  assert.equal((await series())[0].body,'','Live preview and automatic draft save do not publish the text');
  await dialog().getByRole('button',{name:'Use Emerald theme',exact:true}).click();
  await until(async()=>(await note()).draft.background?.color==='#064e3b','inline appearance autosaved privately');
  assert.notEqual((await series())[0].background?.color,'#064e3b');
  await closeNote();
  // Seed private speech through its durable store. These phrases are fixtures,
  // not a claim about recognition accuracy.
  const notes=new NotesStore(path.join(directory,'notes.db'));
  notes.append('prayer',created.id,'fixture-speech',0,'PRIVATE transcript preamble. Hope grows when we act together.',false);
  notes.append('prayer',created.id,'fixture-speech',1,'Care for the people around you. Uncertain private trailing words.',true);notes.close();
  const openNote=async(title,index=0)=>{const card=page.getByRole('article',{name:new RegExp(`Slide \\d+: ${title}`)}).nth(index);await card.hover();await card.getByRole('button',{name:'Edit',exact:true}).click();await body().waitFor();};
  await openNote('Untitled notes');
  assert.equal(await body().inputValue(),'PRIVATE rough thought that must not go live.','Draft survives closing and reopening');
  assert.equal(await dialog().getByRole('button',{name:'Use Emerald theme',exact:true}).getAttribute('aria-pressed'),'true','Private styling survives reopening');
  assert.equal(await dialog().getByLabel('Private transcript text',{exact:true}).count(),0,'Saved speech stays optional');
  await dialog().getByRole('button',{name:'Show transcript',exact:true}).click();
  const transcript=dialog().getByLabel('Private transcript text',{exact:true});assert.match(await transcript.inputValue(),/PRIVATE transcript preamble/);
  await dialog().getByRole('button',{name:'Copy transcript',exact:true}).click();assert.equal(await page.evaluate(()=>navigator.clipboard.readText()),await transcript.inputValue());
  await body().fill('Before. After.');
  await body().evaluate(element=>{element.focus();element.setSelectionRange(8,8);element.dispatchEvent(new Event('select',{bubbles:true}));element.dispatchEvent(new Event('keyup',{bubbles:true}));});
  const selected='Hope grows when we act together.';
  await transcript.evaluate((element,text)=>{const start=element.value.indexOf(text);element.focus();element.setSelectionRange(start,start+text.length);element.dispatchEvent(new Event('select',{bubbles:true}));},selected);
  await dialog().getByRole('button',{name:'Insert selection',exact:true}).click();
  const inserted=await body().inputValue();assert(inserted.startsWith('Before. '));assert(inserted.endsWith('After.'));assert(inserted.indexOf(selected)>inserted.indexOf('Before.')&&inserted.indexOf(selected)<inserted.indexOf('After.'),'Selection inserts at the remembered cursor without replacing existing notes');
  await body().fill('Hope grows when we act together.\nCare for the people around you.');
  await dialog().getByLabel('Notes slide grouping',{exact:true}).selectOption('pointers');
  assert.equal(await dialog().getByRole('button',{name:/^Preview slide \d+$/}).count(),2);
  await dialog().getByRole('button',{name:'Preview slide 2',exact:true}).click();
  await preview().getByRole('img',{name:/Care for the people around you/}).waitFor();
  assert.equal((await series())[0].body,'','Every generated preview remains private until Update');
  await checkFooter('Desktop live preview');
  await page.screenshot({path:path.join(artifacts,'notes-preview-desktop.png')});
  // A failed public update must retain the editable draft and offer a retry.
  let rejectUpdate=true;
  await page.route(`${base}/api/content`,async route=>{if(route.request().method()==='PUT'&&rejectUpdate){rejectUpdate=false;await route.fulfill({status:503,contentType:'application/json',body:JSON.stringify({error:'Fixture: update temporarily unavailable'})});}else await route.continue();});
  await update().click();await until(()=>dialog().getByRole('alert').innerText().then(text=>/could not be updated/.test(text)),'failed update reported');
  assert.equal(await dialog().isVisible(),true);assert.equal((await series())[0].body,'');assert.equal(await update().isEnabled(),true);
  await page.unroute(`${base}/api/content`);
  await update().click();await until(async()=>(await series()).length===2&&(await series())[0].body===selected,'one-step split update');
  assert.equal(await dialog().isVisible(),true,'Update keeps the editor open for the next point');
  const published=await series(),firstIds=published.map(item=>item.id);
  assert.equal(firstIds[0],created.id);assert.notEqual(firstIds[1],created.id);
  assert.deepEqual(published.map(item=>item.body),[selected,'Care for the people around you.']);
  assert(published.every(item=>item.groupId==='message'&&item.layout==='statement'&&item.background.color==='#064e3b'));
  assert.doesNotMatch(JSON.stringify(await content()),/PRIVATE|Uncertain private/,'Only explicitly applied text enters presentation content');
  assert.equal(await update().isDisabled(),true,'An acknowledged unchanged draft does not keep offering another update');
  // Hold a draft write while the operator presses Update, then continues typing.
  // The click applies its snapshot; later keystrokes remain a private next edit.
  let releaseDraft;const draftGate=new Promise(resolve=>{releaseDraft=resolve;});let held=false;
  const privateDraftRoute=url=>`${url.origin}${url.pathname}`===endpoint;
  await page.route(privateDraftRoute,async route=>{if(route.request().method()==='PUT'&&!held){held=true;await draftGate;}await route.continue();});
  const clickedText='Hope grows through action.\nCare for the people around you.';
  await body().fill(clickedText);await update().click();await until(()=>held,'private draft write held while updating');
  const laterText=clickedText+'\nA new thought after the update click.';
  await body().fill(laterText);releaseDraft();
  await until(async()=>(await series())[0].body==='Hope grows through action.','clicked snapshot applied');
  await page.unroute(privateDraftRoute);
  assert.deepEqual((await series()).map(item=>item.id),firstIds,'Repeated updates reuse existing generated slide IDs');
  assert.deepEqual((await series()).map(item=>item.body),clickedText.split('\n'),'Typing after Update is not accidentally included in that publication');
  assert.equal(await body().inputValue(),laterText,'In-flight commits never reset newer editor text');
  await until(()=>update().isEnabled(),'next private edit remains ready to apply');
  await until(async()=>(await note()).draft.body===laterText,'later typing autosaved privately');
  await body().press(process.platform==='darwin'?'Meta+Enter':'Control+Enter');
  await until(async()=>(await series()).length===3,'keyboard shortcut applies next edit');
  const expanded=await series();assert.deepEqual(expanded.slice(0,2).map(item=>item.id),firstIds);
  await closeNote();
  await openNote('A message of hope',1);
  assert.equal(await body().inputValue(),laterText,'Opening a generated child edits its entire original Note series');
  assert.equal(await dialog().getByLabel('Notes slide grouping',{exact:true}).inputValue(),'pointers');
  await body().fill('One clear takeaway.');await update().click();
  await until(async()=>(await series()).length===1&&(await series())[0].body==='One clear takeaway.','removed pointer lines retire only their generated slides');
  const reduced=(await content()).playlists[0].items;
  assert.equal(reduced.find(item=>item.id==='separate-note')?.body,'Keep this unrelated note','Series updates preserve unrelated Notes in the same group');
  assert.equal(reduced.find(item=>item.id==='live-cue')?.body,'Stay on this live cue');
  await output.getByText('Stay on this live cue',{exact:true}).waitFor();
  const studioAfter=await(await request.get(`${base}/api/studio`)).json();assert.deepEqual(studioAfter.program,studioBefore.program,'Notes Update does not Take Program');
  // Closing during an in-flight autosave drains the newest private edits too.
  let releaseCloseDraft,closeHeld=false;const closeGate=new Promise(resolve=>{releaseCloseDraft=resolve;});
  await page.route(privateDraftRoute,async route=>{if(route.request().method()==='PUT'&&!closeHeld){closeHeld=true;await closeGate;}await route.continue();});
  await body().fill('Private wording before close.');
  await until(()=>closeHeld,'autosave is in flight before close');
  await body().fill('Private wording with the newest closing edit.');
  await dialog().getByRole('button',{name:'Close',exact:true}).click();
  assert.equal(await dialog().isVisible(),true,'Closing waits for pending private writes');
  releaseCloseDraft();await dialog().waitFor({state:'hidden'});await page.unroute(privateDraftRoute);
  assert.equal((await note()).draft.body,'Private wording with the newest closing edit.');
  assert.equal((await series())[0].body,'One clear takeaway.','Closing does not apply newer draft words to the audience slide');
  await openNote('A message of hope');
  assert.equal(await body().inputValue(),'Private wording with the newest closing edit.');
  await page.setViewportSize({width:375,height:844});
  await until(()=>dialog().evaluate(element=>{const r=element.getBoundingClientRect();return r.left>=0&&r.right<=innerWidth+1&&r.top>=0&&r.bottom<=innerHeight+1&&! (element.scrollWidth>element.clientWidth+1); }),'Notes fits the mobile viewport',3000);
  await checkFooter('Mobile writing');
  await dialog().getByRole('button',{name:/^Preview\s*\d*$/}).click();await preview().waitFor({state:'visible'});
  await checkFooter('Mobile preview');
  await page.screenshot({path:path.join(artifacts,'notes-mobile-preview.png')});
  await dialog().getByRole('button',{name:'Transcript',exact:true}).click();await dialog().getByLabel('Private transcript text',{exact:true}).waitFor({state:'visible'});
  await checkFooter('Mobile transcript');
  await dialog().getByRole('button',{name:'Write',exact:true}).click();await body().waitFor({state:'visible'});
  assert.deepEqual(errors,[]);assert.deepEqual(listeningStarts,[],'Manual editing, transcript review and preview never start a microphone');
  await fs.writeFile(path.join(artifacts,'report.json'),JSON.stringify({passed:true,scope:'Browser authoring with seeded transcript fixtures; no ASR accuracy claim.',checks:['Manual creation in selected group','Live WYSIWYG preview and automatic private draft saving','Inline appearance persists privately then applies explicitly','Transcript insertion at cursor preserves existing notes','Failed Update retains draft and retries','One-step split update stays open','Stable IDs through repeated saves and child reopening','Later typing stays private during an in-flight update','Keyboard update shortcut','Closing drains in-flight autosave and newest edits','Removed pointers preserve unrelated slides','Shared audience cue and Studio Program unchanged','375px mobile Write/Preview/Transcript with visible Update footer'],errors},null,2));
  console.log(`PASS: Notes live preview, autosave, transcript insertion, stable repeated updates, private/public boundaries, inline appearance and mobile panes. Speech is a fixture. Artifacts: ${artifacts}`);
}catch(error){console.error(logs.slice(-3000));if(page)await page.screenshot({path:path.join(artifacts,'failure.png')}).catch(()=>{});console.error(artifacts);throw error;}
finally{await browser?.close();if(server&&server.exitCode===null&&server.signalCode===null){const exited=new Promise(resolve=>server.once('exit',resolve));server.kill('SIGTERM');await exited;}await fs.rm(directory,{recursive:true,force:true});}
