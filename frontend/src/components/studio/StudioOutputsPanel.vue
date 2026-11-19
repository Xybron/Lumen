<script setup lang="ts">
import { computed, nextTick, onBeforeUnmount, ref, shallowRef } from 'vue';
import { Monitor, Plus, ArrowLeft, ArrowUpRight, Eye, EyeOff, Volume2, VolumeX, RotateCcw, Trash2, Link2, Copy, Check, Globe, Network, Laptop, ShieldCheck, RefreshCw, AlertCircle } from 'lucide-vue-next';
import StudioPropertyInput from './StudioPropertyInput.vue';
import { studioApi, studioRequest } from '@/lib/studio/api';
import { useStudioStore } from '@/stores/studio';
import { useOutputsStore } from '@/stores/outputs';
import { useIdentityStore } from '@/stores/identity';
import { listDisplays, openDisplayOutput, desktopDisplays, assignedDisplay, type DisplayPreference, type ConnectedDisplay } from '@/lib/studio/display-outputs';
import StudioVirtualDevices from './StudioVirtualDevices.vue';
import { useConfirmation } from '@/composables/useConfirmation';
import type { StudioOutput, StudioScene } from '../../../../shared/production';

const props = defineProps<{ outputs: StudioOutput[]; scenes: StudioScene[]; pending: boolean; canOperate: boolean; programName?: string }>();
const emit = defineEmits<{ add: []; rename: [id: string, name: string]; route: [id: string, sceneId: string | null]; blank: [id: string, blanked: boolean]; audio: [id: string]; refresh: [id: string]; remove: [id: string] }>();
interface DeliveryLink { outputId: string; url: string | null; localUrl: string | null; networkUrl: string | null; viewers: number }
interface DeliveryStatus { running: boolean; host: string; port: number; interfaces: { address: string; label: string }[]; links: DeliveryLink[]; maxViewers: number; perLinkLimit: number }
interface ExternalStatus { configured: boolean; verified: boolean; url: string | null; message: string; status?: string }
const nativeDisplays = desktopDisplays();
const studio = useStudioStore(), outputsUi = useOutputsStore(), identity = useIdentityStore();
const operator = identity.me?.id;
const canAct = () => !disposed && !!operator && identity.me?.id === operator && props.canOperate && identity.can('*', 'author');
const root = ref<HTMLElement | null>(null);
const { confirmAction } = useConfirmation();
const open = ref(false), outputId = ref('program'), tab = ref<'display' | 'computer' | 'network' | 'external'>('computer');
const delivery = ref<DeliveryStatus | null>(null), external = ref<ExternalStatus | null>(null), error = ref(''), notice = ref(''), busy = ref(false), copied = ref(false);
const linkSound = ref(false);
// Native display handles are keyed by the original choice object; never proxy it.
const displays = shallowRef<ConnectedDisplay[]>([]), displaysRead = ref(false), displayMessage = ref('Find connected monitors and projectors, or open a window and move it yourself.');
let stopDisplays: (() => void) | undefined, copyTimer: ReturnType<typeof setTimeout> | undefined, disposed = false;
const preferences = ref<Record<string, DisplayPreference>>((() => {
  try {
    const value = JSON.parse(localStorage.getItem('lumen.output.displays') || '{}');
    return Object.fromEntries(Object.entries(value).filter(([id, item]) => /^[a-zA-Z0-9_-]{1,80}$/.test(id) && !!item && typeof item === 'object'
      && typeof (item as DisplayPreference).label === 'string' && (item as DisplayPreference).label.length <= 120
      && Number.isFinite((item as DisplayPreference).width) && Number.isFinite((item as DisplayPreference).height))) as Record<string, DisplayPreference>;
  } catch { return {}; }
})());
const output = computed(() => props.outputs.find(item => item.id === outputId.value));
const name = computed(() => outputId.value === 'program' ? 'Program' : output.value?.name || 'Output');
const link = computed(() => delivery.value?.links.find(item => item.outputId === outputId.value));
const shareUrl = computed(() => {
  const value = tab.value === 'external' ? external.value?.url : tab.value === 'network' ? link.value?.networkUrl : link.value?.localUrl || link.value?.url;
  if (!value || !linkSound.value) return value;
  const url = new URL(value), fragment = new URLSearchParams(url.hash.slice(1)); fragment.set('audio', '1'); url.hash = fragment.toString(); return url.href;
});
const chosenDisplay = computed(() => {
  const saved = preferences.value[outputId.value];
  return assignedDisplay(displays.value, saved);
});
const hasPicture = computed(() => outputId.value === 'program' || output.value?.mode === 'program' ? !!studio.state?.program : !!output.value?.scene);
function displayCaption(id: string) { const saved = preferences.value[id]; return saved ? saved.label : 'No display assigned'; }
async function action(work: () => Promise<void>) {
  if (busy.value || !canAct()) return;
  busy.value = true; error.value = ''; notice.value = ''; copied.value = false;
  try { await work(); } catch (cause) { if (canAct()) error.value = cause instanceof Error ? cause.message : 'Output setup could not be completed.'; }
  finally { busy.value = false; }
}
async function setup(id: string, area: typeof tab.value) {
  if (!canAct() || id !== 'program' && !props.outputs.some(item => item.id === id)) return;
  outputId.value = id; tab.value = area; open.value = true; error.value = ''; notice.value = ''; copied.value = false; linkSound.value = false;
  await action(async () => {
    const [nextDelivery, nextExternal] = await Promise.all([studioRequest<DeliveryStatus>('/output-delivery'), studioRequest<ExternalStatus>('/output-delivery/external')]);
    if (!canAct()) return;
    delivery.value = nextDelivery; external.value = nextExternal;
    if (nativeDisplays) await findDisplays();
  });
}
async function findDisplays() {
  if (!canAct()) return;
  error.value = ''; const result = await listDisplays();
  if (!canAct()) return;
  stopDisplays?.(); displays.value = result.displays; displaysRead.value = true; displayMessage.value = result.message;
  stopDisplays = result.subscribe(items => { displays.value = items; });
}
function chooseDisplay(event: Event) {
  if (!canAct()) return;
  const selected = displays.value.find(item => item.id === (event.target as HTMLSelectElement).value);
  const next = { ...preferences.value };
  if (selected) next[outputId.value] = { ...(nativeDisplays ? { id: selected.id } : {}), label: selected.label, width: selected.width, height: selected.height }; else delete next[outputId.value];
  preferences.value = next;
  try { localStorage.setItem('lumen.output.displays', JSON.stringify(next)); } catch { /* Optional device-local preference. */ }
  outputsUi.changed();
}
async function startEngine() {
  if (!canAct()) return;
  if (studio.status.state !== 'running') {
    const next = await studioApi.start();
    if (canAct()) studio.status = next;
  }
}
async function openDisplay(id = outputId.value) {
  if (!canAct() || busy.value) return;
  const destination = props.outputs.find(item => item.id === id);
  if (id !== 'program' && !destination) { error.value = 'This output has been removed.'; return; }
  if ((id === 'program' || destination?.mode === 'program') && !studio.state?.program) {
    error.value = 'Send a presentation to Program, or take a scene in Studio before opening this output.'; return;
  }
  const saved = preferences.value[id];
  if (nativeDisplays) {
    await action(async () => {
      const current = await nativeDisplays.list();
      if (!canAct()) return;
      displays.value = current; displaysRead.value = true;
      const selected = assignedDisplay(current, saved);
      if (saved && !selected) throw new Error('That display is disconnected or ambiguous. Find displays again or choose Manual window.');
      await startEngine();
      if (!canAct()) return;
      const result = await nativeDisplays.open({ outputId: id, displayId: selected?.id ?? null });
      if (result.status !== 'opened') throw new Error(result.message);
      notice.value = result.message;
    });
    return;
  }
  const selected = assignedDisplay(displays.value, saved);
  if (saved && displaysRead.value && !selected) { error.value = 'That display is disconnected. Find displays again or choose Manual window.'; return; }
  const result = openDisplayOutput(`/studio/output/${encodeURIComponent(id)}?display=1`, selected ?? null, { windowName: `lumen-output-${id}` });
  if (result.status === 'opened') {
    // Open synchronously while the click still carries browser user activation.
    // The output waits for the renderer to become ready in its own window.
    await action(async () => { await startEngine(); notice.value = result.message; });
  } else { error.value = result.message; notice.value = ''; }
}
async function createLink() { await action(async () => { delivery.value = await studioRequest('/output-delivery/links', { method: 'POST', body: JSON.stringify({ outputId: outputId.value }) }); outputsUi.changed(); }); }
async function network(host: string) {
  if (host !== '127.0.0.1' && !await confirmAction({ title: 'Allow output viewers on this network?', description: 'Only the separate, view-only output listener will be available. Anyone with a link can see its picture and enabled audio. Studio controls and saved keys stay private.', confirmLabel: 'Enable network output', details: [host], note: 'Use a trusted church network. Do not forward this port or expose it through a public tunnel.' })) return;
  await action(async () => { delivery.value = await studioRequest('/output-delivery/network', { method: 'POST', body: JSON.stringify({ host }) }); });
}
async function revoke() {
  if (!await confirmAction({ title: 'Revoke this output link?', description: 'Current link viewers will disconnect. Creating a new link will give it a different key; your output routing and Main audio will not change.', confirmLabel: 'Revoke link', tone: 'danger' })) return;
  await action(async () => { delivery.value = await studioRequest(`/output-delivery/links/${encodeURIComponent(outputId.value)}`, { method: 'DELETE' }); outputsUi.changed(); });
}
async function verifyExternal() { await action(async () => { external.value = await studioRequest('/output-delivery/external/verify', { method: 'POST', body: '{}' }); }); }
async function copyLink() {
  if (!canAct()) return;
  const value = shareUrl.value; if (!value) return;
  try { await navigator.clipboard.writeText(value); copied.value = true; clearTimeout(copyTimer); copyTimer = setTimeout(() => { copied.value = false; }, 2000); }
  catch { error.value = 'Clipboard access is unavailable. Select and copy the link below.'; }
}
function reset() { open.value = false; error.value = ''; notice.value = ''; copied.value = false; }
async function focusOutput(id: string) {
  reset(); await nextTick();
  const card = root.value?.querySelector<HTMLElement>(`[data-output-id="${CSS.escape(id)}"]`);
  card?.scrollIntoView({ block: 'nearest' }); card?.querySelector<HTMLElement>('input, button')?.focus({ preventScroll: true });
}
onBeforeUnmount(() => { disposed = true; stopDisplays?.(); clearTimeout(copyTimer); });
defineExpose({ setup, reset, focusOutput });
</script>

<template>
  <div ref="root" class="shared-output-content">
  <section v-if="!open" class="outputs-panel" aria-label="Output configuration">
    <div class="program-output-card" data-output-id="program"><div><span class="output-section-label">PROGRAM</span><h3>{{ programName || 'No Program selected' }}</h3><p>The current Program picture and Main audio.</p></div><div class="program-output-actions"><button class="s-button" aria-label="Set up Program screen" :disabled="!canOperate" @click="setup('program', 'display')"><Monitor :size="14" />Screen</button><button class="s-button" aria-label="Open Lumen Share" :disabled="!canOperate" @click="setup('program', 'computer')"><Link2 :size="14" />Lumen Share</button></div></div>
    <div class="outputs-heading"><div><h2>Additional destinations <small class="panel-count">{{ outputs.length }}</small></h2><p>Follow Program, or pin a scene for a separate screen.</p></div><div class="output-heading-actions"><button class="s-button" aria-label="Add output" :disabled="!canOperate || outputs.length >= 6" @click="emit('add')"><Plus :size="13" />Add output</button></div></div>
    <div class="output-cards">
      <article v-for="item in outputs" :key="item.id" class="output-card" :data-output-id="item.id">
        <div class="output-card-heading"><span class="output-signal" :class="{ blanked: item.blanked }" :title="item.blanked ? 'Picture blanked' : 'Picture enabled'" /><StudioPropertyInput :value="item.name" :identity="item.id" :pending="pending" :disabled="!canOperate" :aria-label="'Output name ' + item.id" trim nonempty maxlength="100" @commit="emit('rename', item.id, $event)" /><button class="s-icon" :disabled="!canOperate || busy" :aria-label="'Open ' + item.name" title="Open output window" @click="openDisplay(item.id)"><ArrowUpRight :size="15" /></button></div>
        <select :aria-label="item.name + ' route'" :disabled="!canOperate" :value="item.mode === 'program' ? '' : item.scene?.id" @change="emit('route', item.id, ($event.target as HTMLSelectElement).value || null)"><option value="">Follow Program</option><option v-for="scene in scenes" :key="scene.id" :value="scene.id">Pin: {{ scene.name }}</option><option v-if="item.scene && !scenes.some(scene => scene.id === item.scene?.id)" :value="item.scene.id">{{ item.scene.name }} (snapshot)</option></select>
        <div class="output-destination"><Monitor :size="12" /><span>{{ displayCaption(item.id) }}</span><button :disabled="!canOperate" :aria-label="'Set up ' + item.name + ' display'" @click="setup(item.id, 'display')">Set up</button><button :disabled="!canOperate" :aria-label="'Share ' + item.name + ' link'" title="Output links" @click="setup(item.id, 'computer')"><Link2 :size="13" /></button></div>
        <div class="output-card-bottom"><button :class="{ enabled: !item.blanked }" :disabled="!canOperate" @click="emit('blank', item.id, !item.blanked)"><EyeOff v-if="item.blanked" :size="12" /><Eye v-else :size="12" />{{ item.blanked ? 'Blanked' : 'Picture on' }}</button><button :class="{ enabled: item.audioEnabled }" :disabled="!canOperate" :aria-label="(item.audioEnabled ? 'Mute ' : 'Enable ') + item.name + ' audio'" @click="emit('audio', item.id)"><Volume2 v-if="item.audioEnabled" :size="12" /><VolumeX v-else :size="12" /></button><button v-if="item.mode === 'scene'" :disabled="!canOperate" :aria-label="'Refresh ' + item.name + ' from draft'" title="Apply latest draft to this output" @click="emit('refresh', item.id)"><RotateCcw :size="11" /></button><button v-if="outputs.length > 1" :disabled="!canOperate" :aria-label="'Remove ' + item.name" title="Remove output" @click="emit('remove', item.id)"><Trash2 :size="11" /></button></div>
      </article>
    </div>
    <p v-if="!open && error" class="output-setup-feedback error output-inline-feedback" role="alert"><AlertCircle :size="14" />{{ error }}</p><p v-if="!open && notice" class="output-setup-feedback output-inline-feedback" role="status"><Check :size="14" />{{ notice }}</p>
    <StudioVirtualDevices :can-operate="canOperate" />
  </section>
    <section v-else class="output-setup-dialog" aria-label="Output setup"><div class="output-setup-navigation"><button class="output-back" type="button" @click="reset"><ArrowLeft :size="14" />All outputs</button><h3>{{ name }} output</h3></div><p class="output-setup-description">{{ outputId === 'program' ? 'The current Program picture and Main audio on a screen or a view-only link.' : 'This destination’s assigned picture and audio on a screen or a view-only link.' }}</p>
      <div class="output-destination-tabs" role="tablist" aria-label="Output destination"><button v-for="area in [{ id: 'display', label: 'Display', icon: Monitor }, { id: 'computer', label: 'This computer', icon: Laptop }, { id: 'network', label: 'Local network', icon: Network }, { id: 'external', label: 'External', icon: Globe }]" :key="area.id" role="tab" :aria-selected="tab === area.id" @click="tab = area.id as typeof tab; error = ''; notice = ''; copied = false"><component :is="area.icon" :size="14" /><span>{{ area.label }}</span></button></div>
      <div v-if="tab === 'display'" class="output-setup-body">
        <div class="output-setup-title"><div><h3>Monitor or projector</h3><p>Display choices are saved only on this computer.</p></div><button class="s-button" :disabled="busy" @click="findDisplays"><RefreshCw :size="13" />{{ displaysRead ? 'Refresh displays' : 'Find displays' }}</button></div>
        <label class="output-setup-field">Connected display<select :value="chosenDisplay?.id || ''" @change="chooseDisplay"><option value="">Manual window</option><option v-for="display in displays" :key="display.id" :value="display.id">{{ display.label }} · {{ display.width }} × {{ display.height }}{{ display.isCurrent ? ' · Current' : '' }}</option></select></label>
        <p class="output-setup-hint">{{ displayMessage }}</p><button class="s-button primary" :disabled="busy" @click="openDisplay()"><ArrowUpRight :size="14" />Open output</button><p class="output-setup-hint">{{ nativeDisplays ? 'Assigned screens open fullscreen. Esc exits; F toggles fullscreen.' : 'Use Fullscreen or press F in the output window.' }} Sound starts muted to avoid feedback.</p>
      </div>
      <div v-else-if="tab === 'computer' || tab === 'network'" class="output-setup-body">
        <h3>{{ tab === 'computer' ? 'Clean link for OBS or a browser' : 'Share on your church network' }}</h3>
        <p>{{ tab === 'computer' ? 'Add this URL as an OBS Browser Source, or open it on this computer. No Studio interface or controls are included.' : 'View on another device connected to the same trusted network. Keep the Studio backend private.' }}</p>
        <div v-if="studio.status.state !== 'running'" class="output-engine-readiness"><span>{{ hasPicture ? 'The engine is stopped. Start it to send a picture to your viewers.' : 'Choose a Program picture in Presentation or Studio before sharing.' }}</span><button v-if="hasPicture" class="s-button" aria-label="Start engine for outputs" :disabled="busy || studio.engineBusy || studio.status.state === 'starting'" @click="action(startEngine)">{{ studio.status.state === 'starting' ? 'Starting…' : 'Start engine' }}</button></div>
        <div v-if="tab === 'network'" class="output-network-choice"><label class="output-setup-field">Network interface<select :value="delivery?.host || '127.0.0.1'" :disabled="busy || !delivery" @change="network(($event.target as HTMLSelectElement).value)"><option value="127.0.0.1">Off · this computer only</option><option v-for="item in delivery?.interfaces || []" :key="item.address" :value="item.address">{{ item.label }}</option></select></label><p v-if="delivery && !delivery.interfaces.length" class="output-setup-hint">No supported local-network address found. Connect Wi-Fi or Ethernet, then reopen setup.</p></div>
        <div v-if="shareUrl" class="output-share-field" data-team-private><label :for="'output-link-' + tab">View-only link</label><div><input :id="'output-link-' + tab" :value="shareUrl" readonly spellcheck="false" @focus="($event.target as HTMLInputElement).select()" /><button class="s-button" @click="copyLink"><Check v-if="copied" :size="14" /><Copy v-else :size="14" />{{ copied ? 'Copied' : 'Copy' }}</button></div></div>
        <div v-else class="output-create-link"><button class="s-button primary" :disabled="busy || (tab === 'network' && (!delivery || delivery.host === '127.0.0.1'))" @click="createLink"><Link2 :size="14" />Create {{ tab === 'network' ? 'network' : 'output' }} link</button></div>
        <div v-if="link" class="output-link-actions"><span>{{ link.viewers }} viewing · up to {{ delivery?.perLinkLimit }} per link</span><button class="output-revoke" :disabled="busy" @click="revoke">Revoke link</button></div>
        <label v-if="shareUrl" class="output-sound-choice"><input v-model="linkSound" type="checkbox" :disabled="outputId !== 'program' && !output?.audioEnabled" />Request sound in this viewer <small v-if="outputId !== 'program' && !output?.audioEnabled">Output audio is muted</small></label>
        <p class="output-setup-hint"><ShieldCheck :size="13" />Anyone with this link can view its output. Revoking disconnects existing viewers. Audio remains under your output’s control; playback starts muted.</p>
      </div>
      <div v-else class="output-setup-body">
        <h3>Secure external Program link</h3><p>Share Program through your HTTPS relay, without exposing this station. It carries the Program picture and Main audio—not a pinned screen’s picture or per-output mute.</p>
        <div class="output-external-state"><ShieldCheck :size="18" /><div><b>{{ external?.verified ? 'Private relay verified' : external?.configured ? 'Check your private relay' : 'Relay setup required' }}</b><p>{{ external?.message || 'Configure the private output relay on your server first. Nothing is published automatically.' }}</p></div></div>
        <button v-if="external?.configured" class="s-button" :disabled="busy" @click="verifyExternal"><RefreshCw :size="13" />{{ external.verified ? 'Check again' : 'Verify relay' }}</button>
        <div v-if="shareUrl" class="output-share-field" data-team-private><label for="output-external-link">Private Program link</label><div><input id="output-external-link" :value="shareUrl" readonly spellcheck="false" @focus="($event.target as HTMLInputElement).select()" /><button class="s-button" @click="copyLink"><Check v-if="copied" :size="14" /><Copy v-else :size="14" />{{ copied ? 'Copied' : 'Copy' }}</button></div></div>
        <label v-if="shareUrl" class="output-sound-choice"><input v-model="linkSound" type="checkbox" />Request sound in this viewer</label>
        <p class="output-setup-hint">Start sending through Go Live with Lumen Watch enabled. This never enables Facebook, YouTube or recording for you. Rotate the relay’s viewer key to revoke external links.</p>
      </div>
      <p v-if="error" class="output-setup-feedback error" role="alert"><AlertCircle :size="14" />{{ error }}</p><p v-if="notice" class="output-setup-feedback" role="status"><Check :size="14" />{{ notice }}</p>
    </section>
  </div>
</template>

<style scoped>
.shared-output-content{min-width:0;color:var(--text-primary)}
.shared-output-content .outputs-panel{margin:0;padding:0;border:0}
.program-output-card{display:flex;justify-content:space-between;align-items:center;gap:20px;padding:18px;margin-bottom:24px;background:var(--surface-2);border:1px solid var(--border-hair);border-radius:10px}.program-output-card>div:first-child{min-width:0}.output-section-label{font-size:10px;letter-spacing:1px;color:var(--text-muted)}.program-output-card h3{font-size:15px;font-weight:500;overflow-wrap:anywhere;margin:5px 0}.program-output-card p{font-size:11px;color:var(--text-muted);line-height:1.6}.program-output-actions{display:flex;gap:8px;flex-shrink:0}
.shared-output-content .s-button,.shared-output-content :deep(.virtual-devices .s-button){display:inline-flex;align-items:center;justify-content:center;gap:7px;min-height:34px;padding:7px 10px;border:1px solid var(--border-hair);border-radius:7px;background:var(--surface-2);color:var(--text-primary);font-size:12px;white-space:nowrap}.shared-output-content .s-button:hover:not(:disabled){background:var(--bg-hover)}.shared-output-content button:disabled{opacity:.45;cursor:not-allowed}.shared-output-content .s-icon{display:inline-flex;align-items:center;justify-content:center;flex-shrink:0;width:30px;height:30px;border-radius:6px;color:var(--text-muted);background:transparent;border:0}.shared-output-content .s-icon:hover:not(:disabled){background:var(--bg-hover);color:var(--text-primary)}
.shared-output-content .outputs-heading{display:flex;justify-content:space-between;align-items:center;gap:16px;margin-bottom:12px}.shared-output-content .outputs-heading h2{display:flex;gap:8px;align-items:center;font-size:12px;font-weight:500;color:var(--text-primary)}.shared-output-content .panel-count{color:var(--text-muted);font-size:11px;font-weight:400}.shared-output-content .outputs-heading p{font-size:11px;line-height:1.6;color:var(--text-muted);margin-top:5px}
.shared-output-content .output-cards{display:grid;grid-template-columns:repeat(auto-fit,minmax(min(240px,100%),1fr));gap:12px}.shared-output-content .output-card{padding:12px;border:1px solid var(--border-hair);border-radius:8px;background:var(--surface-1);min-width:0}.shared-output-content .output-card-heading{display:flex;align-items:center;gap:7px;margin-bottom:9px}.shared-output-content .output-card-heading>input{min-width:0;flex:1;color:var(--text-primary);font-size:12px;background:transparent;border:0;padding:5px 0}.output-signal{width:5px;height:5px;flex-shrink:0;border-radius:50%;background:#9bba8e}.output-signal.blanked{background:var(--text-muted)}.shared-output-content .output-card>select{display:block;width:100%;padding:8px;background:var(--surface-2);border:1px solid var(--border-hair);border-radius:6px;color:var(--text-primary);font-size:11px}.shared-output-content .output-card-bottom{display:flex;align-items:center;gap:9px;margin-top:9px}.shared-output-content .output-card-bottom button{display:inline-flex;align-items:center;justify-content:center;gap:5px;min-height:28px;font-size:11px;color:var(--text-muted)}.shared-output-content .output-card-bottom button:first-child{margin-right:auto}.shared-output-content .output-card-bottom button.enabled{color:#a3ceb7}.shared-output-content .output-card-bottom button:not(:first-child){width:28px;border-radius:5px}.shared-output-content .output-card-bottom button:hover:not(:disabled){background:var(--bg-hover)}
.output-setup-navigation{display:flex;align-items:center;gap:16px;padding-bottom:12px}.output-setup-navigation h3{font-size:14px;font-weight:500;color:var(--text-primary)}.output-back{display:inline-flex;align-items:center;gap:7px;color:var(--text-muted);font-size:12px;padding:4px 0}.output-back:hover{color:var(--text-primary)}.output-setup-description{color:var(--text-muted);font-size:12px;line-height:1.6;margin-bottom:18px}.output-setup-dialog .output-setup-body{padding-top:20px}.shared-output-content button:focus-visible,.shared-output-content input:focus-visible,.shared-output-content select:focus-visible{outline:2px solid var(--accent);outline-offset:2px}
.output-engine-readiness{display:flex;align-items:center;justify-content:space-between;gap:14px;padding:12px;border:1px solid var(--border-hair);border-radius:7px;background:var(--surface-2);font-size:12px;color:var(--text-muted);line-height:1.6}.output-engine-readiness>span{flex:1}.output-engine-readiness .s-button{align-self:center;flex-shrink:0}
@media(max-width:560px){.program-output-card{align-items:flex-start;flex-direction:column;gap:12px;padding:15px}.program-output-actions{width:100%;flex-wrap:wrap}.shared-output-content .outputs-heading{align-items:flex-start}.output-setup-navigation{gap:12px}.output-setup-navigation h3{font-size:13px}}
@media(pointer:coarse){.shared-output-content .s-button,.shared-output-content .s-icon,.shared-output-content .output-card-bottom button,.output-back{min-height:40px}.shared-output-content .output-card-bottom button:not(:first-child){width:36px}}
.output-setup-dialog .s-button{display:inline-flex;align-items:center;justify-content:center;gap:7px;padding:7px 10px;min-height:32px;border:1px solid var(--border-hair);border-radius:var(--radius-control,7px);background:var(--surface-2);color:var(--text-primary);font-size:12px}
.output-setup-dialog .s-button.primary{background:var(--accent);color:#11222c;border-color:var(--accent)}
.output-setup-dialog .s-button:disabled{opacity:.45;cursor:not-allowed}
.output-setup-dialog input:not([type=checkbox]),.output-setup-dialog select{min-width:0;min-height:34px;padding:7px 9px;background:var(--surface-2);color:var(--text-primary);border:1px solid var(--border-hair);border-radius:6px}

.output-inline-feedback{padding-top:10px}
.output-heading-actions{display:flex;gap:7px}.output-heading-actions .s-button{min-height:30px;font-size:11px;padding:5px 9px}.output-destination{display:flex;align-items:center;gap:6px;margin-top:10px;padding:7px 0;border-bottom:1px solid var(--border-hair);color:var(--text-muted);font-size:10px}.output-destination>span{flex:1;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}.output-destination button{padding:3px;color:var(--accent,#7dd3fc)}
.output-sound-choice{display:flex;align-items:center;gap:8px;font-size:12px;color:var(--text-primary)}.output-sound-choice input{accent-color:var(--accent,#7dd3fc)}.output-sound-choice small{color:var(--text-muted);font-size:10px}
.output-setup-dialog{background:var(--surface-1,#18191c);border-color:var(--border-hair);gap:18px}.output-destination-tabs{display:grid;grid-template-columns:repeat(4,minmax(0,1fr));gap:3px;border-bottom:1px solid var(--border-hair);padding-bottom:9px}.output-destination-tabs>button{display:flex;gap:6px;align-items:center;justify-content:center;padding:8px 5px;font-size:11px;color:var(--text-muted);border-radius:5px}.output-destination-tabs>button[aria-selected=true]{background:var(--surface-3,#25272b);color:var(--text-primary)}.output-setup-body{display:flex;flex-direction:column;gap:15px;min-width:0}.output-setup-body h3{font-size:14px;font-weight:550;color:var(--text-primary)}.output-setup-body>p,.output-setup-title p{font-size:12px;line-height:1.65;color:var(--text-muted)}.output-setup-title{display:flex;gap:12px;justify-content:space-between;align-items:center}.output-setup-title h3{margin-bottom:3px}.output-setup-body .s-button{align-self:flex-start;min-height:34px;padding:7px 10px;font-size:12px;display:inline-flex;align-items:center;gap:6px;border:1px solid var(--border-hair);border-radius:6px;color:var(--text-primary);background:var(--surface-2,#202226)}.output-setup-body .s-button.primary{background:var(--accent,#7dd3fc);color:#14232b;border-color:transparent}.output-setup-body button:disabled{opacity:.45;cursor:not-allowed}.output-setup-field{display:flex;flex-direction:column;gap:7px;font-size:11px;color:var(--text-muted)}.output-setup-field select,.output-share-field input{width:100%;min-width:0;border:1px solid var(--border-hair);border-radius:6px;padding:10px;background:var(--surface-2,#202226);color:var(--text-primary);font-size:12px}.output-share-field{display:flex;flex-direction:column;gap:7px;min-width:0}.output-share-field>label{font-size:11px;color:var(--text-muted)}.output-share-field>div{display:flex;gap:7px;min-width:0}.output-share-field input{flex:1;font-family:ui-monospace,monospace;font-size:11px}.output-share-field .s-button{align-self:stretch;flex-shrink:0}.output-link-actions{display:flex;align-items:center;justify-content:space-between;font-size:11px;color:var(--text-muted)}.output-revoke{color:var(--text-muted);text-decoration:underline;text-underline-offset:3px}.output-setup-hint{font-size:11px!important;color:var(--text-muted);line-height:1.65;display:flex;align-items:flex-start;gap:6px}.output-setup-hint svg{flex-shrink:0;margin-top:3px}.output-setup-feedback{display:flex;align-items:flex-start;gap:7px;font-size:12px;color:#a3ceb7;line-height:1.6}.output-setup-feedback.error{color:#e5a598}.output-setup-feedback svg{flex-shrink:0;margin-top:3px}.output-external-state{display:flex;gap:10px;align-items:flex-start;border:1px solid var(--border-hair);border-radius:7px;padding:14px;color:var(--text-muted)}.output-external-state svg{flex-shrink:0;margin-top:2px}.output-external-state b{font-size:12px;color:var(--text-primary);font-weight:500}.output-external-state p{font-size:11px;line-height:1.65;margin-top:4px}.output-setup-dialog button:focus-visible,.output-setup-dialog select:focus-visible,.output-setup-dialog input:focus-visible{outline:2px solid var(--accent,#7dd3fc);outline-offset:2px}
@media(max-width:560px){.outputs-heading{align-items:flex-start}.output-heading-actions{flex-direction:column}.output-destination-tabs>button{flex-direction:column;font-size:10px}.output-setup-title{align-items:flex-start;flex-direction:column}.output-share-field>div{flex-wrap:wrap}.output-share-field input{flex-basis:100%}}
</style>
