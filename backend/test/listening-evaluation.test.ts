import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import {fileURLToPath} from 'node:url';
import {execFile} from 'node:child_process';
import {promisify} from 'node:util';
import {createHash} from 'node:crypto';
import {SermonManifestSchema,validateCorpusSplits,evaluationClipsContiguous,wordErrors,summarizeEvaluation,canonicalEvaluationWav,type SermonManifest,type EvaluationObservation} from '../src/listening-evaluation.js';
import {WorshipLibrary} from '../src/worship-library.js';

const execute=promisify(execFile),root=fileURLToPath(new URL('../../',import.meta.url));
const run=(...args:string[])=>execute(process.execPath,[path.join(root,'backend/node_modules/tsx/dist/cli.mjs'),path.join(root,'backend/scripts/listening-evaluate.ts'),...args],{cwd:root,timeout:30000});
const john={book:43,chapter:3,verse:16};
function manifest(speakerId='speaker-a',split:SermonManifest['split']='evaluation',hash='a'):SermonManifest{return {schemaVersion:1,speakerId,language:'en',split,source:{filename:'sermon.wav',sha256:hash.repeat(64)},clips:[{id:'clip-00000',audio:'clips/clip-00000.wav',sha256:hash.repeat(64),startSeconds:0,durationSeconds:4,reviewed:true,transcript:'John chapter three verse sixteen',expectedReferences:[john],automaticAllowed:true,notes:''}]};}
function wav(seconds=4){
  const out=Buffer.alloc(44+seconds*32000);out.write('RIFF');out.writeUInt32LE(out.length-8,4);out.write('WAVEfmt ',8);out.writeUInt32LE(16,16);out.writeUInt16LE(1,20);out.writeUInt16LE(1,22);out.writeUInt32LE(16000,24);out.writeUInt32LE(32000,28);out.writeUInt16LE(2,32);out.writeUInt16LE(16,34);out.write('data',36);out.writeUInt32LE(out.length-44,40);
  for(let i=44;i<out.length;i+=2)out.writeInt16LE(Math.round(3000*Math.sin(i/10)),i);return out;
}
test('WER counts substitutions, insertions and deletions without disguising wrong numbers',()=>{
  assert.deepEqual(wordErrors('John chapter three verse sixteen','John chapter three verse sixty'),{errors:1,referenceWords:5,hypothesisWords:5});
  assert.deepEqual(wordErrors('the lord is my shepherd','lord is shepherd today'),{errors:3,referenceWords:5,hypothesisWords:4});
  assert.deepEqual(wordErrors('','invented speech'),{errors:2,referenceWords:0,hypothesisWords:2});
  assert.equal(wordErrors('He’s HERE.','he’s here').errors,0);
  assert.equal(wordErrors('verse sixteen','verse 16').errors,1);
});
test('metrics distinguish abstention, false suggestions and incorrect automatic publication',()=>{
  const row:EvaluationObservation={speakerId:'a',expectedTranscript:'John chapter three verse sixteen',transcript:'John chapter three verse sixteen',expectedReferences:[john],predictedReference:john,automaticAllowed:true,published:true,elapsedMs:200,audioSeconds:4};
  const result=summarizeEvaluation([row,{...row,predictedReference:null,published:false},{...row,expectedReferences:[],automaticAllowed:false},{...row,expectedTranscript:'',transcript:'invention',expectedReferences:[],predictedReference:null,published:false,elapsedMs:500}]);
  assert.equal(result.correctCandidates,1);assert.equal(result.wrongCandidates,1);assert.equal(result.referenceRecall,.5);assert.equal(result.candidatePrecision,.5);assert.equal(result.positiveAbstentionRate,.5);assert.equal(result.falsePositiveRate,.5);assert.equal(result.incorrectPublications,1);assert.equal(result.silenceInsertedWords,1);assert.equal(result.latencyMs.p95,500);
  assert.equal(summarizeEvaluation([]).wordErrorRate,null);assert.equal(summarizeEvaluation([]).publicationErrorRate,null);
  const changedRange=summarizeEvaluation([{...row,predictedReference:{...john,endVerse:17}}]);assert.equal(changedRange.correctCandidates,0,'A partially matching range is not an exact correct candidate.');
});
test('corpus validation blocks source/speaker leakage, duplicate clips and unlabelled reviewed data',()=>{
  assert.throws(()=>validateCorpusSplits([manifest(),manifest('speaker-a','train','b')]),/Speaker/);
  assert.throws(()=>validateCorpusSplits([manifest(),manifest('speaker-b','train')]),/Source recording/);
  assert.throws(()=>validateCorpusSplits([manifest(),manifest()]),/Duplicate/);
  assert.doesNotThrow(()=>validateCorpusSplits([manifest(),manifest('speaker-b','train','b')]));
  const labels=manifest();labels.clips[0].transcript=null;assert.equal(SermonManifestSchema.safeParse(labels).success,false);
  labels.clips[0].reviewed=false;assert.equal(SermonManifestSchema.safeParse(labels).success,true);
  labels.clips[0].audio='../outside.wav';assert.equal(SermonManifestSchema.safeParse(labels).success,false);
  const overlap=manifest();overlap.clips.push({...overlap.clips[0],id:'clip-00001',audio:'clips/clip-00001.wav',startSeconds:2});assert.equal(SermonManifestSchema.safeParse(overlap).success,false);
  const overlappingCut=manifest('speaker-b');overlappingCut.clips[0].startSeconds=2;
  assert.throws(()=>validateCorpusSplits([manifest(),overlappingCut]),/Overlapping source intervals/,'Separately prepared cuts cannot count overlapping source speech twice.');
  overlappingCut.clips[0].startSeconds=4;assert.doesNotThrow(()=>validateCorpusSplits([manifest(),overlappingCut]));
  const copiedClip=manifest('speaker-b','train','b');copiedClip.clips[0].sha256=manifest().clips[0].sha256;
  assert.throws(()=>validateCorpusSplits([manifest(),copiedClip]),/Identical clip audio/,'An identical audio clip leaks even if source bytes and speaker IDs differ.');
  const infinite=manifest();infinite.clips[0].startSeconds=Infinity;assert.equal(SermonManifestSchema.safeParse(infinite).success,false);
});
test('evaluation continuity follows adjacent source intervals and never joins a skipped excerpt',()=>{
  const previous={startSeconds:600,durationSeconds:10};
  assert.equal(evaluationClipsContiguous(undefined,{startSeconds:600}),false);
  assert.equal(evaluationClipsContiguous(previous,{startSeconds:610}),true);
  assert.equal(evaluationClipsContiguous(previous,{startSeconds:610.0005}),true,'Sub-millisecond rounding does not create an artificial gap.');
  assert.equal(evaluationClipsContiguous(previous,{startSeconds:612}),false,'Even a short omitted interval must break citation context.');
  assert.equal(evaluationClipsContiguous(previous,{startSeconds:609}),false,'Overlapping clips are not the fixed-clip evaluator input.');
});
test('canonical WAV conversion strips optional chunks and rejects unsupported or overlong audio',()=>{
  const input=wav();const extra=Buffer.alloc(12);extra.write('JUNK');extra.writeUInt32LE(4,4);
  const withJunk=Buffer.concat([input.subarray(0,36),extra,input.subarray(36)]);withJunk.writeUInt32LE(withJunk.length-8,4);
  assert.deepEqual(canonicalEvaluationWav(withJunk),input);
  const stereo=Buffer.from(input);stereo.writeUInt16LE(2,22);assert.throws(()=>canonicalEvaluationWav(stereo),/mono/);
  assert.throws(()=>canonicalEvaluationWav(wav(13)),/0.1–12/);assert.throws(()=>canonicalEvaluationWav(input.subarray(0,100)),/Truncated/);
});
test('CLI imports actual local audio, refuses unreviewed evaluation and exports only reviewed train data',async()=>{
  const temp=await fs.mkdtemp(path.join(os.tmpdir(),'lumen-corpus-test-'));
  try{
    const input=path.join(temp,'input.wav'),out=path.join(temp,'corpus');await fs.writeFile(input,wav(4));
    await run('prepare','--input',input,'--out',out,'--speaker','test-speaker','--split','train','--seconds','3');
    const file=path.join(out,'manifest.json'),data=SermonManifestSchema.parse(JSON.parse(await fs.readFile(file,'utf8')));
    assert.equal(data.clips.length,2);assert.equal(data.clips[0].durationSeconds,3);assert.equal(data.clips[1].durationSeconds,1);assert.equal(data.clips[0].transcript,null);assert.equal(data.clips[0].reviewed,false);
    await assert.rejects(run('export-training','--manifest',file,'--out',path.join(temp,'unreviewed.jsonl')),/lack human-reviewed/);
    data.clips.forEach(clip=>{clip.reviewed=true;clip.transcript='Human corrected text';clip.expectedReferences=[];});await fs.writeFile(file,JSON.stringify(data));
    const training=path.join(temp,'training.jsonl');await run('export-training','--manifest',file,'--out',training);
    const rows=(await fs.readFile(training,'utf8')).trim().split('\n').map(line=>JSON.parse(line));assert.equal(rows.length,2);assert.equal(rows[0].text,'Human corrected text');assert.equal(rows[0].speakerId,'test-speaker');
    await assert.rejects(run('export-training','--manifest',file,'--out',training),/exist/i);
    data.split='evaluation';data.clips[0].reviewed=false;await fs.writeFile(file,JSON.stringify(data));
    await assert.rejects(run('evaluate','--manifest',file,'--model','base.en','--out',path.join(temp,'report.json')),/lack human-reviewed/);
    await assert.rejects(run('export-training','--manifest',file,'--out',path.join(temp,'held-out.jsonl')),/No train-split/);
  }finally{await fs.rm(temp,{recursive:true,force:true});}
});
test('CLI evaluation uses a private library snapshot and reports actual pipeline decisions',async()=>{
  const temp=await fs.mkdtemp(path.join(os.tmpdir(),'lumen-evaluation-test-'));
  try{
    const data=manifest(),audio=wav(),file=path.join(temp,'manifest.json');await fs.mkdir(path.join(temp,'clips'));await fs.writeFile(path.join(temp,data.clips[0].audio),audio);data.clips[0].sha256=createHash('sha256').update(audio).digest('hex');await fs.writeFile(file,JSON.stringify(data));
    const database=path.join(temp,'worship.db'),library=new WorshipLibrary(database);
    library.importBible({version:{id:'KJV',name:'King James Version',attribution:'Public domain'},verses:[{...john,text:'For God so loved the world, that he gave his only begotten Son.'}]});library.close();
    const before=createHash('sha256').update(await fs.readFile(database)).digest('hex');
    const model=path.join(temp,'model.bin');await fs.writeFile(model,'protocol fixture, not model weights');
    const worker=path.join(root,'backend/test/fixtures/local-listener-worker.mjs');await fs.chmod(worker,0o755);
    const draftFile=path.join(temp,'draft.json'),labelsBefore=await fs.readFile(file,'utf8');await run('draft','--manifest',file,'--model',model,'--worker',worker,'--out',draftFile);
    const draft=JSON.parse(await fs.readFile(draftFile,'utf8'));assert.equal(draft.results[0].transcript,'John chapter three verse sixteen');assert.equal(draft.summary,undefined);assert.equal(await fs.readFile(file,'utf8'),labelsBefore,'A draft must never become ground truth automatically.');assert.match(draft.pipeline.sourceSha256,/^[a-f0-9]{64}$/);assert.equal(draft.pipeline.recognitionConfig.version,3);assert.equal(typeof draft.pipeline.sourceChangedDuringRun,'boolean');
    const out=path.join(temp,'report.json');await run('evaluate','--manifest',file,'--model',model,'--worker',worker,'--database',database,'--out',out);
    const report=JSON.parse(await fs.readFile(out,'utf8'));assert.equal(report.summary.clips,1);assert.equal(report.summary.wordErrorRate,0);assert.equal(report.summary.correctCandidates,1);assert.equal(report.summary.incorrectPublications,0);assert.equal(report.mode,'assisted');assert.equal(report.summary.publications,0);assert.equal(report.results[0].decision,'prepared');assert.equal(report.worstSpeakerByWordErrorRate,'speaker-a');assert.equal(report.results[0].recognition.status,'clear');assert.match(report.pipeline.files['backend/src/listening-session.ts'],/^[a-f0-9]{64}$/);assert.equal(report.pipeline.recognitionConfig.version,3);
    // Gold labels score behavior; they must never select the runtime mode.
    data.clips[0].automaticAllowed=false;await fs.writeFile(file,JSON.stringify(data));
    const autoOut=path.join(temp,'auto-report.json');
    await run('evaluate','--manifest',file,'--model',model,'--worker',worker,'--database',database,'--mode','automatic','--out',autoOut);
    const auto=JSON.parse(await fs.readFile(autoOut,'utf8'));
    assert.equal(auto.mode,'automatic');assert.equal(auto.results[0].decision,'sent-live');assert.equal(auto.summary.incorrectPublications,1);
    assert.equal(createHash('sha256').update(await fs.readFile(database)).digest('hex'),before,'Evaluation must not mutate the station library.');
    const check=new WorshipLibrary(database);try{assert.equal(check.db.prepare('SELECT count(*) AS total FROM worship_workspaces').get().total,0);}finally{check.close();}
  }finally{await fs.rm(temp,{recursive:true,force:true});}
});
