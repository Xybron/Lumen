import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { ProductionStore } from '../src/production-store.js';
import { initialProduction, ProductionSchema } from '../src/production-schema.js';
import { programChannelLayer, programChannelVisible } from '../../shared/program-channel.js';
import type { ProductionState, SceneLayer, StudioSource } from '../../shared/production.js';

const channel={id:'scripture',name:'Scripture'};
const allowed=()=>{};
function source(id='bible'):StudioSource {
  return {id,name:'Bible source',kind:'channel',channelId:channel.id,loop:false,audio:{volume:.7,muted:false,mode:'follow',delayMs:120}};
}
function layer(patch:Partial<SceneLayer>={}):SceneLayer {
  return {id:'bible_layer',name:'Scripture overlay',kind:'source',sourceId:'bible',visible:true,locked:false,x:5,y:70,width:90,height:24,opacity:.9,fit:'contain',text:'',color:'#ffffff',background:'#00000000',fontSize:48,fontWeight:500,align:'left',radius:12,channelStyle:'overlay',...patch};
}
function base():ProductionState {
  const state=initialProduction();
  state.program=structuredClone(state.scenes[0]);
  state.programTransition={id:'existing_take',kind:'fade',durationMs:400};
  state.outputs[0]={...state.outputs[0],mode:'scene',scene:structuredClone(state.scenes[1]),sceneRunId:'existing_pin'};
  return state;
}
async function fixture(t:{after:(fn:()=>Promise<void>)=>void},state=base()) {
  const dir=await fs.mkdtemp(path.join(os.tmpdir(),'lumen-channel-program-'));
  t.after(()=>fs.rm(dir,{recursive:true,force:true}));
  await fs.writeFile(path.join(dir,'production.json'),JSON.stringify(state));
  const broadcasts:ProductionState[]=[];
  const store=new ProductionStore(dir,state=>broadcasts.push(state));
  await store.init();
  return {dir,store,broadcasts};
}

test('channel presence uses committed visible geometry, not draft/hidden/offcanvas layers or a different fullscreen foreground',()=>{
  const state=base();state.sources.push(source());
  state.scenes[0].layers.push(layer());
  assert.equal(programChannelVisible(state,channel.id),false);
  state.program!.layers.push(layer());
  assert.equal(programChannelVisible(state,channel.id),true);
  assert.equal(programChannelLayer(state,channel.id)?.id,'bible_layer');
  for (const patch of [{visible:false},{opacity:0},{x:100},{y:-24}]) {
    Object.assign(state.program!.layers.at(-1)!,layer(patch));
    assert.equal(programChannelVisible(state,channel.id),false);
  }
  Object.assign(state.program!.layers.at(-1)!,layer());
  state.channelInsert={id:'insert',channelId:'lyrics',sourceId:'other',mode:'fullscreen',layer:layer({sourceId:'other',x:0,y:0,width:100,height:100})};
  assert.equal(programChannelVisible(state,channel.id),false);
  state.channelInsert.mode='overlay';
  assert.equal(programChannelVisible(state,channel.id),true);
  assert.equal(programChannelVisible(null,channel.id),false);
});

test('showing an absent channel inserts a muted lower third without changing base, audio, draft, pinned output or animation runs',async t=>{
  const initial=base(),{store}=await fixture(t,initial);
  const checks:boolean[]=[];
  let committed=0;
  const state=await store.channelProgram(0,channel,'auto',routing=>checks.push(routing),()=>committed++);
  assert.equal(committed,1);assert.deepEqual(checks,[true,true]);
  assert.deepEqual(state.program,initial.program);
  assert.deepEqual(state.scenes,initial.scenes);
  assert.deepEqual(state.outputs,initial.outputs);
  assert.deepEqual(state.programTransition,initial.programTransition);
  assert.equal(state.masterVolume,initial.masterVolume);assert.equal(state.masterMuted,initial.masterMuted);
  assert.equal(state.channelInsert?.mode,'overlay');
  assert.equal(state.channelInsert?.layer.channelStyle,'overlay');
  assert.deepEqual([state.channelInsert?.layer.x,state.channelInsert?.layer.y,state.channelInsert?.layer.width,state.channelInsert?.layer.height],[8,68,84,26]);
  assert.equal(state.sources.length,1);
  assert.equal(state.sources[0].audio.muted,true);
  assert.equal(programChannelVisible(state,channel.id),true);
});

test('updating a visible committed layer changes only the cue, with no production write or new revision',async t=>{
  const initial=base();initial.sources.push(source());initial.program!.layers.push(layer());
  const {store,dir,broadcasts}=await fixture(t,initial);
  const before=await fs.readFile(path.join(dir,'production.json'),'utf8');
  const checks:boolean[]=[];let commits=0;
  const state=await store.channelProgram(0,channel,'auto',routing=>checks.push(routing),()=>commits++);
  assert.equal(commits,1);assert.deepEqual(checks,[false,false]);
  assert.deepEqual(state,ProductionSchema.parse(initial));
  assert.equal(await fs.readFile(path.join(dir,'production.json'),'utf8'),before);
  assert.equal(broadcasts.length,0);
});

test('hidden matching layers are copied temporarily with their geometry and source audio untouched',async t=>{
  const initial=base();initial.sources.push(source());initial.program!.layers.push(layer({visible:false}));
  const {store}=await fixture(t,initial);
  const state=await store.channelProgram(0,channel,'auto',allowed);
  assert.equal(state.sources.length,1);assert.deepEqual(state.sources,initial.sources);
  assert.deepEqual(state.program,initial.program);
  assert.equal(state.channelInsert?.layer.visible,true);
  assert.equal(state.channelInsert?.layer.x,5);
  assert.equal(state.channelInsert?.layer.y,70);
  assert.equal(state.channelInsert?.layer.height,24);
  assert.notEqual(state.channelInsert?.layer.id,'bible_layer');
});

test('fullscreen is explicit and Return restores the exact committed composition, never the edited draft',async t=>{
  const initial=base(),{store}=await fixture(t,initial);
  let state=await store.channelProgram(0,channel,'fullscreen',allowed);
  const insertId=state.channelInsert!.id;
  assert.equal(state.channelInsert?.mode,'fullscreen');
  assert.equal(state.channelInsert?.layer.channelStyle,'slide');
  assert.deepEqual([state.channelInsert?.layer.x,state.channelInsert?.layer.y,state.channelInsert?.layer.width,state.channelInsert?.layer.height],[0,0,100,100]);
  state.scenes[0].layers[0].text='Uncommitted edit';
  state=await store.save(state);
  state=await store.returnToStudio(state.revision,insertId);
  assert.equal(state.channelInsert,undefined);
  assert.equal(state.scenes[0].layers[0].text,'Uncommitted edit');
  assert.deepEqual(state.program,initial.program);
  assert.deepEqual(state.outputs,initial.outputs);
  assert.deepEqual(state.programTransition,initial.programTransition);
});

test('explicit Take clears the temporary insert, whereas a pinned output route or blank does not',async t=>{
  const {store}=await fixture(t);
  let state=await store.channelProgram(0,channel,'auto',allowed);
  const insert=structuredClone(state.channelInsert);
  state=await store.command(state.revision,{type:'route',outputId:'screen_main',sceneId:'scene_close'});
  assert.deepEqual(state.channelInsert,insert);
  state=await store.command(state.revision,{type:'blank',outputId:'screen_main',blanked:true});
  assert.deepEqual(state.channelInsert,insert);
  state=await store.command(state.revision,{type:'take',sceneId:'scene_message',transition:'fade',durationMs:300});
  assert.equal(state.channelInsert,undefined);
  assert.equal(state.program?.id,'scene_message');
});

test('ordinary and legacy PUTs cannot clear or forge inserts, and cannot delete their source',async t=>{
  const {store}=await fixture(t);
  let state=await store.channelProgram(0,channel,'auto',allowed);
  const insert=structuredClone(state.channelInsert);
  delete state.channelInsert;
  state=await store.save(state);assert.deepEqual(state.channelInsert,insert);
  state.channelInsert!.mode='fullscreen';
  state=await store.save(state);assert.deepEqual(state.channelInsert,insert);
  state.sources=[];
  await assert.rejects(store.save(state),/matching channel source/);
  assert.deepEqual(store.get().channelInsert,insert);
});

test('stale route and stale Return cannot commit content or clear a newer insert',async t=>{
  const {store}=await fixture(t);let committed=0;
  let state=await store.channelProgram(0,channel,'auto',allowed);
  const oldId=state.channelInsert!.id;
  state=await store.channelProgram(state.revision,{id:'lyrics',name:'Lyrics'},'fullscreen',allowed);
  await assert.rejects(store.channelProgram(0,channel,'auto',allowed,()=>committed++),/another device/);
  await assert.rejects(store.returnToStudio(state.revision,oldId),/Program changed/);
  assert.equal(committed,0);assert.equal(store.get().channelInsert?.channelId,'lyrics');
});

test('authorization rejects before cue commit and a final cue conflict rolls unpublished disk state back',async t=>{
  const {store,dir,broadcasts}=await fixture(t);
  const initial=store.get();let committed=0;
  await assert.rejects(store.channelProgram(0,channel,'auto',()=>{throw new Error('Forbidden');},()=>committed++),/Forbidden/);
  assert.equal(committed,0);assert.deepEqual(store.get(),initial);
  await assert.rejects(store.channelProgram(0,channel,'auto',allowed,()=>{throw new Error('Cue changed');}),/Cue changed/);
  assert.deepEqual(store.get(),initial);
  assert.deepEqual(JSON.parse(await fs.readFile(path.join(dir,'production.json'),'utf8')),initial);
  assert.equal(broadcasts.length,0);
  const state=await store.channelProgram(0,channel,'auto',allowed);
  assert.equal(state.revision,1);
});

test('no Program and a full source library reject without cue side effects',async t=>{
  const initial=base();initial.program=null;
  const {store}=await fixture(t,initial);let commits=0;
  await assert.rejects(store.channelProgram(0,channel,'auto',allowed,()=>commits++),/Take a Studio scene/);
  assert.equal(commits,0);
  const state=base();state.sources=Array.from({length:40},(_,i)=>({...source(`source_${i}`),channelId:`channel_${i}`}));
  const second=await fixture(t,state);
  await assert.rejects(second.store.channelProgram(0,channel,'auto',allowed,()=>commits++),/source library is full/);
  assert.equal(commits,0);assert.equal(second.store.get().revision,0);
});

test('inserts persist across restart and replacing one never builds a hidden return stack',async t=>{
  const {store,dir}=await fixture(t);
  let state=await store.channelProgram(0,channel,'auto',allowed);
  const program=structuredClone(state.program);
  state=await store.channelProgram(state.revision,{id:'lyrics',name:'Lyrics'},'fullscreen',allowed);
  const restarted=new ProductionStore(dir);await restarted.init();assert.deepEqual(restarted.get(),state);
  state=await restarted.returnToStudio(state.revision,state.channelInsert!.id);
  assert.equal(state.channelInsert,undefined);assert.deepEqual(state.program,program);
});

test('showing a base channel hidden by another fullscreen insert reveals its original layer without duplicating translucent graphics',async t=>{
  const initial=base();initial.sources.push(source());initial.program!.layers.push(layer({opacity:.4}));
  const {store}=await fixture(t,initial);
  let state=await store.channelProgram(0,{id:'lyrics',name:'Lyrics'},'fullscreen',allowed);
  assert.equal(programChannelVisible(state,channel.id),false);
  const checks:boolean[]=[];let commits=0;
  const sources=structuredClone(state.sources);
  state=await store.channelProgram(state.revision,channel,'auto',routing=>checks.push(routing),()=>commits++,21);
  assert.equal(state.channelInsert,undefined);
  assert.deepEqual(state.programCueGate,{channelId:channel.id,revision:21});
  assert.equal(commits,1);assert.deepEqual(checks,[true,true]);
  assert.deepEqual(state.program,initial.program);assert.deepEqual(state.sources,sources);
  assert.deepEqual(state.programTransition,initial.programTransition);assert.deepEqual(state.outputs,initial.outputs);
  assert.equal(programChannelVisible(state,channel.id),true);
});

test('visual inserts clone dormant always-unmuted channel inputs without changing the original soundtrack settings and reuse the safe copy',async t=>{
  const initial=base();const soundtrack={...source(),loop:true,audio:{...source().audio,mode:'always' as const,muted:false}};
  initial.sources.push(soundtrack);initial.program!.layers.push(layer({visible:false}));
  const {store}=await fixture(t,initial);
  let state=await store.channelProgram(0,channel,'auto',allowed);
  assert.deepEqual(state.sources.find(input=>input.id==='bible'),soundtrack);
  assert.equal(state.sources.length,2);
  const visual=state.sources.find(input=>input.id!=='bible')!;
  assert.equal(visual.channelId,channel.id);assert.equal(visual.loop,true);
  assert.equal(visual.audio.muted,true);assert.equal(visual.audio.mode,'follow');
  assert.equal(state.channelInsert?.sourceId,visual.id);assert.equal(state.channelInsert?.layer.sourceId,visual.id);
  assert.equal(state.channelInsert?.layer.y,70);assert.equal(state.channelInsert?.layer.channelStyle,'overlay');
  state=await store.returnToStudio(state.revision,state.channelInsert!.id);
  state=await store.channelProgram(state.revision,channel,'fullscreen',allowed);
  assert.equal(state.sources.length,2);assert.equal(state.channelInsert?.sourceId,visual.id);
  assert.deepEqual(state.sources.find(input=>input.id==='bible'),soundtrack);
});

test('already-live always sources update in place, while an unsafe visual copy at source capacity is rejected before cue commit',async t=>{
  const initial=base();initial.sources.push({...source(),audio:{...source().audio,mode:'always',muted:false}});initial.program!.layers.push(layer());
  const {store}=await fixture(t,initial);let commits=0;
  const state=await store.channelProgram(0,channel,'auto',allowed,()=>commits++);
  assert.equal(commits,1);assert.deepEqual(state,ProductionSchema.parse(initial));
  const full=structuredClone(initial);full.program!.layers.at(-1)!.visible=false;
  full.sources.push(...Array.from({length:39},(_,i)=>({...source(`filler_${i}`),channelId:`unrelated_${i}`})));
  const second=await fixture(t,full);
  await assert.rejects(second.store.channelProgram(0,channel,'auto',allowed,()=>commits++),/source library is full/);
  assert.equal(commits,1);assert.deepEqual(second.store.get(),ProductionSchema.parse(full));
});

test('fully off-canvas channel layers use a visible default lower third instead of copying unreachable geometry, while reusing their source',async t=>{
  for (const patch of [{x:100},{y:100},{x:-100,width:50},{y:-100,height:24}]) {
    const initial=base();initial.sources.push(source());initial.program!.layers.push(layer(patch));
    const {store}=await fixture(t,initial);
    const state=await store.channelProgram(0,channel,'auto',allowed);
    assert.equal(state.sources.length,1);assert.equal(state.channelInsert?.sourceId,'bible');
    assert.deepEqual(state.sources,initial.sources);assert.deepEqual(state.program,initial.program);
    assert.deepEqual([state.channelInsert?.layer.x,state.channelInsert?.layer.y,state.channelInsert?.layer.width,state.channelInsert?.layer.height],[8,68,84,26]);
    assert.equal(state.channelInsert?.layer.channelStyle,'overlay');assert.equal(programChannelVisible(state,channel.id),true);
  }
});

test('routing cue gates persist, cannot be forged or omitted by ordinary saves, and clear on Return, Take and presentation routes',async t=>{
  const {store,dir}=await fixture(t);
  let state=await store.channelProgram(0,channel,'auto',allowed,undefined,7);
  assert.deepEqual(state.programCueGate,{channelId:channel.id,revision:7});
  const gate=structuredClone(state.programCueGate);
  state.programCueGate={channelId:'forged',revision:99};
  state=await store.save(state);assert.deepEqual(state.programCueGate,gate);
  delete state.programCueGate;
  state=await store.save(state);assert.deepEqual(state.programCueGate,gate);
  const restarted=new ProductionStore(dir);await restarted.init();assert.deepEqual(restarted.get().programCueGate,gate);
  state=await store.returnToStudio(state.revision,state.channelInsert!.id);
  assert.equal(state.programCueGate,undefined);
  state=await store.channelProgram(state.revision,channel,'fullscreen',allowed,undefined,10);
  assert.equal(state.programCueGate?.revision,10);
  state=await store.command(state.revision,{type:'take',sceneId:'scene_message'});
  assert.equal(state.programCueGate,undefined);
  state=await store.channelProgram(state.revision,channel,'auto',allowed,undefined,12);
  state=await store.channelProgram(state.revision,{id:'presentation',name:'Announcements'},'auto',allowed);
  assert.equal(state.programCueGate,undefined);
});

test('content-only updates retain production revision and gate, while invalid gate metadata fails before cue commit',async t=>{
  const initial=base();initial.sources.push(source());initial.program!.layers.push(layer());initial.programCueGate={channelId:channel.id,revision:3};
  const {store}=await fixture(t,initial);
  let commits=0;
  const state=await store.channelProgram(0,channel,'auto',allowed,()=>commits++,20);
  assert.deepEqual(state,ProductionSchema.parse(initial));assert.equal(commits,1);
  assert.equal(ProductionSchema.safeParse({...initial,programCueGate:{channelId:channel.id,revision:-1}}).success,false);
  assert.equal(ProductionSchema.safeParse({...initial,programCueGate:{channelId:channel.id,revision:1,unexpected:true}}).success,false);
  const second=await fixture(t);
  await assert.rejects(second.store.channelProgram(0,channel,'auto',allowed,()=>commits++,-1),/greater than or equal to 0/);
  assert.equal(commits,1);assert.equal(second.store.get().programCueGate,undefined);
});
