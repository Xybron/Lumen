import fs from 'node:fs/promises';
import path from 'node:path';
import net from 'node:net';
import { spawn, type ChildProcess } from 'node:child_process';
import { DATA_DIR } from './paths.js';
import { ProductionError } from './production-store.js';
import { LISTENING_MODELS, listeningModel } from '../../shared/listening-models.js';
import type { ListeningStatus } from '../../shared/worship.js';

interface WorkerResult {text?:unknown;segments?:{text?:unknown;avg_logprob?:unknown;no_speech_prob?:unknown}[]}
export function localTranscript(result:WorkerResult):string {
  if(!result||typeof result!=='object')return '';
  if(Array.isArray(result.segments)&&result.segments.length) {
    return result.segments.filter(segment=>{
      const p=segment.no_speech_prob,log=segment.avg_logprob;
      // Model diagnostics are not a promise of accent-specific accuracy.
      return !(typeof log==='number'&&Number.isFinite(log)&&(log < -1.5||(typeof p==='number'&&p > .8&&log < -.8)));
    }).map(segment=>typeof segment.text==='string'?segment.text:'').join('').trim().slice(0,4000);
  }
  return typeof result.text==='string'?result.text.trim().slice(0,4000):'';
}
interface ListenerPaths {dataDir?:string;executable?:string;model?:string}
export class LocalListener {
  private child: ChildProcess | null = null;
  private starting: Promise<void> | null = null;
  private loading:Promise<void>|null=null;
  private switching=false;
  private busy = false;
  private port = 0;
  private closed = false;
  private state: ListeningStatus['state'] = 'stopped';
  private error: string | undefined;
  private readonly executable:string;
  private readonly modelDir:string;
  private readonly settingsFile:string;
  private readonly customModel:string|undefined;
  private modelId='base.en';
  constructor(options:ListenerPaths={}) {
    const dataDir=options.dataDir??DATA_DIR;
    this.executable=options.executable??process.env.LUMEN_WHISPER_SERVER??path.join(dataDir,'ai/whisper.cpp-1.9.5/build/bin',process.platform==='win32'?'whisper-server.exe':'whisper-server');
    this.modelDir=path.join(dataDir,'ai/models');this.settingsFile=path.join(dataDir,'ai/listening-settings.json');
    this.customModel=options.model??process.env.LUMEN_WHISPER_MODEL;
    if(this.customModel)this.modelId='custom';
  }
  private async loadSettings() {
    if(!this.loading)this.loading=(async()=>{
      if(this.customModel)return;
      try{const settings=JSON.parse(await fs.readFile(this.settingsFile,'utf8'));if(listeningModel(settings.modelId))this.modelId=settings.modelId;}
      catch{/* First run or invalid saved ID: preserve the existing Base model. */}
    })();
    await this.loading;
  }
  private modelPath(id=this.modelId){return id==='custom'&&this.customModel?this.customModel:path.join(this.modelDir,listeningModel(id)!.filename);}
  private async exists(file:string){return fs.access(file).then(()=>true,()=>false);}
  async status():Promise<ListeningStatus> {
    await this.loadSettings();
    const profiles=await Promise.all(LISTENING_MODELS.map(async({id,label,description,downloadMiB,multilingual})=>({id,label,description,downloadMiB,multilingual,installed:await this.exists(this.modelPath(id))})));
    if(this.customModel)profiles.push({id:'custom',label:'Station-configured model',description:'Configured by the station administrator. Language support depends on this model.',downloadMiB:0,multilingual:!path.basename(this.customModel).includes('.en.'),installed:await this.exists(this.customModel)});
    const installed=await this.exists(this.executable)&&profiles.some(profile=>profile.id===this.modelId&&profile.installed);
    return {state:installed?this.state:'unavailable',model:path.basename(this.modelPath()),modelId:this.modelId,profiles,decoding:'beam-search',local:true,error:installed?this.error:'Run npm run setup:ai on the station, or install a listening model. Audio recognition stays local.'};
  }
  async selectModel(id:string):Promise<ListeningStatus> {
    await this.loadSettings();
    if(this.closed)throw new ProductionError(503,'Station is shutting down.');
    if(!listeningModel(id)&&!(id==='custom'&&this.customModel))throw new ProductionError(422,'Choose a known local listening model.');
    if(this.busy||this.starting||this.switching)throw new ProductionError(409,'Stop listening and wait for the current audio window before changing models.');
    if(this.customModel&&id!=='custom')throw new ProductionError(409,'This station uses LUMEN_WHISPER_MODEL. Remove that administrator override before selecting another model.');
    this.switching=true;
    try {
      if(!await this.exists(this.modelPath(id)))throw new ProductionError(409,'Install this model on the station before selecting it. No model is downloaded automatically.');
      if(id===this.modelId)return await this.status();
      await fs.mkdir(path.dirname(this.settingsFile),{recursive:true});
      const temporary=`${this.settingsFile}.${process.pid}.tmp`;
      try{await fs.writeFile(temporary,JSON.stringify({modelId:id}),'utf8');await fs.rename(temporary,this.settingsFile);}
      finally{await fs.rm(temporary,{force:true});}
      // An old process must not clobber a replacement worker's state.
      const child=this.child;this.child=null;child?.kill('SIGTERM');
      this.modelId=id;this.state='stopped';this.error=undefined;
      return await this.status();
    }finally{this.switching=false;}
  }
  async start() {
    if (this.closed) throw new ProductionError(503,'Station is shutting down.');
    if(this.switching)throw new ProductionError(409,'The local listening model is changing. Try again.');
    if (this.state==='ready') return;
    if (this.starting) return this.starting;
    this.starting = (async()=>{
      const status=await this.status();
      if(this.closed)throw new ProductionError(503,'Station is shutting down.');
      if (status.state==='unavailable') throw new ProductionError(503,status.error!);
      this.state='starting'; this.error=undefined;
      this.port=await new Promise<number>((resolve,reject)=>{ const server=net.createServer(); server.once('error',reject); server.listen(0,'127.0.0.1',()=>{ const port=(server.address() as net.AddressInfo).port; server.close(()=>resolve(port)); }); });
      let log='';
      // Disable prompt/history conditioning. On weak input a Bible-book prompt
      // can be echoed as invented speech; reference matching happens only after
      // transcription against the installed library, never in an ASR prompt.
      const child=spawn(this.executable,['--host','127.0.0.1','--port',String(this.port),'-m',this.modelPath(),'-t','4','--max-context','0','--beam-size','5','--no-fallback','--suppress-nst'],{stdio:['ignore','ignore','pipe']});
      this.child=child;
      child.stderr?.on('data',b=>{log=(log+b).slice(-3000);});
      child.on('error',error=>{if(this.child===child){this.error=error.message;this.state='error';}});
      child.on('exit',code=>{if(!this.closed&&this.child===child){this.state='error';this.error=`Local speech worker stopped (exit ${code}). Check the station log and model installation.`;console.warn('[listening]',log);}});
      const deadline=Date.now()+90000;
      while (Date.now()<deadline && !this.closed && (this.state as ListeningStatus['state'])!=='error') {
        try { const response=await fetch(`http://127.0.0.1:${this.port}/health`,{signal:AbortSignal.timeout(1500)}); if (response.ok) { this.state='ready';return; } } catch { /* warming model */ }
        await new Promise(resolve=>setTimeout(resolve,400));
      }
      child.kill('SIGTERM'); this.state='error';
      throw new ProductionError(503,this.error??'Local model did not become ready in time.');
    })().catch(error=>{this.state='error';this.error=error.message;throw error;}).finally(()=>{this.starting=null;});
    return this.starting;
  }
  async transcribe(wav:Buffer,language:string,context?:'scripture'|'lyrics') {
    // Accept only short 16 kHz mono PCM WAV windows. No filenames, URLs,
    // subprocess arguments or model paths are accepted from a browser.
    if (wav.length<3244 || wav.length>384044 || wav.toString('ascii',0,4)!=='RIFF' || wav.toString('ascii',8,12)!=='WAVE' || wav.toString('ascii',12,16)!=='fmt ' || wav.readUInt32LE(16)!==16 || wav.readUInt16LE(20)!==1 || wav.readUInt16LE(22)!==1 || wav.readUInt32LE(24)!==16000 || wav.readUInt16LE(34)!==16 || wav.toString('ascii',36,40)!=='data' || wav.readUInt32LE(40)!==wav.length-44) throw new ProductionError(422,'Expected a short 16 kHz mono PCM WAV window.');
    if(!/^[a-z]{2}$/.test(language))throw new ProductionError(422,'Choose a two-letter spoken language.');
    if(context!==undefined&&context!=='scripture'&&context!=='lyrics')throw new ProductionError(422,'Choose a Scripture or Lyrics listening context.');
    await this.loadSettings();
    if(language!=='en'&&path.basename(this.modelPath()).includes('.en.'))throw new ProductionError(422,'This English model only supports English. Install a multilingual model for other languages.');
    if(this.closed)throw new ProductionError(503,'Station is shutting down.');
    if(this.switching)throw new ProductionError(409,'The local listening model is changing. Try again.');
    if (this.busy) throw new ProductionError(429,'The local model is processing another window. Trying the next window.');
    // Do not feed digital/near-digital silence to the decoder.
    let peak=0;for(let i=44;i+1<wav.length;i+=2)peak=Math.max(peak,Math.abs(wav.readInt16LE(i)));
    if(peak<=8)return {text:'',elapsedMs:0};
    this.busy=true;
    try {
      await this.start();
      const form=new FormData(); form.append('file',new Blob([new Uint8Array(wav)],{type:'audio/wav'}),'window.wav');
      form.append('response_format','verbose_json');form.append('language',language);form.append('detect_language','false');form.append('translate','false');
      form.append('temperature','0');form.append('temperature_inc','0');form.append('beam_size','5');form.append('no_speech_thold','0.6');form.append('no_language_probabilities','true');
      // The server retains request parameters, so clear this explicitly on
      // every request, including Scripture, Lyrics and unspecified contexts.
      form.append('prompt','');
      const start=performance.now();
      const response=await fetch(`http://127.0.0.1:${this.port}/inference`,{method:'POST',body:form,signal:AbortSignal.timeout(30000)});
      if (!response.ok) throw new ProductionError(502,'Local speech recognition failed. Manual search is still available.');
      const result=await response.json() as WorkerResult;
      return {text:localTranscript(result),elapsedMs:Math.round(performance.now()-start)};
    } finally { this.busy=false; }
  }
  close(){this.closed=true;const child=this.child;this.child=null;child?.kill('SIGTERM');this.state='stopped';}
}
