import { Router, type Request, type Response, type NextFunction } from 'express';
import { z } from 'zod';
import { readSession, requireSession, userCan, type SessionUser } from './auth.js';
import { ProductionError } from './production-store.js';
import type { ListeningResult } from '../../shared/worship.js';
import type { SharedListeningSession, SharedListeningSnapshot } from '../../shared/listening.js';

const empty = ():SharedListeningSnapshot => ({session:null,result:null,final:false,turn:-1});
type Reservation = Omit<SharedListeningSession,'state'|'linkedNotes'>;

/** Private fan-out of one producer's words. This hub never opens a microphone,
 * transcribes again, records audio or sends words through the public relay. */
export class SharedListeningHub {
  readonly router=Router();
  private current:SharedListeningSnapshot=empty();
  private stopProducer:(()=>void)|undefined;
  private startupDeadline:ReturnType<typeof setTimeout>|undefined;
  private subscribers=new Set<(snapshot:SharedListeningSnapshot)=>void>();
  private streams=new Set<Response>();
  private stopping=false;

  constructor(){
    this.router.get('/listening/shared',requireSession,(req,res)=>{
      res.set('Cache-Control','private, no-store').json(this.visible(readSession(req)));
    });
    this.router.get('/listening/shared/events',requireSession,(req,res)=>{
      res.set({'Content-Type':'text/event-stream','Cache-Control':'private, no-store','Connection':'keep-alive','X-Accel-Buffering':'no'});
      res.flushHeaders();this.streams.add(res);
      let ended=false,last='';
      const close=()=>{if(ended)return;ended=true;unsubscribe();clearInterval(heartbeat);this.streams.delete(res);res.end();};
      const send=()=>{
        if(ended)return;
        try{
          const user=readSession(req);if(!user){close();return;}
          const value=JSON.stringify(this.visible(user));
          if(value===last)return;
          if(res.writableLength>256*1024){close();return;}
          last=value;res.write(`data: ${value}\n\n`);
        }catch{close();}
      };
      const unsubscribe=this.subscribe(send);
      const heartbeat=setInterval(()=>{send();if(!ended)res.write(': keep-alive\n\n');},2000);heartbeat.unref();
      req.on('close',close);res.on('error',close);send();
    });
    this.router.delete('/listening/shared',requireSession,(req,res,next)=>{
      try{
        const id=z.string().uuid().parse(req.query.session),user=readSession(req)!;
        const session=this.current.session;
        if(!session||session.id!==id){res.json({ok:true});return;}
        if(session.ownerId!==user.id||!userCan(user,session.channelId,'author'))throw new ProductionError(403,'Only the operator who started listening can stop this shared session.');
        this.stop(id);res.json({ok:true});
      }catch(error){next(error);}
    });
    this.router.use((error:Error,_req:Request,res:Response,_next:NextFunction)=>{
      res.status(error instanceof ProductionError?error.status:error instanceof z.ZodError?422:500).json({error:error instanceof z.ZodError?error.issues[0].message:error.message});
    });
  }

  reserve(session:Reservation,stop:()=>void){
    if(this.current.session)throw new ProductionError(409,'A shared listening session is already active. Link to it instead of opening another microphone.');
    this.stopProducer=stop;this.stopping=false;
    this.current={...empty(),session:{...session,state:'starting',linkedNotes:0}};
    this.startupDeadline=setTimeout(()=>{if(this.current.session?.id!==session.id)return;try{this.stop(session.id);}finally{this.end(session.id);}},45000);this.startupDeadline.unref();
    this.emit();
  }
  setMode(id:string,mode:'assisted'|'automatic'){if(this.current.session?.id!==id)return;this.current={...this.current,session:{...this.current.session,mode}};this.emit();}
  ready(id:string){
    if(this.current.session?.id!==id||this.stopping)return;
    clearTimeout(this.startupDeadline);this.startupDeadline=undefined;
    this.current={...this.current,session:{...this.current.session,state:'listening'}};this.emit();
  }
  publish(id:string,result:ListeningResult,final:boolean,turn:number){
    if(this.current.session?.id!==id)return;
    this.current={...this.current,result:structuredClone(result),final,turn};this.emit();
  }
  end(id:string){
    if(this.current.session?.id!==id)return;
    clearTimeout(this.startupDeadline);this.startupDeadline=undefined;this.stopProducer=undefined;this.stopping=false;
    this.current=empty();this.emit();
  }
  stop(id:string){
    if(this.current.session?.id!==id||this.stopping)return;
    this.stopping=true;
    this.current={...this.current,session:{...this.current.session,state:'finishing'}};this.emit();
    try{this.stopProducer?.();}catch(error){this.end(id);throw error;}
  }
  finish(id:string){this.stop(id);}
  snapshot():SharedListeningSnapshot{return structuredClone(this.current);}
  subscribe(callback:(snapshot:SharedListeningSnapshot)=>void){this.subscribers.add(callback);return()=>{this.subscribers.delete(callback);};}
  setLinkedCount(id:string,count:number){
    if(this.current.session?.id!==id)return;
    const bounded=Math.max(0,Math.floor(count));if(this.current.session.linkedNotes===bounded)return;
    this.current={...this.current,session:{...this.current.session,linkedNotes:bounded}};this.emit();
  }
  private visible(user:SessionUser|null):SharedListeningSnapshot{
    if(!user||this.current.session&&!userCan(user,this.current.session.channelId,'author'))return empty();
    return this.snapshot();
  }
  private emit(){
    // Subscribers are private destination workflows. A deleted or revoked
    // destination must not tear down the shared audio producer for everyone.
    for(const callback of [...this.subscribers])try{callback(this.snapshot());}catch{/* The destination owns its error/status reporting. */}
  }
  close(){
    const id=this.current.session?.id;if(id){try{this.stop(id);}finally{this.end(id);}}
    for(const stream of this.streams)stream.end();this.streams.clear();this.subscribers.clear();
  }
}
