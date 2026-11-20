<script setup lang="ts">
import { computed, onDeactivated, onMounted, ref, watch } from 'vue';
import { useRoute } from 'vue-router';
import { ChevronDown, Circle, FolderOpen, Info, Maximize2, Minimize2, MonitorUp, MoreHorizontal, Power, Smartphone } from 'lucide-vue-next';
import { toast } from 'vue-sonner';
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover';
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogDescription } from '@/components/ui/dialog';
import BroadcastButton from '@/components/broadcast/BroadcastButton.vue';
import MobileControlButton from '@/components/mobile/MobileControlButton.vue';
import TeamButton from '@/components/team/TeamButton.vue';
import { useStudioStore } from '@/stores/studio';
import { useBroadcastStore } from '@/stores/broadcast';
import { useIdentityStore } from '@/stores/identity';
import { useOutputsStore } from '@/stores/outputs';
import { useAppFullscreen } from '@/composables/useAppFullscreen';
import { studioApi } from '@/lib/studio/api';

const route = useRoute(), studio = useStudioStore(), identity = useIdentityStore();
const broadcast = useBroadcastStore(), outputs = useOutputsStore();
const mobile = ref<InstanceType<typeof MobileControlButton> | null>(null);
const busy = ref(false), menu = ref(false), about = ref(false);
const canOperate = computed(() => identity.isAuthenticated && identity.can('*', 'author'));
const recording = computed(() => studio.status.recording);
const { isFullscreen, isSupported, toggle } = useAppFullscreen();
onMounted(() => { if (!studio.state) void studio.load(); });
function dismiss() { menu.value = false; about.value = false; }
watch(() => route.fullPath, dismiss);
onDeactivated(dismiss);
async function run(work: () => Promise<void>) {
  if (busy.value || !canOperate.value) return;
  busy.value = true;
  try { await work(); } catch (error) { toast.error(error instanceof Error ? error.message : 'Program controls are unavailable.'); }
  finally { busy.value = false; }
}
function record() {
  void run(async () => {
    if (!recording.value) {
      if (!studio.state?.program) throw new Error('Send a presentation to Program, or choose a scene in Studio first.');
      if (studio.status.state !== 'running') studio.status = await studioApi.start();
    }
    await studio.toggleRecord();
  });
}
function toggleEngine() { menu.value = false; void run(async () => { await studio.toggleEngine(); }); }
async function toggleFullscreen() {
  menu.value = false;
  try { await toggle(); } catch { toast.error('Fullscreen is unavailable in this window.'); }
}
function openMobile() { menu.value = false; mobile.value?.show(); }
</script>

<template>
  <div v-if="canOperate" class="program-controls" role="group" aria-label="Shared Program controls">
    <button type="button" class="program-button outputs-button" aria-label="Open Outputs" aria-haspopup="dialog" :aria-expanded="outputs.open" @click="outputs.show()"><MonitorUp :size="15" /><span>Outputs</span><ChevronDown :size="13" /></button>
    <span class="program-actions-divider" aria-hidden="true" />
    <button type="button" class="program-button record-button" :class="{ recording: !!recording }" :disabled="busy || studio.recordingBusy || (!recording && !studio.state?.program) || recording?.status === 'stopping'" :aria-label="recording ? 'Stop recording Program' : 'Record Program'" :aria-pressed="!!recording" :title="recording?.status === 'stopping' ? 'Finishing recording…' : recording ? 'Recording Program · Click to stop' : 'Record Program and Main audio'" @click="record"><span v-if="recording" class="record-dot" aria-hidden="true" /><Circle v-else :size="12" /><span aria-live="polite">{{ recording?.status === 'stopping' ? 'Finishing…' : recording ? 'Recording' : 'Record' }}</span></button>
    <BroadcastButton compact />
    <button type="button" class="program-button engine-button engine-control" :class="{ running: studio.status.state === 'running' }" :disabled="busy || studio.engineBusy || studio.status.state === 'starting' || !!recording || broadcast.active" :aria-label="studio.status.state === 'running' ? 'Stop engine' : 'Start engine'" :title="recording || broadcast.active ? 'Stop recording and broadcasting before stopping the engine.' : 'Runs the live Program picture and audio. Starts automatically when needed.'" @click="toggleEngine"><Power :size="15" /><span>{{ studio.engineBusy ? studio.status.state === 'running' ? 'Stopping…' : 'Starting…' : studio.status.state === 'starting' ? 'Starting…' : studio.status.state === 'running' ? 'Stop engine' : 'Start engine' }}</span></button>
    <Popover v-model:open="menu"><PopoverTrigger as-child><button type="button" class="program-button program-more" aria-label="More Program controls"><MoreHorizontal :size="17" /></button></PopoverTrigger><PopoverContent align="end" class="program-menu !p-2 w-56">
      <span class="program-menu-label">Workspace</span>
      <button type="button" @click="openMobile"><Smartphone :size="15" />Mobile control</button>
      <button type="button" @click="menu = false; $router.push('/recordings')"><FolderOpen :size="15" />Recordings</button>
      <button v-if="isSupported" type="button" :aria-label="isFullscreen ? 'Exit fullscreen' : 'Enter fullscreen'" @click="toggleFullscreen"><Minimize2 v-if="isFullscreen" :size="15" /><Maximize2 v-else :size="15" />{{ isFullscreen ? 'Exit fullscreen' : 'Fullscreen' }}<kbd>F</kbd></button>
      <TeamButton @click="menu = false" />
      <div class="program-menu-divider" />
      <button type="button" @click="menu = false; about = true"><Info :size="15" />About Lumen</button>
    </PopoverContent></Popover>
    <MobileControlButton ref="mobile" hide-trigger />
    <Dialog v-model:open="about"><DialogContent class="sm:max-w-sm"><DialogHeader><DialogTitle>Lumen <span class="about-credit">by Xybron</span></DialogTitle><DialogDescription>One workspace for presentations, worship, production and live output.</DialogDescription></DialogHeader></DialogContent></Dialog>
  </div>
</template>

<style scoped>
.program-controls{display:flex;align-items:center;justify-content:flex-end;gap:8px;min-width:0;flex-shrink:0}
.program-button{display:inline-flex;align-items:center;justify-content:center;gap:8px;min-height:35px;padding:7px 12px;white-space:nowrap;border:1px solid var(--border-hair);border-radius:7px;background:transparent;color:var(--text-primary);font-size:12px;font-weight:450;line-height:1.4}
.program-button:hover:not(:disabled){background:var(--bg-hover)}.program-button:disabled{opacity:.4;cursor:not-allowed}.program-button:focus-visible{outline:2px solid var(--accent);outline-offset:3px}
.outputs-button,.program-more{border-color:transparent}.outputs-button{color:var(--text-secondary,var(--text-primary))}.program-more{padding:7px;width:33px;color:var(--text-muted)}
.program-actions-divider{height:21px;width:1px;background:var(--border-hair);margin-inline:4px}
.record-button{color:var(--text-muted);background:#ffffff04;min-width:82px}
.record-button:not(.recording)>svg{color:var(--status-live)}
.record-button.recording{color:var(--status-live);background:var(--status-live-fill);border-color:var(--status-live-border)}
.record-button.recording:hover:not(:disabled){background:color-mix(in srgb,var(--status-live) 16%,transparent)}
.record-dot{width:7px;height:7px;flex:0 0 7px;border-radius:50%;background:currentColor}
.program-controls :deep(.broadcast-trigger.is-compact){min-height:35px;padding:7px 12px;gap:8px;border-radius:7px;font-size:12px;font-weight:500;line-height:1.4}

.program-menu{background:var(--surface-2);border-color:var(--border-hair)}.program-menu button,.program-menu :deep(.team-header-button){display:flex;align-items:center;gap:9px;padding:9px;width:100%;font-size:12px;text-align:left;border:0;border-radius:5px;color:var(--text-primary);justify-content:flex-start;min-height:35px;background:transparent}.program-menu button:hover:not(:disabled),.program-menu :deep(.team-header-button:hover){background:var(--bg-hover)}.program-menu button:disabled{opacity:.4}.program-menu kbd{margin-left:auto;font-size:10px;color:var(--text-muted)}.program-menu-label{display:block;padding:8px 9px 5px;color:var(--text-muted);font-size:10px;letter-spacing:.8px;text-transform:uppercase}.program-menu-divider{height:1px;background:var(--border-hair);margin:5px 8px}.about-credit{font-size:12px;color:var(--text-muted);font-weight:400;margin-left:8px}
@media(max-width:600px){.engine-button span{display:none}.engine-button{width:35px;padding-inline:0!important;justify-content:center}.program-controls{gap:6px}.program-button,.program-controls :deep(.broadcast-trigger.is-compact){font-size:12px;padding:7px 10px}.record-button{min-width:72px}}
@media(max-width:380px){.program-controls{gap:4px}.program-button,.program-controls :deep(.broadcast-trigger.is-compact){padding-inline:8px;gap:6px}.program-more{width:28px}.program-actions-divider{margin-inline:1px}.outputs-button>svg:first-child{display:none}}
@media(max-width:360px){.program-button,.program-controls :deep(.broadcast-trigger.is-compact){font-size:11px;padding-inline:6px}.program-actions-divider{display:none}.program-more{width:26px}}
@media(pointer:coarse){.program-button,.program-controls :deep(.broadcast-trigger.is-compact){min-height:40px}.program-menu button{min-height:44px}}
</style>
