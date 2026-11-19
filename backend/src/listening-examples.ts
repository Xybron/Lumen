import fs from 'node:fs/promises';
import path from 'node:path';
import {randomUUID,createHash} from 'node:crypto';
import {z} from 'zod';
import {ProductionError} from './production-store.js';

export function pcmWav(pcm:Buffer){
  const wav=Buffer.alloc(44+pcm.length);wav.write('RIFF');wav.writeUInt32LE(wav.length-8,4);wav.write('WAVEfmt ',8);wav.writeUInt32LE(16,16);wav.writeUInt16LE(1,20);wav.writeUInt16LE(1,22);wav.writeUInt32LE(16000,24);wav.writeUInt32LE(32000,28);wav.writeUInt16LE(2,32);wav.writeUInt16LE(16,34);wav.write('data',36);wav.writeUInt32LE(pcm.length,40);pcm.copy(wav,44);return wav;
}
export const ExampleReviewSchema=z.object({transcript:z.string().max(12000),reference:z.string().max(300),speaker:z.string().trim().min(1).max(100),notes:z.string().max(2000),reviewed:z.boolean()}).strict();
export class ListeningExamples {
  constructor(private directory:string){}
  private file(id:string,extension:string){return path.join(this.directory,`${z.string().uuid().parse(id)}.${extension}`);}
  async save(userId:string,channelId:string,pcm:Buffer,metadata:Record<string,unknown>){
    if(pcm.length<3200||pcm.length>384000)throw new ProductionError(422,'Capture at least a moment of speech before saving an example.');
    await fs.mkdir(this.directory,{recursive:true});const id=randomUUID(),audio=pcmWav(pcm);
    const record={...metadata,id,userId,channelId,createdAt:new Date().toISOString(),durationSeconds:pcm.length/32000,sha256:createHash('sha256').update(audio).digest('hex'),reviewed:false,transcript:null,expectedReferences:null,speaker:'',notes:''};
    await fs.writeFile(this.file(id,'wav'),audio,{flag:'wx',mode:0o600});
    await fs.writeFile(this.file(id,'json'),JSON.stringify(record,null,2),{flag:'wx',mode:0o600});return record;
  }
  async list(userId:string,channelId:string){
    let entries:string[];try{entries=await fs.readdir(this.directory);}catch{return [];}
    const records=[];
    for(const entry of entries.filter(name=>/^[a-f0-9-]{36}\.json$/.test(name))){
      try{const record=JSON.parse(await fs.readFile(path.join(this.directory,entry),'utf8'));if(record.userId===userId&&record.channelId===channelId)records.push(record);}catch{}
    }
    return records.sort((a,b)=>b.createdAt.localeCompare(a.createdAt)).slice(0,20);
  }
  async read(id:string,userId:string){
    let record:any;try{record=JSON.parse(await fs.readFile(this.file(id,'json'),'utf8'));}catch(error){if(error instanceof z.ZodError)throw error;throw new ProductionError(404,'Saved example not found.');}
    if(record.userId!==userId)throw new ProductionError(403,'This example belongs to another operator.');return record;
  }
  async audio(id:string,userId:string){await this.read(id,userId);return fs.readFile(this.file(id,'wav'));}
  async review(id:string,userId:string,review:z.infer<typeof ExampleReviewSchema>,references:unknown[]){
    const record=await this.read(id,userId);Object.assign(record,{reviewReference:review.reference,transcript:review.transcript,expectedReferences:references,speaker:review.speaker,notes:review.notes,reviewed:review.reviewed,reviewedAt:review.reviewed?new Date().toISOString():null});
    const temporary=this.file(id,`${randomUUID()}.tmp`);await fs.writeFile(temporary,JSON.stringify(record,null,2),{mode:0o600});await fs.rename(temporary,this.file(id,'json'));return record;
  }
  async remove(id:string,userId:string){await this.read(id,userId);await fs.rm(this.file(id,'json'));await fs.rm(this.file(id,'wav'),{force:true});}
}
