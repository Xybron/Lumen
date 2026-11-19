import test from 'node:test';
import assert from 'node:assert/strict';
import { notesRoot, notesSeries, replaceNotesSeries } from '../../frontend/src/lib/notes-slides.js';
import type { Item } from '../../frontend/src/types.js';

const note=(id:string,body:string,extra:Partial<Item>={}):Item=>({id,type:'notes',title:'Message',body,reference:'',durationMs:30000,groupId:'message',...extra});

test('repeated Notes updates reuse their slides, preserve unrelated content and reopen the entire series',()=>{
  const audience:Item={id:'audience',type:'text',title:'On screen',body:'Keep showing this',durationMs:30000};
  const unrelated=note('unrelated','Independent note');
  const original=[audience,note('root','Old point'),unrelated];
  const first=replaceNotesSeries(original,'root',[note('root','First point'),note('second','Second point')]);
  assert.deepEqual(first.map(item=>item.id),['audience','root','second','unrelated']);
  assert.equal(first[1].notesSourceId,undefined);
  assert.equal(first[2].notesSourceId,'root');
  assert.deepEqual(original.map(item=>item.body),['Keep showing this','Old point','Independent note'],'Constructing the next save does not mutate current state');
  const next=replaceNotesSeries(first,'root',[note('root','Improved first'),note('second','Improved second'),note('third','New thought')]);
  assert.deepEqual(next.map(item=>item.id),['audience','root','second','third','unrelated'],'Repeated Update never duplicates the prior generated slides');
  assert.equal(next[0],audience);assert.equal(next[4],unrelated);
  const reopened=notesRoot(next,next[3]);
  assert.equal(reopened.id,'root');
  assert.deepEqual(notesSeries(next,reopened).map(item=>item.body),['Improved first','Improved second','New thought']);
  const reduced=replaceNotesSeries(next,'root',[note('root','Single paragraph')]);
  assert.deepEqual(reduced.map(item=>item.id),['audience','root','unrelated'],'Only this Note’s generated slides are removed when returning to one slide');
  assert.equal(reduced[0],audience);assert.equal(reduced[2],unrelated);
});

test('Notes series refuses stale IDs and cannot overwrite an independent slide or another presentation',()=>{
  const root=note('root','Root'),other=note('other','Keep independent');
  const items=[root,other];
  assert.throws(()=>replaceNotesSeries(items,'root',[note('root','New'),note('other','Wrong')]),/slide list changed/);
  assert.throws(()=>replaceNotesSeries(items,'root',[note('root','New'),note('root','Duplicate')]),/slide list changed/);
  assert.throws(()=>replaceNotesSeries(items,'missing',[note('missing','New')]),/removed/);
  assert.throws(()=>replaceNotesSeries(items,'root',[]),/Add text/);
  assert.throws(()=>replaceNotesSeries(items,'root',[note('root',' ')]),/Add text/);
  const orphan=note('child','Own text',{notesSourceId:'root'});
  assert.equal(notesRoot([orphan],orphan),orphan,'A source ID in another presentation is never followed');
  const detached={...orphan,id:'copy',notesSourceId:undefined};
  assert.equal(notesRoot([...items,detached],detached),detached,'A duplicated child is independently editable');
  const unrelatedMarked={...other,type:'text' as const,notesSourceId:'root'};
  const result=replaceNotesSeries([root,unrelatedMarked],'root',[note('root','New')]);
  assert.equal(result[1],unrelatedMarked,'A different content type is never removed as a generated Note');
  assert.deepEqual(items,[root,other]);
});
