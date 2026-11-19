import test from 'node:test';
import assert from 'node:assert/strict';
import {WorshipLibrary} from '../src/worship-library.js';
import {StreamingQuoteContext} from '../src/streaming-quote-context.js';
import type {ListeningResult} from '../../shared/worship.js';

const samuel='Then Samuel took the horn of oil, and anointed him in the midst of his brethren: and the Spirit of the LORD came upon David from that day forward. So Samuel rose up, and went to Ramah.';
function fixture(){
  const library=new WorshipLibrary(':memory:');
  library.importBible({version:{id:'KJV',name:'KJV',attribution:'test'},verses:[
    {book:9,chapter:16,verse:13,text:samuel},
    {book:43,chapter:3,verse:16,text:'For God so loved the world that he gave his only begotten Son.'},
    {book:19,chapter:115,verse:4,text:'Their idols are silver and gold, the work of men\'s hands.'},
    {book:19,chapter:135,verse:15,text:'Their idols are silver and gold, the work of men\'s hands.'},
  ]});
  const context=new StreamingQuoteContext(library);
  const raw=(transcript:string):ListeningResult=>({transcript,elapsedMs:0,candidate:null,match:'none',score:0,switched:false,decision:'listening',reason:'Listening.',workspace:library.workspace('test')});
  const apply=(text:string,atMs:number,newFinal=true,version='KJV')=>context.apply(raw(text),newFinal,atMs,version);
  return {library,context,raw,apply};
}

test('adjacent finalized fragments restore the reviewed Samuel suggestion without changing transcript or publishing',()=>{
  const f=fixture();try{
    f.apply('That Samuel',100);f.apply('Look!',500);
    assert.equal(f.apply('the horn of oil',1000).candidate,null);
    const result=f.apply('and anointed David',2000);
    assert.equal(result.candidate?.reference,'1 Samuel 16:13 · KJV');
    assert.equal(result.transcript,'and anointed David');assert.equal(result.decision,'review');assert.equal(result.switched,false);
    assert.equal(f.library.workspace('test').live,null);
  }finally{f.library.close();}
});

test('even combined exact eligible quotations remain review-only',()=>{
  const f=fixture();try{
    const first='For God so loved the world',second='that he gave his only begotten Son';
    assert.equal(f.library.matchScriptureQuote('KJV',first+' '+second).eligible,true);
    f.apply(first,1000);const result=f.apply(second,2000);
    assert.equal(result.candidate?.reference,'John 3:16 · KJV');assert.equal(result.switched,false);assert.equal(result.decision,'review');
    assert.equal(f.library.workspace('test').live,null);
  }finally{f.library.close();}
});

test('shared quotation wording never gains a suggestion from aggregation',()=>{
  const f=fixture();try{
    f.apply('Their idols are silver and gold',1000);
    assert.equal(f.apply('the work of men\'s hands',2000).candidate,null);
  }finally{f.library.close();}
});

test('empty, no-speech, explicit, invalid and negated citations clear prior quotation fragments',()=>{
  for(const interruption of ['', 'John chapter three', 'John 999:16', 'not John 3:16']){
    const f=fixture();try{f.apply('the horn of oil',1000);f.apply(interruption,2000);assert.equal(f.apply('and anointed David',3000).candidate,null,interruption);}finally{f.library.close();}
  }
  const f=fixture();try{
    f.apply('the horn of oil',1000);
    const silence={...f.raw('noise'),recognition:{status:'no-speech' as const,reason:'Silence',avgLogprob:null,noSpeechProbability:1,rejectedSegments:0,totalSegments:0}};
    f.context.apply(silence,true,2000,'KJV');assert.equal(f.apply('and anointed David',3000).candidate,null);
  }finally{f.library.close();}
});

test('unrelated intervening speech cannot connect quotation fragments',()=>{
  const f=fixture();try{
    f.apply('the horn of oil',1000);f.apply('Please park your vehicle behind the building',2000);
    assert.equal(f.apply('and anointed David',3000).candidate,null);
  }finally{f.library.close();}
});

test('duplicates and interims neither enter nor clear finalized context',()=>{
  const f=fixture();try{
    f.apply('the horn of oil',1000);
    f.apply('John chapter three',1200,false);f.apply('noise',1500,false);
    assert.equal(f.apply('and anointed David',2000).candidate?.reference,'1 Samuel 16:13 · KJV');
    f.apply('the horn of oil',3000,false);
    assert.equal(f.apply('and anointed David',4000).candidate,null,'duplicate final must not seed new history');
  }finally{f.library.close();}
});

test('expired gaps, total duration, edition changes and recognized candidates cannot reuse old fragments',()=>{
  for(const atMs of [9001,20000]){
    const f=fixture();try{f.apply('the horn of oil',1000);assert.equal(f.apply('and anointed David',atMs).candidate,null);}finally{f.library.close();}
  }
  const f=fixture();try{
    f.apply('the horn of oil',1000);f.apply('and anointed David',2000,true,'NIV');assert.equal(f.apply('and anointed David',3000).candidate,null);
    f.apply('the horn of oil',4000);
    const recognized={...f.raw('John 3:16'),candidate:f.library.cue({kind:'scripture',versionId:'KJV',book:43,chapter:3,verse:16}),match:'reference' as const};
    assert.equal(f.context.apply(recognized,true,5000,'KJV'),recognized);
    assert.equal(f.apply('and anointed David',6000).candidate,null);
    f.apply('the horn of oil',7000);
    f.library.command('test',f.library.workspace('test').revision,{type:'blank',value:true});
    assert.equal(f.apply('and anointed David',8000).candidate,null,'manual workspace revision clears preceding words');
  }finally{f.library.close();}
});

test('context is bounded to two previous finals and 96 words',()=>{
  const f=fixture();try{
    f.apply('the horn of oil',1000);f.apply('unrelated phrase one',2000);f.apply('unrelated phrase two',3000);
    assert.equal(f.apply('and anointed David',4000).candidate,null);
    f.apply('the horn of oil',5000);f.apply('word '.repeat(97),6000);assert.equal(f.apply('and anointed David',7000).candidate,null);
  }finally{f.library.close();}
});
