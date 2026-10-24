<script setup lang="ts">
import { computed, onBeforeUnmount, ref, watch } from 'vue';
import { Aperture, ArrowRightLeft, BookOpen, Check, ChevronLeft, ChevronRight, Circle, Layers, Link2, LoaderCircle, LockKeyhole, LogOut, Mic, Music2, Radio, Search, ShieldCheck, SlidersHorizontal, Volume2, VolumeX, Wifi, WifiOff } from 'lucide-vue-next';
import { useMobileController } from '@/lib/mobile/controller';
import { useConfirmation } from '@/composables/useConfirmation';
import MobileScenePoster from '@/components/mobile/MobileScenePoster.vue';
import MobileProgramMonitor from '@/components/mobile/MobileProgramMonitor.vue';
import type { MobileSearchResults, MobileSelection } from '../../../shared/mobile-controller';
import '@/styles/mobile-controller.css';

const controller = useMobileController(), { confirmAction } = useConfirmation();
const { snapshot, session, busy, loading, error, fresh, canControl, leaseOwned, connection } = controller;
const tab = ref<'live' | 'scenes' | 'channels' | 'audio'>('live');
const monitorReady = ref(false);
const code = ref(''), deviceName = ref(''), pairingFromLink = ref(false);
// Pairing capabilities stay out of history, Referrer and persistent storage.
const fragment = new URLSearchParams(location.hash.slice(1));
if (fragment.has('pair')) { code.value = fragment.get('pair') ?? ''; pairingFromLink.value = true; history.replaceState(history.state, '', location.pathname + location.search); }
const preview = computed(() => snapshot.value?.production.scenes.find(scene => scene.id === snapshot.value?.production.previewSceneId) ?? null);
const duration = ref(300), selectedChannelId = ref(''), query = ref(''), searching = ref(false), searchError = ref('');
const results = ref<MobileSearchResults['results']>([]), prepared = ref<{ title: string; text: string; selection: MobileSelection } | null>(null);
const channel = computed(() => snapshot.value?.channels.find(item => item.id === selectedChannelId.value) ?? null);
const permissions = computed(() => snapshot.value?.device.permissions ?? session.value?.device?.permissions);
const main = computed(() => snapshot.value?.mainAudio ?? null), volume = ref(100);
let volumeSource: string | null = null;
const mainIssue = computed(() => !main.value ? 'No Main audio selected' : main.value.masterMuted ? 'Output muted in Studio' : main.value.muted ? 'Main muted' : ['missing', 'error', 'disconnected'].includes(main.value.status) ? 'Input disconnected' : main.value.status === 'ready' ? 'Input ready' : 'Waiting for input');
const canSwitch = computed(() => canControl.value && permissions.value?.studio && snapshot.value?.engine.state === 'running' && !!preview.value);
const canChannel = computed(() => canControl.value && permissions.value?.channels && !!channel.value);
const channelIcon = computed(() => channel.value?.kind === 'lyrics' ? Music2 : BookOpen);
let searchTimer: ReturnType<typeof setTimeout> | undefined, searchRequest: AbortController | null = null, searchSerial = 0;
watch(() => main.value?.volume, value => { volume.value = Math.round((value ?? 1) * 100); });
watch(() => snapshot.value?.channels.map(item => item.id).join(','), () => { if (!snapshot.value?.channels.some(item => item.id === selectedChannelId.value)) selectedChannelId.value = snapshot.value?.channels[0]?.id ?? ''; });
watch(selectedChannelId, () => { query.value = ''; results.value = []; prepared.value = null; searchError.value = ''; });
watch([query, selectedChannelId], () => {
  clearTimeout(searchTimer); searchRequest?.abort(); results.value = []; searchError.value = ''; const sequence = ++searchSerial;
  if (!query.value.trim() || !channel.value || !fresh.value || !permissions.value?.channels || !['scripture', 'lyrics'].includes(channel.value.kind)) { searching.value = false; return; }
  searching.value = true;
  searchTimer = setTimeout(async () => {
    const request = new AbortController(); searchRequest = request;
    const timeout = setTimeout(() => request.abort(), 4500);
    try { const value = await controller.search(selectedChannelId.value, query.value.trim(), request.signal); if (sequence === searchSerial) results.value = value.results; }
    catch (cause) { if (sequence === searchSerial && !(cause instanceof DOMException && cause.name === 'AbortError')) searchError.value = cause instanceof Error ? cause.message : 'Search is unavailable.'; }
    finally { clearTimeout(timeout); if (sequence === searchSerial) searching.value = false; }
  }, 220);
});
onBeforeUnmount(() => { clearTimeout(searchTimer); searchRequest?.abort(); });
async function pair() { await controller.pair(code.value, deviceName.value); if (session.value?.paired) { code.value = ''; pairingFromLink.value = false; } }
async function takeControl() {
  const other = snapshot.value?.lease;
  if (other && !leaseOwned.value && !await confirmAction({ title: 'Take over phone control?', description: `${other.name} currently has phone control. This replaces their control lease; the desktop operator can still intervene.`, confirmLabel: 'Take control', tone: 'live' })) return;
  await controller.lease(!!other && !leaseOwned.value);
}
async function disconnect() {
  if (await confirmAction({ title: 'Disconnect this phone?', description: 'Your station keeps rendering, recording and streaming. A new pairing code will be needed to reconnect this device.', confirmLabel: 'Disconnect' })) await controller.disconnect();
}
async function blank() {
  if (!channel.value || !canChannel.value) return;
  const target = channel.value;
  if (!target.blanked && !await confirmAction({ title: `Hide ${target.name}?`, description: 'Hide this channel’s content wherever it is used. Studio scene switching and audio will not change.', confirmLabel: 'Hide channel', tone: 'live' })) return;
  await controller.command({ type: 'channel-blank', channelId: target.id, blanked: !target.blanked });
}
async function sendLive() {
  if (!channel.value || !prepared.value || !canChannel.value) return;
  const selection = prepared.value.selection;
  if (await controller.command({ type: 'channel-take', channelId: channel.value.id, selection })) prepared.value = null;
}
function setDuration() { duration.value = Math.min(3000, Math.max(100, Math.round(Number(duration.value) || 300))); }
async function setVolume() {
  const current = main.value, intended = Math.max(0, Math.min(1, volume.value / 100)), startedOn = volumeSource; volumeSource = null;
  if (!current || !canControl.value || !permissions.value?.audio) { volume.value = Math.round((current?.volume ?? 1) * 100); return; }
  if (startedOn && startedOn !== current.sourceId) { volume.value = Math.round(current.volume * 100); error.value = 'Main audio changed in Studio. Review the new input before adjusting its volume.'; return; }
  await controller.command({ type: 'main-audio', volume: intended });
}
</script>

<template>
  <div class="mobile-controller" data-testid="mobile-controller">
    <header class="mobile-header"><div class="mobile-brand"><Aperture :size="25" /><b>lumen</b><span>Remote</span></div><span class="mobile-connection" :class="{ connected: fresh, disconnected: !fresh }" role="status"><Wifi v-if="fresh" :size="14" /><WifiOff v-else :size="14" />{{ connection }}</span></header>
    <main v-if="loading && !session" class="mobile-pair-screen"><LoaderCircle :size="28" class="mobile-spin" /><h1>Connecting to your station…</h1><p>Live production continues on the main computer.</p></main>
    <main v-else-if="!session?.paired" class="mobile-pair-screen">
      <div class="mobile-pair-icon"><LockKeyhole :size="28" /></div><span class="mobile-eyebrow">Secure station access</span><h1>Your station.<br />Within reach.</h1><p>Pair this phone from <b>Studio → Mobile control</b>. Your station keeps rendering, recording and streaming.</p>
      <form class="mobile-pair-form" data-mobile-private @submit.prevent="pair"><label>Device name<input v-model="deviceName" name="deviceName" autocomplete="off" maxlength="60" placeholder="e.g. Scripture operator’s phone" /></label><label>{{ pairingFromLink ? 'Pairing code from your link' : 'One-time pairing code' }}<input v-model="code" name="code" autocomplete="off" autocapitalize="off" spellcheck="false" maxlength="160" required placeholder="Paste your pairing code" data-team-private /></label><p v-if="error" class="mobile-error" role="alert">{{ error }}</p><button class="mobile-button primary" :disabled="busy || !code.trim()"><LoaderCircle v-if="busy" :size="17" class="mobile-spin" /><Link2 v-else :size="17" />Pair this phone</button></form>
      <small class="mobile-privacy"><ShieldCheck :size="15" />No stream keys or station passwords are shared.</small>
    </main>
    <template v-else>
      <div class="mobile-station-strip"><span><i :class="{ running: snapshot?.engine.state === 'running' }" />{{ snapshot?.engine.state === 'running' ? `Engine running · ${snapshot.engine.fps} fps` : snapshot?.engine.state === 'starting' ? 'Engine starting' : 'Engine offline' }}</span><div><span v-if="snapshot?.engine.recording"><Circle :size="8" fill="currentColor" />REC</span><span v-if="snapshot?.engine.streaming"><Radio :size="12" />Streaming</span><button type="button" aria-label="Disconnect phone" @click="disconnect"><LogOut :size="16" /></button></div></div>
      <div v-if="!fresh" class="mobile-offline-banner" role="alert"><WifiOff :size="17" /><div><b>Controls paused</b><span>Waiting for fresh station state. No actions will be queued or replayed.</span></div></div>
      <div class="mobile-lease-bar" :class="{ active: leaseOwned }"><div><ShieldCheck :size="17" /><span><b>{{ leaseOwned ? 'You have phone control' : snapshot?.lease ? `${snapshot.lease.name} has phone control` : 'Monitor only' }}</b><small>{{ leaseOwned ? 'Desktop operation remains available' : 'Take control before making changes' }}</small></span></div><button class="mobile-button compact" :disabled="busy || !fresh" @click="leaseOwned ? controller.release() : takeControl()">{{ leaseOwned ? 'Release' : snapshot?.lease ? 'Take over' : 'Take control' }}</button></div>
      <div v-if="error" class="mobile-error mobile-inline-error" role="alert"><span>{{ error }}</span><button aria-label="Dismiss message" @click="error = ''">×</button></div>
      <main class="mobile-content">
        <section v-if="tab === 'live'" class="mobile-live-panel" aria-label="Live control">
          <div class="mobile-page-heading"><div><span class="mobile-eyebrow">Studio buses</span><h1>Live control</h1></div><span class="mobile-design-note">{{ monitorReady ? 'Muted Program monitor' : 'Design previews until video connects' }}</span></div>
          <div class="mobile-monitors">
            <article class="mobile-monitor program"><div class="mobile-monitor-heading"><b><i />Program</b><span>{{ snapshot?.production.program?.name || 'Nothing live' }}</span></div><div class="mobile-monitor-picture"><MobileScenePoster :scene="snapshot?.production.program ?? null" empty="No scene on Program" /><MobileProgramMonitor v-if="fresh && snapshot?.engine.state === 'running' && permissions?.studio" @ready="monitorReady = $event" /><span class="mobile-monitor-caption">{{ monitorReady ? 'Live monitor · muted' : 'Design preview' }}</span></div></article>
            <article class="mobile-monitor preview"><div class="mobile-monitor-heading"><b><i />Preview</b><span>{{ preview?.name || 'Choose a scene' }}</span></div><div class="mobile-monitor-picture"><MobileScenePoster :scene="preview" empty="Choose a scene below" /><span class="mobile-monitor-caption">Design preview</span></div></article>
          </div>
          <div class="mobile-transition-buttons"><button class="mobile-button cut" :disabled="!canSwitch" @click="controller.command({ type: 'take', transition: 'cut' })"><span>Cut</span><ArrowRightLeft :size="20" /></button><button class="mobile-button primary" :disabled="!canSwitch" @click="controller.command({ type: 'take', transition: 'fade', durationMs: duration })"><span>Fade</span><ArrowRightLeft :size="20" /></button></div><div class="mobile-transition-details"><span>Preview goes live. Previous Program returns to Preview.</span><label>Fade<input v-model.number="duration" type="number" min="100" max="3000" step="50" inputmode="numeric" aria-label="Fade duration" @change="setDuration" @blur="setDuration" />ms</label></div>
          <button class="mobile-button mobile-wide" :disabled="!permissions?.studio" @click="tab = 'scenes'"><Layers :size="17" />Choose a scene<ChevronRight :size="17" /></button>
          <div v-if="main" class="mobile-main-summary"><Mic :size="17" /><div><b>{{ main.name }} <span>Main</span></b><small>{{ mainIssue }}</small></div><button class="mobile-button compact" @click="tab = 'audio'">Audio</button></div>
        </section>
        <section v-else-if="tab === 'scenes'" aria-label="Scene control"><div class="mobile-page-heading"><div><span class="mobile-eyebrow">Prepare your next shot</span><h1>Scenes</h1></div><span>{{ snapshot?.production.scenes.length ?? 0 }} scenes</span></div><p class="mobile-section-help">Tap to select Preview, then use Cut or Fade. Selecting never changes Program.</p><p v-if="!permissions?.studio" class="mobile-permission-note"><LockKeyhole :size="16" />This phone has no Studio switching permission.</p><div class="mobile-scene-grid"><button v-for="scene in snapshot?.production.scenes ?? []" :key="scene.id" class="mobile-scene-tile" :class="{ preview: scene.id === snapshot?.production.previewSceneId, program: scene.id === snapshot?.production.programId }" :disabled="!canControl || !permissions?.studio" :aria-label="`Preview ${scene.name}`" :aria-pressed="scene.id === snapshot?.production.previewSceneId" @click="controller.command({ type: 'preview', sceneId: scene.id })"><div class="mobile-scene-tile-picture"><MobileScenePoster :scene="scene" /><div class="mobile-scene-badges"><span v-if="scene.id === snapshot?.production.previewSceneId" class="preview">Preview</span><span v-if="scene.id === snapshot?.production.programId" class="program">Program</span></div></div><b>{{ scene.name }}</b></button></div><p v-if="!snapshot?.production.scenes.length" class="mobile-empty">Create scenes in Studio to use them here.</p><div class="mobile-scene-transitions"><span>Preview: <b>{{ preview?.name || 'None' }}</b></span><button class="mobile-button compact" :disabled="!canSwitch" @click="controller.command({ type: 'take', transition: 'cut' })">Cut<ArrowRightLeft :size="16" /></button><button class="mobile-button primary compact" :disabled="!canSwitch" @click="controller.command({ type: 'take', transition: 'fade', durationMs: duration })">Fade<ArrowRightLeft :size="16" /></button></div></section>
        <section v-else-if="tab === 'channels'" aria-label="Channel control">
          <div class="mobile-page-heading"><div><span class="mobile-eyebrow">Content without scene changes</span><h1>Channels</h1></div><BookOpen :size="23" /></div>
          <label class="mobile-field">Channel<select v-model="selectedChannelId" aria-label="Remote channel"><option v-for="item in snapshot?.channels ?? []" :key="item.id" :value="item.id">{{ item.name }}</option></select></label>
          <p v-if="!snapshot?.channels.length" class="mobile-empty">No channels available on this station.</p>
          <p v-if="!permissions?.channels" class="mobile-permission-note"><LockKeyhole :size="16" />This phone has no channel control permission.</p>
          <template v-if="channel">
            <div class="mobile-channel-live">
              <div class="mobile-channel-heading"><b><component :is="channelIcon" :size="16" />Channel live</b><span :class="{ 'is-hidden': channel.blanked }">{{ channel.blanked ? 'Hidden' : 'Visible' }}</span></div>
              <h2>{{ channel.live?.reference || channel.live?.title || 'Nothing live yet' }}</h2><p>{{ channel.live?.text || 'Prepare content below, then send it live.' }}</p>
              <div class="mobile-channel-step"><button class="mobile-button compact" :disabled="!canChannel || !channel.live" @click="controller.command({ type: 'channel-step', channelId: channel.id, direction: -1 })"><ChevronLeft :size="17" />Previous</button><button class="mobile-button compact" :disabled="!canChannel" @click="blank"><VolumeX v-if="channel.blanked" :size="16" />{{ channel.blanked ? 'Show' : 'Hide' }}</button><button class="mobile-button compact" :disabled="!canChannel || !channel.live" @click="controller.command({ type: 'channel-step', channelId: channel.id, direction: 1 })">Next<ChevronRight :size="17" /></button></div>
            </div>
            <template v-if="['scripture', 'lyrics'].includes(channel.kind)">
              <label class="mobile-search"><Search :size="19" /><input v-model="query" :placeholder="channel.kind === 'scripture' ? 'jn3 16, jer20 11, or a few words…' : 'Song title or a few remembered lyrics…'" :disabled="!fresh || !permissions?.channels" aria-label="Search channel content" maxlength="500" autocomplete="off" autocapitalize="off" /><LoaderCircle v-if="searching" :size="17" class="mobile-spin" /></label>
              <p v-if="searchError" class="mobile-error" role="alert">{{ searchError }}</p>
              <div class="mobile-search-results"><button v-for="(result, index) in results" :key="index" class="mobile-result" :class="{ prepared: prepared === result }" @click="prepared = result"><b>{{ result.title }}<Check v-if="prepared === result" :size="15" /></b><p>{{ result.text }}</p><small>Tap to prepare</small></button><p v-if="query.trim() && !searching && !results.length && !searchError" class="mobile-empty">No matches. Try a shorter title, reference or phrase.</p></div>
            </template>
            <div v-else class="mobile-search-results">
              <button v-for="item in channel.items" :key="item.id" class="mobile-result" @click="prepared = { title: item.title, text: item.text, selection: { kind: 'presentation', index: item.index } }"><b>{{ item.index + 1 }}. {{ item.title || 'Slide' }}</b><p>{{ item.text }}</p><small>Tap to prepare</small></button>
              <p v-if="channel.itemsTruncated" class="mobile-empty">First 200 items shown. Use Next to reach later slides.</p>
            </div>
            <div v-if="prepared" class="mobile-prepared"><span class="mobile-eyebrow">Ready to send · {{ channel.name }}</span><h2>{{ prepared.title }}</h2><p>{{ prepared.text }}</p><button class="mobile-button primary mobile-wide" :disabled="!canChannel" @click="sendLive">Send live<ChevronRight :size="18" /></button><small>Updates this channel only. Studio scene switching stays manual.</small></div>
          </template>
        </section>
        <section v-else aria-label="Main audio control"><div class="mobile-page-heading"><div><span class="mobile-eyebrow">Persistent across scenes</span><h1>Main audio</h1></div><SlidersHorizontal :size="23" /></div><p class="mobile-section-help">Control the selected Main input. Choosing another source and changing the rest of the mix stay in Studio.</p><p v-if="!permissions?.audio" class="mobile-permission-note"><LockKeyhole :size="16" />This phone has no audio control permission.</p><article v-if="main" class="mobile-audio-card"><div class="mobile-audio-source"><span class="mobile-source-icon"><Mic :size="24" /></span><div><small>MAIN INPUT</small><h2>{{ main.name }}</h2><p :class="{ warning: mainIssue !== 'Input ready' }">{{ mainIssue }}</p></div></div><div class="mobile-level-meter" role="meter" aria-label="Main audio signal level" :aria-valuenow="Math.round(main.level * 100)" aria-valuemin="0" aria-valuemax="100"><span :style="{ width: `${Math.min(100, Math.max(0, main.level * 100))}%` }" /></div><div class="mobile-meter-label"><span>Input signal</span><span>{{ fresh ? 'Current station level' : 'Last received level' }}</span></div><button class="mobile-button mobile-mute-button" :class="{ muted: main.muted }" :disabled="!canControl || !permissions?.audio" @click="controller.command({ type: 'main-audio', muted: !main.muted })"><VolumeX v-if="main.muted" :size="22" /><Volume2 v-else :size="22" />{{ main.muted ? 'Unmute Main' : 'Mute Main' }}</button><label class="mobile-volume-label" for="remote-main-volume"><span>Main input volume</span><b>{{ volume }}%</b></label><input id="remote-main-volume" v-model.number="volume" class="mobile-volume-slider" type="range" min="0" max="100" step="1" :disabled="!canControl || !permissions?.audio" @pointerdown="volumeSource = main.sourceId" @keydown="volumeSource = main.sourceId" @change="setVolume" /><div v-if="main.masterMuted" class="mobile-permission-note"><VolumeX :size="17" />The output is muted in Studio. Unmuting Main will not override the output mute.</div></article><div v-else class="mobile-empty mobile-empty-audio"><Mic :size="28" /><h2>No Main input selected</h2><p>Set Main audio in Studio’s Audio mixer. This phone will never choose an input automatically.</p></div></section>
      </main>
      <nav class="mobile-bottom-nav" aria-label="Remote controls"><button v-for="item in ([{ id: 'live', label: 'Live', icon: Radio }, { id: 'scenes', label: 'Scenes', icon: Layers }, { id: 'channels', label: 'Channels', icon: BookOpen }, { id: 'audio', label: 'Audio', icon: Volume2 }] as const)" :key="item.id" :class="{ selected: tab === item.id }" :aria-current="tab === item.id ? 'page' : undefined" @click="tab = item.id"><component :is="item.icon" :size="20" /><span>{{ item.label }}</span></button></nav>
    </template>
  </div>
</template>
