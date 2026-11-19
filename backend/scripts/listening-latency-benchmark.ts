/** Explicit opt-in real-time A/B evaluation. Publishes only into an isolated test library. */
import fs from 'node:fs/promises';
import path from 'node:path';
import http from 'node:http';
import {createHash} from 'node:crypto';
import {fileURLToPath} from 'node:url';
import WebSocket from 'ws';
import Database from 'better-sqlite3';
import {AssemblyStream,assemblyUrl,assemblyKey,type AssemblyTurn} from '../src/assemblyai-stream.js';
import {createAssemblyBridge} from '../src/assemblyai-bridge.js';
import {ListeningSessions} from '../src/listening-session.js';
import {WorshipLibrary} from '../src/worship-library.js';
import {analyzeSpokenReferences} from '../src/scripture-reference.js';
import {SermonManifestSchema,canonicalEvaluationWav,validateCorpusSplits} from '../src/listening-evaluation.js';

const ROOT=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'../..');
const CORPUS=path.join(ROOT,'data/ai/corpus/ogyiri-asare-evaluation-2026-11-12');
const option=(name:string)=>process.argv.find(arg=>arg.startsWith(`--${name}=`))?.slice(name.length+3);
const OUT=path.resolve(option('out')??path.join(ROOT,'data/ai/corpus/listening-latency-2026-11-19'));
const sha=(data:Buffer|string)=>createHash('sha256').update(data).digest('hex');
const sleep=(ms:number)=>new Promise(resolve=>setTimeout(resolve,Math.max(0,ms)));
const ref=(selection:any)=>selection?.kind==='scripture'?{book:selection.book,chapter:selection.chapter,verse:selection.verse,...(selection.endVerse?{endVerse:selection.endVerse}:{})}:null;
const refKey=(selection:any)=>selection?`${selection.book}:${selection.chapter}:${selection.verse}:${selection.endVerse??selection.verse}`:'';
type Profile='manual-10s'|'fast-endpoint';
const sources=['backend/src/assemblyai-stream.ts','backend/src/assemblyai-bridge.ts','backend/src/listening-session.ts','backend/src/streaming-scripture.ts','backend/src/streaming-quote-context.ts','backend/src/scripture-reference.ts','backend/src/scripture-quote-match.ts','backend/src/worship-library.ts','backend/scripts/listening-latency-benchmark.ts'];
type Clip={group:string;file:string;clip:any};

function wordEndProxy(turn:AssemblyTurn,reference:any,match:string){
  const words=turn.words??[];
  if(!words.length||words.some(word=>!Number.isFinite(word.end)))return null;
  // Provider-aligned estimate only: no human word-boundary labels exist in this corpus.
  if(match==='reference')for(let i=0;i<words.length;i++){
    const evidence=analyzeSpokenReferences(words.slice(0,i+1).map(word=>word.text).join(' '));
    if(evidence.references.some(item=>item.complete&&refKey(item)===refKey(reference)))return {atMs:words[i].end,method:'provider-aligned first complete citation prefix (not human annotation)'};
  }
  return {atMs:words.at(-1)!.end,method:'provider-aligned end of matching turn (not necessarily end of quotation)'};
}

async function runClip(profile:Profile,input:Clip,key:string,library:WorshipLibrary){
  const {clip,group}=input,channel=`latency-${profile}-${group}-${clip.id}`;
  const initial=library.workspace(channel);library.command(channel,initial.revision,{type:'version',versionId:'KJV'});
  const gold=new Set(clip.expectedReferences.map(refKey));
  let started=0,currentReceivedAt=0,error:Error|undefined,ready=false;
  const events:any[]=[],publishes:any[]=[],finals=new Map<number,string>();
  const sessions=new ListeningSessions(library,workspace=>{
    const atMs=performance.now()-started,reference=ref(workspace.live?.selection);
    publishes.push({atMs,reference,correct:gold.has(refKey(reference)),providerReceivedAtMs:currentReceivedAt,providerToChannelLiveMs:atMs-currentReceivedAt});
  });
  const lease=sessions.start(channel,'latency-test',{provider:'assemblyai',mode:'automatic',language:'en',commands:false});
  const bridge=createAssemblyBridge({sessions,library,drainOnStop:true,key:async()=>key,
    authorize:()=>{sessions.check(channel,lease.id,'latency-test');return 'latency-test';},
    createStream:(secret,onTurn,onError)=>{
      const url=new URL(assemblyUrl());if(profile==='manual-10s')url.searchParams.set('mode','manual');
      const upstream=new AssemblyStream(secret,turn=>{currentReceivedAt=performance.now()-started;onTurn(turn);},onError,String(url));
      let bytes=0;
      return {connected:upstream.connected,send:(pcm:Buffer)=>{upstream.send(pcm);if(profile==='manual-10s'){bytes+=pcm.length;if(bytes>=320000){upstream.finish();bytes=0;}}},finish:()=>upstream.finish(),close:()=>upstream.close()};
    },
    onResult:({turn,result})=>{
      const atMs=performance.now()-started,reference=ref(result.candidate?.selection);
      if(turn.end_of_turn)finals.set(turn.turn_order,turn.transcript);
      const proxy=wordEndProxy(turn,reference,result.match);
      const event={atMs,providerReceivedAtMs:currentReceivedAt,turn:turn.turn_order,final:turn.end_of_turn,transcript:turn.transcript,words:turn.words??[],reference,correct:gold.has(refKey(reference)),match:result.match,decision:result.decision,reason:result.reason,switched:result.switched,wordEndProxy:proxy};
      events.push(event);
      if(result.switched){const published=publishes.at(-1);if(published){published.match=result.match;published.wordEndProxy=proxy;published.wordEndToLiveProxyMs=proxy?published.atMs-proxy.atMs:null;}}
    }
  });
  const server=http.createServer();server.on('upgrade',(req,socket,head)=>bridge.wss.handleUpgrade(req,socket,head,ws=>bridge.wss.emit('connection',ws,req)));
  await new Promise<void>(resolve=>server.listen(0,'127.0.0.1',resolve));
  const ws=new WebSocket(`ws://127.0.0.1:${(server.address() as any).port}/?channel=${channel}&session=${lease.id}`);
  ws.on('error',()=>{error=new Error('Local benchmark connection failed.');});
  ws.on('message',data=>{const message=JSON.parse(String(data));if(message.type==='ready')ready=true;if(message.type==='error')error=new Error(message.message);});
  const setupAt=performance.now();
  try{
    while(!ready&&!error&&performance.now()-setupAt<20000)await sleep(20);
    if(error)throw error;if(!ready)throw new Error('Readiness deadline exceeded.');
    const setupMs=performance.now()-setupAt,wav=canonicalEvaluationWav(await fs.readFile(path.resolve(path.dirname(input.file),clip.audio))),pcm=wav.subarray(44);
    // Eleven seconds of silence allow both profiles to finalize naturally. Never send Stop before measuring publication.
    const padded=Buffer.concat([pcm,Buffer.alloc(352000)]),packetBytes=3200;started=performance.now();
    for(let offset=0;offset<padded.length;offset+=packetBytes){
      await sleep(started+(offset+packetBytes)/32-performance.now());if(error)throw error;
      const packet=Buffer.alloc(packetBytes);padded.copy(packet,0,offset,Math.min(offset+packetBytes,padded.length));ws.send(packet);
    }
    await sleep(400);if(error)throw error;
    const correctLive=publishes.filter(event=>event.correct),incorrectLive=publishes.filter(event=>!event.correct);
    const correctSuggestions=events.filter(event=>event.correct),incorrectSuggestions=events.filter(event=>event.reference&&!event.correct);
    return {profile,group,clipId:clip.id,audioSha256:clip.sha256,audioSeconds:clip.durationSeconds,expectedReferences:clip.expectedReferences,annotationAutomaticAllowed:clip.automaticAllowed,setupMs,transcript:[...finals.entries()].sort(([a],[b])=>a-b).map(([,text])=>text).join(' ').trim(),expectedTranscript:clip.transcript,firstCorrectLiveFromClipStartMs:correctLive[0]?.atMs??null,firstCorrectSuggestionFromClipStartMs:correctSuggestions[0]?.atMs??null,correctLiveCount:correctLive.length,falseLiveCount:incorrectLive.length,falseSuggestionCount:incorrectSuggestions.length,publishes,events};
  }finally{
    ws.terminate();bridge.close();await new Promise<void>(resolve=>server.close(()=>resolve()));
  }
}

async function main(){
  if(process.argv[2]!=='run')throw new Error('Opt in with run [--out=directory] [--clips=baseline/clip-00007,...] [--profiles=manual-10s,fast-endpoint] [--reuse-manual=previous-comparison.json]. Reviewed audio is sent to AssemblyAI.');
  const key=await assemblyKey();if(!key)throw new Error('AssemblyAI key is not configured.');
  const manifests=await Promise.all(['baseline/manifest.json','stress/scored-manifest.json'].map(async name=>({group:name.split('/')[0],file:path.join(CORPUS,name),manifest:SermonManifestSchema.parse(JSON.parse(await fs.readFile(path.join(CORPUS,name),'utf8')))})));
  validateCorpusSplits(manifests.map(m=>m.manifest));
  const filter=option('clips')?.split(','),profiles=(option('profiles')?.split(',')??['manual-10s','fast-endpoint']) as Profile[];
  if(profiles.some(p=>!['manual-10s','fast-endpoint'].includes(p)))throw new Error('Unknown profile.');
  const clips=manifests.flatMap(m=>m.manifest.clips.map(clip=>({group:m.group,file:m.file,clip}))).filter(input=>!filter||filter.includes(`${input.group}/${input.clip.id}`));
  if(!clips.length||clips.length*profiles.length>40)throw new Error('Request budget invalid.');
  for(const input of clips){const clip=input.clip;if(!clip.reviewed||clip.transcript===null||clip.expectedReferences===null)throw new Error('Only reviewed clips may be sent.');if(sha(await fs.readFile(path.resolve(path.dirname(input.file),clip.audio)))!==clip.sha256)throw new Error('Reviewed clip hash mismatch.');}
  await fs.mkdir(OUT,{recursive:true});
  const sourceHashes=Object.fromEntries(await Promise.all(sources.map(async file=>[file,sha(await fs.readFile(path.join(ROOT,file)))])));
  const reusedReport=option('reuse-manual')?JSON.parse(await fs.readFile(path.resolve(option('reuse-manual')!),'utf8')):null;
  const reusedBaselineSourceHashes=reusedReport?.sourceHashes??null;
  const snapshot=path.join(OUT,'library.db');try{await fs.access(snapshot);throw new Error('Use a fresh output directory.');}catch(error:any){if(error.code!=='ENOENT')throw error;}
  const original=new Database(path.join(CORPUS,'library-snapshot.db'),{readonly:true});await original.backup(snapshot);original.close();
  const library=new WorshipLibrary(snapshot),rows:any[]=[],failures:any[]=[],retries:any[]=[];let requests=0;
  try{
    // Positive clips first so a regression is discovered before spending on negatives.
    clips.sort((a,b)=>Number(!!b.clip.expectedReferences!.length)-Number(!!a.clip.expectedReferences!.length));
    for(const input of clips){
      const results=await Promise.allSettled(profiles.map(async profile=>{
        const cached=profile==='manual-10s'?reusedReport?.rows?.find((row:any)=>row.profile===profile&&row.group===input.group&&row.clipId===input.clip.id):undefined;
        if(cached){
          if(cached.audioSha256!==input.clip.sha256||JSON.stringify(cached.expectedReferences)!==JSON.stringify(input.clip.expectedReferences))throw new Error('Reused baseline labels/audio differ.');
          const result={...cached,reusedFrom:path.resolve(option('reuse-manual')!)};
          await fs.writeFile(path.join(OUT,`${profile}-${input.group}-${input.clip.id}.json`),JSON.stringify(result,null,2),{flag:'wx'});
          console.log(`REUSE ${profile} ${input.group}/${input.clip.id}`);return result;
        }
        console.log(`START ${profile} ${input.group}/${input.clip.id}`);
        let result:any;
        for(let attempt=1;attempt<=2;attempt++){
          if(++requests>40)throw new Error('API request budget exceeded.');
          try{result=await runClip(profile,input,key,library);break;}
          catch(error){
            if(attempt===2)throw error;
            retries.push({profile,clip:`${input.group}/${input.clip.id}`,error:String(error).split(key).join('[REDACTED]')});
            // Clear only this test workspace so a retried clip starts with no live cue.
            library.db.prepare('DELETE FROM worship_workspaces WHERE channelId=?').run(`latency-${profile}-${input.group}-${input.clip.id}`);
            console.log(`RETRY ${profile} ${input.group}/${input.clip.id}`);await sleep(1000);
          }
        }
        await fs.writeFile(path.join(OUT,`${profile}-${input.group}-${input.clip.id}.json`),JSON.stringify(result,null,2),{flag:'wx'});
        console.log(JSON.stringify({profile,clip:`${input.group}/${input.clip.id}`,correctLive:result.correctLiveCount,falseLive:result.falseLiveCount,falseSuggestions:result.falseSuggestionCount,liveAtMs:result.firstCorrectLiveFromClipStartMs,proxies:result.publishes.map(event=>event.wordEndToLiveProxyMs)}));
        return result;
      }));
      results.forEach((result,i)=>{if(result.status==='fulfilled')rows.push(result.value);else failures.push({profile:profiles[i],clip:`${input.group}/${input.clip.id}`,error:String(result.reason).split(key).join('[REDACTED]')});});
      if(failures.length)break;
    }
    const sourceChanged=[];for(const [file,hash]of Object.entries(sourceHashes))if(sha(await fs.readFile(path.join(ROOT,file)))!==hash)sourceChanged.push(file);
    const summary=Object.fromEntries(profiles.map(profile=>[profile,Object.fromEntries(['baseline','stress'].map(group=>{
      const selected=rows.filter(row=>row.profile===profile&&row.group===group),positive=selected.filter(row=>row.expectedReferences.length);
      return [group,{clips:selected.length,positiveClips:positive.length,correctlySuggestedPositiveClips:positive.filter(row=>row.firstCorrectSuggestionFromClipStartMs!==null).length,correctlyPublishedPositiveClips:positive.filter(row=>row.correctLiveCount>0).length,falsePublications:selected.reduce((sum,row)=>sum+row.falseLiveCount,0),falseSuggestionEvents:selected.reduce((sum,row)=>sum+row.falseSuggestionCount,0)}];
    }))]));
    const report={createdAt:new Date().toISOString(),scope:'Reviewed development clips, one preacher and one positive passage. Real AssemblyAI audio streamed at1x through production bridge/session matcher into isolated database; no station or public Program output changed. Two concurrent profiles per clip.',timing:'Live time measured at authoritative channel mutation from clip playback start. Optional provider-word-aligned latency is an estimate, not human-annotated last-reference-word timing. Does not measure Program display latency. Connection setup excluded. 11sec silence appended perclip for naturalfinalization; no forced Stop beforemeasurement.',annotationPolicy:'Original automaticAllowed labels remain unchanged. Automatic test leases are intentionally enabled in isolation to measure actual publication behavior against reviewed reference labels; this is not a relabeling or production accuracy guarantee.',sourceHashes,reusedBaselineSourceHashes,sourceChanged,requests,retries,summary,failures,rows};
    await fs.writeFile(path.join(OUT,'comparison.json'),JSON.stringify(report,null,2));console.log(JSON.stringify({summary,failures,sourceChanged}));
    if(failures.length||sourceChanged.length)process.exitCode=1;
  }finally{library.close();}
}
if(process.argv[1]&&path.resolve(process.argv[1])===fileURLToPath(import.meta.url))main().catch(error=>{console.error(error instanceof Error?error.message:'Benchmark failed');process.exitCode=1;});
