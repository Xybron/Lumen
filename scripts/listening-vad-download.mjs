import fs from 'node:fs/promises';
import {createReadStream,createWriteStream} from 'node:fs';
import path from 'node:path';
import {createHash} from 'node:crypto';
import {Readable,Transform} from 'node:stream';
import {pipeline} from 'node:stream/promises';
import {LISTENING_VAD_MODEL as model} from '../shared/listening-vad.js';

export async function verifyListeningVad(file) {
  if((await fs.stat(file)).size!==model.bytes)return false;
  const hash=createHash('sha256');for await(const chunk of createReadStream(file))hash.update(chunk);
  return hash.digest('hex')===model.sha256;
}

/** Install the single pinned speech detector. No caller-provided URL or ID can
 * become a filename; the final file appears only after integrity verification. */
export async function installListeningVad(modelsDir,fetcher=fetch) {
  await fs.mkdir(modelsDir,{recursive:true});
  const target=path.join(modelsDir,model.filename);
  try {
    await fs.access(target);
    if(await verifyListeningVad(target))return target;
    throw new Error(`Existing ${model.filename} does not match the official size/checksum. It was preserved; move it aside before reinstalling.`);
  }catch(error){if(error.code!=='ENOENT')throw error;}
  const temporary=await fs.mkdtemp(path.join(modelsDir,'.lumen-vad-'));
  const staged=path.join(temporary,model.filename);
  try {
    const response=await fetcher(model.downloadUrl,{signal:AbortSignal.timeout(120000)});
    if(!response.ok||!response.body)throw new Error(`Speech detector download failed (${response.status}).`);
    const length=response.headers.get('content-length');
    if(length!==null&&Number(length)!==model.bytes)throw new Error('Speech detector download size did not match the official file.');
    let received=0;const hash=createHash('sha256');
    const validator=new Transform({transform(chunk,_encoding,callback){
      received+=chunk.length;
      if(received>model.bytes)return callback(new Error('Speech detector download exceeded the official file size.'));
      hash.update(chunk);callback(null,chunk);
    }});
    await pipeline(Readable.fromWeb(response.body),validator,createWriteStream(staged,{flags:'wx'}));
    if(received!==model.bytes||hash.digest('hex')!==model.sha256)throw new Error('Speech detector download integrity check failed. Nothing was installed.');
    // Do not replace another installer's file or a manually configured asset.
    try{await fs.link(staged,target);}catch(error){if(error.code!=='EEXIST'||!await verifyListeningVad(target))throw error;}
    return target;
  }finally{await fs.rm(temporary,{recursive:true,force:true});}
}
