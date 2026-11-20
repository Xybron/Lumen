<script setup lang="ts">
import { computed, nextTick, onBeforeUnmount, ref, shallowRef, useId } from 'vue';
import { Monitor, Plus, ArrowLeft, ArrowUpRight, Eye, EyeOff, Volume2, VolumeX, RotateCcw, Trash2, Link2, Copy, Check, ShieldCheck, RefreshCw, AlertCircle, MoreHorizontal, ChevronRight, Pencil } from 'lucide-vue-next';
import StudioPropertyInput from './StudioPropertyInput.vue';
import { studioApi, studioRequest } from '@/lib/studio/api';
import { useStudioStore } from '@/stores/studio';
import { useOutputsStore } from '@/stores/outputs';
import { useIdentityStore } from '@/stores/identity';
import { listDisplays, openDisplayOutput, desktopDisplays, assignedDisplay, type DisplayPreference, type ConnectedDisplay } from '@/lib/studio/display-outputs';
import { DropdownMenu, DropdownMenuTrigger, DropdownMenuContent, DropdownMenuItem } from '@/components/ui/dropdown-menu';
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
const linkSound = ref(false), shareArea = ref<'computer' | 'network' | 'external'>('computer');
const setupId = useId();
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
  outputId.value = id; tab.value = area; shareArea.value = area === 'display' ? 'computer' : area; open.value = true; error.value = ''; notice.value = ''; copied.value = false; linkSound.value = false;
  await action(async () => {
    const [nextDelivery, nextExternal] = await Promise.all([studioRequest<DeliveryStatus>('/output-delivery'), studioRequest<ExternalStatus>('/output-delivery/external')]);
    if (!canAct()) return;
    delivery.value = nextDelivery; external.value = nextExternal;
    if (nativeDisplays && area === 'display') await findDisplays();
  });
}
async function selectTab(area: typeof tab.value) {
  if (busy.value || !canAct()) return;
  tab.value = area; if (area !== 'display') shareArea.value = area;
  error.value = ''; notice.value = ''; copied.value = false;
  if (area === 'display' && nativeDisplays && !displaysRead.value) await action(findDisplays);
}
function destinationKey(event: KeyboardEvent) {
  if (busy.value || !['ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(event.key)) return;
  event.preventDefault();
  const screen = event.key === 'Home' || (event.key !== 'End' && tab.value !== 'display');
  void selectTab(screen ? 'display' : shareArea.value).then(() => nextTick(() => {
    if (open.value && canAct()) document.getElementById(setupId + (screen ? '-screen' : '-share'))?.focus();
  }));
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
    <div class="program-output-card" data-output-id="program">
      <div class="program-output-identity"><span class="program-output-icon"><Monitor :size="20" /></span><div><span class="output-section-label">Program</span><h3>{{ programName || 'No Program selected' }}</h3><p>Current picture · Main audio</p></div></div>
      <div class="program-output-actions"><button class="s-button" aria-label="Set up Program screen" :disabled="!canOperate" @click="setup('program', 'display')"><Monitor :size="14" />Screen</button><button class="s-button" aria-label="Open Lumen Share" :disabled="!canOperate" @click="setup('program', 'computer')"><Link2 :size="14" />Share</button></div>
    </div>
    <div class="outputs-heading"><div><h2>Screens <small class="panel-count">{{ outputs.length }} / 6</small></h2><p>Choose what each screen shows.</p></div><button class="s-button" aria-label="Add output" :disabled="!canOperate || pending || outputs.length >= 6" @click="emit('add')"><Plus :size="14" />Add output</button></div>
    <div class="output-list">
      <article v-for="item in outputs" :key="item.id" class="output-row" :data-output-id="item.id" :aria-label="item.name + ' output'">
        <div class="output-row-identity">
          <div class="output-name"><StudioPropertyInput :value="item.name" :identity="item.id" :pending="pending" :disabled="!canOperate" :aria-label="'Output name ' + item.id" title="Rename output" trim nonempty maxlength="100" @commit="emit('rename', item.id, $event)" /><Pencil :size="12" aria-hidden="true" /></div>
          <button class="output-display-choice" :disabled="!canOperate || busy" :aria-label="'Set up ' + item.name + ' display'" @click="setup(item.id, 'display')"><Monitor :size="12" /><span>{{ displayCaption(item.id) }}</span><ChevronRight :size="12" /></button>
        </div>
        <div class="output-row-actions">
          <button class="s-button" :disabled="!canOperate || busy" :aria-label="'Open ' + item.name" @click="openDisplay(item.id)"><ArrowUpRight :size="14" />Open</button>
          <button class="s-button" :disabled="!canOperate || busy" :aria-label="'Share ' + item.name + ' link'" @click="setup(item.id, 'computer')"><Link2 :size="14" />Share</button>
          <DropdownMenu v-if="item.mode === 'scene' || outputs.length > 1">
            <DropdownMenuTrigger as-child><button class="s-icon" :disabled="!canOperate || pending" :aria-label="'More options for ' + item.name"><MoreHorizontal :size="17" /></button></DropdownMenuTrigger>
            <DropdownMenuContent align="end">
              <DropdownMenuItem v-if="item.mode === 'scene'" :disabled="!canOperate || pending" :aria-label="'Refresh ' + item.name + ' from draft'" @select="emit('refresh', item.id)"><RotateCcw :size="14" />Update from scene</DropdownMenuItem>
              <DropdownMenuItem v-if="outputs.length > 1" :disabled="!canOperate || pending" variant="destructive" :aria-label="'Remove ' + item.name" @select="emit('remove', item.id)"><Trash2 :size="14" />Remove output</DropdownMenuItem>
            </DropdownMenuContent>
          </DropdownMenu>
        </div>
        <label class="output-route"><span>Content</span><select :aria-label="item.name + ' route'" :disabled="!canOperate || pending" :value="item.mode === 'program' ? '' : item.scene?.id" @change="emit('route', item.id, ($event.target as HTMLSelectElement).value || null)"><option value="">Follow Program</option><option v-for="scene in scenes" :key="scene.id" :value="scene.id">Pin: {{ scene.name }}</option><option v-if="item.scene && !scenes.some(scene => scene.id === item.scene?.id)" :value="item.scene.id">{{ item.scene.name }} (snapshot)</option></select></label>
        <div class="output-row-toggles">
          <button class="s-button output-toggle" :aria-pressed="!item.blanked" :aria-label="(item.blanked ? 'Show ' : 'Blank ') + item.name + ' picture'" :disabled="!canOperate || pending" @click="emit('blank', item.id, !item.blanked)"><EyeOff v-if="item.blanked" :size="14" /><Eye v-else :size="14" />{{ item.blanked ? 'Picture off' : 'Picture on' }}</button>
          <button class="s-button output-toggle" :aria-pressed="item.audioEnabled" :disabled="!canOperate || pending" :aria-label="(item.audioEnabled ? 'Mute ' : 'Enable ') + item.name + ' audio'" @click="emit('audio', item.id)"><Volume2 v-if="item.audioEnabled" :size="14" /><VolumeX v-else :size="14" />{{ item.audioEnabled ? 'Audio on' : 'Audio off' }}</button>
        </div>
      </article>
    </div>
    <p v-if="!open && error" class="output-setup-feedback error output-inline-feedback" role="alert"><AlertCircle :size="14" />{{ error }}</p><p v-if="!open && notice" class="output-setup-feedback output-inline-feedback" role="status"><Check :size="14" />{{ notice }}</p>
  </section>
    <section v-else class="output-setup-dialog" aria-label="Output setup">
      <div class="output-setup-navigation"><button class="output-back" type="button" @click="reset"><ArrowLeft :size="14" />All outputs</button><ChevronRight :size="13" aria-hidden="true" /><h3>{{ name }} output</h3></div>
      <div class="output-destination-tabs" role="tablist" aria-label="Output destination" @keydown="destinationKey">
        <button :id="setupId + '-screen'" role="tab" :aria-selected="tab === 'display'" :aria-controls="setupId + '-panel'" :tabindex="tab === 'display' ? 0 : -1" :disabled="busy" @click="selectTab('display')"><Monitor :size="14" />Screen</button>
        <button :id="setupId + '-share'" role="tab" :aria-selected="tab !== 'display'" :aria-controls="setupId + '-panel'" :tabindex="tab !== 'display' ? 0 : -1" :disabled="busy" @click="selectTab(shareArea)"><Link2 :size="14" />Share</button>
      </div>
      <div :id="setupId + '-panel'" role="tabpanel" :aria-labelledby="setupId + (tab === 'display' ? '-screen' : '-share')" class="output-setup-body">
        <template v-if="tab === 'display'">
          <div class="output-setup-card">
            <div class="output-setup-title"><div><h3>Choose a screen</h3><p>A monitor, projector, or movable window.</p></div><button class="s-button" :disabled="busy" @click="action(findDisplays)"><RefreshCw :size="13" />{{ displaysRead ? 'Refresh displays' : 'Find displays' }}</button></div>
            <label class="output-setup-field">Connected display<select :value="chosenDisplay?.id || ''" :disabled="busy" @change="chooseDisplay"><option value="">Manual window</option><option v-for="display in displays" :key="display.id" :value="display.id">{{ display.label }} · {{ display.width }} × {{ display.height }}{{ display.isCurrent ? ' · Current' : '' }}</option></select></label>
            <p v-if="displaysRead && !displays.length" class="output-setup-hint" role="status">{{ displayMessage }}</p>
            <p v-else class="output-setup-hint">{{ chosenDisplay ? 'Saved for this output on this computer.' : 'Open a window and move it to your screen.' }}</p>
          </div>
          <p v-if="!hasPicture" class="output-setup-hint" role="status">Choose content in Studio or send it to Program first.</p>
          <div class="output-primary-action"><span>Sound starts muted.</span><button class="s-button primary" :disabled="busy || !hasPicture" @click="openDisplay()"><ArrowUpRight :size="14" />Open output</button></div>
          <details class="output-details"><summary>Screen tips</summary><p>{{ nativeDisplays ? 'Assigned screens open fullscreen. Esc exits; F toggles fullscreen.' : 'Press F or use Fullscreen in the output window.' }} Opening an output starts the engine if needed.</p><p>Display choices stay on this computer. If a saved screen is disconnected, reconnect it or choose Manual window.</p></details>
        </template>
        <template v-else>
          <div class="output-setup-card">
            <label class="output-setup-field">Share to<select aria-label="Sharing destination" :value="tab" :disabled="busy" @change="selectTab(($event.target as HTMLSelectElement).value as typeof shareArea)"><option value="computer">This computer · OBS or browser</option><option value="network">Local network · another device</option><option value="external">External · Program only</option></select></label>
            <p class="output-setup-hint">{{ tab === 'computer' ? 'Use this link in OBS or a browser on this computer.' : tab === 'network' ? 'For devices on the same trusted Wi-Fi or Ethernet network.' : 'External sharing always sends Program and Main audio.' }}</p>
            <template v-if="tab === 'computer' || tab === 'network'">
              <label v-if="tab === 'network'" class="output-setup-field">Network interface<select :value="delivery?.host || '127.0.0.1'" :disabled="busy || !delivery" @change="network(($event.target as HTMLSelectElement).value)"><option value="127.0.0.1">Off · this computer only</option><option v-for="item in delivery?.interfaces || []" :key="item.address" :value="item.address">{{ item.label }}</option></select></label>
              <p v-if="tab === 'network' && delivery && !delivery.interfaces.length" class="output-setup-hint" role="status">No network found. Connect Wi-Fi or Ethernet, then reopen setup.</p>
              <div v-if="!hasPicture || studio.status.state !== 'running'" class="output-engine-readiness"><span>{{ !hasPicture ? 'Choose content in Studio or send it to Program first.' : 'Start the engine to send picture and audio.' }}</span><button v-if="hasPicture" class="s-button engine-control" aria-label="Start engine for outputs" :disabled="busy || studio.engineBusy || studio.status.state === 'starting'" @click="action(startEngine)">{{ studio.status.state === 'starting' ? 'Starting…' : 'Start engine' }}</button></div>
              <div v-if="shareUrl" class="output-share-field" data-team-private><label :for="'output-link-' + tab">View-only link</label><div><input :id="'output-link-' + tab" :value="shareUrl" readonly spellcheck="false" @focus="($event.target as HTMLInputElement).select()" /><button class="s-button primary" :disabled="busy" @click="copyLink"><Check v-if="copied" :size="14" /><Copy v-else :size="14" />{{ copied ? 'Copied' : 'Copy' }}</button></div></div>
              <div v-else class="output-primary-action"><span>{{ tab === 'network' && delivery?.host === '127.0.0.1' ? 'Choose a network to enable sharing.' : 'Create a view-only link for this output.' }}</span><button class="s-button primary" :disabled="busy || !delivery || (tab === 'network' && delivery.host === '127.0.0.1')" @click="createLink"><Link2 :size="14" />Create {{ tab === 'network' ? 'network' : 'output' }} link</button></div>
              <template v-if="shareUrl">
                <label class="output-sound-choice"><input v-model="linkSound" type="checkbox" :disabled="outputId !== 'program' && !output?.audioEnabled" /><span>Request sound on open<small v-if="outputId !== 'program' && !output?.audioEnabled">Enable this output’s audio first.</small></span></label>
                <div v-if="link" class="output-link-actions"><span>{{ link.viewers }} viewing</span><button class="output-revoke" :disabled="busy" @click="revoke">Revoke link</button></div>
              </template>
            </template>
            <template v-else>
              <div class="output-external-state"><ShieldCheck :size="18" /><div><b>{{ external?.verified ? 'Private relay verified' : external?.configured ? 'Check your private relay' : 'Relay setup required' }}</b><p>{{ external?.verified ? 'Send Program using Go Live → Lumen Watch.' : external?.configured ? 'Verify the connection before sharing.' : 'Set up a private relay to share beyond your local network.' }}</p></div><button v-if="external?.configured" class="s-button" :disabled="busy" @click="verifyExternal"><RefreshCw :size="13" />{{ external.verified ? 'Check again' : 'Verify relay' }}</button></div>
              <div v-if="shareUrl" class="output-share-field" data-team-private><label for="output-external-link">Private Program link</label><div><input id="output-external-link" :value="shareUrl" readonly spellcheck="false" @focus="($event.target as HTMLInputElement).select()" /><button class="s-button primary" :disabled="busy" @click="copyLink"><Check v-if="copied" :size="14" /><Copy v-else :size="14" />{{ copied ? 'Copied' : 'Copy' }}</button></div></div>
              <label v-if="shareUrl" class="output-sound-choice"><input v-model="linkSound" type="checkbox" />Request sound on open</label>
            </template>
          </div>
          <p v-if="shareUrl" class="output-setup-hint"><ShieldCheck :size="13" />Anyone with this link can view the output.</p>
          <details :key="tab" class="output-details"><summary>{{ tab === 'external' ? 'Relay details' : 'Sharing details' }}</summary><template v-if="tab === 'external'"><p>{{ external?.message || 'Configure your private HTTPS output relay first. Nothing is published automatically.' }}</p><p>External links use Program, including when opened from a pinned screen. Enable Lumen Watch in Go Live to start sending. Rotate the relay’s viewer key to revoke access.</p></template><template v-else><p>This link shows only the output. Viewers cannot control the station. Up to {{ delivery?.perLinkLimit || '—' }} viewers can use each link; revoking it disconnects them.</p><p>Playback starts muted unless sound is requested. The browser may still require a click to play sound. Output mute controls remain in effect.</p><p v-if="tab === 'network'">Use a trusted network. Keep the station private; do not forward the sharing port to the internet.</p></template></details>
        </template>
      </div>
      <p v-if="error" class="output-setup-feedback error" role="alert"><AlertCircle :size="14" />{{ error }}</p><p v-if="notice" class="output-setup-feedback" role="status"><Check :size="14" />{{ notice }}</p>
    </section>
  </div>
</template>

<style scoped>
.shared-output-content{min-width:0;color:var(--text-primary)}
.shared-output-content .outputs-panel{margin:0;padding:0;border:0}
.program-output-card{display:flex;justify-content:space-between;align-items:center;gap:20px;padding:15px 16px;margin-bottom:24px;background:var(--surface-2);border:1px solid var(--border-hair);border-radius:9px}
.program-output-identity{display:flex;align-items:center;gap:13px;min-width:0}.program-output-identity>div{min-width:0}.program-output-icon{display:grid;place-items:center;flex-shrink:0;width:40px;height:40px;border-radius:9px;color:var(--accent);background:var(--selection-fill)}
.output-section-label{font-size:10px;color:var(--text-muted)}.program-output-card h3{font-size:14px;font-weight:550;overflow-wrap:anywhere;margin:3px 0}.program-output-card p{font-size:11px;color:var(--text-muted);line-height:1.5}.program-output-actions{display:flex;gap:7px;flex-shrink:0}
.shared-output-content .s-button{display:inline-flex;align-items:center;justify-content:center;gap:7px;min-height:34px;padding:7px 10px;border:1px solid var(--border-hair);border-radius:7px;background:var(--surface-2);color:var(--text-primary);font-size:12px;white-space:nowrap}.shared-output-content .s-button:hover:not(:disabled){background:var(--bg-hover)}.shared-output-content button:disabled{opacity:.45;cursor:not-allowed}.shared-output-content .s-icon{display:inline-flex;align-items:center;justify-content:center;flex-shrink:0;width:30px;height:34px;border-radius:6px;color:var(--text-muted);background:transparent;border:0}.shared-output-content .s-icon:hover:not(:disabled){background:var(--bg-hover);color:var(--text-primary)}
.outputs-heading{display:flex;justify-content:space-between;align-items:center;gap:16px;margin-bottom:12px}.outputs-heading h2{display:flex;gap:8px;align-items:center;font-size:13px;font-weight:550}.panel-count{color:var(--text-subtle);font-size:11px;font-weight:400}.outputs-heading p{font-size:11px;line-height:1.5;color:var(--text-muted);margin-top:3px}
.output-list{display:flex;flex-direction:column;gap:10px}.output-row{display:grid;grid-template-columns:minmax(0,1fr) auto;gap:14px 20px;align-items:center;padding:14px;border:1px solid var(--border-hair);border-radius:9px;min-width:0}.output-row-identity{min-width:0}.output-name{display:flex;align-items:center;gap:7px}.output-name>input{min-width:0;width:100%;padding:2px 0;color:var(--text-primary);font-size:13px;font-weight:550;background:transparent;border:0;border-radius:3px}.output-name>svg{flex-shrink:0;color:var(--text-subtle)}.output-display-choice{display:flex;align-items:center;gap:6px;max-width:100%;font-size:11px;color:var(--text-muted);margin-top:5px;text-align:left}.output-display-choice>span{overflow:hidden;text-overflow:ellipsis;white-space:nowrap}.output-display-choice>svg{flex-shrink:0}.output-display-choice:hover:not(:disabled){color:var(--accent)}.output-row-actions,.output-row-toggles{display:flex;align-items:center;justify-content:flex-end;gap:6px}.output-route{display:flex;align-items:center;gap:9px;min-width:0;font-size:11px;color:var(--text-muted)}.output-route>select{min-width:0;flex:1;width:100%;padding:8px;background:var(--surface-2);border:1px solid var(--border-hair);border-radius:6px;color:var(--text-primary);font-size:12px}.shared-output-content .output-toggle{font-size:11px;min-height:33px;padding:6px 9px;color:var(--text-muted)}
.output-inline-feedback{padding-top:10px}
.output-setup-navigation{display:flex;align-items:center;gap:10px;margin-bottom:14px;min-width:0}.output-setup-navigation>svg{color:var(--text-subtle);flex-shrink:0}.output-setup-navigation h3{font-size:13px;font-weight:550;overflow-wrap:anywhere;min-width:0}.output-back{display:inline-flex;align-items:center;gap:7px;color:var(--text-muted);font-size:12px;padding:4px 0;flex-shrink:0}.output-back:hover{color:var(--text-primary)}
.output-destination-tabs{display:grid;grid-template-columns:1fr 1fr;gap:4px;background:var(--bg-base);padding:4px;border-radius:8px}.output-destination-tabs>button{display:flex;gap:7px;align-items:center;justify-content:center;padding:9px;font-size:12px;color:var(--text-muted);border-radius:6px}.output-setup-body{display:flex;flex-direction:column;gap:14px;padding-top:16px;min-width:0}.output-setup-card{display:flex;flex-direction:column;gap:14px;padding:16px;border:1px solid var(--border-hair);border-radius:9px;min-width:0}.output-setup-title{display:flex;gap:12px;justify-content:space-between;align-items:center}.output-setup-title h3{font-size:13px;font-weight:550;margin-bottom:4px}.output-setup-title p{font-size:11px;line-height:1.5;color:var(--text-muted)}
.output-setup-field,.output-share-field{display:flex;flex-direction:column;gap:7px;font-size:11px;color:var(--text-muted);min-width:0}.output-setup-field select,.output-share-field input{width:100%;min-width:0;min-height:36px;border:1px solid var(--border-hair);border-radius:6px;padding:8px 10px;background:var(--surface-2);color:var(--text-primary);font-size:12px}.output-share-field>div{display:flex;gap:8px;min-width:0}.output-share-field input{flex:1;font-family:ui-monospace,monospace;font-size:11px}.output-share-field .s-button{flex-shrink:0}
.shared-output-content .s-button.primary{background:var(--accent);color:var(--bg-base);border-color:transparent}.output-primary-action{display:flex;align-items:center;justify-content:space-between;gap:12px}.output-primary-action>span{font-size:11px;line-height:1.5;color:var(--text-muted)}.output-primary-action>.s-button{flex-shrink:0}.output-engine-readiness{display:flex;align-items:center;justify-content:space-between;gap:12px;padding:12px;border-radius:7px;background:var(--surface-2);font-size:12px;color:var(--text-muted);line-height:1.5}.output-engine-readiness .s-button{flex-shrink:0}
.output-setup-hint{font-size:11px;color:var(--text-muted);line-height:1.6;display:flex;align-items:flex-start;gap:6px}.output-setup-hint svg{flex-shrink:0;margin-top:2px}.output-sound-choice{display:flex;align-items:center;gap:8px;font-size:12px;color:var(--text-primary)}.output-sound-choice input{accent-color:var(--accent)}.output-sound-choice small{display:block;margin-top:3px;color:var(--text-muted);font-size:11px}.output-link-actions{display:flex;align-items:center;justify-content:space-between;font-size:11px;color:var(--text-muted)}.output-revoke{padding:4px 0;text-decoration:underline;text-underline-offset:3px}
.output-details{font-size:11px;color:var(--text-muted);line-height:1.6}.output-details summary{cursor:pointer;list-style-position:inside;width:fit-content;padding:4px 0;color:var(--text-primary)}.output-details p{margin-top:9px;max-width:65ch}.output-external-state{display:flex;gap:10px;align-items:flex-start;color:var(--text-muted);padding:12px;background:var(--surface-2);border-radius:7px}.output-external-state>svg{flex-shrink:0;margin-top:2px}.output-external-state>div{flex:1;min-width:0}.output-external-state b{font-size:12px;color:var(--text-primary);font-weight:550}.output-external-state p{font-size:11px;line-height:1.6;margin-top:4px}
.output-setup-feedback{display:flex;align-items:flex-start;gap:7px;margin-top:14px;font-size:12px;color:var(--accent);line-height:1.6}.output-setup-feedback.error{color:#e5a598}.output-setup-feedback svg{flex-shrink:0;margin-top:3px}.shared-output-content :is(button,input,select,summary):focus-visible{outline:2px solid var(--accent);outline-offset:2px}
@media(max-width:560px){.program-output-card{align-items:flex-start;flex-direction:column;gap:12px;padding:15px}.program-output-actions{width:100%;flex-wrap:wrap}.output-row{grid-template-columns:minmax(0,1fr);gap:12px}.output-row-actions,.output-row-toggles{justify-content:flex-start}.output-row-actions{grid-row:3}.output-row-toggles{grid-row:4}.output-route{grid-row:2}.outputs-heading{align-items:flex-start}.output-setup-card{padding:12px}.output-setup-title{align-items:flex-start;flex-wrap:wrap}.output-primary-action{flex-wrap:wrap}.output-primary-action>.s-button{margin-left:auto}.output-external-state{flex-wrap:wrap}.output-share-field>div{flex-wrap:wrap}.output-share-field input{flex-basis:100%}.output-share-field .s-button{margin-left:auto}.output-engine-readiness{flex-wrap:wrap}.output-setup-navigation{gap:8px}}
@media(pointer:coarse){.shared-output-content .s-button,.shared-output-content .s-icon,.output-display-choice,.output-back,.output-revoke{min-height:40px}}
</style>
