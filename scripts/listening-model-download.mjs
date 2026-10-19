import fs from 'node:fs/promises';
import {createReadStream,createWriteStream} from 'node:fs';
import path from 'node:path';
import {createHash} from 'node:crypto';
import {Readable,Transform} from 'node:stream';
import {pipeline} from 'node:stream/promises';
import {listeningModel} from '../shared/listening-models.js';

async function verify(file,model) {
  if((await fs.stat(file)).size!==model.bytes)return false;
  const hash=createHash('sha256');for await(const chunk of createReadStream(file))hash.update(chunk);
  return hash.digest('hex')===model.sha256;
}
export async function installListeningModel(id,modelsDir,fetcher=fetch) {
  const model=listeningModel(id);
  if(!model)throw new Error('Unknown listening model. Use --list-models to see supported IDs.');
  await fs.mkdir(modelsDir,{recursive:true});
  const target=path.join(modelsDir,model.filename);
  try {
    await fs.access(target);
    if(await verify(target,model))return target;
    throw new Error(`Existing ${model.filename} does not match the official size/checksum. It was preserved; move it aside before reinstalling.`);
  }catch(error){if(error.code!=='ENOENT')throw error;}
  // The final filename only appears after byte-count and SHA-256 verification.
  const temporary=await fs.mkdtemp(path.join(modelsDir,'.lumen-model-'));
  const staged=path.join(temporary,model.filename);
  try {
    const response=await fetcher(`https://huggingface.co/ggerganov/whisper.cpp/resolve/main/${model.filename}`,{signal:AbortSignal.timeout(900000)});
    if(!response.ok||!response.body)throw new Error(`Model download failed (${response.status}).`);
    const length=response.headers.get('content-length');
    if(length!==null&&Number(length)!==model.bytes)throw new Error('Model download size did not match the official file.');
    let received=0;const hash=createHash('sha256');
    const validator=new Transform({transform(chunk,_encoding,callback){
      received+=chunk.length;
      if(received>model.bytes)return callback(new Error('Model download exceeded the official file size.'));
      hash.update(chunk);callback(null,chunk);
    }});
    await pipeline(Readable.fromWeb(response.body),validator,createWriteStream(staged,{flags:'wx'}));
    if(received!==model.bytes||hash.digest('hex')!==model.sha256)throw new Error('Model download integrity check failed. Nothing was installed.');
    // Never overwrite a file created by a simultaneous installer.
    try {await fs.link(staged,target);}catch(error){if(error.code!=='EEXIST'||!await verify(target,model))throw error;}
    return target;
  }finally{await fs.rm(temporary,{recursive:true,force:true});}
}
