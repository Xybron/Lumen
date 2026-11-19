/** Explicit opt-in cloud benchmark. Never imported by the live application. */
import fs from 'node:fs/promises';
import path from 'node:path';
import {parseEnv} from 'node:util';
import {createHash} from 'node:crypto';
import {fileURLToPath} from 'node:url';
import {spawnSync} from 'node:child_process';
import {tmpdir} from 'node:os';
import WebSocket from 'ws';
import Database from 'better-sqlite3';
import ffmpeg from 'ffmpeg-static';
import {SermonManifestSchema,canonicalEvaluationWav,summarizeEvaluation,validateCorpusSplits} from '../src/listening-evaluation.js';
import {ListeningSessions} from '../src/listening-session.js';
import {WorshipLibrary} from '../src/worship-library.js';
import {StreamingEvidenceGate} from '../src/streaming-scripture.js';
import {BOOK_NAMES} from '../src/scripture-reference.js';

const ROOT=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'../..');
const CORPUS=path.join(ROOT,'data/ai/corpus/ogyiri-asare-evaluation-2026-11-12');
const option=(name:string)=>process.argv.slice(3).find(value=>value.startsWith(`--${name}=`))?.slice(name.length+3);
const OUT=path.resolve(option('out')??path.join(ROOT,'data/ai/corpus/commercial-comparison-2026-11-18'));
const hash=(data:Buffer|string)=>createHash('sha256').update(data).digest('hex');
const sleep=(ms:number)=>new Promise(resolve=>setTimeout(resolve,Math.max(0,ms)));
const round=(n:number)=>Math.round(n);
const profiles={
  assemblyai:{model:'assemblyai-stt-3-7-realtime-agent',key:'ASSEMBLYAI_API_KEY',ratePerMinute:.55/60},
  deepgram:{model:'nova-3',key:'DEEPGRAM_API_KEY',ratePerMinute:.0048+.0013},
  openai:{model:'gpt-live-transcribe',key:'OPENAI_API_KEY',ratePerMinute:.017},
} as const;
type Provider=keyof typeof profiles;
// Same vocabulary for all providers. No gold transcript, chapter or verse hints.
const vocabulary=[...BOOK_NAMES];
export class TranscriptState {
  chunks=new Map<string,string>();
  ingest(provider:Provider,event:any):string|null {
    if(provider==='deepgram'&&event.type==='Results') {
      const text=event.channel?.alternatives?.[0]?.transcript??'';
      if(event.is_final){if(text.trim())this.chunks.set(String(event.start),text);return [...this.chunks.values()].join(' ').trim();}
      return [...this.chunks.values(),text].join(' ').trim();
    }
    if(provider==='assemblyai'&&event.type==='Turn') {
      this.chunks.set(String(event.turn_order),event.transcript??'');
      return [...this.chunks.entries()].sort(([a],[b])=>Number(a)-Number(b)).map(([,v])=>v).join(' ').trim();
    }
    if(provider==='openai'&&event.type==='conversation.item.input_audio_transcription.delta') {
      this.chunks.set(event.item_id,(this.chunks.get(event.item_id)??'')+(event.delta??''));return [...this.chunks.values()].join(' ').trim();
    }
    if(provider==='openai'&&event.type==='conversation.item.input_audio_transcription.completed') {
      this.chunks.set(event.item_id,event.transcript??'');return [...this.chunks.values()].join(' ').trim();
    }
    return null;
  }
  get text(){return [...this.chunks.values()].join(' ').trim();}
}
export function stableCorrectTime(events:{atMs:number;reference:any}[],expected:any[]) {
  const key=(x:any)=>x?`${x.book}:${x.chapter}:${x.verse}:${x.endVerse??x.verse}`:'';
  const gold=new Set(expected.map(key));if(!gold.size)return null;
  let since:number|null=null;
  for(const event of events){if(gold.has(key(event.reference))){since??=event.atMs;}else since=null;}
  return since;
}
function config(provider:Provider,key:string) {
  if(provider==='deepgram'){
    const url=new URL('wss://api.deepgram.com/v1/listen');
    for(const [k,v]of Object.entries({model:profiles.deepgram.model,language:'en',encoding:'linear16',sample_rate:'16000',channels:'1',interim_results:'true',punctuate:'true',endpointing:'false'}))url.searchParams.set(k,v);
    for(const term of vocabulary)url.searchParams.append('keyterm',term);
    return {url:String(url),headers:{Authorization:`Token ${key}`}};
  }
  if(provider==='assemblyai'){
    const url=new URL('wss://streaming.assemblyai.com/v3/ws');
    for(const [k,v]of Object.entries({sample_rate:'16000',encoding:'pcm_s16le',speech_model:profiles.assemblyai.model,mode:'manual',language_codes:JSON.stringify(['en']),keyterms_prompt:JSON.stringify(vocabulary),voice_focus:'near-field',voice_focus_threshold:'0.5',previous_context_n_turns:'0'}))url.searchParams.set(k,v);
    return {url:String(url),headers:{Authorization:key}};
  }
  return {url:'wss://api.openai.com/v1/realtime?intent=transcription',headers:{Authorization:`Bearer ${key}`}};
}
async function connect(provider:Provider,key:string,onEvent:(event:any)=>void) {
  const c=config(provider,key),ws=new WebSocket(c.url,{headers:c.headers,handshakeTimeout:12000});
  let ready=false,error:Error|undefined;
  let resolveReady:()=>void=()=>{};
  let rejectReady:(error:Error)=>void=()=>{};
  const readyPromise=new Promise<void>((resolve,reject)=>{resolveReady=resolve;rejectReady=reject;});
  const fail=(message:string)=>{error=new Error(message);rejectReady(error);};
  ws.on('error',()=>fail('WebSocket connection error; no credential or request headers logged.'));
  ws.on('unexpected-response',(_req,res)=>{res.resume();fail(`Provider rejected handshake (HTTP ${res.statusCode}).`);ws.terminate();});
  ws.on('close',(code,reason)=>{if(!ready)fail(`Connection closed before ready (${code}): ${reason.toString().slice(0,400)}`);else if(code!==1000)error=new Error(`Stream closed (${code}): ${reason.toString().slice(0,400)}`);});
  ws.on('open',()=>{
    if(provider==='deepgram'){ready=true;resolveReady();}
    if(provider==='openai')ws.send(JSON.stringify({type:'session.update',session:{type:'transcription',audio:{input:{format:{type:'audio/pcm',rate:24000},transcription:{model:profiles.openai.model,languages:['en'],keywords:vocabulary,delay:'medium'},turn_detection:null}}}}));
  });
  ws.on('message',raw=>{
    let event:any;try{event=JSON.parse(String(raw));}catch{fail('Provider returned invalid JSON.');return;}
    if(event.type==='error'||event.error||event.type==='conversation.item.input_audio_transcription.failed') {fail(`Provider error: ${JSON.stringify(event.error??event).slice(0,700)}`);return;}
    if(provider==='assemblyai'&&event.type==='Begin'||provider==='openai'&&event.type==='session.updated'){ready=true;resolveReady();}
    onEvent(event);
  });
  const timeout=setTimeout(()=>fail('Provider readiness timed out.'),18000);
  try{await readyPromise;}catch(e){ws.terminate();throw e;}finally{clearTimeout(timeout);}
  return {ws,check(){if(error)throw error;if(ws.readyState!==WebSocket.OPEN)throw new Error('Stream is no longer open.');},async close(){
    if(ws.readyState===WebSocket.OPEN){if(provider==='assemblyai')ws.send(JSON.stringify({type:'Terminate'}));if(provider==='deepgram')ws.send(JSON.stringify({type:'CloseStream'}));await sleep(200);ws.close();}
    setTimeout(()=>ws.terminate(),500).unref();
  }};
}
export async function resampleForOpenAI(pcm:Buffer) {
  const temporary=await fs.mkdtemp(path.join(tmpdir(),'lumen-cloud-audio-'));
  try {
    const input=path.join(temporary,'input.pcm'),output=path.join(temporary,'output.pcm');
    await fs.writeFile(input,pcm);
    // File input/output avoids a blocked synchronous pipe on the final short
    // clip. A hard deadline also prevents conversion from holding a session.
    const conversion=spawnSync(ffmpeg!,['-nostdin','-hide_banner','-loglevel','error','-y','-f','s16le','-ar','16000','-ac','1','-i',input,'-f','s16le','-ar','24000','-ac','1',output],{timeout:10000,killSignal:'SIGKILL'});
    if(conversion.status!==0)throw new Error('Audio resampling failed or exceeded its 10-second deadline.');
    return await fs.readFile(output);
  } finally {await fs.rm(temporary,{recursive:true,force:true});}
}
async function stream(provider:Provider,key:string,wav:Buffer,match:(text:string,final?:boolean,turn?:number,atMs?:number)=>any) {
  const state=new TranscriptState(),events:any[]=[],metadata:any[]=[];let started=0,ended=0,finished=false,finalAt=0;
  const pcm=provider==='openai'?await resampleForOpenAI(wav.subarray(44)):wav.subarray(44),rate=provider==='openai'?24000:16000;
  const setupStart=performance.now();
  const connection=await connect(provider,key,event=>{
    if(['Begin','Metadata','Termination','session.updated'].includes(event.type)){
      // Whitelist metadata: no request objects or credential fields are persisted.
      metadata.push({type:event.type,configuration:event.configuration,model:event.session?.audio?.input?.transcription?.model,request_id:event.request_id,model_info:event.model_info,audio_duration_seconds:event.audio_duration_seconds,session_duration_seconds:event.session_duration_seconds});
    }
    const text=state.ingest(provider,event);
    if(text!==null&&started){const isFinal=!!(event.is_final??event.end_of_turn??event.type.endsWith('.completed'));const reference=match(text,isFinal,event.turn_order??0,performance.now()-started),atMs=performance.now()-started;events.push({atMs:round(atMs),text,reference,final:event.is_final??event.end_of_turn??event.type.endsWith('.completed')});}
    if(ended&&((provider==='deepgram'&&event.type==='Results'&&event.from_finalize)||(provider==='openai'&&event.type==='conversation.item.input_audio_transcription.completed')||(provider==='assemblyai'&&event.type==='Turn'&&event.end_of_turn))){finished=true;finalAt=performance.now();}
  });
  const setupMs=round(performance.now()-setupStart);
  try {
    const chunkBytes=rate*2/10;started=performance.now();
    for(let offset=0;offset<pcm.length;offset+=chunkBytes){
      await sleep(started+offset/(rate*2)*1000-performance.now());connection.check();
      const chunk=pcm.subarray(offset,offset+chunkBytes);
      if(provider==='openai')connection.ws.send(JSON.stringify({type:'input_audio_buffer.append',audio:chunk.toString('base64')}));else connection.ws.send(chunk);
    }
    await sleep(started+pcm.length/(rate*2)*1000-performance.now());ended=performance.now();
    connection.ws.send(JSON.stringify({type:provider==='deepgram'?'Finalize':provider==='assemblyai'?'ForceEndpoint':'input_audio_buffer.commit'}));
    while(!finished&&performance.now()-ended<18000){connection.check();await sleep(30);}
    if(!finished)throw new Error('No final transcript acknowledgement within 18 seconds of the clip boundary.');
    const transcript=state.text;
    return {transcript,events,metadata,setupMs,finalTranscriptFromStartMs:round(finalAt-started),finalizationLagMs:round(finalAt-ended),sessionMs:round(finalAt-setupStart),audioSentSeconds:pcm.length/(rate*2)};
  } finally {await connection.close();}
}
async function main(){
  const command=process.argv[2];if(!['preflight','run'].includes(command)){console.log('Usage: node --import ./backend/node_modules/tsx/dist/loader.mjs backend/scripts/listening-cloud-benchmark.ts preflight|run [--out=directory] [--provider=assemblyai|deepgram|openai] [--clips=baseline/clip-id,stress/clip-id]');return;}
  const env=parseEnv(await fs.readFile(path.join(ROOT,'.env'),'utf8'));
  const secrets=Object.values(profiles).map(p=>env[p.key]).filter((value):value is string=>!!value);
  const safe=(value:unknown)=>{let text=value instanceof Error?value.message:String(value);for(const secret of secrets)text=text.split(secret).join('[REDACTED]');return text;};
  for(const [provider,p]of Object.entries(profiles))if(!env[p.key])throw new Error(`Missing key for ${provider}.`);
  await fs.mkdir(OUT,{recursive:true});
  if(command==='preflight'){
    const results:any[]=[];
    for(const provider of Object.keys(profiles) as Provider[]){
      let metadata:any;
      try{const connection=await connect(provider,env[profiles[provider].key]!,event=>{if(event.type==='Begin')metadata=event.configuration;});await connection.close();results.push({provider,requestedModel:profiles[provider].model,ready:true,metadata});}
      catch(error){results.push({provider,ready:false,error:safe(error)});}
      console.log(JSON.stringify(results.at(-1)));
    }
    await fs.writeFile(path.join(OUT,`preflight-${Date.now()}.json`),JSON.stringify(results,null,2));return;
  }
  const manifests=await Promise.all(['baseline/manifest.json','stress/scored-manifest.json'].map(async name=>({group:name.split('/')[0],file:path.join(CORPUS,name),manifest:SermonManifestSchema.parse(JSON.parse(await fs.readFile(path.join(CORPUS,name),'utf8')))})));
  validateCorpusSplits(manifests.map(m=>m.manifest));
  for(const {file,manifest}of manifests)for(const clip of manifest.clips){if(!clip.reviewed||clip.transcript===null||clip.expectedReferences===null)throw new Error('Unreviewed data cannot be uploaded.');const audio=await fs.readFile(path.resolve(path.dirname(file),clip.audio));if(hash(audio)!==clip.sha256)throw new Error('Clip hash mismatch.');}
  const sources=['backend/src/streaming-scripture.ts','backend/src/listening-session.ts','backend/src/scripture-reference.ts','backend/src/scripture-quote-match.ts','backend/src/worship-library.ts','backend/src/listening-evaluation.ts','backend/scripts/listening-cloud-benchmark.ts'];
  const sourceHashes=Object.fromEntries(await Promise.all(sources.map(async f=>[f,hash(await fs.readFile(path.join(ROOT,f)))])));
  const snapshot=path.join(OUT,'library.db');
  try{await fs.access(snapshot);}catch{const original=new Database(path.join(CORPUS,'library-snapshot.db'),{readonly:true});try{await original.backup(snapshot);}finally{original.close();}}
  const libraryHash=hash(await fs.readFile(snapshot)),library=new WorshipLibrary(snapshot);
  const workspace=library.workspace('cloud-benchmark');
  library.command('cloud-benchmark',workspace.revision,{type:'version',versionId:'KJV'});
  const fingerprint=hash(JSON.stringify({sourceHashes,profiles,vocabulary,version:'KJV',manifests:manifests.map(m=>m.manifest)}));
  const recognition={status:'unavailable' as const,reason:'Cloud scores are not calibrated across providers. Prepare only.',avgLogprob:null,noSpeechProbability:null,rejectedSegments:0,totalSegments:0};
  const sessions=new ListeningSessions(library,()=>{throw new Error('Benchmark must not publish.');});
  let gate=new StreamingEvidenceGate();
  const match=(text:string,final=true,turn=0,atMs=0)=>{
    const channel='cloud-benchmark';sessions.stop(channel);const lease=sessions.start(channel,'benchmark',{mode:'assisted',language:'en',commands:false});
    const raw=sessions.accept(channel,lease.id,'benchmark',0,'scripture',text,0,library.workspace(channel).revision,recognition);
    const result=gate.apply(raw,final,turn,atMs);const ref=result.candidate?.selection;return ref?.kind==='scripture'?{book:ref.book,chapter:ref.chapter,verse:ref.verse,...(ref.endVerse?{endVerse:ref.endVerse}:{})}:null;
  };
  const rows:any[]=[],failures:any[]=[];let requests=0;
  try {
    // Sequential, rotating provider order per clip to reduce ordering bias.
    const providers=(Object.keys(profiles) as Provider[]).filter(p=>!option('provider')||p===option('provider'));
    if(!providers.length)throw new Error('Unknown provider filter.');
    const clipFilter=option('clips')?new Set(option('clips')!.split(',')):null;
    let index=0;
    for(const {group,file,manifest}of manifests)for(const clip of manifest.clips){
      if(clipFilter&&!clipFilter.has(`${group}/${clip.id}`))continue;
      const order=providers.map((_,i)=>providers[(i+index)%providers.length]);index++;
      for(const provider of order){
        const destination=path.join(OUT,`${group}-${clip.id}-${provider}.json`);
        let cached:any;try{cached=JSON.parse(await fs.readFile(destination,'utf8'));}catch(error:any){if(error.code!=='ENOENT')throw error;}
        if(cached){if(cached.fingerprint!==fingerprint)throw new Error('Cached benchmark configuration differs; use a fresh output directory.');rows.push(cached);continue;}
        if(failures.some(f=>f.provider===provider))continue;
        if(++requests>45)throw new Error('Request budget exceeded.');
        console.log(`${provider}: ${group} ${clip.id}`);
        try {
          const wav=canonicalEvaluationWav(await fs.readFile(path.resolve(path.dirname(file),clip.audio)));
          gate=new StreamingEvidenceGate();
          const result=await stream(provider,env[profiles[provider].key]!,wav,match);
          const predictedReference=match(result.transcript),stableReferenceFromStartMs=stableCorrectTime(result.events,clip.expectedReferences!);
          const row={fingerprint,provider,model:profiles[provider].model,group,clipId:clip.id,speakerId:manifest.speakerId,startSeconds:clip.startSeconds,audioSha256:clip.sha256,expectedTranscript:clip.transcript,expectedReferences:clip.expectedReferences,automaticAllowed:clip.automaticAllowed,published:false,predictedReference,audioSeconds:clip.durationSeconds,elapsedMs:result.finalTranscriptFromStartMs,stableReferenceFromStartMs,...result};
          await fs.writeFile(destination,JSON.stringify(row,null,2),{flag:'wx'});rows.push(row);
          console.log(JSON.stringify({provider,clip:clip.id,group,reference:predictedReference,finalizationLagMs:result.finalizationLagMs,stableReferenceFromStartMs}));
        }catch(error){const failure={provider,group,clipId:clip.id,error:safe(error)};failures.push(failure);console.log(JSON.stringify(failure));}
      }
    }
    const sourceChanged=[];for(const [f,sha]of Object.entries(sourceHashes))if(hash(await fs.readFile(path.join(ROOT,f)))!==sha)sourceChanged.push(f);
    const summary=Object.fromEntries(providers.map(provider=>[provider,Object.fromEntries(manifests.map(({group})=>[group,summarizeEvaluation(rows.filter(r=>r.provider===provider&&r.group===group))]))]));
    const report={fingerprint,version:'KJV',createdAt:new Date().toISOString(),profiles,vocabulary,mode:'assisted',scope:'Cloud streaming of reviewed development clips (see rows for coverage), paced at 1x in 100ms chunks; fresh connection per clip, explicit finalization at clip boundary. Independent clip matching, no cross-clip context, no model training, no live output.',timing:'Stable correct reference is retrospectively measured from clip playback start, not from the spoken reference end (not annotated). Finalization lag starts after the full clip was sent. Connection setup reported separately. One run per clip/provider, not a production latency guarantee.',sourceHashes,sourceChanged,libraryHash,manifestHashes:await Promise.all(manifests.map(async m=>({group:m.group,sha256:hash(await fs.readFile(m.file))}))),summary,failures,rows,cost:'Rates are estimates from published pricing, not actual invoices. Includes one voice-focus profile for AssemblyAI and Bible-book keyterms for all. At most 45 audio requests; 18s post-clip timeout, well below $5 estimated API usage.'};
    await fs.writeFile(path.join(OUT,'comparison.json'),JSON.stringify(report,null,2));
    console.log(JSON.stringify({summary,failures,sourceChanged}));
  }finally{library.close();}
}
if(process.argv[1]&&path.resolve(process.argv[1])===fileURLToPath(import.meta.url))main().catch(error=>{console.error(error instanceof Error?error.message:'Benchmark failed.');process.exitCode=1;});
