<script setup lang="ts">
import { ref, onMounted, onBeforeUnmount } from 'vue';
import { Camera, Mic } from 'lucide-vue-next';
import type { VirtualDeviceStatus, VirtualDevices } from '@/lib/studio/virtual-devices';

defineProps<{ canOperate: boolean }>();
const desktop = window.lumenVirtualDevices;
const state = ref<VirtualDeviceStatus | null>(null), pending = ref(false), error = ref(''), notice = ref('');
let timer: ReturnType<typeof setInterval> | undefined, disposed = false, reading = false;
async function refresh() {
  if (!desktop || reading || pending.value) return;
  reading = true;
  try { const result = await desktop.status(); if (!disposed) state.value = result; }
  catch (cause) { if (!disposed) error.value = cause instanceof Error ? cause.message : 'Device status is unavailable.'; }
  finally { reading = false; }
}
async function action(command: keyof VirtualDevices) {
  if (!desktop) return;
  pending.value = true; error.value = ''; notice.value = '';
  try {
    state.value = await desktop[command]();
    if (command === 'installAudio' || command === 'activateCamera' && state.value.platform === 'win32')
      notice.value = state.value.platform === 'win32' ? 'Complete the Lumen devices installer and approve Windows administrator access. Restart if prompted, then reopen Zoom or OBS.'
        : 'Complete the macOS installer, then restart this Mac to load Lumen Microphone.';
  } catch (cause) { error.value = cause instanceof Error ? cause.message.replace(/^Error invoking remote method '[^']+': Error: /, '') : 'Device operation failed.'; }
  finally { pending.value = false; }
}
onMounted(() => { void refresh(); timer = setInterval(() => void refresh(), 3000); });
onBeforeUnmount(() => { disposed = true; clearInterval(timer); });
</script>

<template>
  <div v-if="desktop" class="virtual-devices" aria-label="Lumen camera and microphone">
    <div class="device-heading"><Camera :size="15" /><strong>Camera &amp; microphone</strong><span v-if="state?.running" class="live">{{ state.receivingVideo ? 'Sending Program' : 'Waiting for Program' }}</span></div>
    <p>Select <b>Lumen Camera</b> and <b>Lumen Microphone</b> in Zoom, OBS or another app. The camera sends Program; the microphone sends the Main mix.</p>
    <p v-if="state && !state.supported">Native Lumen devices require the macOS or Windows desktop app.</p>
    <p v-else-if="state && (!state.built || !state.signed || !state.packaged)">This build does not include installable devices. Use a signed Lumen desktop release with virtual devices included.</p>
    <template v-else-if="state">
      <div class="device-status"><span><Camera :size="13" />{{ state.camera ? 'Camera available' : 'Camera needs setup' }}</span><span><Mic :size="13" />{{ state.microphone ? 'Microphone available' : 'Microphone needs setup' }}</span></div>
      <div class="device-actions">
        <button v-if="state.platform === 'win32' && (!state.camera || !state.microphone)" class="s-button" :disabled="!canOperate || pending || state.busy" @click="action('installAudio')">Install camera &amp; microphone</button>
        <button v-if="state.platform === 'darwin' && !state.camera" class="s-button" :disabled="!canOperate || pending || state.busy || state.activation === 'activating' || state.activation === 'approval-required'" @click="action('activateCamera')">Enable camera</button>
        <button v-if="state.platform === 'darwin' && !state.microphone" class="s-button" :disabled="!canOperate || pending || state.busy" @click="action('installAudio')">Install microphone</button>
        <button class="s-button" :class="{ primary: !state.running }" :disabled="!canOperate || pending || state.busy || (!state.running && (!state.camera || !state.microphone))" @click="action(state.running ? 'stop' : 'start')">{{ pending ? 'Please wait…' : state.running ? 'Stop sending' : 'Start sending Program' }}</button>
      </div>
      <p v-if="state.activation === 'approval-required'">Approve Lumen Camera in macOS System Settings → General → Login Items &amp; Extensions → Camera Extensions.</p>
      <p v-if="state.activation === 'restart-required'">Restart this Mac to finish enabling Lumen Camera.</p>
      <p v-if="state.running && !state.receivingAudio">Waiting for Main audio. Check the Program engine and Main mix.</p>
    </template>
    <p v-if="error || state?.error" class="device-error" role="alert">{{ error || state?.error }}</p>
    <p v-if="notice" role="status">{{ notice }}</p>
  </div>
</template>

<style scoped>
.virtual-devices{border:1px solid var(--border-hair);border-radius:8px;padding:14px;margin-top:12px;font-size:12px}.device-heading,.device-status,.device-status>span,.device-actions{display:flex;align-items:center;gap:8px;flex-wrap:wrap}.device-heading strong{font-weight:500}.virtual-devices p{color:var(--text-muted);font-size:11px;line-height:1.7;margin:9px 0}.device-status{gap:18px;color:var(--text-muted);margin:12px 0}.live{color:#a3ceb7;font-size:10px;margin-left:auto}.device-error{color:#e5a598!important}.device-actions .primary{background:var(--accent,#7dd3fc);color:#14232b}.device-actions button:disabled{opacity:.45;cursor:not-allowed}
</style>
