// Opt-in real AssemblyAI integration. One reviewed sermon loops through one
// synthetic microphone on a disposable station; no physical mic or user data.
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import {spawn} from 'node:child_process';
import {fileURLToPath} from 'node:url';
import {chromium} from 'playwright-core';

if(process.env.LUMEN_RUN_ASSEMBLYAI_SMOKE!=='1')throw new Error('Set LUMEN_RUN_ASSEMBLYAI_SMOKE=1 to run the reviewed-clip shared listening test.');
const root=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'../..');
const temporary=await fs.mkdtemp(path.join(os.tmpdir(),'lumen-shared-listening-'));
const output=path.join(root,'data/ai/corpus/shared-listening-2026-11-18/scripture-start');await fs.mkdir(output,{recursive:true});
const port=Number(process.env.LUMEN_SHARED_TEST_PORT||3469),base=`http://127.0.0.1:${port}`;
const environment=Object.fromEntries(Object.entries(process.env).filter(([name])=>!/^(LUMEN_|VPS_|MEDIA_ENGINE_|SUPABASE_|POWERSYNC_|VITE_|NODE_OPTIONS$|NODE_PATH$|ELECTRON_RUN_AS_NODE$)/i.test(name)));
let server,browser,page,logs='';const errors=[],checks=[],messages=[],connections=[],starts=[];
const until=async(fn,label,timeout=20000)=>{const end=Date.now()+timeout;let last;while(Date.now()<end){try{if(await fn())return;}catch(error){last=error;}await new Promise(resolve=>setTimeout(resolve,80));}throw new Error(`Timed out: ${label}${last?` (${last.message})`:''}`);};
try{
  const fixturePath='data/ai/corpus/ogyiri-asare-evaluation-2026-11-12/baseline/clips/clip-00007.wav',audio=(await fs.readFile(path.join(root,fixturePath))).toString('base64');
  server=spawn(process.execPath,['backend/dist/server.js'],{cwd:root,env:{...environment,PORT:String(port),HOST:'127.0.0.1',LUMEN_DATA_DIR:temporary,LUMEN_RENDERER_URL:base},stdio:['ignore','pipe','pipe']});
  server.stdout.on('data',bytes=>logs+=bytes);server.stderr.on('data',bytes=>logs+=bytes);
  await until(async()=>(await fetch(`${base}/api/workspace`)).ok,'isolated station',30000);
  browser=await chromium.launch({executablePath:process.env.LUMEN_CHROME_PATH||'/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',headless:true,args:['--autoplay-policy=no-user-gesture-required']});
  const context=await browser.newContext({viewport:{width:1440,height:1000}}),request=context.request;context.setDefaultTimeout(12000);
  await context.addInitScript(({audio})=>{
    const media=navigator.mediaDevices;window.__captures=[];
    Object.defineProperty(media,'enumerateDevices',{value:async()=>[{deviceId:'fixture',kind:'audioinput',groupId:'fixture',label:'Reviewed sermon test microphone'}]});
    Object.defineProperty(media,'getUserMedia',{value:async()=>{
      const context=new AudioContext(),destination=context.createMediaStreamDestination(),track=destination.stream.getAudioTracks()[0],stop=track.stop.bind(track);
      track.stop=()=>{stop();void context.close();};track.getSettings=()=>({deviceId:'fixture',sampleRate:context.sampleRate});window.__captures.push(track);await context.resume();
      window.__playClip=async()=>{const data=Uint8Array.from(atob(audio),c=>c.charCodeAt(0)),buffer=await context.decodeAudioData(data.buffer),source=context.createBufferSource();source.buffer=buffer;source.loop=true;source.connect(destination);source.start();};
      return destination.stream;
    }});
  },{audio});
  assert.equal((await request.post(`${base}/api/auth/login`,{data:{username:'admin',password:'admin'}})).status(),200);
  const fixture={version:2,updatedAt:new Date().toISOString(),settings:{transitionMs:0},music:{mode:'off'},channels:[{id:'scripture',name:'Scripture',kind:'scripture',playlistId:'scripture-deck',defaultMode:'manual'},{id:'notes-test',name:'Notes microphone test',kind:'presentation',playlistId:'deck',defaultMode:'manual'}],playlists:[{id:'scripture-deck',name:'Scripture',items:[]},{id:'deck',name:'Notes microphone test',items:[{id:'audience-cue',type:'text',title:'Current audience cue',body:'Keep this audience cue',durationMs:120000}]}]};
  assert.equal((await request.put(`${base}/api/content`,{data:fixture})).status(),200);
  const content=async()=>(await request.get(`${base}/api/content`)).json(),shared=async()=>(await request.get(`${base}/api/listening/shared`)).json();
  const studioBefore=await(await request.get(`${base}/api/studio`)).json();
  page=await context.newPage();page.on('pageerror',error=>errors.push(error.message));
  page.on('request',request=>{if(request.method()==='POST'&&/\/listening$/.test(new URL(request.url()).pathname))starts.push(request.url());});
  page.on('websocket',socket=>{
    if(!/\/(?:worship|notes)\/listening\/stream/.test(socket.url()))return;
    connections.push(socket.url());socket.on('framereceived',({payload})=>{try{messages.push({...JSON.parse(String(payload)),observedAt:Date.now()});}catch{}});
  });
  await page.goto(base);await page.getByRole('heading',{name:'Find a passage',exact:true}).waitFor();
  assert.equal((await content()).playlists.flatMap(playlist=>playlist.items).filter(item=>item.type==='notes').length,0);
  assert.equal(await page.evaluate(()=>window.__captures.length),0);
  await page.getByRole('button',{name:'Open listening controls',exact:true}).click();
  await page.getByLabel('Recognition provider',{exact:true}).selectOption('assemblyai');
  await page.getByRole('button',{name:'Listen',exact:true}).click();
  await until(()=>messages.some(message=>message.type==='ready'),'AssemblyAI ready');
  const sourceSession=(await shared()).session;assert.ok(sourceSession);assert.equal(sourceSession.linkedNotes,0);assert.equal(sourceSession.source,'scripture');
  const audioStarted=Date.now();await page.evaluate(()=>window.__playClip());
  const correct=message=>message.type==='result'&&message.result.candidate?.selection.book===9&&message.result.candidate?.selection.chapter===16&&message.result.candidate?.selection.verse===13;
  await until(()=>messages.some(correct),'scripture without Notes',18000);
  assert.equal((await content()).playlists.flatMap(playlist=>playlist.items).filter(item=>item.type==='notes').length,0,'Listening never creates Notes automatically');
  checks.push('Scripture starts one microphone/AssemblyAI stream and detects scripture with no Notes created');
  await page.getByRole('button',{name:'Close listening controls',exact:true}).click();

  // A note can be created while the preacher stream is already running.
  const withNote=await content();withNote.playlists.find(playlist=>playlist.id==='deck').items.push({id:'note',type:'notes',title:'Sermon notes',body:'Reviewed slide text',reference:'',layout:'key-points'});
  assert.equal((await request.put(`${base}/api/content`,{data:withNote})).status(),200);
  const endpoint=`${base}/api/notes/channels/notes-test/items/note`,note=async()=>(await request.get(endpoint)).json();
  await page.getByRole('button',{name:'Notes microphone test — presentation',exact:true}).click();
  const dialog=()=>page.getByRole('dialog',{name:'Notes workspace',exact:true});
  const openNote=async()=>{const card=page.getByRole('article',{name:/Slide \d+: Sermon notes/});await card.hover();await card.getByRole('button',{name:'Edit',exact:true}).click();await dialog().getByLabel('Notes draft text',{exact:true}).waitFor();};
  await openNote();
  assert.equal(await dialog().getByLabel('Private transcript text',{exact:true}).count(),0,'New note starts manual even while shared listening runs');
  assert.equal(await dialog().getByLabel('Notes recognition provider',{exact:true}).count(),0,'Linking offers no second audio/provider setup');
  assert.equal((await note()).segments.length,0,'Unlinked Note does not backfill earlier speech');
  assert.equal(await page.evaluate(()=>window.__captures.length),1);
  await dialog().getByRole('button',{name:'Show transcript',exact:true}).click();
  await dialog().getByRole('button',{name:'Link live transcript',exact:true}).click();
  await dialog().getByRole('button',{name:'Unlink transcript',exact:true}).waitFor();
  const linked=await(await request.get(`${endpoint}/listening/link`)).json();assert.equal(linked.sessionId,sourceSession.id);assert.equal(linked.linked,true);
  await until(async()=>(await shared()).session?.linkedNotes===1,'shared link count');
  assert.equal((await note()).segments.length,0,'Link does not copy the current or earlier phrase');
  await page.screenshot({path:path.join(output,'linked-notes-desktop.png'),fullPage:true});
  await dialog().getByRole('button',{name:'Close',exact:true}).click();await dialog().waitFor({state:'hidden'});
  assert.equal(await page.evaluate(()=>window.__captures[0].readyState),'live');
  await until(async()=>(await note()).segments.length>0,'future final speech appended while Notes is closed',24000);
  const closedDocument=await note();assert.ok(closedDocument.segments.every(segment=>segment.sessionId===sourceSession.id&&segment.sequence>linked.afterTurn),'Only new completed turns enter linked Notes');
  assert.equal(closedDocument.draft.body,'Reviewed slide text','Transcript never rewrites the Notes draft');
  assert.equal((await content()).playlists.find(playlist=>playlist.id==='deck').items.find(item=>item.id==='note').body,'Reviewed slide text');
  assert.equal((await shared()).session.id,sourceSession.id);
  checks.push('A new Note remains manual until explicitly linked; only future completed phrases append, including while its dialog is closed');

  await openNote();await dialog().getByRole('button',{name:'Unlink transcript',exact:true}).waitFor();
  assert.equal(await dialog().getByLabel('Private transcript text',{exact:true}).inputValue(),closedDocument.segments.map(segment=>segment.text).join('\n\n'));
  await dialog().getByRole('button',{name:'Use Emerald theme',exact:true}).click();
  await dialog().getByRole('button',{name:'Update slide',exact:true}).click();
  await until(async()=>(await content()).playlists.find(playlist=>playlist.id==='deck').items.find(item=>item.id==='note').background?.color==='#064e3b','linked Note appearance applied');
  assert.equal((await shared()).session.id,sourceSession.id,'Updating a linked Note retains the same shared session');
  assert.equal((await shared()).session.linkedNotes,1,'Updating never detaches the Note');
  assert.equal(await page.evaluate(()=>window.__captures[0].readyState),'live');
  await dialog().getByRole('button',{name:'Unlink transcript',exact:true}).click();await dialog().getByRole('button',{name:'Link live transcript',exact:true}).waitFor();
  const unlinkedDocument=await note(),segmentCount=unlinkedDocument.segments.length,lastIncludedTurn=Math.max(...unlinkedDocument.segments.map(segment=>segment.sequence));
  await until(async()=>(await shared()).session?.linkedNotes===0,'unlinked count');
  assert.equal(await page.evaluate(()=>window.__captures[0].readyState),'live','Unlink does not stop the microphone');
  await dialog().getByLabel('Notes draft text',{exact:true}).fill('A manually written thought, independent of the sermon transcript.');
  await until(async()=>(await note()).draft.body.startsWith('A manually written'),'private manual draft saved');
  assert.equal((await content()).playlists.find(playlist=>playlist.id==='deck').items.find(item=>item.id==='note').body,'Reviewed slide text','Saving a private draft does not publish it');
  await dialog().getByRole('button',{name:'Update slide',exact:true}).click();
  await until(async()=>(await content()).playlists.find(playlist=>playlist.id==='deck').items.find(item=>item.id==='note').body.startsWith('A manually written'),'manual Note applied');
  assert.equal(await dialog().isVisible(),true,'One-step Update keeps Notes open');
  await dialog().getByRole('button',{name:'Close',exact:true}).click();await dialog().waitFor({state:'hidden'});
  assert.match((await content()).playlists.find(playlist=>playlist.id==='deck').items.find(item=>item.id==='note').body,/^A manually written thought/,'Only explicitly applied manual text becomes slide content');
  assert.equal(await page.evaluate(()=>window.__captures[0].readyState),'live','Saving a Note leaves shared listening on');

  await page.getByRole('button',{name:'Scripture — scripture',exact:true}).click();await page.getByRole('heading',{name:'Find a passage',exact:true}).waitFor();
  await until(()=>page.getByTestId('channel-send-live').isEnabled(),'shared scripture prepared');
  const beforeTake=(await shared()).session.id;await page.getByTestId('channel-send-live').click();
  await until(async()=>(await(await request.get(`${base}/api/worship/channels/scripture`)).json()).live?.selection.verse===13,'explicit Scripture take');
  assert.equal((await shared()).session.id,beforeTake,'Sending Scripture live retains the shared listening session');
  assert.equal(await page.evaluate(()=>window.__captures[0].readyState),'live');
  await until(()=>messages.some(message=>message.type==='result'&&message.final&&message.turn>lastIncludedTurn),'another final turn after unlink',18000);
  assert.equal((await note()).segments.length,segmentCount,'Unlinked Note receives no later finalized turns');
  assert.equal(connections.length,1,'All workspaces share one ASR websocket');assert.equal(starts.length,1,'Only one recognition session is started');assert.equal(await page.evaluate(()=>window.__captures.length),1,'Only one microphone acquisition across navigation and linking');
  checks.push('Unlinking and saving manual Notes leave the stream active; subsequent speech is not appended, and Scripture Send live preserves the same session');
  await page.screenshot({path:path.join(output,'shared-scripture-desktop.png'),fullPage:true});
  await page.setViewportSize({width:390,height:844});await page.getByLabel('Shared listening session',{exact:true}).waitFor();
  await page.screenshot({path:path.join(output,'shared-scripture-mobile.png'),fullPage:true});assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth>innerWidth),false);
  await page.getByRole('button',{name:'Listening on — session controls',exact:true}).click();await page.getByRole('button',{name:'Stop shared listening',exact:true}).click();
  await until(()=>page.evaluate(()=>window.__captures.every(track=>track.readyState==='ended')),'global Stop releases microphone');
  await until(async()=>!(await shared()).session,'shared session closes',7000);
  assert.equal((await note()).segments.length,segmentCount);assert.deepEqual((await(await request.get(`${base}/api/studio`)).json()).program,studioBefore.program,'Manual channel publication never switches Studio Program');
  assert.deepEqual(errors,[]);
  checks.push('Global Stop releases the one microphone/provider session; no automatic Program change and mobile layout remains in bounds');
  await fs.writeFile(path.join(output,'result.json'),JSON.stringify({passed:true,checks,errors,fixture:fixturePath,sourceSessionId:sourceSession.id,excludedThroughTurn:linked.afterTurn,segments:unlinkedDocument.segments,providerConnections:connections.length,recognitionStarts:starts.length,microphoneAcquisitions:1,firstCorrectFromAudioStartMs:messages.find(correct).observedAt-audioStarted,messages,physicalMicrophoneUsed:false},null,2));
  console.log(JSON.stringify({passed:true,checks,output},null,2));
}catch(error){await fs.writeFile(path.join(output,'failure.txt'),String(error)+'\n'+logs);if(page)await page.screenshot({path:path.join(output,'failure.png'),fullPage:true}).catch(()=>{});throw error;}
finally{await browser?.close();if(server&&server.exitCode===null&&server.signalCode===null){const exited=new Promise(resolve=>server.once('exit',resolve));server.kill('SIGTERM');await exited;}await fs.rm(temporary,{recursive:true,force:true});}
