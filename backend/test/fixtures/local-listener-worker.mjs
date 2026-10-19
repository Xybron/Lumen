#!/usr/bin/env node
// A protocol fixture, not a recognizer. Never used by the application.
import http from 'node:http';
import fs from 'node:fs/promises';
import path from 'node:path';
const args=process.argv.slice(2),value=key=>args[args.indexOf(key)+1];
const dir=path.dirname(value('-m'));
await fs.writeFile(path.join(dir,'worker-args.json'),JSON.stringify(args));
const server=http.createServer(async(req,res)=>{
  if(req.url==='/health'){res.writeHead(200,{'content-type':'application/json'});res.end('{"status":"ok"}');return;}
  if(req.url!=='/inference'){res.writeHead(404).end();return;}
  const chunks=[];for await(const chunk of req)chunks.push(chunk);
  const form=await new Request('http://127.0.0.1/inference',{method:'POST',headers:req.headers,body:Buffer.concat(chunks)}).formData();
  const fields=Object.fromEntries([...form.entries()].filter(([key])=>key!=='file'));
  await fs.appendFile(path.join(dir,'worker-calls.jsonl'),`${JSON.stringify(fields)}\n`);
  let response={text:'John chapter three verse sixteen',segments:[{text:' John chapter three verse sixteen',avg_logprob:-.3,no_speech_prob:.02}]};
  try{response=JSON.parse(await fs.readFile(path.join(dir,'worker-response.json'),'utf8'));}catch{}
  if(response.delayMs)await new Promise(resolve=>setTimeout(resolve,response.delayMs));
  res.writeHead(200,{'content-type':'application/json'});res.end(JSON.stringify(response));
});
server.listen(Number(value('--port')),'127.0.0.1');
process.on('SIGTERM',()=>server.close(()=>process.exit(0)));
