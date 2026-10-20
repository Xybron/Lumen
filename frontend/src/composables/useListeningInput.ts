import { computed,onBeforeUnmount,onMounted,ref,watch } from 'vue';
import { listeningAudioConstraints,listeningInputError,monitorListeningInput,type ListeningInputInfo,type ListeningProcessing } from '@/lib/worship/audio';

const storageKey='lumen.listening-input.v1';
function readPreferences():{deviceId:string;label:string;processing:ListeningProcessing} {
  try{
    const saved=JSON.parse(localStorage.getItem(storageKey)??'null');
    if(saved&&typeof saved==='object')return {deviceId:typeof saved.deviceId==='string'?saved.deviceId:'',label:typeof saved.label==='string'?saved.label:'',processing:saved.processing==='mixer'?'mixer':'speech'};
  }catch{/* Device preferences are optional in private browsing. */}
  return {deviceId:'',label:'',processing:'speech'};
}

/** This input configuration is separate from Studio's main-audio routing.
 * Mounting only enumerates/query-permission; it never opens a microphone. */
export function useListeningInput() {
  const saved=readPreferences(),deviceId=ref(saved.deviceId),processing=ref<ListeningProcessing>(saved.processing),savedLabel=ref(saved.label);
  const devices=ref<MediaDeviceInfo[]>([]),permission=ref<'prompt'|'granted'|'denied'|'unsupported'>('prompt');
  const error=ref(''),refreshing=ref(false),testing=ref(false),level=ref(0),peak=ref(0),clipping=ref(false),enumerated=ref(false);
  const selectedLabel=computed(()=>devices.value.find(device=>device.deviceId===deviceId.value)?.label||savedLabel.value||(deviceId.value?'Selected audio input':'System default microphone'));
  // Hidden labels/IDs before permission are not evidence of a disconnection.
  const missing=computed(()=>!!deviceId.value&&enumerated.value&&permission.value==='granted'&&!devices.value.some(device=>device.deviceId===deviceId.value));
  const canUse=computed(()=>permission.value!=='unsupported'&&!missing.value);
  let disposed=false,adoptingDevice=false,refreshSequence=0,testSequence=0,testAbort:AbortController|undefined,stopMeter:(()=>void)|undefined,permissionStatus:PermissionStatus|undefined;
  const persist=()=>{try{localStorage.setItem(storageKey,JSON.stringify({deviceId:deviceId.value,label:savedLabel.value,processing:processing.value}));}catch{/* Optional local preference. */}};
  function stopTest(){testSequence++;testAbort?.abort();testAbort=undefined;stopMeter?.();stopMeter=undefined;testing.value=false;level.value=0;peak.value=0;clipping.value=false;}
  function syncCaptureInfo(info:ListeningInputInfo){
    if(disposed)return;
    // A permission-era list may contain only hidden/empty IDs. Do not call a
    // newly revealed real device disconnected before re-enumeration finishes.
    enumerated.value=false;
    if(info.deviceId&&(!deviceId.value||deviceId.value==='default'||deviceId.value===info.deviceId)){adoptingDevice=true;deviceId.value=info.deviceId;adoptingDevice=false;savedLabel.value=info.label;persist();}
    permission.value='granted';void refreshDevices();
  }
  async function refreshDevices(requestPermission=false){
    const sequence=++refreshSequence;
    if(!navigator.mediaDevices?.enumerateDevices||!navigator.mediaDevices.getUserMedia){permission.value='unsupported';error.value='Audio input requires localhost or HTTPS and a browser with microphone support.';return;}
    refreshing.value=true;
    if(requestPermission)error.value='';
    try{
      if(requestPermission){
        // Permission-only discovery never attaches audio to a graph or sends it.
        const stream=await navigator.mediaDevices.getUserMedia(listeningAudioConstraints('',processing.value));
        const track=stream.getAudioTracks()[0],settings=track?.getSettings();
        stream.getTracks().forEach(item=>item.stop());
        if(disposed||sequence!==refreshSequence)return;
        enumerated.value=false;permission.value='granted';
        if(!deviceId.value&&settings?.deviceId){deviceId.value=settings.deviceId;savedLabel.value=track?.label??'';persist();}
      }
      const inputs=(await navigator.mediaDevices.enumerateDevices()).filter(device=>device.kind==='audioinput');
      if(disposed||sequence!==refreshSequence)return;
      devices.value=inputs;enumerated.value=permission.value==='granted'||inputs.some(device=>!!device.label);
      if(inputs.some(device=>!!device.label))permission.value='granted';
      const selected=inputs.find(device=>device.deviceId===deviceId.value);
      if(selected?.label){savedLabel.value=selected.label;persist();}
      if(missing.value){stopTest();error.value='The selected audio input disconnected. Reconnect it or choose another device.';}
      else if(error.value.startsWith('The selected audio input disconnected.'))error.value='';
    }catch(cause){
      if(disposed||sequence!==refreshSequence)return;
      if(cause instanceof Error&&['NotAllowedError','PermissionDeniedError'].includes(cause.name))permission.value='denied';
      error.value=listeningInputError(cause);
    }finally{if(sequence===refreshSequence)refreshing.value=false;}
  }
  async function startTest(){
    stopTest();error.value='';
    if(missing.value){error.value='The selected audio input is unavailable. Reconnect it or select another device.';return;}
    const sequence=++testSequence,abort=new AbortController();testAbort=abort;testing.value=true;
    try{
      const stop=await monitorListeningInput(deviceId.value,()=>{
        stopTest();error.value='The test input disconnected. Reconnect it or select another device.';void refreshDevices();
      },{signal:abort.signal,processing:processing.value,onInfo:syncCaptureInfo,onLevels:levels=>{if(sequence!==testSequence||disposed)return;level.value=levels.rms;peak.value=levels.peak;clipping.value=levels.clipping;}});
      if(disposed||sequence!==testSequence||abort.signal.aborted){stop();return;}
      stopMeter=stop;
    }catch(cause){
      if(disposed||sequence!==testSequence||abort.signal.aborted)return;
      stopTest();error.value=listeningInputError(cause);
      if(cause instanceof Error&&['NotAllowedError','PermissionDeniedError'].includes(cause.name))permission.value='denied';
    }
  }
  watch([deviceId,processing],([id],[oldId])=>{if(adoptingDevice)return;if(id!==oldId)savedLabel.value=devices.value.find(device=>device.deviceId===id)?.label??'';stopTest();error.value='';persist();},{flush:'sync'});
  const deviceChange=()=>{void refreshDevices();};
  const permissionChange=()=>{if(permissionStatus){permission.value=permissionStatus.state;if(permissionStatus.state==='denied')stopTest();void refreshDevices();}};
  onMounted(()=>{
    void refreshDevices();navigator.mediaDevices?.addEventListener('devicechange',deviceChange);
    if(navigator.permissions?.query)void navigator.permissions.query({name:'microphone' as PermissionName}).then(status=>{
      if(disposed)return;permissionStatus=status;permission.value=status.state;status.addEventListener('change',permissionChange);
    }).catch(()=>{/* Safari does not expose microphone permission queries. */});
  });
  onBeforeUnmount(()=>{disposed=true;refreshSequence++;stopTest();navigator.mediaDevices?.removeEventListener('devicechange',deviceChange);permissionStatus?.removeEventListener('change',permissionChange);});
  return {devices,deviceId,processing,permission,error,refreshing,testing,level,peak,clipping,selectedLabel,missing,canUse,refreshDevices,startTest,stopTest,syncCaptureInfo};
}
