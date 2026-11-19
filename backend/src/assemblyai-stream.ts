import fs from 'node:fs/promises';
import path from 'node:path';
import {parseEnv} from 'node:util';
import WebSocket from 'ws';
import {ROOT,DATA_DIR} from './paths.js';
import {BOOK_NAMES} from './scripture-reference.js';

export const ASSEMBLYAI_MODEL='assemblyai-stt-3-7-realtime-agent';
export async function assemblyKey(environment:NodeJS.ProcessEnv=process.env,files:readonly string[]=[path.join(ROOT,'.env'),path.join(DATA_DIR,'.env')]){
  const configured=environment.ASSEMBLYAI_API_KEY?.trim();if(configured)return configured;
  // Desktop updates replace application resources, while station settings stay
  // in DATA_DIR. Read only this provider's key; never load the file into env.
  for(const file of files){
    try{const key=parseEnv(await fs.readFile(file,'utf8')).ASSEMBLYAI_API_KEY?.trim();if(key)return key;}catch{/* Missing/unreadable config must not expose secrets in logs. */}
  }
  return '';
}
export function assemblyUrl(){
  const url=new URL('wss://streaming.assemblyai.com/v3/ws');
  // Let the provider finalize at natural pauses. Manual mode disabled its
  // end-of-turn detector and left auto publish waiting for our 10-second timer.
  for(const [key,value] of Object.entries({sample_rate:'16000',encoding:'pcm_s16le',speech_model:ASSEMBLYAI_MODEL,mode:'min_latency',language_codes:JSON.stringify(['en']),keyterms_prompt:JSON.stringify(BOOK_NAMES),voice_focus:'near-field',voice_focus_threshold:'0.5',previous_context_n_turns:'0'}))url.searchParams.set(key,value);
  return String(url);
}
export interface AssemblyTurn {type:'Turn';turn_order:number;transcript:string;end_of_turn:boolean;words?:{text:string;start:number;end:number;confidence:number}[]}
export class AssemblyStream {
  private socket:WebSocket;
  private stopped=false;
  private ready=false;
  private deadline:ReturnType<typeof setTimeout>;
  private rejectReady!:(error:Error)=>void;
  readonly connected:Promise<void>;
  constructor(key:string,onTurn:(turn:AssemblyTurn)=>void,onError:(message:string)=>void,url=assemblyUrl()){
    this.socket=new WebSocket(url,{headers:{Authorization:key},handshakeTimeout:12000,maxPayload:256*1024});
    let resolveReady!:()=>void;
    this.connected=new Promise<void>((resolve,reject)=>{resolveReady=resolve;this.rejectReady=reject;});
    const fail=(message:string)=>{if(this.stopped)return;this.rejectReady(new Error(message));onError(message);this.close();};
    this.deadline=setTimeout(()=>fail('AssemblyAI did not become ready. Check your connection and API account.'),15000);
    this.socket.on('unexpected-response',(_req,response)=>{response.resume();fail(`AssemblyAI rejected the connection (HTTP ${response.statusCode}). Check the station API key and credits.`);});
    this.socket.on('error',()=>fail('AssemblyAI connection failed. Check internet access and restart listening.'));
    this.socket.on('close',()=>fail('AssemblyAI disconnected. Listening has stopped.'));
    this.socket.on('message',data=>{
      if(this.stopped)return;
      let event:any;try{event=JSON.parse(String(data));}catch{fail('AssemblyAI returned an invalid response.');return;}
      if(event.type==='Begin'){
        if(event.configuration?.model!==ASSEMBLYAI_MODEL||event.configuration?.voice_focus!=='near-field'){fail('AssemblyAI did not confirm the requested model and Voice Focus.');return;}
        clearTimeout(this.deadline);this.ready=true;resolveReady();
      }else if(event.type==='Turn'){
        if(!Number.isInteger(event.turn_order)||typeof event.transcript!=='string'||event.transcript.length>12000){fail('AssemblyAI returned an unsupported transcript.');return;}
        onTurn(event);
      }else if(event.type==='error'||event.error)fail('AssemblyAI could not process this stream. Check the provider account and try again.');
    });
  }
  send(pcm:Buffer){
    if(this.stopped||!this.ready||this.socket.readyState!==WebSocket.OPEN)throw new Error('AssemblyAI is not connected.');
    if(this.socket.bufferedAmount>64000)throw new Error('The network cannot keep up with microphone audio. Listening stopped.');
    this.socket.send(pcm);
  }
  finish(){
    if(this.stopped||!this.ready||this.socket.readyState!==WebSocket.OPEN)throw new Error('AssemblyAI is not connected.');
    this.socket.send(JSON.stringify({type:'ForceEndpoint'}));
  }
  close(){
    if(this.stopped)return;this.stopped=true;clearTimeout(this.deadline);
    if(!this.ready)this.rejectReady(new Error('Listening start cancelled.'));
    if(this.socket.readyState===WebSocket.OPEN){this.socket.send(JSON.stringify({type:'Terminate'}));this.socket.close();}
    else this.socket.terminate();
    setTimeout(()=>this.socket.terminate(),1000).unref();
  }
}
