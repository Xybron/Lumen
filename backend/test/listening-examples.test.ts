import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {ListeningExamples} from '../src/listening-examples.js';

test('saved examples require explicit review and remain private to their operator',async()=>{
  const directory=await fs.mkdtemp(path.join(os.tmpdir(),'lumen-examples-test-')),store=new ListeningExamples(directory);
  try {
    const record=await store.save('owner','scripture',Buffer.alloc(32000),{asrTranscript:'Machine text',sourceSessionId:'test'});
    assert.equal(record.reviewed,false);assert.equal(record.transcript,null);assert.equal(record.expectedReferences,null);
    await assert.rejects(store.read(record.id,'other'),/another operator/);
    await assert.rejects(store.audio(record.id,'other'),/another operator/);
    await assert.rejects(store.read('../private','owner'));
    const wav=await store.audio(record.id,'owner');assert.equal(wav.length,32044);assert.equal(wav.toString('ascii',0,4),'RIFF');
    const reviewed=await store.review(record.id,'owner',{transcript:'Actual words',reference:'',speaker:'Speaker A',notes:'Clear speech',reviewed:true},[]);
    assert.equal(reviewed.transcript,'Actual words');assert.deepEqual(reviewed.expectedReferences,[]);assert.equal(reviewed.reviewed,true);
    assert.equal((await store.list('owner','scripture')).length,1);assert.equal((await store.list('other','scripture')).length,0);
    await store.remove(record.id,'owner');assert.deepEqual(await fs.readdir(directory),[]);
  }finally{await fs.rm(directory,{recursive:true,force:true});}
});
