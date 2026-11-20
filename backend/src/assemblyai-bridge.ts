import {WebSocketServer,WebSocket} from 'ws';
import type {IncomingMessage} from 'node:http';
import type {ListeningSessions} from './listening-session.js';
import type {WorshipLibrary} from './worship-library.js';
import type {ListeningExamples} from './listening-examples.js';
import {AssemblyStream,assemblyKey,ASSEMBLYAI_MODEL,type AssemblyTurn} from './assemblyai-stream.js';
import {StreamingEvidenceGate,cloudRecognition} from './streaming-scripture.js';
import {StreamingQuoteContext} from './streaming-quote-context.js';
import type {ListeningResult} from '../../shared/worship.js';

export interface AssemblyBridgeOptions {
  sessions:ListeningSessions;
  library:WorshipLibrary;
  examples?:ListeningExamples;
  authorize:(request:IncomingMessage,channel:string,session:string)=>string;
  onReady?:(channel:string,session:string)=>void;
  onResult?:(context:{request:IncomingMessage;channel:string;session:string;user:string;turn:AssemblyTurn;result:ListeningResult})=>Record<string,unknown>|void;
  onClose?:(channel:string,session:string)=>void;
  drainOnStop?:boolean;
  kind?:(channel:string)=>'scripture'|'lyrics';
  key?:()=>Promise<string>;
  createStream?:(key:string,onTurn:(turn:AssemblyTurn)=>void,onError:(message:string)=>void)=>Pick<AssemblyStream,'connected'|'send'|'finish'|'close'>;
}

export function createAssemblyBridge(options:AssemblyBridgeOptions){
  const wss=new WebSocketServer({noServer:true,maxPayload:16000});
  const clients=new Map<string,{session:string;close:()=>void;finish:()=>void}>();
  wss.on('connection',(ws,request)=>{
    let registered=false;let upstream:Pick<AssemblyStream,'connected'|'send'|'finish'|'close'>|undefined,closed=false,draining=false,pendingTurn=false,channel='',session='',user='',timer:ReturnType<typeof setInterval>|undefined;
    let drainDeadline:ReturnType<typeof setTimeout>|undefined,drainQuiet:ReturnType<typeof setTimeout>|undefined;
    let pcm=Buffer.alloc(0),totalBytes=0,sequence=0,lastAudio=Date.now(),lastSave=0,saving=false;
    let finalizedTurn=-1;
    const started=Date.now(),gate=new StreamingEvidenceGate(),quoteContext=new StreamingQuoteContext(options.library);let result:ListeningResult|null=null;
    let events:{atMs:number;audioSeconds:number;result:ListeningResult;final:boolean}[]=[];
    const send=(value:unknown)=>{if(ws.readyState===WebSocket.OPEN){if(ws.bufferedAmount>256*1024){close();return;}ws.send(JSON.stringify(value));}};
    const close=()=>{
      if(closed)return;closed=true;clearInterval(timer);clearTimeout(drainDeadline);clearTimeout(drainQuiet);upstream?.close();pcm=Buffer.alloc(0);events=[];
      if(registered&&clients.get(channel)?.session===session){clients.delete(channel);try{options.sessions.check(channel,session,user);options.sessions.stop(channel);}catch{}options.onClose?.(channel,session);}
      ws.close();setTimeout(()=>ws.terminate(),1000).unref();
    };
    const fail=(message:string)=>{send({type:'error',message});close();};
    const finish=()=>{
      if(closed||draining)return;
      if(!options.drainOnStop||!upstream){close();return;}
      draining=true;
      send({type:'finishing'});
      drainDeadline=setTimeout(()=>{if(pendingTurn)fail('The final words could not be finalized before listening stopped. Only completed passages were saved; check the transcript before continuing.');else close();},3000);
      try{upstream.finish();}catch{close();}
    };
    ws.on('close',close);ws.on('error',close);
    void(async()=>{
      const url=new URL(request.url!,'http://localhost');channel=url.searchParams.get('channel')??'';session=url.searchParams.get('session')??'';
      user=options.authorize(request,channel,session);
      if(clients.has(channel))throw new Error('This channel already has a streaming connection.');
      clients.set(channel,{session,close,finish});registered=true;
      const key=await (options.key??assemblyKey)();if(!key)throw new Error('Add ASSEMBLYAI_API_KEY to the station .env and try again.');
      if(closed)return;
      // Recheck after asynchronous key loading; a stopped or revoked lease
      // must not open a paid provider connection.
      options.authorize(request,channel,session);
      upstream=(options.createStream??((key,onTurn,onError)=>new AssemblyStream(key,onTurn,onError)))(key,turn=>{
        if(closed)return;
        try {
          options.authorize(request,channel,session);
          pendingTurn=!turn.end_of_turn&&!!turn.transcript.trim();
          const workspace=options.library.workspace(channel);
          const final=!!turn.end_of_turn&&turn.turn_order>finalizedTurn;
          if(turn.end_of_turn)finalizedTurn=Math.max(finalizedTurn,turn.turn_order);
          const trustedFinal=final&&!draining&&!(turn.words??[]).some(word=>!Number.isFinite(word.confidence)||word.confidence<.7);
          const kind=options.kind?.(channel)??'scripture';
          const raw=options.sessions.accept(channel,session,user,sequence++,kind,turn.transcript,Date.now()-started,workspace.revision,cloudRecognition,trustedFinal,final);
          result=kind==='lyrics'?raw:quoteContext.apply(gate.apply(raw,turn.end_of_turn,turn.turn_order,Date.now()-started),final,Date.now()-started,workspace.versionId);
          if(options.examples){const event={atMs:Date.now()-started,audioSeconds:totalBytes/32000,result,final:!!turn.end_of_turn,words:Array.isArray(turn.words)?turn.words.slice(0,200):[]};events.push(event);events=events.filter(e=>e.audioSeconds>=totalBytes/32000-12).slice(-150);}
          const extra=options.onResult?.({request,channel,session,user,turn,result});
          send({...extra,type:'result',result,final:!!turn.end_of_turn,turn:turn.turn_order});
          // Allow queued turn boundaries to settle before disconnecting. The
          // hard deadline still bounds an unresponsive provider on Stop.
          if(draining){clearTimeout(drainQuiet);if(turn.end_of_turn)drainQuiet=setTimeout(close,300);}
        }catch{fail('Listening stopped because the session or channel control changed.');}
      },fail);
      await upstream.connected;
      if(closed){upstream.close();return;}options.authorize(request,channel,session);
      options.onReady?.(channel,session);
      send({type:'ready',model:ASSEMBLYAI_MODEL});
      timer=setInterval(()=>{try{options.authorize(request,channel,session);if(Date.now()-lastAudio>15000)fail('No microphone audio arrived for 15 seconds. Listening stopped.');}catch{fail('Listening stopped because the session or channel control changed.');}},2000);
      ws.on('message',(data,binary)=>{
        if(closed)return;
        try {
          options.authorize(request,channel,session);
          if(binary){
            if(draining)return;
            const bytes=Buffer.from(data as Buffer);
            if(bytes.length<1600||bytes.length>12800||bytes.length%2)throw new Error('Unsupported microphone audio packet.');
            if(totalBytes+bytes.length>(Date.now()-started)*32+64000)throw new Error('Microphone audio arrived faster than real time.');
            upstream!.send(bytes);totalBytes+=bytes.length;lastAudio=Date.now();if(options.examples){pcm=Buffer.concat([pcm,bytes]);if(pcm.length>384000)pcm=Buffer.from(pcm.subarray(pcm.length-384000));}
            options.sessions.renew(channel,session,user);
          }else{
            const message=JSON.parse(String(data));
            if(message.type==='stop'){
              finish();
              return;
            }
            if(message.type!=='save-example')return;
            if(!options.examples){send({type:'save-error',message:'Audio examples are not enabled for this workspace.'});return;}
            if(saving||Date.now()-lastSave<2000){send({type:'save-error',message:'Wait a moment before saving another example.'});return;}
            saving=true;lastSave=Date.now();
            const snapshot=Buffer.from(pcm),savedEvents=structuredClone(events),savedResult=result;
            void options.examples.save(user,channel,snapshot,{provider:'assemblyai',model:ASSEMBLYAI_MODEL,matchingPolicy:'distinctive-quotation-and-number-confirmation-v2',sourceSessionId:session,startSeconds:(totalBytes-snapshot.length)/32000,asrTranscript:savedResult?.transcript??'',predictedReference:savedResult?.candidate?.selection??null,events:savedEvents})
              .then(example=>send({type:'example',example})).catch(()=>send({type:'save-error',message:'Could not save this example. Capture some speech and try again.'})).finally(()=>{saving=false;});
          }
        }catch(error){fail(error instanceof Error?error.message:'Streaming failed.');}
      });
    })().catch(error=>fail(error instanceof Error?error.message:'Could not start streaming.'));
  });
  return {wss,stop(channel:string){clients.get(channel)?.close();},finish(channel:string){const client=clients.get(channel);if(!client)return false;client.finish();return true;},close(){for(const client of clients.values())client.close();wss.close();}};
}
