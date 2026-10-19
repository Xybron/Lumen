import { Router, raw, json, type Request, type Response, type NextFunction } from 'express';
import fs from 'node:fs/promises';
import path from 'node:path';
import { z } from 'zod';
import { DATA_DIR, ROOT, CONTENT_FILE } from './paths.js';
import { requireSession, readSession, userCan, grantsFor } from './auth.js';
import { loadOwners } from './presence.js';
import type { RelayHandle } from './ws.js';
import { WorshipLibrary, SelectionSchema, WorshipCommandSchema } from './worship-library.js';
import { ProductionError } from './production-store.js';
import { LocalListener } from './local-listener.js';
import { ListeningSessions } from './listening-session.js';
import type { WorshipWorkspace } from '../../shared/worship.js';

const route=(fn:(req:Request,res:Response)=>Promise<unknown>|unknown)=>(req:Request,res:Response,next:NextFunction)=>{Promise.resolve().then(()=>fn(req,res)).catch(next);};
export async function createWorship(relay:RelayHandle) {
  const library=new WorshipLibrary(path.join(DATA_DIR,'worship.db'));
  if (!library.versions().find(v=>v.id==='KJV')?.installed) {
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
  let modelChanging=false,modelGeneration=0;
  const listeningGeneration=new Map<string,number>();
  function invalidateListening(id:string){listeningGeneration.set(id,(listeningGeneration.get(id)??0)+1);sessions.stop(id);}
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
    // Manual changes invalidate in-flight inference and require an explicit rearm.
    invalidateListening(ch.id);
    const state=library.command(ch.id,input.revision,input.command);publish(state);res.json(state);
  }));
  router.get('/worship/listening/status',requireSession,route(async(_req,res)=>res.json(await listener.status())));
  router.post('/worship/listening/model',requireSession,route(async(req,res)=>{
    const user=readSession(req)!;
    if(!userCan(user,'*','author'))throw new ProductionError(403,'A station-wide author role is required to change the shared speech model.');
    const {modelId}=z.object({modelId:z.string().min(1).max(80)}).strict().parse(req.body);
    if(modelChanging||sessions.hasActive())throw new ProductionError(409,'Stop listening on every channel before changing the station speech model.');
    modelChanging=true;
    try{const status=await listener.selectModel(modelId);modelGeneration++;res.json(status);}finally{modelChanging=false;}
  }));
  router.post('/worship/channels/:channelId/listening',requireSession,route(async(req,res)=>{
    const ch=await channel(req,true),options=z.object({mode:z.enum(['assisted','automatic']),language:z.string().regex(/^[a-z]{2}$/).default('en'),commands:z.boolean().default(false)}).parse(req.body);
    if(modelChanging)throw new ProductionError(409,'The station speech model is changing. Try Listen again when it finishes.');
    if (ch.kind==='scripture' && !library.versions().find(v=>v.id===library.workspace(ch.id).versionId)?.installed) throw new ProductionError(409,'Install and select a Bible version before listening.');
    if (ch.kind==='lyrics' && !library.workspace(ch.id).setlist.length) throw new ProductionError(409,'Add songs to the setlist before listening.');
    const generation=(listeningGeneration.get(ch.id)??0)+1,selectedModelGeneration=modelGeneration;
    listeningGeneration.set(ch.id,generation);
    await listener.start(); if(res.destroyed)return;
    await channel(req,true);
    if(res.destroyed)return;
    if(modelChanging||selectedModelGeneration!==modelGeneration)throw new ProductionError(409,'The station speech model changed. Try Listen again.');
    if(listeningGeneration.get(ch.id)!==generation)throw new ProductionError(409,'This listening start was cancelled. Click Listen to start again.');
    res.json(sessions.start(ch.id,readSession(req)!.id,options));
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
    if (!Buffer.isBuffer(req.body)) throw new ProductionError(422,'An audio/wav body is required.');
    const transcript=await listener.transcribe(req.body,lease.language,ch.kind);
    await channel(req,true);
    res.json(sessions.accept(ch.id,id,user.id,sequence,ch.kind,transcript.text,transcript.elapsedMs,revision));
  }));
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
  return {router,library,sceneCueGates,close(){listener.close();library.close();}};
}
