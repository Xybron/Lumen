import { z } from 'zod';

const referenceSchema = z.object({
  book:z.number().int().min(1).max(66), chapter:z.number().int().min(1).max(150),
  verse:z.number().int().min(1).max(200), endVerse:z.number().int().min(1).max(200).optional(),
}).strict().refine(value=>value.endVerse===undefined||value.endVerse>=value.verse&&value.endVerse-value.verse<12,'A reference must span 1–12 verses.');
export type EvaluationReference = z.infer<typeof referenceSchema>;
export const SermonManifestSchema = z.object({
  schemaVersion:z.literal(1), speakerId:z.string().trim().min(1).max(100),
  language:z.string().regex(/^[a-z]{2}$/), split:z.enum(['train','development','evaluation']),
  source:z.object({filename:z.string().min(1),sha256:z.string().regex(/^[a-f0-9]{64}$/)}).strict(),
  clips:z.array(z.object({
    id:z.string().regex(/^[\w-]{1,100}$/), audio:z.string().regex(/^clips\/[\w-]+\.wav$/),
    sha256:z.string().regex(/^[a-f0-9]{64}$/), startSeconds:z.number().finite().nonnegative(),
    durationSeconds:z.number().min(.1).max(12), reviewed:z.boolean(),
    transcript:z.string().max(12000).nullable(), expectedReferences:z.array(referenceSchema).max(20).nullable(),
    automaticAllowed:z.boolean(), notes:z.string().max(2000),
  }).strict()).min(1).max(50000),
}).strict().superRefine((manifest,ctx)=>{
  const ids=new Set<string>(),audio=new Set<string>();let previousEnd=-1;
  manifest.clips.forEach((clip,index)=>{
    if(ids.has(clip.id)||audio.has(clip.audio))ctx.addIssue({code:'custom',path:['clips',index],message:'Clip IDs and audio paths must be unique.'});
    ids.add(clip.id);audio.add(clip.audio);
    if(clip.startSeconds<previousEnd-.001)ctx.addIssue({code:'custom',path:['clips',index],message:'Clips must be ordered and non-overlapping.'});
    previousEnd=clip.startSeconds+clip.durationSeconds;
    if(clip.reviewed&&(clip.transcript===null||clip.expectedReferences===null))ctx.addIssue({code:'custom',path:['clips',index],message:'Reviewed clips require a human transcript and reference labels (empty is valid).'});
    if(clip.automaticAllowed&&!clip.expectedReferences?.length)ctx.addIssue({code:'custom',path:['clips',index],message:'Automatic publication requires an expected reference.'});
  });
});
export type SermonManifest = z.infer<typeof SermonManifestSchema>;

/** Clip boundaries are defined by source audio, never inference wall time. */
export function evaluationClipsContiguous(previous:Pick<SermonManifest['clips'][number],'startSeconds'|'durationSeconds'>|undefined,current:Pick<SermonManifest['clips'][number],'startSeconds'>):boolean {
  return !!previous&&Math.abs(current.startSeconds-(previous.startSeconds+previous.durationSeconds))<=.001;
}

/** Speakers and recordings are held out together, including different cuts of a recording. */
export function validateCorpusSplits(manifests:SermonManifest[]) {
  const speakers=new Map<string,string>(),sources=new Map<string,string>();
  const clips=new Set<string>();
  const audioSplits=new Map<string,string>();
  const intervals=new Map<string,Array<{start:number;end:number;id:string}>>();
  for(const manifest of manifests){
    for(const [key,seen,label] of [[manifest.speakerId,speakers,'Speaker'],[manifest.source.sha256,sources,'Source recording']] as const){
      const split=seen.get(key);
      if(split&&split!==manifest.split)throw new Error(`${label} ${key} appears in both ${split} and ${manifest.split}. Hold out entire speakers and source recordings.`);
      seen.set(key,manifest.split);
    }
    for(const clip of manifest.clips){
      const key=`${manifest.source.sha256}:${clip.startSeconds}:${clip.durationSeconds}`;
      if(clips.has(key))throw new Error(`Duplicate source interval in corpus: ${clip.id}.`);
      clips.add(key);
      const split=audioSplits.get(clip.sha256);
      if(split&&split!==manifest.split)throw new Error(`Identical clip audio ${clip.id} appears in both ${split} and ${manifest.split}. Keep duplicate audio in one split.`);
      audioSplits.set(clip.sha256,manifest.split);
      const sourceIntervals=intervals.get(manifest.source.sha256)??[];
      sourceIntervals.push({start:clip.startSeconds,end:clip.startSeconds+clip.durationSeconds,id:clip.id});
      intervals.set(manifest.source.sha256,sourceIntervals);
    }
  }
  for(const sourceIntervals of intervals.values()){
    sourceIntervals.sort((a,b)=>a.start-b.start);
    let previousEnd=-1;
    for(const interval of sourceIntervals){
      if(interval.start<previousEnd-.001)throw new Error(`Overlapping source intervals in corpus: ${interval.id}. Different cuts of the same speech must not be counted twice.`);
      previousEnd=Math.max(previousEnd,interval.end);
    }
  }
}

export function evaluationWords(text:string) {
  // Preserve spoken number words and lexical substitutions. A scoring normalizer
  // must not silently turn a wrongly recognised number into a correct citation.
  return text.normalize('NFKC').toLocaleLowerCase('en').replace(/[’‘]/g,"'").match(/[\p{L}\p{N}]+(?:'[\p{L}\p{N}]+)*/gu)??[];
}
export function wordErrors(expected:string,actual:string) {
  const gold=evaluationWords(expected),heard=evaluationWords(actual);
  let row=Array.from({length:heard.length+1},(_,i)=>i);
  for(let i=1;i<=gold.length;i++){
    const next=[i];
    for(let j=1;j<=heard.length;j++)next[j]=Math.min(row[j]+1,next[j-1]+1,row[j-1]+Number(gold[i-1]!==heard[j-1]));
    row=next;
  }
  return {errors:row[heard.length],referenceWords:gold.length,hypothesisWords:heard.length};
}
function referenceKey(value:EvaluationReference){return `${value.book}:${value.chapter}:${value.verse}-${value.endVerse??value.verse}`;}
export interface EvaluationObservation {
  speakerId:string; transcript:string; expectedTranscript:string; expectedReferences:EvaluationReference[];
  predictedReference:EvaluationReference|null; automaticAllowed:boolean; published:boolean;
  elapsedMs:number; audioSeconds:number;
}
function ratio(n:number,d:number){return d?n/d:null;}
function percentile(values:number[],fraction:number){if(!values.length)return null;const sorted=[...values].sort((a,b)=>a-b);return sorted[Math.max(0,Math.ceil(sorted.length*fraction)-1)];}
export function summarizeEvaluation(rows:EvaluationObservation[]) {
  let errors=0,referenceWords=0,correctCandidates=0,wrongCandidates=0,expectedCount=0,missedReferences=0;
  let positives=0,abstainedOnPositive=0,negativeClips=0,falsePositiveClips=0,publications=0,incorrectPublications=0;
  let silentClips=0,silenceInsertions=0,audioSeconds=0,elapsedMs=0;
  for(const row of rows){
    const words=wordErrors(row.expectedTranscript,row.transcript);errors+=words.errors;referenceWords+=words.referenceWords;
    if(!words.referenceWords){silentClips++;silenceInsertions+=words.hypothesisWords;}
    const expected=new Set(row.expectedReferences.map(referenceKey));expectedCount+=expected.size;
    const correct=row.predictedReference!==null&&expected.has(referenceKey(row.predictedReference));
    if(row.predictedReference){if(correct)correctCandidates++;else wrongCandidates++;}
    missedReferences+=expected.size-Number(correct);
    if(expected.size){positives++;if(!row.predictedReference)abstainedOnPositive++;}
    else {negativeClips++;if(row.predictedReference)falsePositiveClips++;}
    if(row.published){publications++;if(!correct||!row.automaticAllowed)incorrectPublications++;}
    audioSeconds+=row.audioSeconds;elapsedMs+=row.elapsedMs;
  }
  return {
    clips:rows.length,wordErrors:errors,referenceWords,wordErrorRate:ratio(errors,referenceWords),silentClips,silenceInsertedWords:silenceInsertions,
    expectedReferences:expectedCount,correctCandidates,wrongCandidates,missedReferences,
    candidatePrecision:ratio(correctCandidates,correctCandidates+wrongCandidates),referenceRecall:ratio(correctCandidates,expectedCount),
    positiveClips:positives,abstainedOnPositive,positiveAbstentionRate:ratio(abstainedOnPositive,positives),
    negativeClips,falsePositiveClips,falsePositiveRate:ratio(falsePositiveClips,negativeClips),
    publications,incorrectPublications,publicationErrorRate:ratio(incorrectPublications,publications),
    audioSeconds,elapsedMs,realTimeFactor:ratio(elapsedMs,audioSeconds*1000),
    latencyMs:{p50:percentile(rows.map(row=>row.elapsedMs),.5),p95:percentile(rows.map(row=>row.elapsedMs),.95)},
  };
}

/** FFmpeg WAV output can contain LIST/JUNK chunks; the local worker wants canonical PCM. */
export function canonicalEvaluationWav(input:Buffer) {
  if(input.toString('ascii',0,4)!=='RIFF'||input.toString('ascii',8,12)!=='WAVE')throw new Error('Expected a PCM WAV file.');
  let format:Buffer|undefined,data:Buffer|undefined;
  for(let offset=12;offset+8<=input.length;){
    const name=input.toString('ascii',offset,offset+4),size=input.readUInt32LE(offset+4),start=offset+8;
    if(start+size>input.length)throw new Error('Truncated WAV chunk.');
    if(name==='fmt ')format=input.subarray(start,start+size);
    if(name==='data')data=input.subarray(start,start+size);
    offset=start+size+(size%2);
  }
  if(!format||format.length<16||format.readUInt16LE(0)!==1||format.readUInt16LE(2)!==1||format.readUInt32LE(4)!==16000||format.readUInt16LE(14)!==16||!data||data.length%2)throw new Error('Expected mono 16 kHz, 16-bit PCM audio.');
  if(data.length<3200||data.length>384000)throw new Error('Each evaluation window must contain 0.1–12 seconds of audio.');
  const out=Buffer.alloc(44+data.length);out.write('RIFF');out.writeUInt32LE(out.length-8,4);out.write('WAVEfmt ',8);out.writeUInt32LE(16,16);out.writeUInt16LE(1,20);out.writeUInt16LE(1,22);out.writeUInt32LE(16000,24);out.writeUInt32LE(32000,28);out.writeUInt16LE(2,32);out.writeUInt16LE(16,34);out.write('data',36);out.writeUInt32LE(data.length,40);data.copy(out,44);return out;
}
