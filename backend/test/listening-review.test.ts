import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import {createHash} from 'node:crypto';
import {fileURLToPath,pathToFileURL} from 'node:url';
import {execFile} from 'node:child_process';
import {promisify} from 'node:util';
import {chromium} from 'playwright-core';
import {SermonManifestSchema} from '../src/listening-evaluation.js';

const execute=promisify(execFile),root=fileURLToPath(new URL('../../',import.meta.url));
const sha=(value:Buffer|string)=>createHash('sha256').update(value).digest('hex');
const run=(...args:string[])=>execute(process.execPath,[path.join(root,'backend/node_modules/tsx/dist/cli.mjs'),path.join(root,'backend/scripts/listening-review.ts'),...args],{cwd:root,timeout:30000});
async function fixture(){
  const temp=await fs.mkdtemp(path.join(os.tmpdir(),'lumen-review-test-')),audio=Buffer.alloc(44+4*32000);
  audio.write('RIFF');audio.writeUInt32LE(audio.length-8,4);audio.write('WAVEfmt ',8);audio.writeUInt32LE(16,16);audio.writeUInt16LE(1,20);audio.writeUInt16LE(1,22);audio.writeUInt32LE(16000,24);audio.writeUInt32LE(32000,28);audio.writeUInt16LE(2,32);audio.writeUInt16LE(16,34);audio.write('data',36);audio.writeUInt32LE(audio.length-44,40);
  await fs.mkdir(path.join(temp,'clips'));await fs.writeFile(path.join(temp,'clips/clip-00000.wav'),audio);
  const manifest={schemaVersion:1,speakerId:'speaker-a',language:'en',split:'development',source:{filename:'sermon.wav',sha256:'a'.repeat(64)},clips:[{id:'clip-00000',audio:'clips/clip-00000.wav',sha256:sha(audio),startSeconds:10,durationSeconds:4,reviewed:false,transcript:null,expectedReferences:null,automaticAllowed:false,notes:''}]};
  const source=JSON.stringify(manifest),file=path.join(temp,'manifest.json');await fs.writeFile(file,source);
  const draft={schemaVersion:1,model:{id:'test-recognizer',sha256:'b'.repeat(64)},manifests:[{filename:'manifest.json',sha256:sha(source),speakerId:manifest.speakerId,sourceSha256:manifest.source.sha256}],results:[{speakerId:manifest.speakerId,sourceSha256:manifest.source.sha256,clipId:'clip-00000',clipSha256:sha(audio),audio:'clips/clip-00000.wav',startSeconds:10,audioSeconds:4,transcript:'UNVERIFIED words </script><script>window.injected=true</script>',recognition:{status:'uncertain'},elapsedMs:123}]};
  const draftFile=path.join(temp,'draft.json');await fs.writeFile(draftFile,JSON.stringify(draft));
  return {temp,file,draft,draftFile,manifest,source,out:path.join(temp,'review.html'),async close(){await fs.rm(temp,{recursive:true,force:true});}};
}
test('offline review validates source, clip identity and audio hashes without changing labels',async()=>{
  const f=await fixture();try{
    await run('--manifest',f.file,'--draft',f.draftFile,'--out',f.out);
    const html=await fs.readFile(f.out,'utf8');assert.match(html,/connect-src 'none'/);assert.match(html,/UNVERIFIED words \\u003c\/script>/);assert.equal(await fs.readFile(f.file,'utf8'),f.source);assert.match(html,/Export labels for this set/);
    f.draft.results[0].clipSha256='f'.repeat(64);await fs.writeFile(f.draftFile,JSON.stringify(f.draft));await assert.rejects(run('--manifest',f.file,'--draft',f.draftFile,'--out',path.join(f.temp,'bad.html')),/provenance mismatch/);
    delete (f.draft.results[0] as {clipSha256?:string}).clipSha256;f.draft.manifests[0].sha256='c'.repeat(64);await fs.writeFile(f.draftFile,JSON.stringify(f.draft));await assert.rejects(run('--manifest',f.file,'--draft',f.draftFile,'--out',path.join(f.temp,'bad-old.html')),/provenance mismatch/);
    f.draft.results[0].clipSha256=f.manifest.clips[0].sha256;await fs.writeFile(f.draftFile,JSON.stringify(f.draft));
    f.manifest.clips[0].transcript='Corrected labels';await fs.writeFile(f.file,JSON.stringify(f.manifest));await run('--manifest',f.file,'--draft',f.draftFile,'--out',path.join(f.temp,'reopened.html'));
    await fs.writeFile(path.join(f.temp,'clips/clip-00000.wav'),'changed');await assert.rejects(run('--manifest',f.file,'--draft',f.draftFile,'--out',path.join(f.temp,'changed.html')),/Audio hash mismatch/);
  }finally{await f.close();}
});
test('offline review keeps hypotheses separate, requires human review and exports valid labels',{skip:process.env.LUMEN_REVIEW_BROWSER_TEST!=='1'},async()=>{
  const f=await fixture();let browser;try{
    await run('--manifest',f.file,'--draft',f.draftFile,'--out',f.out);
    browser=await chromium.launch({executablePath:process.env.LUMEN_CHROME_PATH??'/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',headless:true});
    const page=await browser.newPage({acceptDownloads:true});const errors:string[]=[];page.on('pageerror',error=>errors.push(error.message));await page.goto(pathToFileURL(f.out).href);
    await page.locator('audio').evaluate((audio:HTMLAudioElement)=>audio.load());await page.waitForFunction(()=>document.querySelector('audio')?.duration===4);
    assert.equal(await page.locator('textarea').inputValue(),'');assert.equal(await page.locator('.draft').count(),1);assert.equal(await page.evaluate(()=>Object.hasOwn(window,'injected')),false);assert.equal(await page.locator('.verified input').isChecked(),false);
    await page.getByLabel('Human transcript').fill('John chapter three verse sixteen');await page.getByLabel('Expected scripture references').fill('John 3:16');await page.getByLabel('Allow automatic publication').check();await page.locator('.verified input').check();assert.match(await page.locator('#overall').innerText(),/1 of 1/);
    await page.getByLabel('Human transcript').fill('John chapter three, verse sixteen.');assert.equal(await page.locator('.verified input').isChecked(),false,'Editing a verified label requires a fresh explicit review.');await page.locator('.verified input').check();
    const downloading=page.waitForEvent('download');await page.getByRole('button',{name:'Export labels for this set'}).click();const download=await downloading,saved=path.join(f.temp,'saved.json');await download.saveAs(saved);
    const labels=SermonManifestSchema.parse(JSON.parse(await fs.readFile(saved,'utf8')));assert.equal(labels.clips[0].reviewed,true);assert.equal(labels.clips[0].transcript,'John chapter three, verse sixteen.');assert.deepEqual(labels.clips[0].expectedReferences,[{book:43,chapter:3,verse:16}]);assert.equal(await fs.readFile(f.file,'utf8'),f.source);assert.deepEqual(errors,[]);
    await page.getByLabel('Expected scripture references').fill('Invented 3:16');await page.locator('.verified input').click();assert.equal(await page.locator('.verified input').isChecked(),false);assert.match(await page.locator('.error').innerText(),/Check the book/);
  }finally{await browser?.close();await f.close();}
});
