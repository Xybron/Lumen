// Local corpus tooling. No microphone access, downloads, remote APIs, station
// settings changes or real output mutations. Run with the installed tsx runner.
import fs from 'node:fs/promises';
import {createReadStream} from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import {createHash} from 'node:crypto';
import {spawn,execFile} from 'node:child_process';
import ffmpeg from 'ffmpeg-static';
import Database from 'better-sqlite3';
import {SermonManifestSchema,validateCorpusSplits,canonicalEvaluationWav,summarizeEvaluation,evaluationClipsContiguous,type SermonManifest,type EvaluationObservation} from '../src/listening-evaluation.js';
import {LocalListener} from '../src/local-listener.js';
import {LISTENING_RECOGNITION_CONFIG} from '../src/listening-recognition.js';
import {ListeningSessions} from '../src/listening-session.js';
import {WorshipLibrary} from '../src/worship-library.js';
import {DATA_DIR,ROOT} from '../src/paths.js';
import {listeningModel} from '../../shared/listening-models.js';
import {LISTENING_VAD_MODEL} from '../../shared/listening-vad.js';

const help=`Local sermon evaluation (run from the repository root):
  backend/node_modules/.bin/tsx backend/scripts/listening-evaluate.ts prepare --input FILE --out DIR --speaker ID [--language en] [--split development] [--seconds 10] [--start 0] [--duration SECONDS]
  backend/node_modules/.bin/tsx backend/scripts/listening-evaluate.ts draft --manifest FILE [--manifest FILE...] --model ID_OR_PATH --out DRAFT.json [--worker FILE] [--speech-detection auto|neural|energy] [--vad-model FILE]
  backend/node_modules/.bin/tsx backend/scripts/listening-evaluate.ts evaluate --manifest FILE [--manifest FILE...] --model ID_OR_PATH --out REPORT.json [--split evaluation] [--mode assisted|automatic] [--version KJV] [--database FILE] [--worker FILE] [--speech-detection auto|neural|energy] [--vad-model FILE]
  backend/node_modules/.bin/tsx backend/scripts/listening-evaluate.ts export-training --manifest FILE [--manifest FILE...] --out TRAIN.jsonl

prepare creates unreviewed labels. A person must listen and fill transcript,
expectedReferences and reviewed before evaluate/export-training will run.
This evaluates or exports data; it does not train model weights.
draft writes model hypotheses separately; it never fills human labels.
See docs/listening-evaluation.md. All output paths must be new.`;
const [command,...args]=process.argv.slice(2), options=new Map<string,string[]>();
function option(name:string,fallback?:string){const values=options.get(name);if(values&&values.length>1)throw new Error(`--${name} may only be supplied once.`);return values?.[0]??fallback;}
function required(name:string){const value=option(name);if(!value)throw new Error(`--${name} is required.`);return value;}
function numeric(name:string,fallback:number,min:number,max:number){const value=Number(option(name,String(fallback)));if(!Number.isFinite(value)||value<min||value>max)throw new Error(`--${name} must be between ${min} and ${max}.`);return value;}
function allowed(names:string[]){for(const name of options.keys())if(!names.includes(name))throw new Error(`Unknown option --${name}.`);}
async function hashFile(file:string){const hash=createHash('sha256');for await(const chunk of createReadStream(file))hash.update(chunk);return hash.digest('hex');}
async function pipelineSources(){
  const files=['backend/src/local-listener.ts','backend/src/listening-recognition.ts','backend/src/listening-session.ts','backend/src/scripture-reference.ts','backend/src/scripture-quote-match.ts','backend/src/worship-library.ts','backend/src/listening-evaluation.ts','backend/scripts/listening-evaluate.ts','shared/listening-models.js','shared/listening-vad.js'];
  const hashes=Object.fromEntries(await Promise.all(files.map(async file=>[file,await hashFile(path.join(ROOT,file))])));
  return {sourceSha256:createHash('sha256').update(JSON.stringify(hashes)).digest('hex'),files:hashes};
}
async function pipelineProvenance(){
  const git=(args:string[])=>new Promise<string|null>(resolve=>execFile('git',args,{cwd:ROOT,maxBuffer:4*1024*1024},(error,stdout)=>resolve(error?null:stdout.trim())));
  const [gitRevision,status,sources]=await Promise.all([git(['rev-parse','HEAD']),git(['status','--porcelain','--untracked-files=normal']),pipelineSources()]);
  return {gitRevision,gitDirty:status===null?null:status.length>0,...sources,recognitionConfig:LISTENING_RECOGNITION_CONFIG,runtime:{node:process.version,platform:process.platform,arch:process.arch}};
}
async function vadConfiguration(){
  const mode=option('speech-detection','auto');if(!['auto','neural','energy'].includes(mode!))throw new Error('--speech-detection must be auto, neural or energy.');
  const explicit=option('vad-model');if(mode==='energy'&&explicit)throw new Error('--vad-model cannot be combined with energy-only speech detection.');
  if(mode==='energy')return {path:false as const,report:{mode:'energy',model:null}};
  const file=path.resolve(explicit??path.join(DATA_DIR,'ai/models',LISTENING_VAD_MODEL.filename));
  try{return {path:file,report:{mode:'neural',model:{filename:path.basename(file),sha256:await hashFile(file)}}};}
  catch(error){if(explicit||mode==='neural')throw error;return {path:false as const,report:{mode:'energy',model:null}};}
}
async function writeNew(file:string,contents:string){await fs.mkdir(path.dirname(file),{recursive:true});await fs.writeFile(file,contents,{flag:'wx'});}
async function run(program:string,args:string[]){
  await new Promise<void>((resolve,reject)=>{
    const child=spawn(program,args,{stdio:['ignore','ignore','pipe']});let error='';
    child.stderr.on('data',chunk=>{error=(error+chunk).slice(-5000);});
    child.on('error',reject);child.on('exit',(code,signal)=>code===0?resolve():reject(new Error(`Audio conversion failed (${signal??code}): ${error}`)));
  });
}
async function prepare(){
  allowed(['input','out','speaker','language','split','seconds','start','duration']);
  if(!ffmpeg)throw new Error('The installed FFmpeg binary is required.');
  const input=path.resolve(required('input')),out=path.resolve(required('out'));
  if(!(await fs.stat(input)).isFile())throw new Error('--input must name a local audio or video file.');
  const seconds=numeric('seconds',10,3,12),start=numeric('start',0,0,864000),duration=option('duration');
  if(!Number.isInteger(seconds))throw new Error('--seconds must be a whole number from 3 to 12.');
  if(duration!==undefined)numeric('duration',0,.1,864000);
  const metadata=SermonManifestSchema.innerType().omit({clips:true}).parse({schemaVersion:1,speakerId:required('speaker'),language:option('language','en'),split:option('split','development'),source:{filename:path.basename(input),sha256:await hashFile(input)}});
  await fs.mkdir(path.dirname(out),{recursive:true});await fs.mkdir(out);await fs.mkdir(path.join(out,'clips'));
  await run(ffmpeg,['-hide_banner','-loglevel','error','-nostdin','-protocol_whitelist','file,pipe','-ss',String(start),'-i',input,...(duration?['-t',duration]:[]),'-map','0:a:0','-vn','-ac','1','-ar','16000','-af','asetnsamples=n=160:p=0','-c:a','pcm_s16le','-f','segment','-segment_time',String(seconds),'-reset_timestamps','1',path.join(out,'clips','clip-%05d.wav')]);
  const names=(await fs.readdir(path.join(out,'clips'))).filter(name=>/^clip-\d+\.wav$/.test(name)).sort();
  const clips:SermonManifest['clips']=[];let offset=start;
  for(const name of names){
    const file=path.join(out,'clips',name),raw=await fs.readFile(file);
    let wav:Buffer;
    try{wav=canonicalEvaluationWav(raw);}catch(error){
      // FFmpeg may emit a final packet shorter than the worker's minimum.
      if(name===names.at(-1)&&raw.length<4000){await fs.rm(file);console.error('Omitted final audio tail shorter than 0.1 seconds.');continue;}throw error;
    }
    await fs.writeFile(file,wav);const durationSeconds=(wav.length-44)/32000;
    clips.push({id:path.basename(name,'.wav'),audio:`clips/${name}`,sha256:await hashFile(file),startSeconds:offset,durationSeconds,reviewed:false,transcript:null,expectedReferences:null,automaticAllowed:false,notes:''});offset+=durationSeconds;
  }
  const manifest=SermonManifestSchema.parse({...metadata,clips});
  await writeNew(path.join(out,'manifest.json'),JSON.stringify(manifest,null,2)+'\n');
  console.log(JSON.stringify({manifest:path.join(out,'manifest.json'),clips:clips.length,audioSeconds:offset-start,next:'Listen to each clip and fill the human-reviewed transcript and reference labels. No training has occurred.'},null,2));
}
async function loadManifests(){
  const files=options.get('manifest')??[];if(!files.length)throw new Error('At least one --manifest is required.');
  const manifests=await Promise.all(files.map(async file=>({file:path.resolve(file),manifest:SermonManifestSchema.parse(JSON.parse(await fs.readFile(file,'utf8')))})));
  validateCorpusSplits(manifests.map(item=>item.manifest));return manifests;
}
function requireReviewed(manifest:SermonManifest){
  const unreviewed=manifest.clips.filter(clip=>!clip.reviewed||clip.transcript===null||clip.expectedReferences===null);
  if(unreviewed.length)throw new Error(`${manifest.speakerId}: ${unreviewed.length} clip(s) lack human-reviewed labels, starting with ${unreviewed[0].id}. Do not use ASR output as ground truth.`);
}
async function checkedAudio(manifestFile:string,clip:SermonManifest['clips'][number]){
  const file=path.resolve(path.dirname(manifestFile),clip.audio),wav=await fs.readFile(file);
  if(createHash('sha256').update(wav).digest('hex')!==clip.sha256)throw new Error(`Audio changed since import: ${clip.id}. Re-import and review its labels.`);
  const canonical=canonicalEvaluationWav(wav);
  if(Math.abs((canonical.length-44)/32000-clip.durationSeconds)>.001)throw new Error(`Audio duration does not match label: ${clip.id}.`);
  return {file,wav:canonical};
}
async function exportTraining(){
  allowed(['manifest','out']);const manifests=await loadManifests(),selected=manifests.filter(item=>item.manifest.split==='train');
  if(!selected.length)throw new Error('No train-split manifest was supplied. Evaluation/development labels are never exported for training.');
  const rows:object[]=[];
  for(const {file,manifest} of selected){requireReviewed(manifest);for(const clip of manifest.clips){
    const audio=await checkedAudio(file,clip);
    rows.push({audio:audio.file,text:clip.transcript,language:manifest.language,speakerId:manifest.speakerId,sourceSha256:manifest.source.sha256,startSeconds:clip.startSeconds,durationSeconds:clip.durationSeconds,sha256:clip.sha256});
  }}
  const out=path.resolve(required('out'));await writeNew(out,rows.map(row=>JSON.stringify(row)).join('\n')+'\n');
  console.log(JSON.stringify({file:out,clips:rows.length,scope:'Reviewed train split only. Dataset export, not model training.'},null,2));
}
async function draft(){
  allowed(['manifest','model','out','worker','speech-detection','vad-model']);
  const out=path.resolve(required('out'));await fs.access(out).then(()=>{throw new Error('--out already exists; choose a new draft filename.');},()=>{});
  const manifests=await loadManifests(),modelOption=required('model'),known=listeningModel(modelOption);
  const model=known?path.join(DATA_DIR,'ai/models',known.filename):path.resolve(modelOption);
  const executable=path.resolve(option('worker',process.env.LUMEN_WHISPER_SERVER??path.join(DATA_DIR,'ai/whisper.cpp-1.9.5/build/bin',process.platform==='win32'?'whisper-server.exe':'whisper-server'))!);
  const [modelSha256,workerSha256]=await Promise.all([hashFile(model),hashFile(executable)]);
  const vad=await vadConfiguration();
  const pipeline=await pipelineProvenance();
  const temp=await fs.mkdtemp(path.join(os.tmpdir(),'lumen-sermon-draft-')),listener=new LocalListener({dataDir:temp,model,executable,vadModel:vad.path});
  try{
    for(const {file,manifest} of manifests)for(const clip of manifest.clips)await checkedAudio(file,clip);
    const start=performance.now();await listener.start();const warmupMs=Math.round(performance.now()-start),results:object[]=[];
    for(const {file,manifest} of manifests)for(const [index,clip] of manifest.clips.entries()){
      const {wav}=await checkedAudio(file,clip),result=await listener.transcribe(wav,manifest.language,'scripture');
      results.push({speakerId:manifest.speakerId,sourceSha256:manifest.source.sha256,clipId:clip.id,audio:clip.audio,clipSha256:clip.sha256,startSeconds:clip.startSeconds,audioSeconds:clip.durationSeconds,transcript:result.text,recognition:result.recognition,elapsedMs:result.elapsedMs});
      console.error(`${manifest.speakerId} ${clip.id} (${index+1}/${manifest.clips.length}): draft transcribed`);
    }
    const report={schemaVersion:1,createdAt:new Date().toISOString(),scope:'Unverified model hypotheses for listening review. No ground truth, accuracy score, training or manifest changes. A person must listen and independently correct labels.',model:{id:known?.id??'custom',filename:path.basename(model),sha256:modelSha256},worker:{filename:path.basename(executable),sha256:workerSha256},speechDetection:vad.report,pipeline:{...pipeline,sourceChangedDuringRun:(await pipelineSources()).sourceSha256!==pipeline.sourceSha256},warmupMs,manifests:await Promise.all(manifests.map(async item=>({filename:path.basename(item.file),sha256:await hashFile(item.file),speakerId:item.manifest.speakerId,sourceSha256:item.manifest.source.sha256}))),results};
    await writeNew(out,JSON.stringify(report,null,2)+'\n');console.log(JSON.stringify({draft:out,clips:results.length,scope:report.scope},null,2));
  }finally{listener.close();await fs.rm(temp,{recursive:true,force:true});}
}
async function evaluate(){
  allowed(['manifest','model','out','split','version','database','worker','speech-detection','vad-model','mode']);
  const out=path.resolve(required('out'));await fs.access(out).then(()=>{throw new Error('--out already exists; choose a new report filename.');},()=>{});
  const manifests=await loadManifests(),split=option('split','evaluation');
  const mode=option('mode','assisted');if(mode!=='assisted'&&mode!=='automatic')throw new Error('--mode must be assisted or automatic.');
  if(!['development','evaluation'].includes(split!))throw new Error('Evaluate only development or evaluation splits.');
  const selected=manifests.filter(item=>item.manifest.split===split);if(!selected.length)throw new Error(`No ${split}-split manifest was supplied.`);
  for(const {manifest} of selected)requireReviewed(manifest);
  const modelOption=required('model'),known=listeningModel(modelOption);
  const model=known?path.join(DATA_DIR,'ai/models',known.filename):path.resolve(modelOption);
  const executable=path.resolve(option('worker',process.env.LUMEN_WHISPER_SERVER??path.join(DATA_DIR,'ai/whisper.cpp-1.9.5/build/bin',process.platform==='win32'?'whisper-server.exe':'whisper-server'))!);
  const [modelSha256,workerSha256]=await Promise.all([hashFile(model),hashFile(executable)]);
  const database=path.resolve(option('database',path.join(DATA_DIR,'worship.db'))!),version=option('version','KJV')!;
  const temp=await fs.mkdtemp(path.join(os.tmpdir(),'lumen-sermon-evaluation-'));
  const vad=await vadConfiguration();
  const pipeline=await pipelineProvenance();
  const listener=new LocalListener({dataDir:temp,model,executable,vadModel:vad.path});let library:WorshipLibrary|undefined;
  try{
    const snapshot=path.join(temp,'worship.db'),source=new Database(database,{readonly:true,fileMustExist:true});
    try{await source.backup(snapshot);}finally{source.close();}
    const librarySha256=await hashFile(snapshot);library=new WorshipLibrary(snapshot);
    if(!library.versions().some(item=>item.id===version&&item.installed))throw new Error(`${version} is not installed in the supplied library.`);
    // Verify expected passages before running expensive recognition. Missing
    // source text is a dataset setup error, not evidence of model failure.
    for(const {file,manifest} of selected)for(const clip of manifest.clips){await checkedAudio(file,clip);for(const reference of clip.expectedReferences!)library.cue({kind:'scripture',versionId:version,...reference});}
    let audioTime=0;const sessions=new ListeningSessions(library,()=>{},()=>audioTime),rows:Array<EvaluationObservation&Record<string,unknown>>=[];
    const warmupStart=performance.now();await listener.start();const warmupMs=Math.round(performance.now()-warmupStart);
    for(const [index,{file,manifest}] of selected.entries()){
      const channel=`sermon-evaluation-${index}`;let workspace=library.workspace(channel);
      workspace=library.command(channel,workspace.revision,{type:'version',versionId:version});
      audioTime=manifest.clips[0].startSeconds*1000;
      let lease=sessions.start(channel,'offline-evaluation',{mode,language:manifest.language,commands:false});
      for(const [sequence,clip] of manifest.clips.entries()){
        if(sequence&&!evaluationClipsContiguous(manifest.clips[sequence-1],clip)){
          sessions.stop(channel);audioTime=clip.startSeconds*1000;
          lease=sessions.start(channel,'offline-evaluation',{mode,language:manifest.language,commands:false});
        }
        const {wav}=await checkedAudio(file,clip),start=performance.now();
        const result=await listener.transcribe(wav,manifest.language,'scripture');
        audioTime=(clip.startSeconds+clip.durationSeconds)*1000;
        sessions.renew(channel,lease.id,'offline-evaluation');
        const matched=sessions.accept(channel,lease.id,'offline-evaluation',sequence,'scripture',result.text,result.elapsedMs,library.workspace(channel).revision,result.recognition);
        const selection=matched.candidate?.selection,predictedReference=selection?.kind==='scripture'?{book:selection.book,chapter:selection.chapter,verse:selection.verse,...(selection.endVerse?{endVerse:selection.endVerse}:{})}:null;
        rows.push({speakerId:manifest.speakerId,clipId:clip.id,sourceSha256:manifest.source.sha256,startSeconds:clip.startSeconds,transcript:result.text,expectedTranscript:clip.transcript!,expectedReferences:clip.expectedReferences!,predictedReference,automaticAllowed:clip.automaticAllowed,published:matched.switched,decision:matched.decision,reason:matched.reason,recognition:result.recognition,elapsedMs:Math.round(performance.now()-start),recognitionMs:result.elapsedMs,audioSeconds:clip.durationSeconds});
        console.error(`${manifest.speakerId} ${clip.id} (${sequence+1}/${manifest.clips.length}): ${matched.decision}`);
      }
      sessions.stop(channel);
    }
    const speakers=[...new Set(rows.map(row=>row.speakerId))].map(speakerId=>({speakerId,...summarizeEvaluation(rows.filter(row=>row.speakerId===speakerId))}));
    const wordErrorSpeakers=speakers.filter(speaker=>speaker.wordErrorRate!==null).sort((a,b)=>b.wordErrorRate!-a.wordErrorRate!);
    const report={schemaVersion:1,createdAt:new Date().toISOString(),scope:'Offline sequential clip evaluation on a private library snapshot. Session timing uses source audio timestamps and resets across gaps. No model training or live output. Processing latency excludes capture-window duration and model warmup; this is not a live microphone end-to-end benchmark.',mode,split,version,model:{id:known?.id??'custom',filename:path.basename(model),sha256:modelSha256},worker:{filename:path.basename(executable),sha256:workerSha256},speechDetection:vad.report,pipeline:{...pipeline,sourceChangedDuringRun:(await pipelineSources()).sourceSha256!==pipeline.sourceSha256},librarySha256,warmupMs,manifests:await Promise.all(manifests.map(async item=>({filename:path.basename(item.file),sha256:await hashFile(item.file),split:item.manifest.split,speakerId:item.manifest.speakerId,sourceSha256:item.manifest.source.sha256}))),summary:summarizeEvaluation(rows),speakers,worstSpeakerByWordErrorRate:wordErrorSpeakers[0]?.speakerId??null,results:rows};
    await writeNew(out,JSON.stringify(report,null,2)+'\n');console.log(JSON.stringify({report:out,summary:report.summary,speakers:report.speakers},null,2));
  }finally{listener.close();library?.close();await fs.rm(temp,{recursive:true,force:true});}
}

try{
  if(!command||command==='--help'||command==='help'){console.log(help);}
  else{
    for(let i=0;i<args.length;i+=2){const key=args[i],value=args[i+1];if(!key?.startsWith('--')||!value||value.startsWith('--'))throw new Error(`Expected --option value, got ${key??''}.`);const name=key.slice(2);options.set(name,[...(options.get(name)??[]),value]);}
    if(command==='prepare')await prepare();else if(command==='draft')await draft();else if(command==='evaluate')await evaluate();else if(command==='export-training')await exportTraining();else throw new Error(`Unknown command ${command}. Run with --help.`);
  }
}catch(error){console.error(error instanceof Error?error.message:String(error));process.exitCode=1;}
