<script setup lang="ts">
import SegmentedMeter from '@/components/audio/SegmentedMeter.vue';
import { ref,computed,onMounted,watch } from 'vue';
import { AudioLines,Mic,Square,ShieldCheck,Settings2,ChevronDown,RefreshCw,Headphones,AlertCircle,Check,X,Info } from 'lucide-vue-next';
import { Dialog,DialogContent,DialogHeader,DialogTitle,DialogDescription } from '@/components/ui/dialog';
import { Popover,PopoverContent,PopoverTrigger } from '@/components/ui/popover';
import { SkeletonIndicator } from '@/components/ui/skeleton';
import { useWorshipStore } from '@/stores/worship';
import { useIdentityStore } from '@/stores/identity';
import { useSharedListeningStore } from '@/stores/shared-listening';
import { useListeningInput } from '@/composables/useListeningInput';
import ListeningExampleReview from './ListeningExampleReview.vue';
import { useConfirmation } from '@/composables/useConfirmation';
import type { ListeningDecision, ListeningRecognition } from '../../../../shared/worship';

const props=defineProps<{channelId:string;kind:string;canOperate:boolean;compact?:boolean;popover?:boolean}>(),store=useWorshipStore(),identity=useIdentityStore();
const shared=useSharedListeningStore();
const sharedSession=computed(()=>shared.session);
const {confirmAction}=useConfirmation();
const {devices,deviceId,processing,permission,error:inputError,refreshing,testing,level:testLevel,clipping:testClipping,selectedLabel,missing,canUse,refreshDevices,startTest,stopTest,syncCaptureInfo}=useListeningInput();
const reviewPanel=ref<InstanceType<typeof ListeningExampleReview>|null>(null);
const settingsOpen=ref(false),popoverOpen=ref(false),modelChoice=ref(''),modelBusy=ref(false),modelError=ref('');
const ownView=computed(()=>store.listening[props.channelId]);
const view=computed(()=>sharedSession.value&&(props.kind==='lyrics'||!ownView.value?.session)?{session:{id:sharedSession.value.id,channelId:props.channelId,provider:'assemblyai' as const,mode:'assisted' as const,commands:false,language:'en',expiresAt:0},starting:sharedSession.value.state==='starting',busy:false,level:ownView.value?.level??0,peak:ownView.value?.peak??0,clipping:ownView.value?.clipping??false,inputInfo:ownView.value?.inputInfo??null,result:props.kind==='lyrics'?store.sharedResults[props.channelId]??null:shared.snapshot.result?.candidate?.selection.kind==='lyrics'?null:shared.snapshot.result,error:store.sharedErrors[props.channelId]||shared.error}:ownView.value);
const active=computed(()=>!!sharedSession.value||!!view.value?.session||!!view.value?.starting);
async function stop(){if(sharedSession.value)await shared.stop();else await store.stopListening(props.channelId);}
const controls=computed(()=>store.listeningControlsFor(props.channelId));
// The active session is authoritative. Merely returning to a channel must
// never show a safer mode than the listener is actually running.
const mode=computed<'assisted'|'automatic'>({
  get:()=>{
    if(props.kind==='lyrics'&&provider.value==='assemblyai')return 'assisted';
    if(sharedSession.value&&sharedSession.value.channelId!==props.channelId)return 'assisted';
    return sharedSession.value?.mode??view.value?.session?.mode??controls.value.mode;
  },
  set:value=>{if(!active.value)controls.value.mode=value;},
});
const commands=computed<boolean>({get:()=>view.value?.session?.commands??controls.value.commands,set:value=>{if(!active.value)controls.value.commands=value;}});
const profiles=computed(()=>store.aiStatus?.profiles??[]),currentModel=computed(()=>profiles.value.find(model=>model.id===store.aiStatus?.modelId));
const chosenModel=computed(()=>profiles.value.find(model=>model.id===modelChoice.value));
const canChangeModel=computed(()=>identity.can('*','author'));
const anyListening=computed(()=>Object.values(store.listening).some(input=>input.starting||input.session));
const provider=computed<'local'|'assemblyai'>({get:()=>sharedSession.value?'assemblyai':ownView.value?.session?.provider??controls.value.provider,set:value=>{if(!active.value){controls.value.provider=value;controls.value.providerSelected=true;}}});
// Prefer the configured shared listener once per channel; respect an operator's
// explicit provider choice and never change a running or armed session.
watch(()=>[store.aiStatus,props.channelId,props.kind] as const,()=>{
  if(!store.aiStatus||active.value||controls.value.providerSelected||controls.value.mode!=='assisted'||controls.value.commands)return;
  controls.value.provider=store.aiStatus.assemblyai?.available?'assemblyai':'local';
  controls.value.providerSelected=true;
},{immediate:true});
const cloud=computed(()=>provider.value==='assemblyai');
const available=computed(()=>cloud.value?!!store.aiStatus?.assemblyai?.available:store.aiStatus?.state!=='unavailable');
watch(provider,value=>{if(value==='assemblyai'&&!active.value){commands.value=false;if(props.kind==='lyrics')controls.value.mode='assisted';}});
const level=computed(()=>active.value?view.value?.level??0:testLevel.value);
const clipping=computed(()=>active.value?view.value?.clipping??false:testClipping.value);
const meterPercent=computed(()=>Math.min(100,Math.max(0,level.value*400)));
const signalLabel=computed(()=>sharedSession.value&&!ownView.value?.session?'Using shared audio input':clipping.value?'Input is clipping — lower the source gain':active.value||testing.value?level.value<.003?'No signal — check your input':level.value<.015?'Low input level':'Receiving audio':missing.value?'Selected device disconnected':permission.value==='denied'?'Microphone access blocked':permission.value==='granted'?'Input ready':'Microphone permission required');
const modelCommand=computed(()=>`npm run setup:ai -- --model=${chosenModel.value?.id||'small.en'}`);
const decisionLabels:Record<ListeningDecision,string>={listening:'Listening for a match',prepared:'Prepared', 'sent-live':'Sent live','already-live':'Already live',partial:'Waiting for a verse',review:'Needs review',conflict:'Conflicting references',unavailable:'Passage unavailable',cooldown:'Holding briefly',stale:'Result ignored'};
const decisionLabel=computed(()=>view.value?.result?decisionLabels[view.value.result.decision]??'Listening for a match':'');
const recognitionLabels:Record<ListeningRecognition['status'],string>={clear:'Words recognised',uncertain:'Check these words','no-speech':'No clear speech',unavailable:'Words need review'};
const needsAttention=computed(()=>sharedSession.value&&!ownView.value?.session?!!shared.error:!!view.value?.error||!!inputError.value||missing.value||permission.value==='denied'||!canUse.value||!available.value);
const triggerLabel=computed(()=>view.value?.starting?'Starting…':active.value?mode.value==='automatic'?'Listening · Auto':'Listening on':needsAttention.value?'Check listening':'Listening');
const triggerDescription=computed(()=>view.value?.error||inputError.value||(!available.value?(cloud.value?'Add the AssemblyAI key on the station.':'Set up a local speech model.'):active.value?`${mode.value==='automatic'?'Auto publish':'Prepare only'}. ${signalLabel.value}. Open listening controls for details.`:'Open microphone and listening controls.'));

onMounted(()=>{void store.refreshAi().catch(()=>{});});
watch(()=>[props.channelId,props.kind] as const,([id,kind])=>{if(kind==='lyrics'||kind==='scripture')store.followShared(id,kind);},{immediate:true});
watch(()=>store.aiStatus?.modelId,id=>{modelChoice.value=id??'';},{immediate:true});
watch(()=>view.value?.inputInfo,info=>{if(info)syncCaptureInfo(info);},{immediate:true});
watch(()=>view.value?.session,()=>void refreshDevices());
watch(()=>props.canOperate,value=>{if(!value&&ownView.value?.session)void store.stopListening(props.channelId,false);});
watch([missing,permission],([disconnected,access])=>{if((disconnected||access==='denied')&&ownView.value?.session)void store.stopListening(props.channelId);});
watch(settingsOpen,open=>{
  if(open){popoverOpen.value=false;modelError.value='';void refreshDevices();void store.refreshAi().catch(()=>{});}
  else {stopTest();if(props.popover)popoverOpen.value=true;}
});
async function toggle(){
  if(active.value){await stop();return;}
  const channelId=props.channelId,options={mode:mode.value,commands:commands.value,deviceId:deviceId.value,processing:processing.value};
  if(options.mode==='automatic'&&!await confirmAction({
    title:'Enable Auto publish?',
    description:props.kind==='lyrics'?'Repeated, unambiguous song matches will update this channel’s live lyrics.':'Clear, complete references and distinctive exact quotations will update this channel’s live Scripture.',
    details:['Changes appear wherever this channel is used, including an active Studio scene.','Studio scene switching stays manual.'],
    note:'Manual scripture controls disarm automatic publishing.',
    confirmLabel:'Enable Auto publish',tone:'live',
  }))return;
  // Confirmation is asynchronous: navigation, ownership or device state may
  // change while it is open. Never arm a different channel/input afterward.
  if(props.channelId!==channelId||active.value||!props.canOperate||!canUse.value||!available.value||mode.value!==options.mode||commands.value!==options.commands||deviceId.value!==options.deviceId||processing.value!==options.processing)return;
  stopTest();
  await store.startListening(channelId,options.deviceId,options.mode,options.commands,options.processing);
}
async function prepareSuggestion(){
  const candidate=view.value?.result?.candidate;if(!candidate||!props.canOperate)return;
  try{await store.prepare(props.channelId,candidate.selection);}catch(error){store.sharedErrors[props.channelId]=(error as Error).message;}
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
  <Popover v-model:open="popoverOpen">
    <div v-if="popover" class="w-listening-control">
      <PopoverTrigger as-child><button class="w-button w-listening-trigger" :class="{'is-listening':active,armed:active&&mode==='automatic','needs-attention':needsAttention}" aria-label="Open listening controls" :aria-description="triggerDescription" :title="triggerDescription"><SkeletonIndicator v-if="view?.starting" /><AlertCircle v-else-if="needsAttention" :size="14" /><span v-else-if="active" class="w-listening-dot" /><AudioLines v-else :size="15" /><span role="status">{{triggerLabel}}</span></button></PopoverTrigger>
      <button v-if="active&&!popoverOpen" class="w-button w-listening-stop" :disabled="!!sharedSession&&sharedSession.ownerId!==identity.me?.id" :aria-label="view?.starting?'Cancel start':'Stop listening'" @click="stop"><Square :size="11" />{{view?.starting?'Cancel':'Stop'}}</button>
    </div>
    <!-- Only the controls close. The input/controller above stays mounted, so
         dismissing a popover never tears down listening or requests a new mic. -->
    <component :is="popover?PopoverContent:'section'" class="w-listener" :class="[popover?'w-listener-popover':'panel-soft',{'is-cloud':cloud,armed:mode==='automatic','is-listening':active,'w-listener-compact':compact}]" v-bind="popover?{align:'end',sideOffset:8,collisionPadding:12}:{}" aria-label="AI listening" @close-auto-focus="settingsOpen&&$event.preventDefault()">
    <div class="w-listener-title">
      <span v-if="!popover" class="w-ai-icon"><AudioLines :size="17" /></span>
      <div><h3><AudioLines v-if="popover" :size="16" />AI listening <span v-if="view?.session" class="w-pill">{{mode==='automatic'?'AUTO ARMED':'PREPARE ONLY'}}</span></h3><p v-if="!popover">{{view?.starting?'Connecting recognition…':active?sharedSession?'Shared listening continues as you work.':'Listening. Manual changes stop listening.':kind==='lyrics'?'Suggest songs and sections from sung words.':'Prepare Scripture as the speaker quotes it.'}}</p></div>
      <span v-if="!popover" class="w-local"><ShieldCheck :size="12" />{{cloud?'AssemblyAI':'Local'}}</span>
      <button v-if="!popover" class="w-icon w-listener-settings" aria-label="Listening settings" title="Microphone and recognition settings" @click="settingsOpen=true"><Settings2 :size="16" /></button>
      <button v-else class="w-icon w-listener-close" aria-label="Close listening controls" @click="popoverOpen=false"><X :size="16" /></button>
    </div>
    <label v-if="(!cloud||!active)" class="w-listener-field"><span class="flex items-center gap-2">Provider <Popover><PopoverTrigger as-child><button type="button" class="w-icon" aria-label="About recognition providers"><Info :size="13" /></button></PopoverTrigger><PopoverContent class="w-listener-popover"><p class="w-muted">{{cloud?'Audio streams to AssemblyAI. One audio session can supply Scripture, Notes and song suggestions.':'Audio is transcribed locally on your station.'}} Use a clear microphone or vocal feed. Saved examples stay on this station.</p></PopoverContent></Popover></span><select v-model="provider" :disabled="active" aria-label="Recognition provider"><option value="local">Local model</option><option value="assemblyai">AssemblyAI</option></select></label>
    <p v-if="cloud&&active" class="w-muted">AssemblyAI · {{view?.inputInfo?.label||(sharedSession?'Shared audio input':selectedLabel)}}<template v-if="sharedSession"> · {{sharedSession.linkedNotes}} Notes linked</template></p>
    <div class="w-listener-transport">
      <template v-if="popover">
        <label v-if="!cloud||!active" class="w-listener-field"><span>Audio input</span><select v-model="deviceId" :disabled="active||testing" aria-label="Listening audio input"><option value="">System default microphone</option><option v-if="missing" :value="deviceId" disabled>{{selectedLabel}} — disconnected</option><option v-for="(device,i) in devices" :key="device.deviceId||i" :value="device.deviceId">{{device.label||`Audio input ${i+1} — allow access to identify`}}</option></select></label>
        <button v-if="permission!=='granted'&&!active" class="w-text-button w-listener-access" :disabled="refreshing||active||testing||permission==='unsupported'" @click="refreshDevices(true)"><Mic :size="13" />Allow microphone access</button>
        <label v-if="!cloud||!active" class="w-listener-field"><span>Mode</span><select v-model="mode" :disabled="active" aria-label="Listening mode"><option value="assisted">Prepare only</option><option v-if="kind!=='lyrics'||!cloud" value="automatic">Auto publish</option></select></label>
      </template>
      <template v-else>
        <button class="w-listener-device" aria-label="Configure listening input" :class="{'has-input-error':missing||permission==='denied'}" @click="settingsOpen=true"><Mic :size="15" /><span><small>Audio input</small><b>{{sharedSession&&!ownView?.session?'Shared audio input':active&&view?.inputInfo?view.inputInfo.label:selectedLabel}}</b></span><ChevronDown :size="14" /></button>
        <select v-model="mode" :disabled="active" aria-label="Listening mode"><option value="assisted">Prepare only</option><option v-if="kind!=='lyrics'||!cloud" value="automatic">Auto publish</option></select>
      </template>
      <button class="w-button w-listener-start" :class="{primary:!active}" :disabled="sharedSession?.state==='finishing'||!!sharedSession&&sharedSession.ownerId!==identity.me?.id||!active&&(!canOperate||!canUse||!available)" @click="toggle"><SkeletonIndicator v-if="view?.starting" /><Square v-else-if="active" :size="12" /><Mic v-else :size="14" />{{sharedSession?.state==='finishing'?'Finishing…':view?.starting?'Cancel start':active?'Stop listening':'Listen'}}</button>
    </div>
    <label v-if="mode==='automatic'&&!cloud" class="w-check"><input v-model="commands" type="checkbox" :disabled="active" />Enable “Lumen next / previous” voice commands</label>
    <div class="w-listener-signal"><SegmentedMeter data-testid="listening-level-meter" label="Listening input level" :percent="meterPercent" /><span :class="{'w-error':missing||clipping||permission==='denied'}">{{signalLabel}}</span><button v-if="!active&&!popover" class="w-text-button" @click="settingsOpen=true">Configure</button></div>
    <p v-if="popover" class="w-listener-note">{{active?sharedSession?mode==='automatic'?'Auto publish is armed. Manual scripture changes disarm it.':'Listening continues while you work.':'Manual content changes stop listening.':mode==='automatic'?'Matched passages can go live automatically.':'You choose when a verse goes live.'}}</p>
    <div v-if="view?.result" class="w-transcript"><span>HEARD <small>{{cloud?'Streaming':view.result.elapsedMs+' ms'}} · {{view.busy?'Processing…':'English'}}</small></span><p>{{view.result.transcript||'No clear speech detected'}}</p><small v-if="view.result.recognition&&!cloud" :title="view.result.recognition.reason" :data-recognition="view.result.recognition.status">{{recognitionLabels[view.result.recognition.status]}}</small></div>
    <div v-if="view?.result && (kind==='lyrics' || !(cloud && ['review', 'listening'].includes(view.result.decision)))" class="w-listener-decision" :data-decision="view.result.decision" data-testid="listening-decision" role="status"><div><span class="w-decision-dot" /><b>{{kind==='lyrics'&&cloud&&view.result.candidate?'Suggested song':decisionLabel}}</b><span v-if="view.result.candidate">{{view.result.candidate.reference}}</span></div><strong v-if="kind==='lyrics'&&view.result.candidate" class="w-song-suggestion-title">{{view.result.candidate.title}}</strong><p v-if="!cloud||kind==='lyrics'">{{view.result.reason}}</p><button v-if="kind==='lyrics'&&cloud&&view.result.candidate" class="w-button" :disabled="!canOperate||store.preparing[channelId]" @click="prepareSuggestion">Prepare song</button></div>
    <p v-if="view?.error||inputError" class="w-error" role="alert">{{view?.error||inputError}}</p>
    <p v-else-if="!available" class="w-listener-note"><button class="w-text-button" @click="settingsOpen=true">{{cloud?'Configure AssemblyAI on the station':'Set up a local speech model'}}<ChevronDown :size="12" /></button></p>
    <p v-else-if="!popover" class="w-listener-note">{{cloud?'AssemblyAI realtime':currentModel?.label||store.aiStatus?.model||'Local speech model'}} · English recognition · {{kind==='lyrics'?cloud?'Matches sung words in your song library. Use a clear vocal feed.':'Matches your service setlist.':'Exact Bible text from your library.'}}</p>
    <div v-if="popover" class="w-listener-popover-footer"><button class="w-text-button" aria-label="Listening settings" @click="settingsOpen=true"><Settings2 :size="14" />Settings</button><span class="w-local"><ShieldCheck :size="12" />{{cloud?'AssemblyAI':'Local'}}</span></div>
    <div v-if="kind==='scripture'&&(cloud||store.examples[channelId]?.length)" style="display:grid;gap:8px;padding-top:8px">
      <button v-if="cloud&&ownView?.session&&active&&!view?.starting" class="w-button" :disabled="store.exampleBusy[channelId]" @click="store.saveListeningExample(channelId)">Save last 12 seconds for review</button>
      <details v-if="store.examples[channelId]?.length"><summary>Saved listening examples ({{store.examples[channelId].length}})</summary><button v-for="example in store.examples[channelId]" :key="example.id" class="w-button" @click="popoverOpen=false;reviewPanel?.edit(example)">{{example.reviewed?'Reviewed':'Review'}} · {{new Date(example.createdAt).toLocaleTimeString()}}</button></details>
    </div>
    </component>
  </Popover>

  <ListeningExampleReview v-if="kind==='scripture'" ref="reviewPanel" :channel-id="channelId" :enabled="false" :show-controls="false" />
  <Dialog v-model:open="settingsOpen"><DialogContent class="w-dialog listening-settings-dialog" @close-auto-focus="popover&&$event.preventDefault()"><DialogHeader><DialogTitle>Listening settings</DialogTitle><DialogDescription>Choose what Lumen hears. This input is separate from Studio’s main audio.</DialogDescription></DialogHeader>
    <div class="listening-settings-grid">
      <section class="listening-settings-section"><div class="listening-settings-heading"><Mic :size="16" /><h3>Audio input</h3><button class="w-icon" aria-label="Refresh devices" :disabled="refreshing" @click="refreshDevices()"><SkeletonIndicator v-if="refreshing" /><RefreshCw v-else :size="14" /></button></div>
        <label class="w-label" for="listening-input-device">MICROPHONE OR AUDIO INTERFACE</label>
        <select id="listening-input-device" v-model="deviceId" :disabled="active||testing" aria-label="Listening input"><option value="">System default microphone</option><option v-if="missing" :value="deviceId" disabled>{{selectedLabel}} — disconnected</option><option v-for="(device,i) in devices" :key="device.deviceId||i" :value="device.deviceId">{{device.label||`Audio input ${i+1} — allow access to identify`}}</option></select>
        <p v-if="permission!=='granted'" class="w-muted">Allow microphone access to see device names. Device discovery briefly opens the microphone without transcribing audio.</p>
        <button v-if="permission!=='granted'" class="w-button" :disabled="refreshing||active||testing||permission==='unsupported'" @click="refreshDevices(true)"><Mic :size="14" />Allow microphone access</button>
        <p v-if="missing" class="w-error"><AlertCircle :size="13" />Reconnect the selected device or choose another. Lumen will not silently use a different microphone.</p>
        <label class="w-label" for="listening-input-processing">INPUT PROCESSING</label>
        <select id="listening-input-processing" v-model="processing" :disabled="active||testing" aria-label="Input processing"><option value="speech">Microphone · speech cleanup</option><option value="mixer">Mixer / line input · clean feed</option></select>
        <p class="w-muted">{{processing==='speech'?'Requests noise reduction, echo cancellation and automatic gain where the device supports them.':'Keeps your mixer’s signal unprocessed. Use a clear vocal feed rather than the full room mix.'}}</p>
        <div class="listening-test"><div class="listening-test-top"><span><Headphones :size="14" />Check your signal</span><button class="w-button" :disabled="active||!canUse" @click="testing?stopTest():startTest()">{{testing?'Stop test':'Test microphone'}}</button></div><SegmentedMeter data-testid="listening-test-meter" label="Test microphone level" :percent="meterPercent" /><p>{{signalLabel}}</p><small>Local level check only. No recording, transcription or speaker playback.</small></div>
        <p v-if="active" class="w-muted">Stop listening before changing or testing your input.</p><p v-if="inputError" class="w-error" role="alert">{{inputError}}</p>
      </section>
      <section v-if="!cloud" class="listening-settings-section"><div class="listening-settings-heading"><AudioLines :size="16" /><h3>Recognition</h3><ShieldCheck :size="14" /></div>
        <label class="w-label" for="listening-model-choice">LOCAL SPEECH MODEL</label>
        <select id="listening-model-choice" v-model="modelChoice" :disabled="modelBusy||anyListening||!canChangeModel" aria-label="Local speech model"><option v-if="!profiles.length" value="">Checking installed models…</option><option v-for="profile in profiles" :key="profile.id" :value="profile.id">{{profile.label}}{{profile.installed?'':' · Install required'}}</option></select>
        <p class="w-muted">{{chosenModel?.description||'Models run on this station. A stronger model uses more memory and may take longer.'}}</p>
        <button v-if="chosenModel?.installed" class="w-button" :disabled="modelBusy||anyListening||!canChangeModel||modelChoice===store.aiStatus?.modelId" @click="changeModel"><SkeletonIndicator v-if="modelBusy" /><Check v-else :size="13" />{{modelChoice===store.aiStatus?.modelId?'In use':'Use model'}}</button>
        <div v-else-if="chosenModel" class="listening-install"><span v-if="chosenModel.id==='custom'">Ask your station administrator to check the configured LUMEN_WHISPER_MODEL file.</span><template v-else><span>Install on the station · {{chosenModel.downloadMiB}} MiB download</span><code>{{modelCommand}}</code></template><button class="w-text-button" @click="checkModels"><RefreshCw :size="12" />Check installation</button></div>
        <p v-if="anyListening" class="w-muted">Stop listening on every channel before changing the shared station model.</p><p v-if="!canChangeModel" class="w-muted">A station-wide author can change the model.</p><p v-if="modelError" class="w-error" role="alert">{{modelError}}</p>
        <p v-if="store.aiStatus?.speechDetection==='neural'" class="w-muted">Speech detection helps separate voices from silence and background noise.</p>
        <div v-else-if="store.aiStatus?.speechDetection==='energy'" class="listening-install"><span>Add local speech detection to reduce recognition of background noise.</span><code>npm run setup:ai -- --vad-only</code></div>
        <div class="listening-language"><span>RECOGNITION LANGUAGE</span><b>English</b><p>Compare Small English and Turbo with recordings of your speakers. Base uses fewer resources but can miss accented speech and Bible names.</p><p>Uncertain words and approximate quotations are prepared for your review. English mixed with Twi still needs separate evaluation and language support.</p></div>
        <p class="w-listener-note">Use Prepare only while checking accuracy. Recognition uses unprompted beam decoding, not a supplied list of Bible names. This is not accent training.</p>
      </section>
    </div>
    <div class="listening-settings-footer"><span><ShieldCheck :size="13" />{{cloud?'Audio streams through this station to AssemblyAI. Saved listening examples stay on this station.':'Audio stays between this browser and your Lumen station.'}}</span><button class="w-button" @click="settingsOpen=false">Done</button></div>
  </DialogContent></Dialog>
</template>
