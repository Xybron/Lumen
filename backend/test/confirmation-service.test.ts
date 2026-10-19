import assert from 'node:assert/strict';
import { afterEach,test } from 'node:test';
import { createRequire } from 'node:module';
import { currentConfirmation,settleConfirmation,useConfirmation } from '../../frontend/src/composables/useConfirmation.js';

const {effectScope}=createRequire(new URL('../../frontend/package.json',import.meta.url))('vue');
const options={title:'Enable Auto publish?',description:'Explicit confirmation is required.',confirmLabel:'Enable Auto publish'};
afterEach(()=>{if(currentConfirmation.value)settleConfirmation(currentConfirmation.value.id);});

test('confirmation resolves once, only for the displayed request',async()=>{
  const {confirmAction}=useConfirmation(),pending=confirmAction(options),id=currentConfirmation.value!.id;
  settleConfirmation(id+1,true);
  assert.equal(currentConfirmation.value!.id,id);
  settleConfirmation(id,true);settleConfirmation(id,false);
  assert.equal(await pending,true);assert.equal(currentConfirmation.value,null);
});

test('a second confirmation is declined rather than silently queued',async()=>{
  const {confirmAction}=useConfirmation(),first=confirmAction(options),id=currentConfirmation.value!.id;
  assert.equal(await confirmAction({...options,title:'Delete scene?'}),false);
  assert.equal(currentConfirmation.value!.title,options.title);
  settleConfirmation(id);assert.equal(await first,false);assert.equal(currentConfirmation.value,null);
});

test('disposing the requester cancels its dialog and prevents delayed actions',async()=>{
  const scope=effectScope(),controls=scope.run(()=>useConfirmation())!;
  const pending=controls.confirmAction(options);
  assert.ok(currentConfirmation.value);
  scope.stop();assert.equal(await pending,false);assert.equal(currentConfirmation.value,null);
  assert.equal(await controls.confirmAction(options),false);
});

test('disposing a rejected concurrent requester does not close another request',async()=>{
  const firstScope=effectScope(),secondScope=effectScope();
  const first=firstScope.run(()=>useConfirmation())!,second=secondScope.run(()=>useConfirmation())!;
  const pending=first.confirmAction(options),id=currentConfirmation.value!.id;
  assert.equal(await second.confirmAction({...options,title:'Sign out?'}),false);
  secondScope.stop();assert.equal(currentConfirmation.value!.id,id);
  settleConfirmation(id,true);assert.equal(await pending,true);firstScope.stop();
});

test('confirmation text is snapshotted rather than changed behind an open dialog',async()=>{
  const details=['Studio scene switching stays manual.'];
  const pending=useConfirmation().confirmAction({...options,details});
  details[0]='Changed by caller';
  assert.deepEqual(currentConfirmation.value!.details,['Studio scene switching stays manual.']);
  settleConfirmation(currentConfirmation.value!.id);assert.equal(await pending,false);
});
