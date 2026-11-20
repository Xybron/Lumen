import type {IncomingMessage} from 'node:http';
import {assemblyKey,ASSEMBLYAI_MODEL} from './assemblyai-stream.js';
import {createAssemblyBridge,type AssemblyBridgeOptions} from './assemblyai-bridge.js';
import {ListeningExamples,ExampleReviewSchema} from './listening-examples.js';
import {analyzeSpokenReferences} from './scripture-reference.js';
import { Router, raw, json, type Request, type Response, type NextFunction } from 'express';
import fs from 'node:fs/promises';
import {readFileSync,statSync} from 'node:fs';
import path from 'node:path';
import { z } from 'zod';
import { DATA_DIR, ROOT, CONTENT_FILE } from './paths.js';
import { requireSession, readSession, userCan, grantsFor } from './auth.js';
import { loadOwners } from './presence.js';
import type { RelayHandle } from './ws.js';
import { WorshipLibrary, SelectionSchema, WorshipCommandSchema } from './worship-library.js';
import { ProductionError } from './production-store.js';
import { LocalListener } from './local-listener.js';
import { suggestSharedLyrics } from './shared-lyrics.js';
import { ListeningSessions } from './listening-session.js';
import type { SharedListeningHub } from './shared-listening.js';
import type { WorshipWorkspace, ListeningSession } from '../../shared/worship.js';

const route=(fn:(req:Request,res:Response)=>Promise<unknown>|unknown)=>(req:Request,res:Response,next:NextFunction)=>{Promise.resolve().then(()=>fn(req,res)).catch(next);};
export async function createWorship(relay:RelayHandle,shared?:SharedListeningHub,cloudOptions:Pick<AssemblyBridgeOptions,'key'|'createStream'>={}) {
  const library=new WorshipLibrary(path.join(DATA_DIR,'worship.db'));
  if (!library.versions().find(v=>v.id==='KJV')?.installed && !library.db.prepare("SELECT 1 FROM worship_preferences WHERE key='suppress_default_kjv' AND value='1'").get()) {
    try {
      const books=JSON.parse((await fs.readFile(path.join(ROOT,'backend/assets/kjv.source.json'),'utf8')).replace(/^\uFEFF/,'')) as {chapters:string[][]}[];
      if (books.length!==66) throw new Error('KJV dataset must contain 66 books.');
      const verses=books.flatMap((book,b)=>book.chapters.flatMap((chapter,c)=>chapter.map((text,v)=>({book:b+1,chapter:c+1,verse:v+1,text}))));
      if (verses.length!==31102) throw new Error('KJV dataset verse count is invalid.');
      library.importBible({version:{id:'KJV',name:'King James Version',language:'en',attribution:'King James Version (KJV)'},verses});
    } catch(error) {console.warn('[worship] KJV library not installed:',(error as Error).message);}
  }
  const listener=new LocalListener();
  function publish(state:WorshipWorkspace) {
    const live=state.live;
    const cue=live?{id:`cue_${state.channelId}_${state.revision}`,type:live.selection.kind,title:live.title,body:live.text,reference:live.reference,subtitle:live.attribution,durationMs:0,
      ...(live.selection.kind==='lyrics'?{stanzas:[{id:live.selection.sectionId,lines:live.text}]}:{}),}:null;
    relay.setAuthoritativeChannel(state.channelId,{channelId:state.channelId,channelRevision:state.revision,playlistId:null,index:0,mode:'manual',playing:false,blanked:state.blanked,startedAt:null,durationMs:0,cue});
    relay.injectRemote({t:'worship-state',channel:state.channelId,workspace:state});
  }
  const sessions=new ListeningSessions(library,publish);
  const examples=new ListeningExamples(path.join(DATA_DIR,'ai/live-evaluation'));
  const cloudOrigins=new Map<string,string>();
  const cloudLeases=new Map<string,string>();
  let cloudChannels:{stamp:string;kinds:Map<string,'scripture'|'lyrics'>}|undefined;
  function cloudChannelExists(id:string){
    const stat=statSync(CONTENT_FILE,{bigint:true}),stamp=`${stat.dev}:${stat.ino}:${stat.mtimeNs}:${stat.size}`;
    if(cloudChannels?.stamp!==stamp){
      const content=JSON.parse(readFileSync(CONTENT_FILE,'utf8')) as {channels?:{id:string;kind:string}[]};
      cloudChannels={stamp,kinds:new Map((content.channels??[]).filter(channel=>['scripture','lyrics'].includes(channel.kind)).map(channel=>[channel.id,channel.kind as 'scripture'|'lyrics']))};
    }
    return cloudChannels.kinds.get(id);
  }
  const cloud=createAssemblyBridge({...cloudOptions,sessions,library,examples,drainOnStop:true,kind:id=>cloudChannelExists(id)??'scripture',
    onReady:(_channel,session)=>shared?.ready(session),
    onResult:({session,result,turn})=>{shared?.publish(session,result,!!turn.end_of_turn,turn.turn_order);},
    onClose:(channel,session)=>{cloudOrigins.delete(session);if(cloudLeases.get(channel)===session)cloudLeases.delete(channel);shared?.end(session);},
    authorize:(request:IncomingMessage,id:string,session:string)=>{
    const user=readSession(request as Request);
    if(!user||!userCan(user,id,'author'))throw new ProductionError(403,'Sign in with permission to control this channel.');
    if(!cloudChannelExists(id))throw new ProductionError(404,'The source listening channel no longer exists.');
    const lease=sessions.check(id,session,user.id),owner=loadOwners()[id];
    if(lease.provider!=='assemblyai'||lease.commands)throw new ProductionError(403,'This session does not use AssemblyAI shared listening.');
    if(owner&&owner!==user.id)throw new ProductionError(409,'Another operator controls this channel.');
    if(!request.headers.origin||request.headers.origin!==cloudOrigins.get(session))throw new ProductionError(403,'Streaming origin does not match the listening session.');
    return user.id;
  }});
  let modelChanging=false,modelGeneration=0;
  let externalListeningActive=()=>false,listeningStarts=0;
  const listeningGeneration=new Map<string,number>();
  function invalidateListening(id:string){const session=cloudLeases.get(id);cloud.stop(id);listeningGeneration.set(id,(listeningGeneration.get(id)??0)+1);sessions.stop(id);if(session){cloudLeases.delete(id);cloudOrigins.delete(session);shared?.end(session);}}
  function keepSharedListening(id:string){const session=shared?.snapshot().session;const keep=!!session&&['scripture','lyrics'].includes(session.source)&&session.channelId===id&&session.id===cloudLeases.get(id);if(keep){sessions.disarm(id);shared?.setMode(session!.id,'assisted');}return keep;}
  try {const content=JSON.parse(await fs.readFile(CONTENT_FILE,'utf8'));for (const ch of content.channels??[]) if (['scripture','lyrics'].includes(ch.kind)) publish(library.workspace(ch.id));} catch { /* new station */ }
  async function channel(req:Request,write=false) {
    const id=String(req.params.channelId);
    let channels:{id:string;kind:string}[]=[];
    try {channels=JSON.parse(await fs.readFile(CONTENT_FILE,'utf8')).channels??[];} catch { /* missing manifest */ }
    const ch=channels.find(c=>c.id===id && ['scripture','lyrics'].includes(c.kind));
    if (!ch) throw new ProductionError(404,'Scripture or Lyrics channel not found.');
    if (write) {
      const user=readSession(req);
      if (!user) throw new ProductionError(401,'Sign in to control this channel.');
      if (!userCan(user,id,'author')) throw new ProductionError(403,'You do not have permission to control this channel.');
      const owner=loadOwners()[id];
      if (owner && owner!==user.id) throw new ProductionError(409,'Another team member controls this channel. Take control before changing it.');
    }
    return ch as {id:string;kind:'scripture'|'lyrics'};
  }
  function libraryWriter(req:Request,res:Response,next:NextFunction) {
    const user=readSession(req);
    if (!user) return res.status(401).json({error:'Sign in to manage the library.'});
    if (!user.isAdmin && !grantsFor(user).some(g=>['author','owner'].includes(g.role))) return res.status(403).json({error:'An author role is required to manage the library.'});
    next();
  }
  const router=Router();
  router.get('/worship/scripture-pins',requireSession,route((_req,res)=>res.json(library.scripturePins())));
  router.post('/worship/scripture-pins',libraryWriter,route((req,res)=>res.json(library.pinScripture(req.body))));
  router.delete('/worship/scripture-pins/:id',libraryWriter,route((req,res)=>res.json(library.unpinScripture(z.string().uuid().parse(req.params.id)))));
  router.get('/worship/versions',requireSession,(_req,res)=>res.json(library.versions()));
  router.post('/worship/versions/import',libraryWriter,json({limit:'20mb'}),route((req,res)=>res.json(library.importBible(req.body))));
  router.get('/worship/scripture',requireSession,route((req,res)=>res.json(library.searchScripture(z.string().max(80).parse(req.query.version??'KJV'),z.string().max(500).parse(req.query.q??'')))));
  router.get('/worship/books',requireSession,route((req,res)=>res.json(library.books(z.string().max(80).parse(req.query.version??'KJV')))));
  router.post('/worship/preview',requireSession,route((req,res)=>res.json(library.cue(SelectionSchema.parse(req.body)))));
  router.get('/worship/songs',requireSession,route((req,res)=>res.json(library.songs(z.string().max(500).parse(req.query.q??'')))));
  router.get('/worship/song-search',requireSession,route((req,res)=>res.json(library.searchSongs(z.string().max(500).parse(req.query.q??'')))));
  router.post('/worship/songs',libraryWriter,route((req,res)=>res.status(201).json(library.saveSong(req.body))));
  router.get('/worship/songs/:id',requireSession,route((req,res)=>res.json(library.song(String(req.params.id)))));
  router.get('/worship/channels/:channelId',route(async(req,res)=>{await channel(req);const state=library.workspace(String(req.params.channelId));publish(state);res.json(state);}));
  router.post('/worship/channels/:channelId/command',requireSession,route(async(req,res)=>{
    const ch=await channel(req,true),input=z.object({revision:z.number().int().nonnegative(),command:WorshipCommandSchema}).parse(req.body);
    if (input.command.type==='take' && input.command.selection.kind!==ch.kind) throw new ProductionError(422,'The content does not match this channel type.');
    // Manual publication does not end the shared preacher audio. The cloud
    // matcher is disarmed by manual changes while linked Notes keep receiving
    // transcript. Local listening keeps its explicit stop/rearm rule.
    if(!keepSharedListening(ch.id))invalidateListening(ch.id);
    const state=library.command(ch.id,input.revision,input.command);publish(state);res.json(state);
  }));
  router.get('/worship/listening/status',requireSession,route(async(_req,res)=>res.json({...await listener.status(),assemblyai:{available:!!await assemblyKey(),model:ASSEMBLYAI_MODEL}})));
  router.post('/worship/listening/model',requireSession,route(async(req,res)=>{
    const user=readSession(req)!;
    if(!userCan(user,'*','author'))throw new ProductionError(403,'A station-wide author role is required to change the shared speech model.');
    const {modelId}=z.object({modelId:z.string().min(1).max(80)}).strict().parse(req.body);
    if(modelChanging||listeningStarts||sessions.hasActive()||externalListeningActive())throw new ProductionError(409,'Stop listening on every channel before changing the station speech model.');
    modelChanging=true;
    try{const status=await listener.selectModel(modelId);modelGeneration++;res.json(status);}finally{modelChanging=false;}
  }));
  router.get('/worship/channels/:channelId/listening/shared-result',requireSession,route(async(req,res)=>{
    const ch=await channel(req,true),user=readSession(req)!;
    if(ch.kind!=='lyrics')throw new ProductionError(422,'Song suggestions require a Lyrics channel.');
    const snapshot=shared?.snapshot();
    if(!snapshot?.session||snapshot.session.id!==req.query.session)throw new ProductionError(409,'The shared listening session has ended or changed.');
    if(!userCan(user,snapshot.session.channelId,'author'))throw new ProductionError(403,'You do not have access to the shared audio source.');
    res.set('Cache-Control','private, no-store').json({sessionId:snapshot.session.id,turn:snapshot.turn,
      result:snapshot.result?suggestSharedLyrics(library,ch.id,snapshot.result.transcript,snapshot.final):null});
  }));
  router.post('/worship/channels/:channelId/listening',requireSession,route(async(req,res)=>{
    const ch=await channel(req,true),options=z.object({provider:z.enum(['local','assemblyai']).default('local'),mode:z.enum(['assisted','automatic']),language:z.string().regex(/^[a-z]{2}$/).default('en'),commands:z.boolean().default(false)}).parse(req.body);
    if(modelChanging)throw new ProductionError(409,'The station speech model is changing. Try Listen again when it finishes.');
    if(shared?.snapshot().session)throw new ProductionError(409,'Shared listening is already active. Link to that transcript instead of starting another microphone.');
    if(externalListeningActive())throw new ProductionError(409,'Stop the active listener before starting another microphone.');
    if(options.provider==='assemblyai'&&(listeningStarts>0||sessions.hasActive()))throw new ProductionError(409,'Stop the active local listener before starting shared listening.');
    if (ch.kind==='scripture' && !library.versions().find(v=>v.id===library.workspace(ch.id).versionId)?.installed) throw new ProductionError(409,'Install and select a Bible version before listening.');
    if (ch.kind==='lyrics' && options.provider==='local' && !library.workspace(ch.id).setlist.length) throw new ProductionError(409,'Add songs to the setlist before listening.');
    const generation=(listeningGeneration.get(ch.id)??0)+1,selectedModelGeneration=modelGeneration;
    listeningGeneration.set(ch.id,generation);
    listeningStarts++;let lease:ListeningSession|undefined;
    try {
      if(options.provider==='assemblyai'){
        if(options.commands)throw new ProductionError(422,'Voice commands are not available with shared listening.');
        if(ch.kind==='lyrics'&&options.mode!=='assisted')throw new ProductionError(422,'Shared song listening suggests songs for review; choose Prepare only.');
        lease=sessions.start(ch.id,readSession(req)!.id,options);cloudLeases.set(ch.id,lease.id);
        shared?.reserve({id:lease.id,channelId:ch.id,source:ch.kind,ownerId:readSession(req)!.id,provider:'assemblyai',mode:options.mode,startedAt:Date.now()},()=>{if(!cloud.finish(ch.id))invalidateListening(ch.id);});
        if(!await (cloudOptions.key??assemblyKey)())throw new ProductionError(409,'Add ASSEMBLYAI_API_KEY to the station .env to enable streaming.');
      }else await listener.start(); if(res.destroyed)throw new ProductionError(409,'Listening start was cancelled.');
      await channel(req,true); if(res.destroyed)throw new ProductionError(409,'Listening start was cancelled.');
      if(modelChanging||selectedModelGeneration!==modelGeneration)throw new ProductionError(409,'The station speech model changed. Try Listen again.');
      if(listeningGeneration.get(ch.id)!==generation)throw new ProductionError(409,'This listening start was cancelled. Click Listen to start again.');
      lease??=sessions.start(ch.id,readSession(req)!.id,options);
      if(options.provider==='assemblyai'){const sessionId=lease.id;cloudOrigins.set(sessionId,req.get('origin')??`${req.protocol}://${req.get('host')}`);setTimeout(()=>cloudOrigins.delete(sessionId),4*60*60*1000).unref();}
      res.json(lease);
    } catch(error){if(lease&&cloudLeases.get(ch.id)===lease.id)invalidateListening(ch.id);throw error;}
    finally { listeningStarts--; }
  }));
  router.delete('/worship/channels/:channelId/listening',requireSession,route(async(req,res)=>{
    const ch=await channel(req),user=readSession(req)!;
    if(!sessions.stopOwned(ch.id,user.id))await channel(req,true);
    invalidateListening(ch.id);
    res.json({ok:true});
  }));
  router.post('/worship/channels/:channelId/listening/heartbeat',requireSession,route(async(req,res)=>{const ch=await channel(req,true);res.json(sessions.renew(ch.id,z.string().uuid().parse(req.body.sessionId),readSession(req)!.id));}));
  router.post('/worship/channels/:channelId/listening/audio',requireSession,raw({type:'audio/wav',limit:'400kb'}),route(async(req,res)=>{
    const ch=await channel(req,true),user=readSession(req)!;
    const id=z.string().uuid().parse(req.query.session),sequence=z.coerce.number().int().nonnegative().parse(req.query.sequence);
    const lease=sessions.check(ch.id,id,user.id),revision=library.workspace(ch.id).revision;
    if(lease.provider==='assemblyai')throw new ProductionError(422,'Use the streaming connection for AssemblyAI audio.');
    if (!Buffer.isBuffer(req.body)) throw new ProductionError(422,'An audio/wav body is required.');
    const transcript=await listener.transcribe(req.body,lease.language,ch.kind);
    await channel(req,true);
    res.json(sessions.accept(ch.id,id,user.id,sequence,ch.kind,transcript.text,transcript.elapsedMs,revision,transcript.recognition));
  }));
  router.get('/worship/listening/examples',requireSession,route(async(req,res)=>res.json(await examples.list(readSession(req)!.id,z.string().max(100).parse(req.query.channel)))));
  router.get('/worship/listening/examples/:id/audio',requireSession,route(async(req,res)=>{res.type('audio/wav').send(await examples.audio(String(req.params.id),readSession(req)!.id));}));
  router.get('/worship/listening/examples/:id',requireSession,route(async(req,res)=>res.json(await examples.read(String(req.params.id),readSession(req)!.id))));
  router.patch('/worship/listening/examples/:id',requireSession,route(async(req,res)=>{
    const review=ExampleReviewSchema.parse(req.body),evidence=analyzeSpokenReferences(review.reference),references=evidence.references;
    if(review.reference.trim()&&(evidence.invalid||evidence.negated||!references.length||references.some(r=>!r.complete)))throw new ProductionError(422,'Enter complete references, for example John 3:16, or leave blank for no scripture.');
    const record=await examples.read(String(req.params.id),readSession(req)!.id);
    const versionId=library.workspace(record.channelId).versionId;
    const expected=references.map(r=>({book:r.book,chapter:r.chapter!,verse:r.verse!,...(r.endVerse?{endVerse:r.endVerse}:{})}));
    for(const reference of expected)library.cue({kind:'scripture',versionId,...reference});
    res.json(await examples.review(record.id,readSession(req)!.id,review,expected));
  }));
  router.delete('/worship/listening/examples/:id',requireSession,route(async(req,res)=>{await examples.remove(String(req.params.id),readSession(req)!.id);res.json({ok:true});}));
  router.use((error:Error,_req:Request,res:Response,_next:NextFunction)=>{const status=error instanceof ProductionError?error.status:error instanceof z.ZodError?422:500;res.status(status).json({error:error instanceof z.ZodError?error.issues[0].message:error.message});});
  // Snapshot only already-published content; never consume a prepared cue.
  // Replaying the authoritative snapshot also initializes channels created
  // since startup before the renderer subscribes to a newly added source.
  async function sceneCueGates(channelIds:string[]) {
    if (!channelIds.length) return [];
    const content=JSON.parse(await fs.readFile(CONTENT_FILE,'utf8'));
    return [...new Set(channelIds)].filter(id=>content.channels?.some((ch:{id:string;kind?:string})=>ch.id===id&&['scripture','lyrics'].includes(ch.kind??''))).map(channelId=>{
      const state=library.workspace(channelId);publish(state);
      return {channelId,revision:state.revision};
    });
  }
  return {router,library,sceneCueGates,listener,cloudWss:cloud.wss,
    hasActiveListening:()=>modelChanging||listeningStarts>0||sessions.hasActive()||!!shared?.snapshot().session,
    setExternalListeningGuard(guard:()=>boolean){externalListeningActive=guard;},
    dataCleared(channelIds: string[]) { for (const id of channelIds) { invalidateListening(id); publish(library.workspace(id)); } },
    mobile: {
      workspace: (channelId:string) => library.workspace(channelId),
      search: (channelId:string, query:string) => {
        const workspace = library.workspace(channelId);
        return { scripture: () => library.searchScripture(workspace.versionId,query), lyrics: () => library.searchSongs(query) };
      },
      command: (channelId:string, revision:number, command:import('../../shared/worship.js').WorshipCommand, authorize:()=>void) => {
        authorize(); if(!keepSharedListening(channelId))invalidateListening(channelId);
        const state=library.command(channelId,revision,command);publish(state);return state;
      },
    },close(){cloud.close();listener.close();library.close();}};
}
