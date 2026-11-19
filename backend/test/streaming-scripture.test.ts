import test from 'node:test';
import assert from 'node:assert/strict';
import {StreamingEvidenceGate,cloudRecognition} from '../src/streaming-scripture.js';
import {WorshipLibrary} from '../src/worship-library.js';
import {ListeningSessions} from '../src/listening-session.js';

test('provisional number revisions are withdrawn before a confirmed reference is prepared',()=>{
  const library=new WorshipLibrary(':memory:');
  try {
    library.importBible({version:{id:'KJV',name:'KJV',attribution:'test'},verses:[10,13].map(verse=>({book:9,chapter:16,verse,text:`Synthetic verse ${verse}`}))});
    const sessions=new ListeningSessions(library,()=>assert.fail('Must never publish'));
    const session=sessions.start('test','owner',{mode:'assisted',language:'en',commands:false});
    let sequence=0;const gate=new StreamingEvidenceGate();
    const update=(text:string,at:number,final=false,turn=0)=>gate.apply(sessions.accept('test',session.id,'owner',sequence++,'scripture',text,at,0,cloudRecognition),final,turn,at);
    assert.equal(update('First Samuel chapter sixteen verse ten',100).candidate,null);
    assert.equal(update('First Samuel chapter sixteen verse thirteen',600).candidate,null);
    assert.equal(update('First Samuel chapter sixteen verse thirteen',700).candidate,null);
    assert.equal(update('First Samuel chapter sixteen verse thirteen.',1000).candidate?.selection.kind,'scripture');
    assert.equal(update('First Samuel chapter sixteen',1200).candidate,null);
    assert.equal(update('First Samuel chapter sixteen verse ten',1600).candidate,null);
    assert.equal(update('First Samuel chapter sixteen verse thirteen',1700,true).candidate?.reference,'1 Samuel 16:13 · KJV');
    assert.equal(update('First Samuel chapter sixteen verse thirteen',2100,false,1).candidate,null,'A new turn starts fresh.');
    assert.equal(library.workspace('test').live,null);
  }finally{library.close();}
});

test('shared quotation prefixes wait for the distinguishing continuation even at a turn boundary',()=>{
  const library=new WorshipLibrary(':memory:');
  try {
    library.importBible({version:{id:'KJV',name:'KJV',attribution:'test'},verses:[
      {book:7,chapter:3,verse:10,text:'And the Spirit of the LORD came upon him, and he judged Israel, and went out to war.'},
      {book:9,chapter:16,verse:13,text:'Then Samuel took the horn of oil, and anointed him in the midst of his brethren: and the Spirit of the LORD came upon David from that day forward.'},
    ]});
    const sessions=new ListeningSessions(library,()=>assert.fail('Must not publish')),gate=new StreamingEvidenceGate();
    const lease=sessions.start('quote','owner',{mode:'assisted',language:'en',commands:false});let sequence=0;
    const raw=(text:string)=>sessions.accept('quote',lease.id,'owner',sequence++,'scripture',text,0,0,cloudRecognition);
    const shared=raw('And the Spirit of the Lord came upon');assert.equal(shared.quoteAmbiguous,true);
    assert.equal(gate.apply(shared,false,0,1000).candidate,null);assert.equal(gate.apply(shared,true,0,1100).candidate,null);
    const distinct=gate.apply(raw('And the Spirit of the Lord came upon David from that day forward'),false,0,2000);
    assert.equal(distinct.candidate?.reference,'1 Samuel 16:13 · KJV');
  }finally{library.close();}
});
