import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {assemblyKey} from '../src/assemblyai-stream.js';

test('AssemblyAI key honors process, project and persistent station precedence',async t=>{
  const directory=await fs.mkdtemp(path.join(os.tmpdir(),'lumen-assemblyai-key-'));
  t.after(()=>fs.rm(directory,{recursive:true,force:true}));
  const project=path.join(directory,'project.env'),station=path.join(directory,'station.env');
  const unrelatedBefore=process.env.UNRELATED_SECRET;
  await fs.writeFile(project,'ASSEMBLYAI_API_KEY=fake-project-key\n',{mode:0o600});
  await fs.writeFile(station,'ASSEMBLYAI_API_KEY="fake-station-key"\nUNRELATED_SECRET=unrelated-value\n',{mode:0o600});
  const environment={ASSEMBLYAI_API_KEY:'fake-process-key'};
  assert.equal(await assemblyKey(environment,[project,station]),'fake-process-key');
  assert.equal(await assemblyKey({},[project,station]),'fake-project-key');
  await fs.rm(project);
  assert.equal(await assemblyKey({},[project,station]),'fake-station-key','Finder launch can use station config without a project env file');
  await fs.writeFile(project,'ASSEMBLYAI_API_KEY="  "\n');
  assert.equal(await assemblyKey({ASSEMBLYAI_API_KEY:'  '},[project,station]),'fake-station-key');
  assert.deepEqual(environment,{ASSEMBLYAI_API_KEY:'fake-process-key'});
  assert.equal(process.env.UNRELATED_SECRET,unrelatedBefore,'Loading provider config must not populate other environment variables');
});

test('AssemblyAI config errors and missing keys do not log file contents or secrets',async t=>{
  const directory=await fs.mkdtemp(path.join(os.tmpdir(),'lumen-assemblyai-key-'));
  t.after(()=>fs.rm(directory,{recursive:true,force:true}));
  const unrelated=path.join(directory,'unrelated.env');
  await fs.writeFile(unrelated,'UNRELATED_SECRET=fake-private-value\n',{mode:0o600});
  const logs=['log','info','warn','error','debug'].map(method=>t.mock.method(console,method as 'log',()=>{}));
  assert.equal(await assemblyKey({},[path.join(directory,'missing.env'),directory,unrelated]),'');
  const station=path.join(directory,'station.env');
  await fs.writeFile(station,'ASSEMBLYAI_API_KEY=fake-private-provider-key\n',{mode:0o600});
  assert.equal(await assemblyKey({},[directory,station]),'fake-private-provider-key');
  for(const log of logs)assert.equal(log.mock.callCount(),0);
});
