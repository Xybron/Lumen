// Opt-in paid smoke test: one reviewed sermon clip through a synthetic browser
// microphone. Never acquires the operator's physical mic or changes real data.
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import {spawn} from 'node:child_process';
import {fileURLToPath} from 'node:url';
import {chromium} from 'playwright-core';
import WebSocket from 'ws';
if(process.env.LUMEN_RUN_ASSEMBLYAI_SMOKE!=='1')throw new Error('Set LUMEN_RUN_ASSEMBLYAI_SMOKE=1 to authorize the reviewed-clip cloud smoke test.');
const root=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'../..'),temporary=await fs.mkdtemp(path.join(os.tmpdir(),'lumen-assembly-live-'));
const output=path.join(root,'data/ai/corpus/assemblyai-improvement-2026-11-18/live-smoke');await fs.mkdir(output,{recursive:true});
const port=3467,base=`http://127.0.0.1:${port}`;let server,browser,page,logs='';const errors=[],checks=[],messages=[];
const until=async(fn,label,timeout=20000)=>{const end=Date.now()+timeout;while(Date.now()<end){if(await fn())return;await new Promise(r=>setTimeout(r,80));}throw new Error(`Timed out: ${label}`);};
try{
  const audio=(await fs.readFile(path.join(root,'data/ai/corpus/ogyiri-asare-evaluation-2026-11-12/baseline/clips/clip-00007.wav'))).toString('base64');
  server=spawn(process.execPath,['backend/dist/server.js'],{cwd:root,env:{...process.env,PORT:String(port),HOST:'127.0.0.1',LUMEN_DATA_DIR:temporary,LUMEN_RENDERER_URL:base},stdio:['ignore','pipe','pipe']});
  server.stdout.on('data',b=>logs+=b);server.stderr.on('data',b=>logs+=b);
  await until(async()=>{try{return(await fetch(`${base}/api/workspace`)).ok;}catch{return false;}},'isolated station',30000);
  browser=await chromium.launch({executablePath:'/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',headless:true,args:['--autoplay-policy=no-user-gesture-required']});
  const context=await browser.newContext({viewport:{width:1440,height:1000}}),request=context.request;
  await context.addInitScript(({audio})=>{
    const media=navigator.mediaDevices;window.__captures=[];
    Object.defineProperty(media,'enumerateDevices',{value:async()=>[{deviceId:'fixture',kind:'audioinput',groupId:'fixture',label:'Reviewed sermon test microphone'}]});
    Object.defineProperty(media,'getUserMedia',{value:async()=>{
      const context=new AudioContext(),destination=context.createMediaStreamDestination(),track=destination.stream.getAudioTracks()[0];
      const stop=track.stop.bind(track);track.stop=()=>{stop();void context.close();};track.getSettings=()=>({deviceId:'fixture',sampleRate:context.sampleRate});
      window.__captures.push(track);await context.resume();
      window.__playClip=async()=>{const data=Uint8Array.from(atob(audio),c=>c.charCodeAt(0));const buffer=await context.decodeAudioData(data.buffer),source=context.createBufferSource();source.buffer=buffer;source.connect(destination);source.start();};
      return destination.stream;
    }});
  },{audio});
  assert.equal((await request.post(`${base}/api/auth/login`,{data:{username:'admin',password:'admin'}})).status(),200);
  assert.equal((await request.put(`${base}/api/content`,{data:{version:2,updatedAt:new Date().toISOString(),settings:{transitionMs:0},music:{mode:'off'},channels:[{id:'scripture',name:'Scripture',kind:'scripture',playlistId:'p',defaultMode:'manual'}],playlists:[{id:'p',name:'Scripture',items:[]}]}})).status(),200);
  const status=await(await request.get(`${base}/api/worship/listening/status`)).json();assert.ok(status.assemblyai.available);assert.ok(!JSON.stringify(status).includes('API_KEY'));
  const anonymous=await browser.newContext();assert.equal((await anonymous.request.post(`${base}/api/worship/channels/scripture/listening`,{data:{provider:'assemblyai',mode:'assisted'}})).status(),401);await anonymous.close();
  assert.equal((await request.post(`${base}/api/worship/channels/scripture/listening`,{data:{provider:'assemblyai',mode:'automatic'}})).status(),422);
  // Wrong-origin upgrades are rejected before making an upstream request.
  const lease=await(await request.post(`${base}/api/worship/channels/scripture/listening`,{data:{provider:'assemblyai',mode:'assisted'}})).json();
  const cookie=(await context.cookies()).map(c=>`${c.name}=${c.value}`).join(';');
  const denied=await new Promise((resolve,reject)=>{const socket=new WebSocket(`ws://127.0.0.1:${port}/worship/listening/stream?channel=scripture&session=${lease.id}`,{headers:{Cookie:cookie,Origin:'https://wrong.example'}});socket.on('message',data=>{resolve(JSON.parse(String(data)));socket.close();});socket.on('error',reject);});assert.equal(denied.type,'error');
  await request.delete(`${base}/api/worship/channels/scripture/listening`);checks.push('Authentication, origin and Prepare-only restrictions enforced before provider audio');
  page=await context.newPage();page.on('pageerror',e=>errors.push(e.message));
  page.on('websocket',socket=>{if(socket.url().includes('/worship/listening/stream'))socket.on('framereceived',({payload})=>{try{messages.push(JSON.parse(String(payload)));}catch{}});});
  await page.goto(base);await page.getByRole('heading',{name:'Find a passage',exact:true}).waitFor();
  assert.equal(await page.evaluate(()=>window.__captures.length),0);
  await page.getByRole('button',{name:'Open listening controls',exact:true}).click();
  await page.getByLabel('Recognition provider',{exact:true}).selectOption('assemblyai');
  assert.equal(await page.getByLabel('Listening mode',{exact:true}).inputValue(),'assisted');
  await until(()=>page.getByLabel('Listening mode',{exact:true}).locator('option[value="automatic"]').evaluate(option=>option.disabled),'automatic mode disabled');
  await page.getByRole('button',{name:'Listen',exact:true}).click();await until(()=>messages.some(m=>m.type==='ready'),'cloud ready');
  await page.evaluate(()=>window.__playClip());
  await until(()=>messages.some(m=>m.type==='result'&&m.result.candidate?.selection.book===9&&m.result.candidate?.selection.chapter===16&&m.result.candidate?.selection.verse===13),'correct live scripture',18000);
  const latest=messages.filter(m=>m.type==='result').at(-1);assert.equal(latest.result.switched,false);
  assert.equal((await(await request.get(`${base}/api/worship/channels/scripture`)).json()).live,null);
  checks.push('Reviewed sermon passes through browser microphone capture, station proxy, AssemblyAI and scripture matcher without publishing');
  assert.ok((await page.locator('.w-transcript').boundingBox()).height>=80,'The live words remain readable');
  await page.screenshot({path:path.join(output,'live-desktop.png'),fullPage:true});
  assert.equal((await(await request.get(`${base}/api/worship/listening/examples?channel=scripture`)).json()).length,0);
  await page.getByRole('button',{name:'Save last 12 seconds for review'}).click();await until(()=>messages.some(m=>m.type==='example'),'saved example');
  const sample=messages.find(m=>m.type==='example').example;assert.equal(sample.reviewed,false);assert.equal(sample.transcript,null);
  await page.getByRole('button',{name:'Stop listening',exact:true}).click();await until(()=>page.evaluate(()=>window.__captures.every(t=>t.readyState==='ended')),'microphone stopped');
  await page.locator('summary').filter({hasText:'Saved listening examples'}).click();
  await page.getByRole('button',{name:/^Review ·/}).click();const dialog=page.getByRole('dialog',{name:'Review microphone example'});await dialog.waitFor();
  await dialog.getByLabel('Example speaker').fill('Automated browser fixture');await dialog.getByLabel('Example notes').fill('Reviewed source audio; captured excerpt still needs human annotation.');
  await Promise.all([page.waitForResponse(response=>response.request().method()==='PATCH'&&response.url().endsWith(`/listening/examples/${sample.id}`)),dialog.getByRole('button',{name:'Save draft',exact:true}).click()]);
  await dialog.waitFor({state:'hidden'});
  const saved=await(await request.get(`${base}/api/worship/listening/examples/${sample.id}`)).json();assert.equal(saved.reviewed,false);assert.equal(saved.speaker,'Automated browser fixture');
  assert.equal((await request.get(`${base}/api/worship/listening/examples/${sample.id}/audio`)).status(),200);
  const other=await browser.newContext();assert.equal((await other.request.get(`${base}/api/worship/listening/examples/${sample.id}/audio`)).status(),401);await other.close();
  await page.reload();await page.getByRole('button',{name:'Open listening controls',exact:true}).click();await page.locator('summary').filter({hasText:'Saved listening examples'}).waitFor();
  await page.setViewportSize({width:390,height:844});await page.screenshot({path:path.join(output,'live-mobile.png'),fullPage:true});assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth>innerWidth),false);
  assert.equal((await request.delete(`${base}/api/worship/listening/examples/${sample.id}`)).status(),200);
  checks.push('Explicit save, private audio, draft review, reload persistence, deletion and microphone shutdown verified');assert.deepEqual(errors,[]);
  await fs.writeFile(path.join(output,'result.json'),JSON.stringify({checks,errors,results:messages.filter(m=>m.type==='result'),fixture:'baseline/clip-00007.wav',livePublication:false},null,2));console.log(JSON.stringify({checks,output},null,2));
}catch(error){await fs.writeFile(path.join(output,'failure.txt'),String(error)+'\n'+logs);if(page)await page.screenshot({path:path.join(output,'failure.png'),fullPage:true}).catch(()=>{});throw error;}
finally{await browser?.close();server?.kill('SIGTERM');if(server)await new Promise(resolve=>{server.once('exit',resolve);setTimeout(resolve,5000).unref();});await fs.rm(temporary,{recursive:true,force:true});}
