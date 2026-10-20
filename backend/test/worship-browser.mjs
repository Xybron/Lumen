// Isolated browser/API smoke test. Never uses the operator's data or microphone.
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import net from 'node:net';
import {spawn,execFileSync} from 'node:child_process';
import {fileURLToPath} from 'node:url';
import {chromium} from 'playwright-core';
import ffmpeg from 'ffmpeg-static';
const root=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'../..');
const dir=await fs.mkdtemp(path.join(os.tmpdir(),'lumen-worship-smoke-'));
const ai=process.argv.includes('--ai'),port=Number(process.env.LUMEN_TEST_PORT??3418),base=`http://127.0.0.1:${port}`;
await new Promise((resolve,reject)=>{const server=net.createServer();server.once('error',reject);server.listen(port,'127.0.0.1',()=>server.close(resolve));});
let logs='',server,browser;
function start(){const child=spawn(process.execPath,['backend/dist/server.js'],{cwd:root,env:{...process.env,PORT:String(port),HOST:'127.0.0.1',LUMEN_DATA_DIR:dir,LUMEN_RENDERER_URL:base,LUMEN_WHISPER_SERVER:path.join(root,'data/ai/whisper.cpp-1.9.5/build/bin/whisper-server'),LUMEN_WHISPER_MODEL:path.join(root,'data/ai/models/ggml-base.en.bin')},stdio:['ignore','pipe','pipe']});child.stdout.on('data',b=>logs+=b);child.stderr.on('data',b=>logs+=b);return child;}
async function until(fn,label,timeout=30000){const end=Date.now()+timeout;let error;while(Date.now()<end){try{const result=await fn();if(result)return result;}catch(e){error=e;}await new Promise(r=>setTimeout(r,200));}throw new Error(`Timed out: ${label} ${error?.message??''}`);}
async function shutdown(){if(server&&server.exitCode===null){const exited=new Promise(resolve=>server.once('exit',resolve));server.kill('SIGTERM');await exited;}}
try{
  server=start();await until(async()=> (await fetch(`${base}/api/studio`)).ok,'station ready');
  browser=await chromium.launch({executablePath:process.env.LUMEN_CHROME_PATH??'/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',headless:true,args:['--use-fake-device-for-media-stream','--use-fake-ui-for-media-stream','--autoplay-policy=no-user-gesture-required']});
  const context=await browser.newContext({viewport:{width:1512,height:982},permissions:['microphone']});const request=context.request;
  assert.equal((await request.post(`${base}/api/auth/login`,{data:{username:'admin',password:'admin'}})).status(),200);
  const content={version:2,updatedAt:new Date().toISOString(),settings:{transitionMs:0},music:{mode:'off'},channels:[{id:'scripture',name:'Scripture',kind:'scripture',playlistId:'p_s',defaultMode:'manual'},{id:'lyrics',name:'Worship',kind:'lyrics',playlistId:'p_l',defaultMode:'manual'},{id:'slides',name:'Presentation',kind:'presentation',playlistId:'p_p',defaultMode:'manual'}],playlists:[{id:'p_s',name:'Scripture archive',items:[]},{id:'p_l',name:'Lyrics archive',items:[]},{id:'p_p',name:'Announcements',items:[{id:'welcome',type:'text',title:'Welcome to Lumen',durationMs:30000},{id:'notes',type:'text',title:'Service notes',durationMs:30000}]}]};
  const save=await request.put(`${base}/api/content`,{data:content});assert.equal(save.status(),200,await save.text());
  const workspace=async id=>(await request.get(`${base}/api/worship/channels/${id}`)).json();
  const command=async(id,command)=>{const state=await workspace(id);const response=await request.post(`${base}/api/worship/channels/${id}/command`,{data:{revision:state.revision,command}});assert.equal(response.status(),200,await response.text());return response.json();};
  const versions=await (await request.get(`${base}/api/worship/versions`)).json();assert.equal(versions.find(v=>v.id==='KJV').verseCount,31102);assert.equal(versions.find(v=>v.id==='NIV').installed,false);
  const searchStart=performance.now();for(let i=0;i<15;i++)await request.get(`${base}/api/worship/scripture?version=KJV&q=John%203:16`);console.log(`Reference lookup average: ${Math.round((performance.now()-searchStart)/15)} ms (HTTP + SQLite).`);
  const page=await context.newPage(),errors=[],publishRequests=[],previewRequests=[];page.on('pageerror',e=>errors.push(e.message));
  page.on('request',request=>{
    if(request.method()!=='POST')return;
    if(request.url().endsWith('/api/worship/preview'))previewRequests.push(request);
    if(/\/api\/worship\/channels\/[^/]+\/command$/.test(request.url())&&request.postDataJSON().command?.type==='take')publishRequests.push(request);
  });
  const settleKeys=()=>page.evaluate(()=>new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve))));
  const noPublication=async(label,press)=>{
    const count=publishRequests.length;await press();await settleKeys();
    assert.equal(publishRequests.length,count,label);
  };
  const selectionMatches=(selection,expected)=>selection&&Object.entries(expected).every(([key,value])=>selection[key]===value);
  const prepareClick=async(locator,reference)=>{
    await locator.click();
    await until(async()=>await page.getByRole('button',{name:'Send live',exact:true}).isEnabled()&&(await page.getByTestId('prepared-cue').textContent()).includes(reference),`prepare ${reference}`);
    assert.ok(await locator.evaluate(element=>element===document.activeElement),'Selecting content leaves its own button focused; the test must not refocus search');
  };
  const shortcutSend=async(channel,chord,expected,label)=>{
    const before=await workspace(channel),takes=publishRequests.length,previews=previewRequests.length;
    await page.keyboard.press(chord);
    await until(async()=>{const next=await workspace(channel);return next.revision>before.revision&&!next.blanked&&selectionMatches(next.live?.selection,expected);},label);
    await until(()=>page.getByRole('button',{name:'Send live',exact:true}).isEnabled(),`${label} finishes`);await settleKeys();
    assert.equal(publishRequests.length,takes+1,`${label}: exactly one take is sent`);
    assert.equal(previewRequests.length,previews,`${label}: modified Enter does not natively click and reprepare the focused selection`);
  };
  await page.addInitScript(()=>{if(!localStorage.getItem('lumen.toolbar.v1')&&!localStorage.getItem('lumen.present.toolbar.v1'))localStorage.setItem('lumen.present.toolbar.v1',JSON.stringify({x:260,y:650,collapsed:false}));});
  await page.goto(base);await page.getByRole('heading',{name:'Find a passage'}).waitFor();
  await page.evaluate(()=>document.fonts.ready);
  const dock=page.getByRole('navigation',{name:'Channel toolbar'}),grip=page.getByRole('button',{name:'Move toolbar',exact:true});
  const expandDock=async()=>{const expand=dock.getByRole('button',{name:'Expand toolbar',exact:true});if(await expand.isVisible())await expand.click();};
  const openStudio=async()=>{await expandDock();await dock.getByRole('button',{name:'Open Production Studio',exact:true}).click();await page.getByRole('heading',{name:'Production Studio'}).waitFor();};
  const openScripture=async()=>{await expandDock();await dock.getByRole('button',{name:'Scripture — scripture',exact:true}).click();await page.getByRole('heading',{name:'Find a passage'}).waitFor();};
  const checkSharedHeader=async()=>{
    const header=page.locator('.lumen-header');
    assert.equal(await header.getByRole('navigation',{name:'Workspaces',exact:true}).count(),0,'The redundant header workspace switcher is removed');
    assert.equal(await header.locator('.lumen-tabs').count(),0,'There is no empty segmented-switcher shell');
    assert.equal(await header.getByRole('link',{name:/^(Present|Studio)$/}).count(),0,'Channels and Studio are reached from the shared toolbar');
    assert.ok(await header.getByRole('link',{name:'Lumen home',exact:true}).isVisible());
    assert.ok(await header.getByRole('button',{name:'Open Live View',exact:true}).isVisible());
    assert.equal(await page.getByRole('button',{name:'Open Live View',exact:true}).count(),1,'One consistent live-view button per workspace');
    assert.ok(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth),'Shared header has no horizontal overflow');
  };
  await checkSharedHeader();
  const originalDock=await dock.boundingBox(),handle=await grip.boundingBox();
  assert.deepEqual([originalDock.x,originalDock.y],[260,650],'Existing toolbar placement is retained when adopting shared preferences');
  await page.mouse.move(handle.x+handle.width/2,handle.y+handle.height/2);await page.mouse.down();
  await page.mouse.move(handle.x+handle.width/2-120,handle.y+handle.height/2-100,{steps:6});await page.mouse.up();
  const movedDock=await dock.boundingBox();assert.ok(Math.abs(movedDock.x-originalDock.x+120)<2&&Math.abs(movedDock.y-originalDock.y+100)<2,'Scripture toolbar can be dragged');
  await page.getByRole('button',{name:'Collapse toolbar',exact:true}).click();
  assert.ok((await dock.boundingBox()).width<originalDock.width);
  const compactDock=await dock.boundingBox();
  await page.reload();await page.getByRole('button',{name:'Expand toolbar',exact:true}).waitFor();
  const restoredDock=await dock.boundingBox();assert.deepEqual([restoredDock.x,restoredDock.y],[compactDock.x,compactDock.y],'Present toolbar remembers position and collapse on reload');
  // Opening the Studio URL must retain a collapsed layout without requiring a
  // duplicate header switcher. Expanded in-app navigation is checked below.
  await page.goto(`${base}/studio`);await page.getByRole('heading',{name:'Production Studio'}).waitFor();
  await page.getByRole('button',{name:'Expand toolbar',exact:true}).waitFor();
  const studioCompact=await dock.boundingBox();assert.deepEqual([studioCompact.x,studioCompact.y],[compactDock.x,compactDock.y],'Collapsed toolbar stays in the same place when entering Studio');
  await checkSharedHeader();
  const compactStudioIcon=await dock.locator('.dock-summary > svg').innerHTML();
  await page.getByRole('button',{name:'Expand toolbar',exact:true}).click();await grip.press('ArrowUp');
  const studioControl=dock.getByRole('button',{name:'Open Production Studio',exact:true});
  assert.equal(await studioControl.locator('svg').innerHTML(),compactStudioIcon,'Expanded and collapsed Studio use the same icon');
  assert.equal(await studioControl.getAttribute('aria-current'),'page','The toolbar clearly identifies the active Studio');
  assert.equal(await studioControl.locator('svg.lucide-sliders-horizontal').count(),0,'Studio is no longer represented by a settings-sliders icon');
  const studioExpanded=await dock.boundingBox();
  await openScripture();
  await page.getByRole('button',{name:'Collapse toolbar',exact:true}).waitFor();
  const presentExpanded=await dock.boundingBox();assert.deepEqual([presentExpanded.x,presentExpanded.y],[studioExpanded.x,studioExpanded.y],'Position and expanded state set in Studio carry back to Present');
  await grip.press('ArrowDown');await page.getByRole('button',{name:'Collapse toolbar',exact:true}).click();
  await page.getByRole('button',{name:'Expand toolbar',exact:true}).click();
  await page.getByRole('button',{name:'Worship — lyrics',exact:true}).click();await page.getByRole('heading',{name:'Find a song'}).waitFor();
  const lyricsDock=await dock.boundingBox();assert.deepEqual([lyricsDock.x,lyricsDock.y],[movedDock.x,movedDock.y],'Lyrics keeps the same toolbar position');
  await page.getByRole('button',{name:'Collapse toolbar',exact:true}).click();assert.equal(await dock.locator('.dock-summary').innerText(),'Worship');
  await page.getByRole('button',{name:'Expand toolbar',exact:true}).click();
  await page.getByRole('button',{name:'Scripture — scripture',exact:true}).click();await page.getByLabel('Search scripture',{exact:true}).waitFor();
  await grip.focus();await grip.press('Control+k');assert.ok(await page.getByLabel('Search scripture',{exact:true}).evaluate(el=>el===document.activeElement),'Search shortcut remains available from the toolbar');
  await page.getByRole('button',{name:'Reset toolbar position',exact:true}).click();
  const resetDock=await dock.boundingBox();
  await openStudio();
  const resetInStudio=await dock.boundingBox();assert.deepEqual([resetInStudio.x,resetInStudio.y],[resetDock.x,resetDock.y],'Reset placement does not jump between workspaces');
  await page.getByRole('button',{name:'Collapse toolbar',exact:true}).click();
  const studioCollapsed=await dock.boundingBox();
  await page.getByRole('link',{name:'Lumen home',exact:true}).click();await page.getByRole('heading',{name:'Find a passage'}).waitFor();
  assert.ok(await dock.getByRole('button',{name:'Expand toolbar',exact:true}).isVisible(),'Collapsed state survives returning from Studio through Lumen home');
  const scriptureCollapsed=await dock.boundingBox();assert.deepEqual([scriptureCollapsed.x,scriptureCollapsed.y],[studioCollapsed.x,studioCollapsed.y],'Collapsed placement remains shared when returning from Studio');
  await expandDock();
  const checkChannelHeader=async()=>{
    await checkSharedHeader();
    const header=page.locator('.lumen-header');
    assert.equal(await page.locator('.w-workspace header').count(),0,'No secondary row above the panels');
    assert.ok(await header.getByRole('link',{name:'Lumen home',exact:true}).isVisible());
    assert.ok(await header.getByRole('button',{name:'Open Live View',exact:true}).isVisible());
    assert.equal(await page.getByRole('button',{name:'Open Live View',exact:true}).count(),1,'One consistent live-view button per channel');
    assert.ok(await header.getByText('Offline library',{exact:true}).isVisible());
    const spacing=await page.evaluate(()=>({
      gap:document.querySelector('.w-layout').getBoundingClientRect().top-document.querySelector('.lumen-header').getBoundingClientRect().bottom,
      padding:parseFloat(getComputedStyle(document.querySelector('.w-workspace')).paddingTop),
      fits:document.documentElement.scrollWidth<=innerWidth,
    }));
    assert.ok(Math.abs(spacing.gap-spacing.padding)<1,'Panels sit directly beneath the top bar with only normal padding');
    assert.ok(spacing.fits,'Channel header has no horizontal overflow');
  };
  await checkChannelHeader();
  const checkContentOnlyControls=async()=>{
    assert.equal(await page.getByRole('button',{name:'Send live',exact:true}).count(),1,'One clear publishing action per content channel');
    for(const label of ['Update Program','Show on Program','Show full-screen','Return to Studio','Start engine'])assert.equal(await page.locator('.w-workspace').getByRole('button',{name:label,exact:true}).count(),0,`${label} does not belong in the content workspace`);
    assert.equal(await page.locator('.w-output-style,input[type="color"]').count(),0,'Channel design controls are owned by Studio');
    assert.equal(await page.getByTestId('prepared-cue').locator('.cue-canvas').count(),0,'A prepared cue is a neutral content proof, not a designed scene');
  };
  await checkContentOnlyControls();
  const beforePublishing=await (await request.get(`${base}/api/studio`)).json();
  assert.notEqual((await (await request.get(`${base}/api/studio/status`)).json()).state,'running','Content publishing is checked with the Studio engine stopped');
  await page.getByLabel('Search scripture',{exact:true}).fill('John 3:16');await until(()=>page.locator('.w-verse-result').count(),'scripture results');
  await page.locator('.w-verse-result').first().click();await until(()=>page.getByTestId('prepared-cue').textContent().then(s=>s.includes('For God so loved')),'prepared verse');
  assert.equal((await workspace('scripture')).live,null);
  // The prior prepared verse remains readable while a new one resolves, but
  // neither a click nor the shortcut may publish that stale selection.
  const delayedPreviews=[];
  const holdPreview=async route=>{delayedPreviews.push({route,selection:route.request().postDataJSON()});};
  await page.route('**/api/worship/preview',holdPreview);
  const selectDelayedVerse=async verse=>{
    const index=delayedPreviews.length;
    await page.getByLabel('Search scripture',{exact:true}).fill(`John 3:${verse}`);
    await until(()=>page.locator('.w-verse-result').first().innerText().then(s=>s.includes(`John 3:${verse}`)),`results for delayed verse ${verse}`);
    await page.locator('.w-verse-result').first().click();
    await until(()=>delayedPreviews.length>index,`preview request ${verse}`);
    assert.equal(delayedPreviews[index].selection.verse,verse);
    return delayedPreviews[index].route;
  };
  const staleResponse=await selectDelayedVerse(17);
  assert.equal(await page.getByRole('button',{name:'Send live',exact:true}).isDisabled(),true,'Send live is disabled while the next selection is preparing');
  assert.equal(await page.getByTestId('prepared-cue').getAttribute('aria-busy'),'true');
  assert.ok((await page.getByTestId('prepared-cue').textContent()).includes('3:16'),'The prior proof may remain visible, but not sendable');
  for(const chord of ['Control+Enter','Meta+Enter'])await noPublication('A delayed selection cannot publish the previous prepared verse',()=>page.keyboard.press(chord));
  assert.equal((await workspace('scripture')).live,null,'A delayed selection cannot publish the previous prepared verse');
  const newestResponse=await selectDelayedVerse(18);
  await newestResponse.continue();
  await until(()=>page.getByTestId('prepared-cue').textContent().then(s=>s.includes('3:18')),'newest preview resolves first');
  await until(()=>page.getByRole('button',{name:'Send live',exact:true}).isEnabled(),'newest preparation enables Send live');
  const staleFinished=page.waitForResponse(response=>response.url().endsWith('/api/worship/preview')&&response.request().postDataJSON().verse===17);
  await staleResponse.continue();await (await staleFinished).finished();
  await page.evaluate(()=>new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve))));
  assert.ok((await page.getByTestId('prepared-cue').textContent()).includes('3:18'),'An out-of-order old response cannot replace the latest prepared cue');
  const failedResponse=await selectDelayedVerse(17);
  await failedResponse.fulfill({status:422,contentType:'application/json',body:JSON.stringify({error:'This test preparation is unavailable.'})});
  await until(()=>page.getByTestId('prepared-cue').getAttribute('aria-busy').then(value=>value==='false'),'failed preparation finishes');
  assert.equal(await page.getByRole('button',{name:'Send live',exact:true}).isDisabled(),true,'A failed new selection cannot expose the previous cue to accidental publishing');
  assert.ok(!(await page.getByTestId('prepared-cue').textContent()).includes('3:18'));
  assert.equal((await workspace('scripture')).live,null);
  await page.unroute('**/api/worship/preview',holdPreview);
  await page.getByLabel('Search scripture',{exact:true}).fill('John 3:16');await until(()=>page.locator('.w-verse-result').first().innerText().then(s=>s.includes('John 3:16')),'restore initial search');
  await page.locator('.w-verse-result').first().click();await until(()=>page.getByRole('button',{name:'Send live',exact:true}).isEnabled(),'initial verse is prepared again');
  await grip.focus();for(const chord of ['Control+Enter','Meta+Enter'])await noPublication('Toolbar keys cannot publish Scripture',()=>page.keyboard.press(chord));
  assert.equal((await workspace('scripture')).live,null,'Toolbar keys cannot send a prepared Scripture cue live');
  for(const chord of ['Control+Enter','Meta+Enter']){
    await prepareClick(page.locator('.w-verse-result').first(),'3:16');
    await shortcutSend('scripture',chord,{kind:'scripture',verse:16},`${chord} publishes immediately after selecting a Scripture result`);
    await prepareClick(page.locator('.w-recent').filter({hasText:'John 3:16'}).first(),'3:16');
    await shortcutSend('scripture',chord,{kind:'scripture',verse:16},`${chord} publishes immediately after selecting a recent passage`);
    await page.getByLabel('Search scripture',{exact:true}).fill('John 3:16-17');
    await page.getByRole('button',{name:'Prepare passage',exact:true}).waitFor();
    await prepareClick(page.getByRole('button',{name:'Prepare passage',exact:true}),'3:16–17');
    await shortcutSend('scripture',chord,{kind:'scripture',verse:16,endVerse:17},`${chord} publishes immediately after preparing a passage range`);
    await page.getByRole('button',{name:'Send live',exact:true}).focus();
    await shortcutSend('scripture',chord,{kind:'scripture',verse:16,endVerse:17},`${chord} works on the focused Scripture Send live button`);
    await page.getByLabel('Search scripture',{exact:true}).fill('John 3:16');
    await until(()=>page.locator('.w-verse-result').count().then(count=>count===1),'single verse results after range');
  }
  await prepareClick(page.locator('.w-verse-result').first(),'3:16');
  // Plain Enter still prepares the first search result without taking it live.
  await page.getByLabel('Search scripture',{exact:true}).fill('John 3:18');
  await until(()=>page.locator('.w-verse-result').first().innerText().then(value=>value.includes('3:18')),'plain Enter search results');
  const plainEnterTakes=publishRequests.length,plainEnterPreviews=previewRequests.length;
  await page.keyboard.press('Enter');await until(()=>page.getByTestId('prepared-cue').textContent().then(value=>value.includes('3:18')),'plain Enter prepares first result');
  assert.equal(publishRequests.length,plainEnterTakes,'Plain Enter only prepares content');assert.equal(previewRequests.length,plainEnterPreviews+1,'Plain Enter still resolves the first Scripture result');
  await page.getByRole('button',{name:'Manage Bible library',exact:true}).click();await page.getByRole('heading',{name:'Bible library',exact:true}).waitFor();
  for(const chord of ['Control+Enter','Meta+Enter'])await noPublication('An open Bible library dialog blocks publishing',()=>page.keyboard.press(chord));
  await page.keyboard.press('Escape');
  // The safe result-button shortcut must not turn held, IME, or ambiguous
  // modified Enter events into a publication.
  await prepareClick(page.locator('.w-verse-result').first(),'3:18');
  for(const chord of ['Control+Shift+Enter','Meta+Shift+Enter','Control+Alt+Enter','Meta+Alt+Enter','Control+Meta+Enter'])await noPublication(`${chord} is not the Send live chord`,()=>page.keyboard.press(chord));
  for(const modifier of ['ctrlKey','metaKey']){
    for(const flag of ['repeat','isComposing'])await noPublication(`${modifier} with ${flag} cannot publish`,()=>page.locator('.w-verse-result').first().dispatchEvent('keydown',{key:'Enter',code:'Enter',bubbles:true,[modifier]:true,[flag]:true}));
  }
  const heldTakes=[];
  const holdTake=async route=>{if(route.request().postDataJSON().command?.type==='take')heldTakes.push(route);else await route.continue();};
  await page.route('**/api/worship/channels/scripture/command',holdTake);
  const takesBeforePending=publishRequests.length;
  await page.keyboard.press('Control+Enter');await until(()=>heldTakes.length===1,'hold pending publication');
  assert.equal(await page.getByRole('button',{name:'Send live',exact:true}).isDisabled(),true,'Send live disables during an in-flight publication');
  for(const chord of ['Control+Enter','Meta+Enter'])await noPublication('In-flight publication does not send duplicate commands',()=>page.keyboard.press(chord));
  assert.equal(publishRequests.length,takesBeforePending+1);assert.equal((await workspace('scripture')).live.selection.verse,16,'Pending publication cannot change live until accepted');
  await heldTakes[0].continue();await until(async()=>(await workspace('scripture')).live.selection.verse===18,'pending publication finishes');
  await page.unroute('**/api/worship/channels/scripture/command',holdTake);
  await page.getByLabel('Search scripture',{exact:true}).fill('John 3:16');await until(()=>page.locator('.w-verse-result').first().innerText().then(value=>value.includes('3:16')),'restore initial verse after shortcut regression');
  await prepareClick(page.locator('.w-verse-result').first(),'3:16');await page.keyboard.press('Control+Enter');await until(async()=>(await workspace('scripture')).live.selection.verse===16,'restore initial live verse after shortcut regression');
  assert.deepEqual(await (await request.get(`${base}/api/studio`)).json(),beforePublishing,'Send live never routes, takes or modifies a Studio scene');
  assert.equal(await page.getByTestId('channel-live-status').innerText(),'Ready in Studio');
  const outputOpened=context.waitForEvent('page');await page.getByRole('button',{name:'Open channel output',exact:true}).click();
  const output=await outputOpened;await output.waitForURL(`${base}/live/scripture`);await output.getByText('For God so loved the world',{exact:false}).waitFor();
  await page.getByRole('button',{name:'Next',exact:true}).click();await until(()=>output.locator('.cue-reference').textContent().then(s=>s.includes('3:17')),'next verse mirrors output');
  await page.getByRole('button',{name:'Clear live content',exact:true}).click();await until(async()=>(await workspace('scripture')).blanked,'clear channel content');
  assert.equal(await page.getByRole('button',{name:'Clear live content',exact:true}).isDisabled(),true,'Clear is not a confusing blank/restore toggle');
  await until(()=>page.getByRole('button',{name:'Send live',exact:true}).isEnabled(),'manual clear finishes before the next command');
  await page.getByLabel('Search scripture',{exact:true}).focus();await page.keyboard.press('Control+Enter');await until(async()=>!(await workspace('scripture')).blanked&&(await workspace('scripture')).live.selection.verse===16,'Send live shortcut restores prepared content');
  await page.getByRole('button',{name:'Next',exact:true}).click();await until(async()=>(await workspace('scripture')).live.selection.verse===17,'restore next verse');
  assert.deepEqual(await (await request.get(`${base}/api/studio`)).json(),beforePublishing,'Stepping and clearing content never alter Studio state');
  await page.getByRole('button',{name:'Send live',exact:true}).waitFor();await page.getByTestId('live-cue').getByText('For God sent not',{exact:false}).waitFor();await page.screenshot({path:path.join(dir,'scripture-workspace.png'),fullPage:true});
  await page.getByRole('button',{name:'Manage Bible library',exact:true}).click();await page.getByRole('heading',{name:'Bible library',exact:true}).waitFor();assert.equal(await page.locator('.w-edition').count(),7);await page.keyboard.press('Escape');
  await page.getByRole('button',{name:'Worship — lyrics',exact:true}).click();await page.getByRole('heading',{name:'Find a song'}).waitFor();
  await checkChannelHeader();
  await checkContentOnlyControls();
  await page.getByRole('button',{name:'Add your first song',exact:true}).click();await page.getByLabel('Song title',{exact:true}).fill('A song of welcome');await page.getByLabel('Writer / artist').fill('Lumen test');await page.getByLabel('Section 1 lyrics').fill('Mercy fills this house today\nLet every heart find rest');
  await page.getByRole('button',{name:'Add section',exact:true}).click();await page.getByLabel('Section 2 lyrics').fill('Let every voice sing out with joy\nTogether in this place');await page.getByRole('button',{name:'Save song',exact:true}).click();await page.getByRole('button',{name:'Pin song to setlist',exact:true}).click();await until(async()=>(await workspace('lyrics')).setlist.length===1,'setlist saved');
  const songId=(await workspace('lyrics')).setlist[0];
  const songDetails=await (await request.get(`${base}/api/worship/songs`)).json(),testSong=songDetails.find(song=>song.id===songId);
  assert.equal(testSong.title,'A song of welcome');
  for(const chord of ['Control+Enter','Meta+Enter']){
    await prepareClick(page.locator('.w-song-select').first(),'Verse 1');
    await shortcutSend('lyrics',chord,{kind:'lyrics',songId,sectionId:testSong.sections[0].id},`${chord} publishes immediately after selecting a song`);
    await prepareClick(page.locator('.w-section-cue').last(),'Chorus');
    await shortcutSend('lyrics',chord,{kind:'lyrics',songId,sectionId:testSong.sections[1].id},`${chord} publishes immediately after selecting a song section`);
    await prepareClick(page.locator('.w-setlist-song > button').first(),'Verse 1');
    await shortcutSend('lyrics',chord,{kind:'lyrics',songId,sectionId:testSong.sections[0].id},`${chord} publishes immediately after selecting a setlist song`);
    await page.getByRole('button',{name:'Send live',exact:true}).focus();
    await shortcutSend('lyrics',chord,{kind:'lyrics',songId,sectionId:testSong.sections[0].id},`${chord} works on the focused Lyrics Send live button`);
  }
  await grip.focus();for(const chord of ['Control+Enter','Meta+Enter'])await noPublication('Toolbar keys cannot publish Lyrics',()=>page.keyboard.press(chord));
  await page.getByRole('button',{name:'Edit song',exact:true}).click();await page.getByRole('button',{name:'Save song',exact:true}).waitFor();
  for(const chord of ['Control+Enter','Meta+Enter'])await noPublication('An open song editor dialog blocks publishing',()=>page.keyboard.press(chord));
  await page.keyboard.press('Escape');
  await page.getByLabel('Search songs',{exact:true}).fill('A song of welcome');
  await until(()=>page.locator('.w-song-select').count().then(count=>count===1),'song result before plain Enter');
  const songEnterTakes=publishRequests.length,songEnterPreviews=previewRequests.length;
  await page.keyboard.press('Enter');await until(()=>previewRequests.length===songEnterPreviews+1,'plain Enter prepares the first song');
  await until(()=>page.getByRole('button',{name:'Send live',exact:true}).isEnabled(),'plain Enter song preparation completes');
  assert.equal(publishRequests.length,songEnterTakes,'Plain Enter in song search only prepares content');
  const pendingSongPreviews=[];
  const holdSongPreview=async route=>{pendingSongPreviews.push(route);};
  await page.route('**/api/worship/preview',holdSongPreview);
  await page.locator('.w-section-cue').last().click();await until(()=>pendingSongPreviews.length===1,'hold Lyrics section preparation');
  for(const chord of ['Control+Enter','Meta+Enter'])await noPublication('A pending Lyrics section cannot publish the previous cue',()=>page.keyboard.press(chord));
  await pendingSongPreviews[0].continue();await until(()=>page.getByRole('button',{name:'Send live',exact:true}).isEnabled(),'pending Lyrics preparation resolves');
  await page.unroute('**/api/worship/preview',holdSongPreview);
  await prepareClick(page.locator('.w-section-cue').first(),'Verse 1');
  for(const chord of ['Control+Shift+Enter','Meta+Shift+Enter','Control+Alt+Enter','Meta+Alt+Enter','Control+Meta+Enter'])await noPublication(`${chord} does not publish Lyrics`,()=>page.keyboard.press(chord));
  for(const modifier of ['ctrlKey','metaKey'])for(const flag of ['repeat','isComposing'])await noPublication(`Lyrics ${modifier} with ${flag} cannot publish`,()=>page.locator('.w-section-cue').first().dispatchEvent('keydown',{key:'Enter',code:'Enter',bubbles:true,[modifier]:true,[flag]:true}));
  await shortcutSend('lyrics','Control+Enter',{kind:'lyrics',songId,sectionId:testSong.sections[0].id},'Lyrics returns to the first section without search refocus');
  await page.getByRole('button',{name:'Next',exact:true}).click();await until(async()=>(await workspace('lyrics')).live?.reference==='Chorus','lyrics next');
  assert.deepEqual(await (await request.get(`${base}/api/studio`)).json(),beforePublishing,'Lyrics publishing and section changes also preserve Studio state');
  assert.equal((await workspace('scripture')).live.selection.verse,17,'lyrics must not affect scripture');
  await page.getByRole('button',{name:'Send live',exact:true}).waitFor();await page.getByTestId('live-cue').getByText('Chorus',{exact:true}).waitFor();await page.screenshot({path:path.join(dir,'lyrics-workspace.png'),fullPage:true});
  const lyricsOpened=context.waitForEvent('page');await page.getByRole('button',{name:'Open channel output',exact:true}).click();
  const lyricsOutput=await lyricsOpened;await lyricsOutput.waitForURL(`${base}/live/lyrics`);await lyricsOutput.getByText('Let every voice sing out with joy',{exact:false}).waitFor();await lyricsOutput.close();
  for(const width of [1512,820,768,700,390,320]){await page.setViewportSize({width,height:844});await checkChannelHeader();}
  await page.screenshot({path:path.join(dir,'lyrics-mobile.png'),fullPage:true});await page.setViewportSize({width:1512,height:982});
  await page.getByRole('button',{name:'Presentation — presentation',exact:true}).click();
  await page.getByRole('button',{name:'Collapse toolbar',exact:true}).press('Enter');
  await page.getByRole('button',{name:'Expand toolbar',exact:true}).press('Space');
  await grip.press('ArrowRight');await grip.press('Home');
  await until(()=>page.locator('.w-offline').count().then(n=>n===0),'offline library status only appears for Scripture and Lyrics');
  const liveViewButton=page.locator('.lumen-header').getByRole('button',{name:'Open Live View',exact:true});
  assert.ok(await liveViewButton.isVisible(),'Presentation uses the same top-bar live-view button');
  assert.equal(await page.getByRole('button',{name:'Open Live View',exact:true}).count(),1,'No duplicate desktop or mobile transport button');
  assert.equal(await page.locator('.lumen-header').getByText('One service. Every screen.',{exact:true}).count(),0,'Live view replaces the slogan');
  const slidesOpened=context.waitForEvent('page');await page.getByRole('button',{name:'More channel controls',exact:true}).click();await page.getByRole('button',{name:'Open channel output',exact:true}).click();
  const slidesOutput=await slidesOpened;await slidesOutput.waitForURL(`${base}/live/slides`);await slidesOutput.getByText('Welcome to Lumen',{exact:true}).waitFor();await slidesOutput.close();
  await page.screenshot({path:path.join(dir,'presentation-workspace.png'),fullPage:true});
  await page.setViewportSize({width:390,height:844});assert.ok(await liveViewButton.isVisible());assert.equal(await page.getByRole('button',{name:'Open Live View',exact:true}).count(),1);
  await liveViewButton.click({trial:true}); // Wait for responsive side rails to finish sliding away.
  const liveButtonBounds=await liveViewButton.boundingBox();assert.ok(liveButtonBounds.x>=0&&liveButtonBounds.x+liveButtonBounds.width<=390,'Live-view button stays in bounds on mobile');
  await page.screenshot({path:path.join(dir,'presentation-mobile.png'),fullPage:true});await page.setViewportSize({width:1512,height:982});
  await openStudio();
  for(const width of [320,390,768,1512]){await page.setViewportSize({width,height:844});await checkSharedHeader();}
  await page.setViewportSize({width:1512,height:982});await page.screenshot({path:path.join(dir,'unified-studio.png'),fullPage:true});
  const studio=await (await request.get(`${base}/api/studio`)).json();
  studio.sources.push({id:'bible_feed',name:'Scripture feed',kind:'channel',channelId:'scripture',loop:false,audio:{volume:0,muted:true,mode:'follow',delayMs:0}});
  studio.scenes.push({id:'bible_scene',name:'Scripture output',background:'#000000',layers:[{...studio.scenes[0].layers[0],id:'bible_layer',name:'Scripture',kind:'source',sourceId:'bible_feed',x:0,y:0,width:100,height:100,background:'#00000000'}]});studio.previewSceneId='bible_scene';
  const stored=await request.put(`${base}/api/studio`,{data:studio});assert.equal(stored.status(),200,await stored.text());
  await request.post(`${base}/api/studio/command`,{data:{revision:(await stored.json()).revision,command:{type:'take',sceneId:'bible_scene'}}});
  const engine=await request.post(`${base}/api/studio/engine/start`,{timeout:50000});assert.equal(engine.status(),200,await engine.text());
  await until(()=>page.locator('.program-panel video').evaluate(v=>v.readyState>=2&&v.videoWidth>0),'Scripture in Studio');
  const brightPixels=()=>page.locator('.program-panel video').evaluate(video=>{const canvas=document.createElement('canvas');canvas.width=320;canvas.height=180;const ctx=canvas.getContext('2d');ctx.drawImage(video,0,0,320,180);const data=ctx.getImageData(0,0,320,180).data;let count=0;for(let i=0;i<data.length;i+=4)if(data[i]>120&&data[i+1]>120&&data[i+2]>120)count++;return count;});
  await until(async()=>(await brightPixels())>100,'Scripture text pixels in composed feed');await page.screenshot({path:path.join(dir,'scripture-studio-output.png'),fullPage:true});
  await openScripture();await until(()=>page.getByTestId('channel-live-status').innerText().then(s=>s==='On Program'),'Committed Studio scene is identified quietly in the channel');
  const committedBeforeUpdate=await (await request.get(`${base}/api/studio`)).json();
  await page.getByLabel('Search scripture',{exact:true}).fill('John 3:18');await until(()=>page.locator('.w-verse-result').first().innerText().then(s=>s.includes('John 3:18')),'new verse results');
  await page.locator('.w-verse-result').first().click();await until(()=>page.getByTestId('prepared-cue').textContent().then(s=>s.includes('3:18')),'prepare while Studio is live');
  assert.equal((await workspace('scripture')).live.selection.verse,17,'Preparing content stays private even when this channel is on Program');
  await page.getByLabel('Search scripture',{exact:true}).focus();await page.keyboard.press('Control+Enter');await until(async()=>(await workspace('scripture')).live.selection.verse===18,'Update on-air channel with sole Send live shortcut');
  await until(()=>output.locator('.cue-reference').textContent().then(s=>s.includes('3:18')),'Every channel consumer follows the published cue');
  assert.deepEqual(await (await request.get(`${base}/api/studio`)).json(),committedBeforeUpdate,'Publishing into the existing Program scene does not retake it or reset its animations');
  await command('scripture',{type:'take',selection:{kind:'scripture',versionId:'KJV',book:43,chapter:3,verse:17}});await openStudio();
  await command('scripture',{type:'blank',value:true});await until(async()=>(await brightPixels())===0,'channel blank reaches compositor');
  await command('scripture',{type:'blank',value:false});await until(async()=>(await brightPixels())>100,'channel restore reaches compositor');
  assert.equal((await request.post(`${base}/api/studio/engine/stop`)).status(),200);
  await page.getByRole('button',{name:'Scripture — scripture',exact:true}).click();await page.getByLabel('Search scripture',{exact:true}).waitFor();
  await until(()=>page.getByLabel('Bible book',{exact:true}).locator('option').count().then(n=>n===66),'book browser survives channel navigation');await page.setViewportSize({width:390,height:844});await page.screenshot({path:path.join(dir,'scripture-mobile.png'),fullPage:true});assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth),true,'mobile has no page horizontal overflow');await page.setViewportSize({width:1512,height:982});
  const unauth=await browser.newContext();assert.equal((await unauth.request.post(`${base}/api/worship/channels/scripture/command`,{data:{revision:0,command:{type:'blank',value:true}}})).status(),401);await unauth.close();
  // A channel author is a content operator, not a Studio operator. Publishing
  // must not acquire a global role or start the engine as a hidden side effect.
  const scopedManifest=await (await request.get(`${base}/api/content`)).json();
  scopedManifest.channels.push({id:'scoped_scripture',name:'Team Scripture',kind:'scripture',playlistId:'p_s',defaultMode:'manual'});
  const scopedSave=await request.put(`${base}/api/content`,{data:scopedManifest});assert.equal(scopedSave.status(),200,await scopedSave.text());
  const scopedUser=await (await request.post(`${base}/api/users`,{data:{username:'scripture-author',password:'test-password'}})).json();
  assert.equal((await request.post(`${base}/api/users/${scopedUser.user.id}/grants`,{data:{channelId:'scoped_scripture',role:'author'}})).status(),200);
  const scoped=await browser.newContext();await scoped.request.post(`${base}/api/auth/login`,{data:{username:'scripture-author',password:'test-password'}});
  const beforeScopedPublish=await (await request.get(`${base}/api/studio`)).json();
  const scopedState=await workspace('scoped_scripture');
  const scopedPublish=await scoped.request.post(`${base}/api/worship/channels/scoped_scripture/command`,{data:{revision:scopedState.revision,command:{type:'take',selection:{kind:'scripture',versionId:'KJV',book:43,chapter:3,verse:16}}}});
  assert.equal(scopedPublish.status(),200,await scopedPublish.text());
  assert.equal((await scopedPublish.json()).live.selection.verse,16);
  assert.equal((await scoped.request.post(`${base}/api/studio/command`,{data:{revision:beforeScopedPublish.revision,command:{type:'take',sceneId:'bible_scene'}}})).status(),403,'Content publishing does not imply Studio scene-switching permission');
  assert.deepEqual(await (await request.get(`${base}/api/studio`)).json(),beforeScopedPublish);
  assert.equal((await (await request.get(`${base}/api/studio/status`)).json()).state,'offline');await scoped.close();
  const created=await (await request.post(`${base}/api/users`,{data:{username:'viewer',password:'test-password'}})).json();await request.post(`${base}/api/users/${created.user.id}/grants`,{data:{channelId:'*',role:'viewer'}});
  const viewer=await browser.newContext();await viewer.request.post(`${base}/api/auth/login`,{data:{username:'viewer',password:'test-password'}});assert.equal((await viewer.request.post(`${base}/api/worship/channels/scripture/command`,{data:{revision:0,command:{type:'blank',value:true}}})).status(),403);assert.equal((await viewer.request.post(`${base}/api/worship/songs`,{data:{title:'Not allowed',sections:[]}})).status(),403);await viewer.close();
  const stale=await request.post(`${base}/api/worship/channels/scripture/command`,{data:{revision:0,command:{type:'blank',value:true}}});assert.equal(stale.status(),409);
  if(ai){
    const aiff=path.join(dir,'reference.aiff');execFileSync('say',['-v','Samantha','-r','135','-o',aiff,'John chapter three, verse sixteen.']);
    const pcm=execFileSync(ffmpeg,['-hide_banner','-loglevel','error','-i',aiff,'-af','apad=pad_dur=1','-ac','1','-ar','16000','-f','s16le','-'],{maxBuffer:400000});
    const wav=Buffer.alloc(44+pcm.length);wav.write('RIFF',0);wav.writeUInt32LE(36+pcm.length,4);wav.write('WAVEfmt ',8);wav.writeUInt32LE(16,16);wav.writeUInt16LE(1,20);wav.writeUInt16LE(1,22);wav.writeUInt32LE(16000,24);wav.writeUInt32LE(32000,28);wav.writeUInt16LE(2,32);wav.writeUInt16LE(16,34);wav.write('data',36);wav.writeUInt32LE(pcm.length,40);pcm.copy(wav,44);
    const listen=await request.post(`${base}/api/worship/channels/scripture/listening`,{data:{mode:'automatic',language:'en',commands:false},timeout:100000});assert.equal(listen.status(),200,await listen.text());const session=await listen.json();
    for(let sequence=0;sequence<2;sequence++){const r=await request.post(`${base}/api/worship/channels/scripture/listening/audio?session=${session.id}&sequence=${sequence}`,{headers:{'Content-Type':'audio/wav'},data:wav,timeout:45000});assert.equal(r.status(),200,await r.text());const result=await r.json();console.log(`Local ASR: ${JSON.stringify(result.transcript)} · ${result.elapsedMs} ms · switched=${result.switched}`);assert.equal(result.candidate?.selection.verse,16);assert.equal(result.switched,sequence===0);assert.equal(result.decision,sequence===0?'sent-live':'already-live');}
    await command('scripture',{type:'step',direction:1});assert.equal((await request.post(`${base}/api/worship/channels/scripture/listening/heartbeat`,{data:{sessionId:session.id}})).status(),409,'manual action invalidates listener');
    await page.getByRole('button',{name:'Listen',exact:true}).click();await page.getByRole('button',{name:'Stop listening',exact:true}).waitFor({timeout:100000});await until(()=>page.locator('.w-transcript').count(),'real browser worklet sends fake-device audio',20000);await page.getByRole('button',{name:'Stop listening',exact:true}).click();await page.getByRole('button',{name:'Listen',exact:true}).waitFor();
  }
  await shutdown();server=start();await until(async()=>(await request.get(`${base}/api/worship/channels/scripture`)).ok(),'restart');await page.reload();await until(()=>page.getByTestId('live-cue').textContent().then(s=>s.includes('3:17')),'persisted live state');assert.equal((await workspace('lyrics')).live.reference,'Chorus');
  await output.reload();await output.getByText('John 3:17 · KJV',{exact:true}).waitFor();assert.equal(await page.getByRole('button',{name:'Listen',exact:true}).count(),1,'automatic listening never rearms on restart');
  assert.deepEqual(errors,[]);console.log(`Worship smoke passed${ai?' with real local ASR':''}. Screenshots: ${dir}`);
}catch(error){console.error(logs.slice(-6000));console.error(`Test artifacts: ${dir}`);throw error;}finally{await browser?.close();await shutdown();}
