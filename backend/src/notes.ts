import { Router, raw, type Request, type Response, type NextFunction } from 'express';
import fs from 'node:fs/promises';
import { readFileSync, statSync } from 'node:fs';
import type { IncomingMessage } from 'node:http';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import { CONTENT_FILE, DATA_DIR } from './paths.js';
import { requireSession, readSession, userCan, userFromCookieHeader, type SessionUser } from './auth.js';
import { loadOwners } from './presence.js';
import { ProductionError } from './production-store.js';
import { NotesStore, NotesDraftSchema, novelNotesText } from './notes-store.js';
import type { LocalListener } from './local-listener.js';
import type { NotesDraft, NotesListeningSession, NotesSegment } from '../../shared/notes.js';
import type { SharedListeningSession, SharedListeningSnapshot } from '../../shared/listening.js';
import type { WorshipLibrary } from './worship-library.js';
import { ListeningSessions } from './listening-session.js';
import { assemblyKey } from './assemblyai-stream.js';
import { createAssemblyBridge, type AssemblyBridgeOptions } from './assemblyai-bridge.js';
import { SharedListeningHub } from './shared-listening.js';

const route=(fn:(req:Request,res:Response)=>Promise<unknown>|unknown)=>(req:Request,res:Response,next:NextFunction)=>{Promise.resolve().then(()=>fn(req,res)).catch(next);};
interface Lease extends NotesListeningSession { provider:'local'|'assemblyai';userId:string;lastSequence:number;previousText:string;busy:boolean;origin:string;starting:boolean }
interface TranscriptLink { channelId:string;itemId:string;sessionId:string;userId:string;cookie:string|undefined;afterTurn:number;lastFinalTurn:number;lastSegment?:NotesSegment }
export function createNotes(options:{listener:LocalListener;otherListeningActive:()=>boolean;library?:WorshipLibrary;shared?:SharedListeningHub;cloudOptions?:Pick<AssemblyBridgeOptions,'key'|'createStream'>}) {
  const store=new NotesStore(path.join(DATA_DIR,'notes.db')),router=Router();
  const shared=options.shared??new SharedListeningHub(),links=new Map<string,TranscriptLink>();
  const linkKey=(channelId:string,itemId:string)=>JSON.stringify([channelId,itemId]);
  let lease:Lease|null=null;
  // Notes uses the same matcher in assisted mode, with no public-state callback.
  const matching=options.library?new ListeningSessions(options.library,()=>{}):undefined;
  let cachedContent:{stamp:string;value:any}|undefined;
  function streamingContent(){
    const stat=statSync(CONTENT_FILE,{bigint:true}),stamp=`${stat.dev}:${stat.ino}:${stat.mtimeNs}:${stat.size}`;
    if(cachedContent?.stamp!==stamp)cachedContent={stamp,value:JSON.parse(readFileSync(CONTENT_FILE,'utf8'))};
    return cachedContent.value;
  }
  function notesItem(content:any,channelId:string,itemId:string){
    const channel=content.channels?.find((value:{id:string})=>value.id===channelId);
    const item=content.playlists?.find((value:{id:string})=>value.id===channel?.playlistId)?.items?.find((value:{id:string;type:string})=>value.id===itemId&&value.type==='notes');
    if(!channel||!item)throw new ProductionError(404,'This Notes slide no longer exists.');
    return item;
  }
  function sourceAccess(user:SessionUser|null,session:SharedListeningSession){
    if(!user||!userCan(user,session.channelId,'author'))throw new ProductionError(403,'An author role on the listening source is required to link its transcript.');
    const content=streamingContent();
    if(!content.channels?.some((channel:{id:string})=>channel.id===session.channelId))throw new ProductionError(404,'The listening source channel no longer exists.');
    const sourceOwner=loadOwners()[session.channelId];
    if(sourceOwner&&sourceOwner!==session.ownerId)throw new ProductionError(409,'Control of the listening source changed.');
  }
  function checkLink(link:TranscriptLink,session:SharedListeningSession){
    const user=userFromCookieHeader(link.cookie);
    if(!user||user.id!==link.userId||!userCan(user,link.channelId,'author'))throw new ProductionError(403,'Notes author access changed.');
    sourceAccess(user,session);
    notesItem(streamingContent(),link.channelId,link.itemId);
    const owner=loadOwners()[link.channelId];if(owner&&owner!==user.id)throw new ProductionError(409,'Control of these Notes changed.');
  }
  function updateLinkedCount(){const session=shared.snapshot().session;if(session)shared.setLinkedCount(session.id,[...links.values()].filter(link=>link.sessionId===session.id).length);}
  function pruneLinks(snapshot=shared.snapshot()){
    let changed=false;
    for(const [key,link] of links){
      try{if(!snapshot.session||snapshot.session.id!==link.sessionId)throw new Error('Listening ended.');checkLink(link,snapshot.session);}
      catch{links.delete(key);changed=true;}
    }
    if(changed)updateLinkedCount();
  }
  function consume(snapshot:SharedListeningSnapshot){
    pruneLinks(snapshot);
    if(!snapshot.session||!snapshot.final||!snapshot.result)return;
    for(const [key,link] of links){
      if(link.sessionId!==snapshot.session.id||snapshot.turn<=link.lastFinalTurn)continue;
      // Snapshot metadata updates and duplicate final events must not append twice.
      link.lastFinalTurn=snapshot.turn;
      try{checkLink(link,snapshot.session);link.lastSegment=store.appendSegment(link.channelId,link.itemId,link.sessionId,snapshot.turn,snapshot.result.transcript,true);}
      catch{links.delete(key);}
    }
    updateLinkedCount();
  }
  const unsubscribe=shared.subscribe(consume);
  const linkTimer=setInterval(()=>pruneLinks(),2000);linkTimer.unref();
  function addLink(channelId:string,itemId:string,cookie:string|undefined,userId:string,sessionId:string){
    pruneLinks();
    const snapshot=shared.snapshot();
    if(!snapshot.session||snapshot.session.id!==sessionId)throw new ProductionError(409,'That listening session has ended. Start listening before linking Notes.');
    const key=linkKey(channelId,itemId),previous=links.get(key);
    if(previous?.sessionId===sessionId){checkLink(previous,snapshot.session);return;}
    const link:TranscriptLink={channelId,itemId,cookie,userId,sessionId,afterTurn:snapshot.turn,lastFinalTurn:snapshot.turn};
    checkLink(link,snapshot.session);links.set(key,link);updateLinkedCount();
  }
  function stopLease(current=lease){
    if(!current||lease!==current)return;
    lease=null;
    if(current.provider==='assemblyai'){cloud?.stop(current.channelId);matching?.stop(current.channelId);shared.end(current.id);}
  }
  const hasActive=()=>{
    if(lease?.provider==='assemblyai'&&!lease.starting&&matching){
      try{lease.expiresAt=matching.check(lease.channelId,lease.id,lease.userId).expiresAt;}catch{stopLease();}
    }
    if(lease&&lease.expiresAt<=Date.now())stopLease();
    return !!lease;
  };
  const publicLease=(value:Lease):NotesListeningSession=>({id:value.id,channelId:value.channelId,itemId:value.itemId,expiresAt:value.expiresAt,provider:value.provider});
  function authorizeCloud(request:IncomingMessage,channelId:string,sessionId:string){
    const user=readSession(request as Request),itemId=new URL(request.url!,'http://localhost').searchParams.get('item');
    if(!user||!userCan(user,channelId,'author'))throw new ProductionError(403,'Sign in with permission to open these private notes.');
    if(!hasActive()||!lease||lease.starting||lease.id!==sessionId||lease.channelId!==channelId||lease.itemId!==itemId||lease.userId!==user.id||lease.provider!=='assemblyai')throw new ProductionError(409,'Notes listening stopped or expired. Start again when ready.');
    if(!request.headers.origin||request.headers.origin!==lease.origin)throw new ProductionError(403,'Streaming origin does not match the Notes session.');
    const owner=loadOwners()[channelId];if(owner&&owner!==user.id)throw new ProductionError(409,'Another team member controls this channel.');
    // The preacher stream belongs to the source channel, not the optional Note
    // that launched it. Unlinking/deleting that Note must not interrupt Scripture.
    if(!streamingContent().channels?.some((channel:{id:string})=>channel.id===channelId))throw new ProductionError(404,'The listening source channel no longer exists.');
    const current=matching!.check(channelId,sessionId,user.id);
    if(current.mode!=='assisted'||current.commands)throw new ProductionError(403,'Notes scripture suggestions require review.');
    return user.id;
  }
  const cloud=options.library&&matching?createAssemblyBridge({
    ...options.cloudOptions,sessions:matching,library:options.library,authorize:authorizeCloud,drainOnStop:true,
    onReady(_channel,session){shared.ready(session);},
    onClose(channelId,sessionId){if(lease?.channelId===channelId&&lease.id===sessionId)lease=null;shared.end(sessionId);},
    onResult({channel,session,turn,result}){
      const current=lease;
      if(!current||current.id!==session)return;
      shared.publish(session,result,!!turn.end_of_turn,turn.turn_order);
      const segment=links.get(linkKey(channel,current.itemId))?.lastSegment;
      if(segment?.sessionId!==session||segment.sequence!==turn.turn_order||!turn.end_of_turn)return;
      return segment?{segment}:undefined;
    },
  }):undefined;
  async function authorize(req:Request,write=false) {
    const channelId=z.string().min(1).max(160).parse(req.params.channelId),itemId=z.string().min(1).max(160).parse(req.params.itemId),user=readSession(req);
    if(!user)throw new ProductionError(401,'Sign in to open private notes.');
    if(!userCan(user,channelId,'author'))throw new ProductionError(403,'An author role is required to open private notes.');
    const content=JSON.parse(await fs.readFile(CONTENT_FILE,'utf8'));
    const item=notesItem(content,channelId,itemId);
    if(write){const owner=loadOwners()[channelId];if(owner&&owner!==user.id)throw new ProductionError(409,'Another team member controls this channel.');}
    resNoStore(req);
    const channel=content.channels.find((value:{id:string})=>value.id===channelId);
    const items=content.playlists.find((value:{id:string})=>value.id===channel.playlistId).items;
    return {channelId,itemId,user,item,items};
  }
  function initialDraft(a:Awaited<ReturnType<typeof authorize>>):NotesDraft {
    const children=a.items.filter((item:{id:string;type:string;notesSourceId?:string})=>item.id!==a.itemId&&item.type==='notes'&&item.notesSourceId===a.itemId);
    return {title:a.item.title??'',body:children.length?[a.item,...children].map(item=>item.body??'').join('\n'):a.item.body??'',reference:a.item.reference??'',layout:a.item.layout??'key-points',
      grouping:children.length?'pointers':'single',...(a.item.background?{background:a.item.background}:{}),...(a.item.typography?{typography:a.item.typography}:{})};
  }
  function resNoStore(req:Request){req.res?.set('Cache-Control','private, no-store');}
  function check(req:Request,sessionId:string) {
    if(!hasActive()||!lease||lease.id!==sessionId||lease.userId!==readSession(req)?.id||lease.channelId!==req.params.channelId||lease.itemId!==req.params.itemId)throw new ProductionError(409,'Notes listening stopped or expired. Start again when ready.');
    return lease;
  }
  function authorizeProducerRequest(req:Request){
    const user=readSession(req),channelId=String(req.params.channelId);
    if(!user||!userCan(user,channelId,'author'))throw new ProductionError(403,'An author role is required to control listening.');
    if(!streamingContent().channels?.some((channel:{id:string})=>channel.id===channelId))throw new ProductionError(404,'The listening source channel no longer exists.');
    const owner=loadOwners()[channelId];if(owner&&owner!==user.id)throw new ProductionError(409,'Another team member controls the listening source.');
    resNoStore(req);return user;
  }
  function linkResponse(channelId:string,itemId:string,after:number){
    pruneLinks();const link=links.get(linkKey(channelId,itemId));
    return {clearedThrough:store.clearedThrough(channelId,itemId),sessionId:link?.sessionId??null,linked:!!link,afterTurn:link?.afterTurn??-1,segments:store.segmentsSince(channelId,itemId,after)};
  }
  const prefix='/notes/channels/:channelId/items/:itemId';
  router.delete(`${prefix}/transcript`,requireSession,route(async(req,res)=>{
    const a=await authorize(req,true),input=z.object({throughId:z.number().int().nonnegative().safe()}).strict().parse(req.body);
    const last=store.get(a.channelId,a.itemId).segments.at(-1)?.id??store.clearedThrough(a.channelId,a.itemId);
    if(input.throughId>last)throw new ProductionError(409,'Refresh the transcript before clearing it.');
    res.json(store.clearTranscript(a.channelId,a.itemId,input.throughId));
  }));
  router.get(`${prefix}`,requireSession,route(async(req,res)=>{const a=await authorize(req);res.json(store.get(a.channelId,a.itemId,initialDraft(a)));}));
  router.put(`${prefix}`,requireSession,route(async(req,res)=>{const a=await authorize(req,true),input=z.object({revision:z.number().int().nonnegative(),draft:NotesDraftSchema}).strict().parse(req.body),transcript=z.enum(['include','omit']).default('include').parse(req.query.transcript);res.json(store.saveDraft(a.channelId,a.itemId,input.revision,input.draft,transcript!=='omit'));}));
  router.get(`${prefix}/listening/link`,requireSession,route(async(req,res)=>{const a=await authorize(req),after=z.coerce.number().int().nonnegative().parse(req.query.after??0);res.json(linkResponse(a.channelId,a.itemId,after));}));
  router.post(`${prefix}/listening/link`,requireSession,route(async(req,res)=>{
    const a=await authorize(req,true),input=z.object({sessionId:z.string().uuid()}).strict().parse(req.body);
    if(lease?.provider==='local')throw new ProductionError(409,'Stop local Notes transcription before linking the shared transcript.');
    const snapshot=shared.snapshot();if(snapshot.session?.state==='finishing')throw new ProductionError(409,'Listening is finishing. Start a new session before linking Notes.');
    store.get(a.channelId,a.itemId,initialDraft(a));
    addLink(a.channelId,a.itemId,req.headers.cookie,a.user.id,input.sessionId);res.json(linkResponse(a.channelId,a.itemId,0));
  }));
  router.delete(`${prefix}/listening/link`,requireSession,route(async(req,res)=>{
    const a=await authorize(req,true);links.delete(linkKey(a.channelId,a.itemId));updateLinkedCount();res.json({sessionId:null,linked:false,afterTurn:-1,segments:[]});
  }));
  router.post(`${prefix}/listening`,requireSession,route(async(req,res)=>{
    const a=await authorize(req,true),input=z.object({provider:z.enum(['local','assemblyai']).default('local')}).strict().parse(req.body??{});
    if(hasActive()||options.otherListeningActive()||shared.snapshot().session)throw new ProductionError(409,'A listener is already active. Link to its transcript or stop it before starting another.');
    const current:Lease={id:randomUUID(),channelId:a.channelId,itemId:a.itemId,userId:a.user.id,provider:input.provider,expiresAt:Date.now()+120000,lastSequence:-1,previousText:'',busy:false,origin:req.get('origin')??`${req.protocol}://${req.get('host')}`,starting:true};lease=current;
    try {
      if(input.provider==='assemblyai'){
        if(!cloud||!matching||!options.library)throw new ProductionError(409,'AssemblyAI is not available in Notes on this station.');
        if(!await(options.cloudOptions?.key??assemblyKey)())throw new ProductionError(409,'Add ASSEMBLYAI_API_KEY to the station .env and try again.');
        if(!options.library.versions().some(version=>version.id===options.library!.workspace(a.channelId).versionId&&version.installed))throw new ProductionError(409,'Install a Bible version before listening for scripture in Notes.');
      }else await options.listener.start();
      await authorize(req,true);if(lease!==current||res.destroyed)throw new ProductionError(409,'Notes listening start was cancelled.');
      if(input.provider==='assemblyai'){
        const matchLease=matching!.start(a.channelId,a.user.id,{provider:'assemblyai',mode:'assisted',commands:false,language:'en'});
        current.id=matchLease.id;
        shared.reserve({id:current.id,channelId:a.channelId,source:'notes',ownerId:a.user.id,provider:'assemblyai',startedAt:Date.now()},()=>{if(!cloud!.finish(current.channelId))stopLease(current);});
        store.get(a.channelId,a.itemId,initialDraft(a));
        addLink(a.channelId,a.itemId,req.headers.cookie,a.user.id,current.id);
      }
      current.starting=false;current.expiresAt=Date.now()+45000;res.json(publicLease(current));
    }catch(error){stopLease(current);throw error;}
  }));
  router.delete(`${prefix}/listening`,requireSession,route(async(req,res)=>{
    const id=z.string().uuid().parse(req.query.session);
    if(lease?.provider==='assemblyai'&&lease.id===id){authorizeProducerRequest(req);check(req,id);stopLease();}
    else{const a=await authorize(req);if(lease?.id===id&&lease.userId===a.user.id&&lease.channelId===a.channelId&&lease.itemId===a.itemId)stopLease();}
    res.json({ok:true});
  }));
  router.post(`${prefix}/listening/heartbeat`,requireSession,route(async(req,res)=>{const id=z.string().uuid().parse(req.body.sessionId);if(lease?.provider==='assemblyai'&&lease.id===id)authorizeProducerRequest(req);else await authorize(req,true);const current=check(req,id);if(current.provider==='assemblyai')matching!.renew(current.channelId,current.id,current.userId);current.expiresAt=Date.now()+45000;res.json(publicLease(current));}));
  router.post(`${prefix}/listening/audio`,requireSession,raw({type:'audio/wav',limit:'400kb'}),route(async(req,res)=>{
    const a=await authorize(req,true),current=check(req,z.string().uuid().parse(req.query.session)),sequence=z.coerce.number().int().nonnegative().parse(req.query.sequence);
    if(current.provider==='assemblyai')throw new ProductionError(409,'AssemblyAI Notes listening uses the realtime audio connection.');
    if(sequence<=current.lastSequence)return res.json(store.get(a.channelId,a.itemId));
    if(sequence!==current.lastSequence+1)throw new ProductionError(409,'An audio window is missing. Restart Notes listening.');
    if(current.busy)throw new ProductionError(409,'The previous Notes audio window is still being processed.');
    if(!Buffer.isBuffer(req.body))throw new ProductionError(422,'An audio/wav body is required.');
    current.busy=true;
    try {
      const result=await options.listener.transcribe(req.body,'en');
      await authorize(req,true);check(req,current.id);
      const text=result.recognition?.status==='no-speech'?'':novelNotesText(current.previousText,result.text);
      const document=store.append(a.channelId,a.itemId,current.id,sequence,text,result.recognition?.status!=='clear');
      current.lastSequence=sequence;current.previousText=result.text;current.expiresAt=Date.now()+45000;
      res.json(document);
    } finally {current.busy=false;}
  }));
  router.use((error:Error,_req:Request,res:Response,_next:NextFunction)=>{res.status(error instanceof ProductionError?error.status:error instanceof z.ZodError?422:500).json({error:error instanceof z.ZodError?error.issues[0].message:error.message});});
  return {router,hasActive,cloudWss:cloud?.wss,close(){clearInterval(linkTimer);unsubscribe();links.clear();stopLease();cloud?.close();if(!options.shared)shared.close();store.close();}};
}
