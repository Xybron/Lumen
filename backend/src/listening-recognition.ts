import type { ListeningRecognition } from '../../shared/worship.js';

/** Versioned, reportable operating parameters. None are calibrated accuracy. */
export const LISTENING_RECOGNITION_CONFIG=Object.freeze({
  version:3,
  decoder:Object.freeze({beamSize:5,temperature:0,maxContext:0,suppressNonSpeechTokens:true,turboSuppressNonSpeechTokens:false}),
  recovery:Object.freeze({minimumSeconds:8,maximumWordsPerSecond:.5,maximumInitialLogprob:-.4,minimumAddedWords:3}),
  evidence:Object.freeze({rejectLogprob:-1.5,uncertainLogprob:-.8,rejectNoSpeechProbability:.8,uncertainNoSpeechProbability:.6,weakTokenProbability:.1}),
  // Windows are at most 12 seconds. Once any speech is detected, padding and
  // silence duration retain the whole window, avoiding destructive removal of
  // quiet/accented words. Zero extra overlap avoids duplicating retained audio.
  vad:Object.freeze({threshold:.25,minSpeechDurationMs:100,minSilenceDurationMs:12000,speechPadMs:12000,samplesOverlap:0,maxSpeechDurationSeconds:60}),
});
const evidence=LISTENING_RECOGNITION_CONFIG.evidence;

export interface WorkerResult {text?:unknown;segments?:unknown}
type Segment = {text?:unknown;avg_logprob?:unknown;no_speech_prob?:unknown;words?:unknown};
const finite = (value:unknown):value is number => typeof value==='number' && Number.isFinite(value);
const logprob = (value:unknown):number|null => finite(value)&&value<=0?value:null;
const probability = (value:unknown):number|null => finite(value)&&value>=0&&value<=1?value:null;
// Keep the decoder free to emit music markers instead of forcing words.
// Remove only recognised acoustic annotations, never arbitrary bracketed speech.
const acousticMarker = /[♪♫♬]+|\[(?:music|singing|applause|laughter|background music)\]|\((?:music|singing|applause|laughter|background music)\)/gi;
const rawSegmentText = (segment:Segment) => typeof segment.text==='string'?segment.text:'';
const cleanText = (text:string) => text.replace(acousticMarker,' ');
const segmentText = (segment:Segment) => cleanText(rawSegmentText(segment));
const rejected = (segment:Segment) => {
  const log=logprob(segment.avg_logprob),p=probability(segment.no_speech_prob);
  return log!==null && (log < evidence.rejectLogprob || p!==null && p > evidence.rejectNoSpeechProbability && log < evidence.uncertainLogprob);
};

export function noSpeechRecognition():ListeningRecognition {
  return {status:'no-speech',reason:'No clear speech detected.',avgLogprob:null,noSpeechProbability:null,rejectedSegments:0,totalSegments:0};
}

/** Keep raw decoder evidence separate from scripture similarity. Thresholds are
 * conservative operating rules; benchmark and calibrate against held-out voices
 * before interpreting them as accuracy. Missing evidence never means certainty. */
export function analyzeLocalRecognition(result:WorkerResult|null|undefined):{text:string;recognition:ListeningRecognition} {
  const segments=Array.isArray(result?.segments)?result.segments:[];
  const valid=segments.filter((value):value is Segment=>!!value&&typeof value==='object');
  const acoustic=valid.some(segment=>cleanText(rawSegmentText(segment))!==rawSegmentText(segment)) || typeof result?.text==='string'&&cleanText(result.text)!==result.text;
  const spoken=valid.filter(segment=>segmentText(segment).trim());
  const kept=spoken.filter(segment=>!rejected(segment));
  const fullText=(segments.length?kept.map(segmentText).join(''):typeof result?.text==='string'?cleanText(result.text):'').trim();
  const text=fullText.slice(0,4000);
  const logs=spoken.map(segment=>logprob(segment.avg_logprob)).filter((value):value is number=>value!==null);
  const probabilities=spoken.map(segment=>probability(segment.no_speech_prob)).filter((value):value is number=>value!==null);
  const recognition:ListeningRecognition={
    status:'unavailable',reason:'Recognition diagnostics are unavailable. Review the words before publishing.',
    avgLogprob:logs.length?logs.reduce((sum,value)=>sum+value,0)/logs.length:null,
    noSpeechProbability:probabilities.length?Math.max(...probabilities):null,
    rejectedSegments:spoken.length-kept.length,totalSegments:segments.length,
  };
  // Dropped segments can contain a correction or a negation. Never turn the
  // surviving text into a claim that an entire utterance was heard clearly.
  if(fullText.length>4000) {
    recognition.status='uncertain';recognition.reason='The recognition response was too long and has been shortened. Review the audio before publishing.';
  } else if(valid.length!==segments.length||valid.some(segment=>typeof segment.text!=='string')) {
    recognition.status='unavailable';recognition.reason='Some recognition data is incomplete. Review the words before publishing.';
  } else if(recognition.rejectedSegments) {
    recognition.status='uncertain';recognition.reason='Some speech could not be recognised reliably. Review the remaining words; nothing will publish automatically.';
  } else if(!/[\p{L}\p{N}]/u.test(text)) {
    recognition.status='no-speech';recognition.reason='No clear speech detected.';
  } else if(acoustic) {
    recognition.status='uncertain';recognition.reason='Music or other background sounds were detected. Review the words and speaker before publishing.';
  } else if(spoken.length && logs.length===spoken.length && probabilities.length===spoken.length && valid.length===segments.length) {
    const weakToken=spoken.some(segment=>Array.isArray(segment.words)&&segment.words.some(word=>
      word&&typeof word==='object'&&typeof word.word==='string'&&/[\p{L}\p{N}]/u.test(word.word)&&
      probability(word.probability)!==null&&word.probability<evidence.weakTokenProbability));
    if(logs.some(log=>log < evidence.uncertainLogprob)||probabilities.some(p=>p > evidence.uncertainNoSpeechProbability)||weakToken) {
      recognition.status='uncertain';recognition.reason='The recogniser is uncertain about these words. Prepared matches need your review.';
    } else {
      recognition.status='clear';recognition.reason='No uncertainty was flagged by the recogniser. This is not a guarantee of correct words.';
    }
  }
  return {text,recognition};
}

export function localTranscript(result:WorkerResult):string {return analyzeLocalRecognition(result).text;}

/** Sparse output can mean masked speech, but also genuine pauses. Recovery is
 * bounded, unprompted and review-only; never call this speaker identification. */
export function needsSpeechRecovery(text:string,recognition:ListeningRecognition,seconds:number) {
  const count=(text.match(/[\p{L}\p{N}]+/gu)??[]).length;
  return seconds>=LISTENING_RECOGNITION_CONFIG.recovery.minimumSeconds && count>0 &&
    count/seconds<LISTENING_RECOGNITION_CONFIG.recovery.maximumWordsPerSecond &&
    recognition.status!=='no-speech' && recognition.avgLogprob!==null && recognition.avgLogprob<=LISTENING_RECOGNITION_CONFIG.recovery.maximumInitialLogprob;
}
export function chooseRecoveredSpeech(primary:ReturnType<typeof analyzeLocalRecognition>,parts:ReturnType<typeof analyzeLocalRecognition>[]) {
  const tokens=(text:string)=>text.toLowerCase().match(/[\p{L}\p{N}]+/gu)??[];
  const text=parts.map(part=>part.text.trim()).filter(Boolean).join(' '),original=tokens(primary.text),recovered=tokens(text);
  // Do not trust extra words alone: retain the original evidence in order and
  // reject looping decoder output. No label or scripture match selects a pass.
  let at=0;for(const word of recovered)if(word===original[at])at++;
  const triples=new Map<string,number>();let looping=false;
  for(let i=0;i+2<recovered.length;i++){const key=recovered.slice(i,i+3).join(' '),count=(triples.get(key)??0)+1;triples.set(key,count);if(count>=3)looping=true;}
  if(at!==original.length || recovered.length<original.length+LISTENING_RECOGNITION_CONFIG.recovery.minimumAddedWords || looping || text.length>4000 || parts.some(part=>part.recognition.status==='unavailable'||part.recognition.rejectedSegments>0))return primary;
  return {text,recognition:{...primary.recognition,status:'uncertain' as const,reason:'Additional speech was recovered from shorter audio windows. Overlapping voices are not identified; review these words before publishing.'}};
}
