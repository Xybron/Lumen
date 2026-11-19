import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { NotesStore,NotesDraftSchema,novelNotesText } from '../src/notes-store.js';

test('rolling transcript removes only matching boundary context',()=>{
  assert.equal(novelNotesText('Let us pray for our community.','for our community. We stand together.'),'We stand together.');
  assert.equal(novelNotesText('We stand together.','we stand together'),'');
  assert.equal(novelNotesText('We pray for peace.','Peace. Peace matters.'),'Peace. Peace matters.','A single repeated word is retained');
  assert.equal(novelNotesText('Hope brings strength.','Faith brings hope.'),'Faith brings hope.');
});

test('Notes private drafts retain styling and split mode across restart without changing legacy documents',async()=>{
  const directory=await fs.mkdtemp(path.join(os.tmpdir(),'lumen-notes-style-')),file=path.join(directory,'notes.db');
  let store=new NotesStore(file);
  try {
    const legacy={title:'Existing',body:'An earlier private thought',reference:'Speaker',layout:'quote' as const};
    assert.deepEqual(NotesDraftSchema.parse(legacy),legacy,'Old drafts remain valid without adding new fields');
    const initial=store.get('channel','note',legacy);
    store.append('channel','note','speech',0,'Private live transcript',false);
    const next={...legacy,body:'First line\nSecond line',grouping:'pointers' as const,
      background:{kind:'gradient' as const,gradient:'linear-gradient(135deg, #172554, #312e81)',overlayOpacity:0.2},
      typography:{size:'lg' as const,align:'left' as const,weight:600}};
    const saved=store.saveDraft('channel','note',initial.revision,next);
    assert.equal(saved.revision,1);assert.deepEqual(saved.draft,next);
    assert.throws(()=>store.saveDraft('channel','note',initial.revision,{...next,body:'Stale edit'}),/changed in another window/);
    store.close();store=new NotesStore(file);
    assert.deepEqual(store.get('channel','note').draft,next);
    assert.equal(store.get('channel','note').segments[0].text,'Private live transcript');
    assert.throws(()=>NotesDraftSchema.parse({...next,background:{kind:'color',color:'#fff',overlayOpacity:2}}));
    assert.throws(()=>NotesDraftSchema.parse({...next,grouping:'unexpected'}));
  }finally{store.close();await fs.rm(directory,{recursive:true,force:true});}
});

test('frequent private autosaves do not reread a long transcript and still enforce revisions',async()=>{
  const directory=await fs.mkdtemp(path.join(os.tmpdir(),'lumen-notes-autosave-'));
  const store=new NotesStore(path.join(directory,'notes.db'));
  try{
    const initial=store.get('channel','note');
    for(let index=0;index<250;index++)store.appendSegment('channel','note','sermon',index,`A sermon passage ${index}`,false);
    const readSegments=store.segmentsSince.bind(store);let reads=0;
    store.segmentsSince=(...args)=>{reads++;return readSegments(...args);};
    const first=store.saveDraft('channel','note',initial.revision,{...initial.draft,body:'First draft'},false);
    const second=store.saveDraft('channel','note',first.revision,{...first.draft,body:'Second draft'},false);
    assert.equal(reads,0,'Autosave must not scan or serialize completed speech');
    assert.deepEqual(second.segments,[]);assert.equal(second.revision,2);assert.equal(second.draft.body,'Second draft');
    assert.throws(()=>store.saveDraft('channel','note',first.revision,first.draft,false),/changed in another window/);
    assert.equal(store.get('channel','note').segments.length,250,'Omitted response does not delete private speech');
  }finally{store.close();await fs.rm(directory,{recursive:true,force:true});}
});
test('private notes persist ordered idempotent segments separately from reviewed drafts',async()=>{
  const directory=await fs.mkdtemp(path.join(os.tmpdir(),'lumen-notes-store-')),file=path.join(directory,'notes.db');
  let store=new NotesStore(file);
  try {
    const initial=store.get('prayer','notes',{title:'Reviewed title',body:'Approved slide',layout:'statement'});
    store.append('prayer','notes','session-a',0,'Private first passage',false);
    store.append('prayer','notes','session-a',0,'Duplicate must not replace text',false);
    store.append('prayer','notes','session-a',1,'Uncertain second passage',true);
    const saved=store.saveDraft('prayer','notes',initial.revision,{title:'Edited privately',body:'Refined words',reference:'Speaker',layout:'quote'});
    assert.deepEqual(saved.segments.map(segment=>segment.text),['Private first passage','Uncertain second passage']);
    assert.equal(saved.segments[1].uncertain,true);
    assert.equal(saved.draft.body,'Refined words');
    assert.throws(()=>store.saveDraft('prayer','notes',initial.revision,saved.draft),/changed in another window/);
    store.close();store=new NotesStore(file);
    assert.deepEqual(store.get('prayer','notes'),saved,'Transcript and private draft survive process restart');
    assert.equal(store.get('other-channel','notes').segments.length,0,'Item IDs cannot cross channel documents');
    assert.equal(store.get('prayer','other-item').segments.length,0,'Each Notes item has a separate transcript');
  }finally{store.close();await fs.rm(directory,{recursive:true,force:true});}
});

test('clearing captured phrases preserves drafts, other notes, later speech and duplicate protection',()=>{
  const store=new NotesStore(':memory:');
  try{
    const original=store.get('channel','one',{body:'Keep my written point'});
    const old=store.appendSegment('channel','one','session',1,'Old speech',true)!;
    const later=store.appendSegment('channel','one','session',2,'New speech during confirmation',true)!;
    store.appendSegment('channel','two','session',1,'Other note',true);
    const result=store.clearTranscript('channel','one',old.id);
    assert.deepEqual(result.segments.map(s=>s.id),[later.id]);
    assert.equal(store.get('channel','one').draft.body,original.draft.body);
    assert.equal(store.get('channel','one').revision,original.revision);
    assert.equal(store.get('channel','two').segments.length,1);
    assert.equal(store.appendSegment('channel','one','session',1,'Old speech',true),undefined);
    assert.equal(store.db.prepare('SELECT text FROM notes_segments WHERE id=?').get(old.id).text,'');
    store.appendSegment('channel','one','session',3,'Continuing speech',true);
    assert.deepEqual(store.segmentsSince('channel','one').map(s=>s.sequence),[2,3]);
    assert.equal(store.clearedThrough('channel','one'),old.id);
  }finally{store.close();}
});
