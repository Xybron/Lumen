import test from 'node:test';
import assert from 'node:assert/strict';
import {TranscriptState,stableCorrectTime,resampleForOpenAI} from '../scripts/listening-cloud-benchmark.js';

test('Deepgram partials do not duplicate finalized segments',()=>{
 const state=new TranscriptState();
 const event=(text:string,is_final:boolean,start:number)=>({type:'Results',channel:{alternatives:[{transcript:text}]},is_final,start});
 assert.equal(state.ingest('deepgram',event('First Sam',false,0)),'First Sam');
 assert.equal(state.ingest('deepgram',event('First Samuel',true,0)),'First Samuel');
 assert.equal(state.ingest('deepgram',event('sixteen',false,2)),'First Samuel sixteen');
 assert.equal(state.ingest('deepgram',event('sixteen thirteen',true,2)),'First Samuel sixteen thirteen');
 assert.equal(state.ingest('deepgram',event('sixteen thirteen',true,2)),'First Samuel sixteen thirteen');
 assert.equal(state.ingest('deepgram',event('',true,0)),'First Samuel sixteen thirteen');
});
test('AssemblyAI replaces revisions within a turn instead of appending them',()=>{
 const state=new TranscriptState();
 state.ingest('assemblyai',{type:'Turn',turn_order:0,transcript:'Samuel sixteen thirty'});
 assert.equal(state.ingest('assemblyai',{type:'Turn',turn_order:0,transcript:'Samuel sixteen thirteen',end_of_turn:true}),'Samuel sixteen thirteen');
 assert.equal(state.ingest('assemblyai',{type:'Turn',turn_order:1,transcript:'The Bible says'}),'Samuel sixteen thirteen The Bible says');
});
test('OpenAI completion replaces provisional deltas',()=>{
 const state=new TranscriptState();
 state.ingest('openai',{type:'conversation.item.input_audio_transcription.delta',item_id:'a',delta:'Samuel '});
 state.ingest('openai',{type:'conversation.item.input_audio_transcription.delta',item_id:'a',delta:'16:30'});
 assert.equal(state.ingest('openai',{type:'conversation.item.input_audio_transcription.completed',item_id:'a',transcript:'Samuel 16:13'}),'Samuel 16:13');
});
test('stable reference latency rejects an early correct guess that is later revised',()=>{
 const correct={book:9,chapter:16,verse:13},wrong={book:9,chapter:16,verse:30};
 assert.equal(stableCorrectTime([{atMs:100,reference:correct},{atMs:200,reference:wrong},{atMs:300,reference:correct},{atMs:400,reference:correct}],[correct]),300);
 assert.equal(stableCorrectTime([{atMs:100,reference:correct},{atMs:200,reference:null}],[correct]),null);
 assert.equal(stableCorrectTime([{atMs:100,reference:correct}],[]),null);
});

test('short final audio window resamples without blocking on a pipe',{timeout:15000},async()=>{
 const result=await resampleForOpenAI(Buffer.alloc(319926));
 assert.equal(result.length,479890);
 assert.ok(result.every(sample=>sample===0));
});
