import fs from 'node:fs/promises';
import path from 'node:path';
import {WorshipLibrary} from '../src/worship-library.js';
import {ListeningSessions} from '../src/listening-session.js';
import {StreamingEvidenceGate,cloudRecognition} from '../src/streaming-scripture.js';
import {stableCorrectTime} from './listening-cloud-benchmark.js';
const directory=path.resolve('data/ai/corpus/commercial-comparison-2026-11-18');
const old=JSON.parse(await fs.readFile(path.join(directory,'comparison.json'),'utf8'));
const library=new WorshipLibrary(':memory:');
const source=new WorshipLibrary(path.join(directory,'library.db'));
library.importBible({version:{id:'KJV',name:'KJV',attribution:'KJV'},verses:source.db.prepare("SELECT book,chapter,verse,text FROM verses WHERE versionId='KJV'").all()});source.close();
const rows=[];
try{
  for(const row of old.rows.filter((r:any)=>r.provider==='assemblyai')){
    const gate=new StreamingEvidenceGate(),sessions=new ListeningSessions(library,()=>{throw new Error('Replay must not publish');});
    const events=row.events.map((e:any)=>{
      sessions.stop('replay');const lease=sessions.start('replay','replay',{mode:'assisted',language:'en',commands:false});
      const raw=sessions.accept('replay',lease.id,'replay',0,'scripture',e.text,0,0,cloudRecognition);
      const result=gate.apply(raw,e.final,0,e.atMs),selection=result.candidate?.selection;
      return {...e,reference:selection?.kind==='scripture'?{book:selection.book,chapter:selection.chapter,verse:selection.verse,...(selection.endVerse?{endVerse:selection.endVerse}:{})}:null};
    });
    rows.push({group:row.group,clipId:row.clipId,expectedReferences:row.expectedReferences,oldStableMs:row.stableReferenceFromStartMs,newStableMs:stableCorrectTime(events,row.expectedReferences),events});
  }
  const wrong=rows.flatMap(r=>r.events.filter((e:any)=>e.reference&&!r.expectedReferences.some((g:any)=>JSON.stringify(g)===JSON.stringify(e.reference))).map((e:any)=>({clip:r.clipId,text:e.text,reference:e.reference})));
  const report={method:'Offline replay of saved AssemblyAI updates with the new matcher and stability gate. Provider timing is unchanged recorded timing, not a new API speed measurement.',wrong,positives:rows.filter(r=>r.expectedReferences.length).map(({events,...r})=>r),rows};
  await fs.mkdir('data/ai/corpus/assemblyai-improvement-2026-11-18',{recursive:true});
  await fs.writeFile('data/ai/corpus/assemblyai-improvement-2026-11-18/replay.json',JSON.stringify(report,null,2));console.log(JSON.stringify({wrong,positives:report.positives},null,2));
}finally{library.close();}
