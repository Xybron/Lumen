<script setup lang="ts">
import { ref,computed,onMounted,watch } from 'vue';
import { AudioLines,Mic,Square,ShieldCheck,LoaderCircle,Settings2,ChevronDown,RefreshCw,Headphones,AlertCircle,Check } from 'lucide-vue-next';
import { Dialog,DialogContent,DialogHeader,DialogTitle,DialogDescription } from '@/components/ui/dialog';
import { useWorshipStore } from '@/stores/worship';
import { useIdentityStore } from '@/stores/identity';
import { useListeningInput } from '@/composables/useListeningInput';
import { useConfirmation } from '@/composables/useConfirmation';
import type { ListeningDecision } from '../../../../shared/worship';

const props=defineProps<{channelId:string;kind:string;canOperate:boolean}>(),store=useWorshipStore(),identity=useIdentityStore();
const {confirmAction}=useConfirmation();
const {devices,deviceId,processing,permission,error:inputError,refreshing,testing,level:testLevel,clipping:testClipping,selectedLabel,missing,canUse,refreshDevices,startTest,stopTest,syncCaptureInfo}=useListeningInput();
const settingsOpen=ref(false),modelChoice=ref(''),modelBusy=ref(false),modelError=ref('');
const view=computed(()=>store.listening[props.channelId]),active=computed(()=>!!view.value?.session||!!view.value?.starting);
const controls=computed(()=>store.listeningControlsFor(props.channelId));
// The active session is authoritative. Merely returning to a channel must
// never show a safer mode than the listener is actually running.
const mode=computed<'assisted'|'automatic'>({get:()=>view.value?.session?.mode??controls.value.mode,set:value=>{if(!active.value)controls.value.mode=value;}});
const commands=computed<boolean>({get:()=>view.value?.session?.commands??controls.value.commands,set:value=>{if(!active.value)controls.value.commands=value;}});
const profiles=computed(()=>store.aiStatus?.profiles??[]),currentModel=computed(()=>profiles.value.find(model=>model.id===store.aiStatus?.modelId));
const chosenModel=computed(()=>profiles.value.find(model=>model.id===modelChoice.value));
const canChangeModel=computed(()=>identity.can('*','author'));
const anyListening=computed(()=>Object.values(store.listening).some(input=>input.starting||input.session));
const available=computed(()=>store.aiStatus?.state!=='unavailable');
const level=computed(()=>active.value?view.value?.level??0:testLevel.value);
const clipping=computed(()=>active.value?view.value?.clipping??false:testClipping.value);
const meterPercent=computed(()=>Math.min(100,Math.max(0,level.value*400)));
const signalLabel=computed(()=>clipping.value?'Input is clipping — lower the source gain':active.value||testing.value?level.value<.003?'No signal — check your input':level.value<.015?'Low input level':'Receiving audio':missing.value?'Selected device disconnected':permission.value==='denied'?'Microphone access blocked':permission.value==='granted'?'Input ready':'Microphone permission required');
const modelCommand=computed(()=>`npm run setup:ai -- --model=${chosenModel.value?.id||'small.en'}`);
const decisionLabels:Record<ListeningDecision,string>={listening:'Listening for a match',prepared:'Prepared', 'sent-live':'Sent live','already-live':'Already live',partial:'Waiting for a verse',review:'Needs review',conflict:'Conflicting references',unavailable:'Passage unavailable',cooldown:'Holding briefly',stale:'Result ignored'};
const decisionLabel=computed(()=>view.value?.result?decisionLabels[view.value.result.decision]??'Listening for a match':'');

onMounted(()=>{void store.refreshAi().catch(()=>{});});
watch(()=>store.aiStatus?.modelId,id=>{modelChoice.value=id??'';},{immediate:true});
watch(()=>view.value?.inputInfo,info=>{if(info)syncCaptureInfo(info);},{immediate:true});
watch(()=>view.value?.session,()=>void refreshDevices());
watch(()=>props.canOperate,value=>{if(!value&&active.value)void store.stopListening(props.channelId);});
watch([missing,permission],([disconnected,access])=>{if((disconnected||access==='denied')&&active.value)void store.stopListening(props.channelId);});
watch(settingsOpen,open=>{
  if(open){modelError.value='';void refreshDevices();void store.refreshAi().catch(()=>{});}
  else stopTest();
});
async function toggle(){
  if(active.value){await store.stopListening(props.channelId);return;}
  const channelId=props.channelId,options={mode:mode.value,commands:commands.value,deviceId:deviceId.value,processing:processing.value};
  if(options.mode==='automatic'&&!await confirmAction({
    title:'Enable Auto publish?',
    description:props.kind==='lyrics'?'Repeated, unambiguous song matches will update this channel’s live lyrics.':'Clear, complete references and distinctive exact quotations will update this channel’s live Scripture.',
    details:['Changes appear wherever this channel is used, including an active Studio scene.','Studio scene switching stays manual.'],
    note:'Rehearse with Prepare only first. Manual content controls stop listening.',
    confirmLabel:'Enable Auto publish',tone:'live',
  }))return;
  // Confirmation is asynchronous: navigation, ownership or device state may
  // change while it is open. Never arm a different channel/input afterward.
  if(props.channelId!==channelId||active.value||!props.canOperate||!canUse.value||!available.value||mode.value!==options.mode||commands.value!==options.commands||deviceId.value!==options.deviceId||processing.value!==options.processing)return;
  stopTest();
  await store.startListening(channelId,options.deviceId,options.mode,options.commands,options.processing);
}
async function changeModel(){
  if(!canChangeModel.value||modelBusy.value||anyListening.value||!chosenModel.value?.installed)return;
  modelBusy.value=true;modelError.value='';
  try{await store.selectListeningModel(modelChoice.value);}catch(error){modelError.value=(error as Error).message;await store.refreshAi().catch(()=>{});}finally{modelBusy.value=false;}
}
async function checkModels(){
  modelError.value='';
  try{await store.refreshAi();}catch(error){modelError.value=(error as Error).message;}
}
</script>

<template>
  <section class="w-listener panel-soft" :class="{armed:view?.session?.mode==='automatic','is-listening':active}" aria-label="Local listening">
    <div class="w-listener-title">
      <span class="w-ai-icon"><AudioLines :size="17" /></span>
      <div><h3>Local listening <span v-if="view?.session" class="w-pill">{{view.session.mode==='automatic'?'AUTO ARMED':'PREPARE ONLY'}}</span></h3><p>{{view?.starting?'Starting local recognition…':active?'Listening. Manual changes stop listening.':kind==='lyrics'?'Find the right song section as it is sung.':'Prepare Scripture as the speaker quotes it.'}}</p></div>
      <span class="w-local"><ShieldCheck :size="12" />Local</span>
      <button class="w-icon w-listener-settings" aria-label="Listening settings" title="Microphone and recognition settings" @click="settingsOpen=true"><Settings2 :size="16" /></button>
    </div>
    <div class="w-listener-transport">
      <button class="w-listener-device" aria-label="Configure listening input" :class="{'has-input-error':missing||permission==='denied'}" @click="settingsOpen=true"><Mic :size="15" /><span><small>Audio input</small><b>{{active&&view?.inputInfo?view.inputInfo.label:selectedLabel}}</b></span><ChevronDown :size="14" /></button>
      <select v-model="mode" :disabled="active" aria-label="Listening mode"><option value="assisted">Prepare only</option><option value="automatic">Auto publish</option></select>
      <button class="w-button w-listener-start" :class="{primary:!active}" :disabled="!active&&(!canOperate||!canUse||!available)" @click="toggle"><LoaderCircle v-if="view?.starting" :size="14" class="w-spin" /><Square v-else-if="active" :size="12" /><Mic v-else :size="14" />{{view?.starting?'Cancel start':active?'Stop listening':'Listen'}}</button>
    </div>
    <label v-if="mode==='automatic'" class="w-check"><input v-model="commands" type="checkbox" :disabled="active" />Enable “Lumen next / previous” voice commands</label>
    <div class="w-listener-signal"><div class="w-listener-meter" data-testid="listening-level-meter" role="meter" aria-label="Listening input level" aria-valuemin="0" aria-valuemax="100" :aria-valuenow="Math.round(meterPercent)" :class="{clipping}"><span :style="{width:meterPercent+'%'}" /></div><span :class="{'w-error':missing||clipping||permission==='denied'}">{{signalLabel}}</span><button v-if="!active" class="w-text-button" @click="settingsOpen=true">Configure</button></div>
    <div v-if="view?.result" class="w-transcript"><span>HEARD <small>{{view.result.elapsedMs}} ms · {{view.busy?'Processing…':'English'}}</small></span><p>{{view.result.transcript||'No clear speech detected'}}</p></div>
    <div v-if="view?.result" class="w-listener-decision" :data-decision="view.result.decision" data-testid="listening-decision" role="status"><div><span class="w-decision-dot" /><b>{{decisionLabel}}</b><span v-if="view.result.candidate">{{view.result.candidate.reference}}</span></div><p>{{view.result.reason}}</p></div>
    <p v-if="view?.error||inputError" class="w-error" role="alert">{{view?.error||inputError}}</p>
    <p v-else-if="!available" class="w-listener-note"><button class="w-text-button" @click="settingsOpen=true">Set up a local speech model<ChevronDown :size="12" /></button></p>
    <p v-else class="w-listener-note">{{currentModel?.label||store.aiStatus?.model||'Local speech model'}} · English recognition · {{kind==='lyrics'?'Matches your service setlist.':'Exact Bible text from your library.'}}</p>
  </section>

  <Dialog v-model:open="settingsOpen"><DialogContent class="w-dialog listening-settings-dialog"><DialogHeader><DialogTitle>Listening settings</DialogTitle><DialogDescription>Choose what Lumen hears. This input is separate from Studio’s main audio.</DialogDescription></DialogHeader>
    <div class="listening-settings-grid">
      <section class="listening-settings-section"><div class="listening-settings-heading"><Mic :size="16" /><h3>Audio input</h3><button class="w-icon" aria-label="Refresh devices" :disabled="refreshing" @click="refreshDevices()"><RefreshCw :size="14" :class="{'w-spin':refreshing}" /></button></div>
        <label class="w-label" for="listening-input-device">MICROPHONE OR AUDIO INTERFACE</label>
        <select id="listening-input-device" v-model="deviceId" :disabled="active||testing" aria-label="Listening input"><option value="">System default microphone</option><option v-if="missing" :value="deviceId" disabled>{{selectedLabel}} — disconnected</option><option v-for="(device,i) in devices" :key="device.deviceId||i" :value="device.deviceId">{{device.label||`Audio input ${i+1} — allow access to identify`}}</option></select>
        <p v-if="permission!=='granted'" class="w-muted">Allow microphone access to see device names. Device discovery briefly opens the microphone without transcribing audio.</p>
        <button v-if="permission!=='granted'" class="w-button" :disabled="refreshing||active||testing||permission==='unsupported'" @click="refreshDevices(true)"><Mic :size="14" />Allow microphone access</button>
        <p v-if="missing" class="w-error"><AlertCircle :size="13" />Reconnect the selected device or choose another. Lumen will not silently use a different microphone.</p>
        <label class="w-label" for="listening-input-processing">INPUT PROCESSING</label>
        <select id="listening-input-processing" v-model="processing" :disabled="active||testing" aria-label="Input processing"><option value="speech">Microphone · speech cleanup</option><option value="mixer">Mixer / line input · clean feed</option></select>
        <p class="w-muted">{{processing==='speech'?'Requests noise reduction, echo cancellation and automatic gain where the device supports them.':'Keeps your mixer’s signal unprocessed. Use a clear preacher feed rather than the full room mix.'}}</p>
        <div class="listening-test"><div class="listening-test-top"><span><Headphones :size="14" />Check your signal</span><button class="w-button" :disabled="active||!canUse" @click="testing?stopTest():startTest()">{{testing?'Stop test':'Test microphone'}}</button></div><div class="w-listener-meter" data-testid="listening-test-meter" role="meter" aria-label="Test microphone level" aria-valuemin="0" aria-valuemax="100" :aria-valuenow="Math.round(meterPercent)" :class="{clipping}"><span :style="{width:meterPercent+'%'}" /></div><p>{{signalLabel}}</p><small>Local level check only. No recording, transcription or speaker playback.</small></div>
        <p v-if="active" class="w-muted">Stop listening before changing or testing your input.</p><p v-if="inputError" class="w-error" role="alert">{{inputError}}</p>
      </section>
      <section class="listening-settings-section"><div class="listening-settings-heading"><AudioLines :size="16" /><h3>Recognition</h3><ShieldCheck :size="14" /></div>
        <label class="w-label" for="listening-model-choice">LOCAL SPEECH MODEL</label>
        <select id="listening-model-choice" v-model="modelChoice" :disabled="modelBusy||anyListening||!canChangeModel" aria-label="Local speech model"><option v-if="!profiles.length" value="">Checking installed models…</option><option v-for="profile in profiles" :key="profile.id" :value="profile.id">{{profile.label}}{{profile.installed?'':' · Install required'}}</option></select>
        <p class="w-muted">{{chosenModel?.description||'Models run on this station. A stronger model uses more memory and may take longer.'}}</p>
        <button v-if="chosenModel?.installed" class="w-button" :disabled="modelBusy||anyListening||!canChangeModel||modelChoice===store.aiStatus?.modelId" @click="changeModel"><LoaderCircle v-if="modelBusy" :size="13" class="w-spin" /><Check v-else :size="13" />{{modelChoice===store.aiStatus?.modelId?'In use':'Use model'}}</button>
        <div v-else-if="chosenModel" class="listening-install"><span v-if="chosenModel.id==='custom'">Ask your station administrator to check the configured LUMEN_WHISPER_MODEL file.</span><template v-else><span>Install on the station · {{chosenModel.downloadMiB}} MiB download</span><code>{{modelCommand}}</code></template><button class="w-text-button" @click="checkModels"><RefreshCw :size="12" />Check installation</button></div>
        <p v-if="anyListening" class="w-muted">Stop listening on every channel before changing the shared station model.</p><p v-if="!canChangeModel" class="w-muted">A station-wide author can change the model.</p><p v-if="modelError" class="w-error" role="alert">{{modelError}}</p>
        <div class="listening-language"><span>RECOGNITION LANGUAGE</span><b>English</b><p>For Ghanaian English, try a stronger model and rehearse with your own speaker’s audio. Accent accuracy is not guaranteed.</p><p>English mixed with Twi is not yet supported or validated by the installed recogniser. A multilingual model alone does not add Twi support.</p></div>
        <p class="w-listener-note">Use Prepare only while checking accuracy. Recognition uses unprompted beam decoding, not a supplied list of Bible names. This is not accent training.</p>
      </section>
    </div>
    <div class="listening-settings-footer"><span><ShieldCheck :size="13" />Audio stays between this browser and your Lumen station.</span><button class="w-button" @click="settingsOpen=false">Done</button></div>
  </DialogContent></Dialog>
</template>
