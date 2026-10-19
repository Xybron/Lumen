<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, reactive, ref, watch } from 'vue';
import { Aperture, ArrowLeft, ArrowUpRight, Check, ChevronDown, Copy, CircleAlert, CircleCheck, Facebook, Film, LoaderCircle, Radio, RefreshCw, Settings2, ShieldCheck, Square, Volume2, VolumeX, X, Youtube } from 'lucide-vue-next';
import { Dialog, DialogContent, DialogDescription, DialogTitle } from '@/components/ui/dialog';
import StudioMonitor from '@/components/studio/StudioMonitor.vue';
import { useBroadcastStore } from '@/stores/broadcast';
import { useIdentityStore } from '@/stores/identity';
import type { BroadcastDestinationId, BroadcastProfile, BroadcastSinkState } from '../../../../shared/broadcast';
import { PROGRAM_MONITOR_OUTPUT_ID } from '../../../../shared/program-monitor.js';
import '@/styles/broadcast.css';

const broadcast = useBroadcastStore(), identity = useIdentityStore();
const phase = ref<'main' | 'start' | 'stop'>('main');
const recordWithStream = ref(true), stopRecording = ref(false), title = ref(''), saved = ref(false), readinessExpanded = ref(false);
const formBaseline = ref(''), previewReady = ref(false), copyMessage = ref('');
const expandedDestination = ref<BroadcastDestinationId | 'watch' | null>(null);
const form = reactive({ profile: '720p' as BroadcastProfile, recordOnStart: true, youtube: { enabled: false, streamKey: '', clearKey: false }, facebook: { enabled: false, streamKey: '', clearKey: false }, watchEnabled: false });
let detach: (() => void) | undefined;
onMounted(() => { detach = broadcast.attach(); });
onBeforeUnmount(() => { detach?.(); clearSecrets(); });
const config = computed(() => broadcast.snapshot?.config), preflight = computed(() => broadcast.snapshot?.preflight);
const localWatch = computed(() => broadcast.snapshot?.mode === 'local-watch');
const production = computed(() => broadcast.snapshot?.production);
const configFor = (id: BroadcastDestinationId) => config.value?.destinations.find(value => value.id === id);
const settingsDisabled = computed(() => !identity.me?.isAdmin || broadcast.active || !!broadcast.busy);
function clearSecrets() { form.youtube.streamKey = ''; form.facebook.streamKey = ''; form.youtube.clearKey = form.facebook.clearKey = false; }
function formState() { return JSON.stringify({ profile: form.profile, recordOnStart: form.recordOnStart, watchEnabled: form.watchEnabled, youtube: form.youtube.enabled, facebook: form.facebook.enabled }); }
function hydrate(resetRecording = false) {
  if (!config.value) return;
  if (resetRecording || !formBaseline.value) recordWithStream.value = config.value.recordOnStart;
  form.profile = config.value.profile; form.recordOnStart = config.value.recordOnStart; form.watchEnabled = config.value.watch.enabled;
  for (const id of ['youtube', 'facebook'] as const) form[id].enabled = !!configFor(id)?.enabled;
  clearSecrets(); formBaseline.value = formState();
}
const dirty = computed(() => !!formBaseline.value && (formState() !== formBaseline.value || (['youtube', 'facebook'] as const).some(id => !!form[id].streamKey || form[id].clearKey)));
watch(() => broadcast.open, open => {
  phase.value = 'main'; saved.value = false; copyMessage.value = ''; readinessExpanded.value = false; expandedDestination.value = null;
  if (open) { hydrate(true); void broadcast.refresh(); }
  else { clearSecrets(); previewReady.value = false; }
});
// Polling updates runtime state, never an unfinished destination or key edit.
watch(config, () => { if (!formBaseline.value || !dirty.value) hydrate(); });
watch(dirty, value => { if (value) saved.value = false; });
watch([() => identity.me?.id, () => identity.me?.isAdmin], () => { clearSecrets(); formBaseline.value = ''; title.value = ''; phase.value = 'main'; expandedDestination.value = null; });
const states: Record<BroadcastSinkState, string> = { disabled: 'Off', unconfigured: 'Not configured', connecting: 'Connecting', live: 'Sending', retrying: 'Reconnecting', stopped: 'Stopped', error: 'Needs attention' };
function draftEnabled(id: BroadcastDestinationId | 'watch') { return id === 'watch' ? form.watchEnabled : form[id].enabled; }
function changeEnabled(id: BroadcastDestinationId | 'watch', event: Event) {
  if (settingsDisabled.value) return;
  const enabled = (event.target as HTMLInputElement).checked;
  if (id === 'watch') form.watchEnabled = enabled; else form[id].enabled = enabled;
  const configured = id === 'watch' ? config.value?.watch.configured : configFor(id)?.configured;
  if (enabled && !configured) expandedDestination.value = id;
}
const destinations = computed(() => (['youtube', 'facebook', 'watch'] as const).map(id => {
  const enabled = id === 'watch' ? !!config.value?.watch.enabled : !!configFor(id)?.enabled;
  const configured = id === 'watch' ? !!config.value?.watch.configured : !!configFor(id)?.configured;
  const sink = id === 'watch' ? broadcast.snapshot?.session?.watch : broadcast.snapshot?.session?.destinations.find(value => value.id === id);
  const state = sink?.state ?? (!enabled ? 'disabled' : configured ? 'stopped' : 'unconfigured');
  const pending = draftEnabled(id) !== enabled || id !== 'watch' && (!!form[id].streamKey || form[id].clearKey);
  const draftConfigured = id === 'watch' ? configured : !form[id].clearKey && (!!form[id].streamKey.trim() || configured);
  const idleLabel = !draftEnabled(id) ? 'Off' : draftConfigured ? 'Ready' : 'Setup needed';
  const showRuntime = broadcast.active || state === 'error' && enabled && !pending;
  return { id, name: id === 'youtube' ? 'YouTube' : id === 'facebook' ? 'Facebook' : 'Lumen Watch', icon: id === 'youtube' ? Youtube : id === 'facebook' ? Facebook : Aperture, enabled, configured, state, pending, error: sink?.error, retries: sink?.retries ?? 0,
    label: showRuntime ? id === 'watch' && state === 'live' ? 'Live view ready' : states[state] : idleLabel,
    tone: showRuntime ? state : !draftEnabled(id) ? 'disabled' : draftConfigured ? 'ready' : 'unconfigured' };
}));
const watchUrl = computed(() => {
  const value = broadcast.snapshot?.session?.watch.publicUrl || config.value?.watch.publicUrl;
  if (!value) return '';
  try { const url = new URL(value, location.origin); return ['http:', 'https:'].includes(url.protocol) ? url.href : ''; } catch { return ''; }
});
const enabledNames = computed(() => destinations.value.filter(value => value.enabled).map(value => value.name).join(', '));
const enabledCount = computed(() => destinations.value.filter(value => value.enabled).length);
const checkState = (check: { ok: boolean; severity?: string }) => check.ok ? 'ready' : check.severity === 'error' ? 'error' : check.severity === 'warning' || check.severity === 'info' || preflight.value?.ready ? 'warning' : 'error';
const attentionChecks = computed(() => preflight.value?.checks.filter(check => !check.ok && check.severity !== 'info') ?? []);
const detailChecks = computed(() => preflight.value?.checks.filter(check => check.ok || check.severity === 'info') ?? []);
const passedCount = computed(() => preflight.value?.checks.filter(check => check.ok).length ?? 0);
const readinessLabel = computed(() => broadcast.active ? 'Stream needs attention' : dirty.value ? 'Setup has unsaved changes' : !enabledCount.value ? 'Choose a destination' : preflight.value?.ready ? attentionChecks.value.length ? 'Ready, with a reminder' : 'Ready to go live' : 'Setup needs attention');
watch(watchUrl, () => { copyMessage.value = ''; });
watch(() => production.value?.engineState, () => { previewReady.value = false; });
async function copyWatchLink() { if (!watchUrl.value) return; try { await navigator.clipboard.writeText(watchUrl.value); copyMessage.value = 'Watch link copied.'; } catch { copyMessage.value = 'Copy is unavailable in this browser. Open Watch and copy its address.'; } }
async function saveSettings() {
  if (settingsDisabled.value || !dirty.value) return;
  const success = await broadcast.save({ profile: form.profile, recordOnStart: form.recordOnStart, watch: { enabled: form.watchEnabled }, destinations: (['youtube', 'facebook'] as const).map(id => ({ id, enabled: form[id].enabled, ...(!form[id].clearKey && form[id].streamKey.trim() ? { streamKey: form[id].streamKey.trim() } : {}), ...(form[id].clearKey ? { clearKey: true } : {}) })) });
  if (success) { hydrate(); saved.value = true; }
}
async function prepareStart() { if (broadcast.busy || dirty.value) return; saved.value = false; const checks = await broadcast.check(); if (checks) phase.value = 'start'; }
async function start() { if (!preflight.value?.ready || dirty.value) return; if (await broadcast.start(recordWithStream.value, title.value)) phase.value = 'main'; }
async function stop() { if (await broadcast.stop(stopRecording.value)) phase.value = 'main'; }
function prepareStop() { stopRecording.value = false; phase.value = 'stop'; }
function shortcuts(event: KeyboardEvent) { if (event.key === 'Enter' && (event.ctrlKey || event.metaKey || event.altKey)) { event.preventDefault(); event.stopPropagation(); } }
</script>

<template>
  <Dialog :open="broadcast.open && broadcast.canOperate" @update:open="value => { broadcast.open = value; }">
    <DialogContent class="broadcast-panel" :class="{ 'is-confirmation': phase !== 'main' }" :show-close-button="false" @keydown.capture="shortcuts">
      <header class="broadcast-panel-heading">
        <span class="broadcast-heading-icon"><Radio :size="19" :stroke-width="1.6" /></span>
        <div><DialogTitle>Go Live</DialogTitle><DialogDescription>Stream your Studio Program.</DialogDescription></div>
        <span v-if="broadcast.active" class="broadcast-running"><i />{{ broadcast.snapshot?.session?.state === 'starting' ? 'Connecting' : broadcast.snapshot?.session?.state === 'stopping' ? 'Ending stream' : 'Stream active' }}</span>
        <button type="button" class="broadcast-icon" aria-label="Close Go Live controls" @click="broadcast.open = false"><X :size="17" /></button>
      </header>
      <aside v-if="localWatch" class="broadcast-local-notice" aria-label="Local Lumen Watch"><Aperture :size="15" aria-hidden="true" /><div><strong>Local Lumen Watch</strong><p>Watch is local to this computer. Facebook and YouTube stream publicly when enabled.</p></div></aside>
      <div class="broadcast-panel-body">
        <div v-if="broadcast.loading && !config" class="broadcast-loading"><LoaderCircle :size="21" class="broadcast-spin" />Connecting to this station…</div>
        <template v-else-if="config">
          <div v-if="phase === 'main'" class="broadcast-workspace">
            <section class="broadcast-picture-column" aria-label="Program and recording">
              <div class="broadcast-section-heading"><h3><span class="broadcast-program-dot" />Program</h3><span><VolumeX :size="12" />Muted preview</span></div>
              <div class="broadcast-program-monitor" role="region" aria-label="Program preview">
                <template v-if="broadcast.open && production?.engineState === 'running'">
                  <span v-if="!previewReady" class="broadcast-monitor-placeholder"><LoaderCircle :size="18" class="broadcast-spin" />Connecting to Program…</span>
                  <StudioMonitor :output-id="PROGRAM_MONITOR_OUTPUT_ID" :audible="false" @ready="previewReady = $event" />
                </template>
                <div v-else class="broadcast-monitor-empty"><Aperture :size="30" :stroke-width="1.2" /><strong>{{ production?.programName || 'No scene on Program' }}</strong><span>{{ production?.programName ? 'The engine starts when you go live.' : 'Take a scene to Program in Studio first.' }}</span></div>
              </div>
              <dl class="broadcast-program"><div><dt><Film :size="14" />Picture</dt><dd>{{ production?.programName || 'No Program selected' }}</dd></div><div><dt><Volume2 :size="14" />Main audio</dt><dd>{{ production?.mainAudioName || 'Existing Program mix' }}<em v-if="production?.masterMuted">Muted</em></dd></div></dl>
              <section class="broadcast-quality" aria-label="Stream setup">
                <label class="broadcast-field"><span>Stream quality</span><select v-model="form.profile" aria-label="Stream quality" :disabled="settingsDisabled"><option value="720p">720p · 30 fps</option><option value="1080p">1080p · 30 fps</option></select></label>
              </section>
              <div class="broadcast-record-option">
                <label v-if="!broadcast.active"><input v-model="recordWithStream" type="checkbox" :disabled="!!broadcast.busy" aria-label="Record with stream" /><span>Record on this station<small>Program and Main audio, saved separately.</small></span></label>
                <span v-else class="broadcast-production-note"><ShieldCheck :size="15" /><span>{{ production?.recording ? 'Recording on this station' : 'Recording is off' }}<small>Scene switching and Main audio stay in Studio.</small></span></span>
                <details v-if="!broadcast.active" class="broadcast-station-defaults">
                  <summary>Station defaults<ChevronDown :size="12" aria-hidden="true" /></summary>
                  <label class="broadcast-checkbox"><input v-model="form.recordOnStart" type="checkbox" :disabled="settingsDisabled" />Record new streams by default</label>
                  <p class="broadcast-caption">Sets the initial recording choice next time you open Go Live.</p>
                </details>
              </div>
              <section v-if="!broadcast.active || attentionChecks.length" class="broadcast-preflight" aria-label="Stream readiness">
                <div class="broadcast-readiness-summary" :class="{ ready: preflight?.ready && !dirty && !attentionChecks.length, attention: !preflight?.ready || dirty || attentionChecks.length }"><CircleCheck v-if="preflight?.ready && !dirty && !attentionChecks.length" :size="16" /><CircleAlert v-else :size="16" /><strong>{{ readinessLabel }}</strong><button type="button" class="broadcast-icon" :disabled="!!broadcast.busy" aria-label="Refresh stream checks" @click="broadcast.check()"><RefreshCw :size="13" :class="{ 'broadcast-spin': broadcast.busy === 'check' }" /></button></div>
                <p v-if="dirty && attentionChecks.length" class="broadcast-caption">Checks below reflect your saved setup.</p>
                <ul v-if="attentionChecks.length" class="broadcast-attention-checks"><li v-for="check in attentionChecks" :key="check.id" :class="`check-${checkState(check)}`"><CircleAlert :size="13" /><span>{{ check.message }}</span></li></ul>
                <button type="button" class="broadcast-readiness-toggle" :aria-expanded="readinessExpanded" :aria-label="readinessExpanded ? 'Hide readiness details' : 'Show readiness details'" @click="readinessExpanded = !readinessExpanded"><span>{{ passedCount }} checks passed<span v-if="preflight?.estimatedUploadKbps"> · ~{{ (preflight.estimatedUploadKbps / 1000).toFixed(1) }} Mb/s upload</span></span><ChevronDown :size="13" :class="{ expanded: readinessExpanded }" /></button>
                <div v-if="readinessExpanded" class="broadcast-readiness-details"><ul><li v-for="check in detailChecks" :key="check.id"><CircleCheck v-if="check.ok" :size="13" /><CircleAlert v-else :size="13" /><span>{{ check.message }}</span></li></ul><p class="broadcast-caption">Upload is an estimate, not a connection speed test.</p></div>
              </section>
            </section>
            <section class="broadcast-destination-column" aria-label="Stream destinations">
              <div class="broadcast-section-heading"><h3>Destinations</h3><span>{{ broadcast.active ? `${enabledCount} enabled` : 'Choose where to stream' }}</span></div>
              <p v-if="broadcast.active || !identity.me?.isAdmin" class="broadcast-settings-note"><ShieldCheck :size="14" /><span>{{ broadcast.active ? 'Setup is locked while your stream is active.' : 'An administrator manages destination setup. You can start and end the stream.' }}</span></p>
              <div class="broadcast-destinations">
                <article v-for="destination in destinations" :key="destination.id" class="broadcast-destination" :data-destination="destination.id" :data-state="destination.state">
                  <div class="broadcast-destination-row">
                    <span class="broadcast-destination-icon" :class="`brand-${destination.id}`"><component :is="destination.icon" :size="21" :stroke-width="1.65" /></span>
                    <div class="broadcast-destination-identity"><strong>{{ destination.name }}<small v-if="destination.pending">Unsaved</small></strong><span class="broadcast-sink-state" :class="`sink-${destination.tone}`"><i />{{ destination.label }}<small v-if="broadcast.active && destination.retries"> · attempt {{ destination.retries }}</small></span></div>
                    <label class="broadcast-destination-switch"><input type="checkbox" :checked="draftEnabled(destination.id)" :aria-label="`Enable ${destination.name} destination`" :disabled="settingsDisabled" @change="changeEnabled(destination.id, $event)" /><span aria-hidden="true" /></label>
                  </div>
                  <p v-if="destination.error && (broadcast.active || destination.state === 'error')" class="broadcast-destination-error">{{ destination.error }}</p>
                  <div class="broadcast-destination-toolbar">
                    <button type="button" class="broadcast-text-button" :aria-label="`Configure ${destination.name} destination`" :aria-expanded="expandedDestination === destination.id" @click="expandedDestination = expandedDestination === destination.id ? null : destination.id"><Settings2 :size="12" />{{ destination.id === 'watch' ? 'Watch setup' : destination.configured ? 'Manage key' : 'Configure' }}<ChevronDown :size="12" :class="{ expanded: expandedDestination === destination.id }" /></button>
                    <div v-if="broadcast.active && destination.enabled" class="broadcast-destination-actions"><button v-if="['error', 'stopped'].includes(destination.state) && destination.configured" type="button" :aria-label="`Retry ${destination.name} destination`" :disabled="!!broadcast.busy" @click="broadcast.retry(destination.id)"><RefreshCw :size="12" />Retry</button><button v-if="['live', 'connecting', 'retrying'].includes(destination.state)" type="button" :aria-label="`Stop ${destination.name} destination`" :disabled="!!broadcast.busy" @click="broadcast.stopDestination(destination.id)"><Square :size="10" />Stop</button></div>
                    <span v-else-if="destination.configured" class="broadcast-destination-saved"><Check :size="11" />{{ destination.id === 'watch' ? 'Relay configured' : 'Key saved' }}</span>
                  </div>
                  <fieldset v-if="expandedDestination === destination.id" class="broadcast-destination-setup" :disabled="settingsDisabled">
                    <template v-if="destination.id !== 'watch'">
                      <label class="broadcast-field"><span>Stream key<span>{{ destination.configured ? 'Saved on station' : 'Not configured' }}</span></span><input v-model="form[destination.id].streamKey" type="password" :aria-label="`${destination.name} stream key`" autocomplete="new-password" spellcheck="false" :placeholder="destination.configured ? 'Leave blank to keep the saved key' : 'Paste your stream key'" maxlength="1024" :disabled="settingsDisabled || form[destination.id].clearKey" /></label>
                      <p class="broadcast-caption">Secure RTMPS connection. Keys are never sent back to this browser.</p>
                      <label v-if="destination.configured" class="broadcast-checkbox"><input v-model="form[destination.id].clearKey" type="checkbox" :aria-label="`Remove saved ${destination.name} stream key`" />Remove saved key</label>
                    </template>
                    <template v-else><p class="broadcast-caption">{{ localWatch ? 'Local Watch is available while this launcher is running.' : config.watch.configured ? 'Watch relay is configured on this station.' : 'Public Watch is not configured on this station.' }}</p><p v-if="!localWatch" class="broadcast-caption">An administrator sets the public domain, relay and access credentials on the server.</p></template>
                  </fieldset>
                  <div v-if="destination.id === 'watch' && watchUrl && (draftEnabled('watch') || broadcast.active)" class="broadcast-watch"><span :title="watchUrl">{{ watchUrl.replace(/^https?:\/\//, '') }}</span><div class="broadcast-watch-actions"><button type="button" aria-label="Copy Lumen Watch link" @click="copyWatchLink"><Copy :size="12" />Copy link</button><a :href="watchUrl" target="_blank" rel="noopener noreferrer" aria-label="Open Lumen Watch"><ArrowUpRight :size="13" />Open</a></div><p v-if="copyMessage" role="status">{{ copyMessage }}</p></div>
                </article>
              </div>
              <p class="broadcast-caption broadcast-destination-caption">{{ broadcast.active ? 'Sending confirms the connection. YouTube and Facebook may still need you to publish in their live dashboard.' : 'Your Studio picture and audio go to every enabled destination. Nothing starts until you confirm.' }}</p>
            </section>
          </div>
          <section v-else-if="phase === 'start'" class="broadcast-confirmation" aria-label="Confirm stream start">
            <button type="button" class="broadcast-text-button" :disabled="!!broadcast.busy" @click="phase = 'main'"><ArrowLeft :size="13" />Back to setup</button>
            <h2>Ready to go live?</h2><p>{{ enabledNames ? `Send Program and Main audio to ${enabledNames}.` : 'Choose and save at least one destination before going live.' }}</p>
            <dl><div><dt>Program</dt><dd>{{ production?.programName || 'No scene selected' }}</dd></div><div><dt>Quality</dt><dd>{{ config.profile }} · 30 fps</dd></div><div v-if="recordWithStream"><dt>Local recording</dt><dd>Record alongside the stream</dd></div></dl>
            <label v-if="recordWithStream" class="broadcast-field"><span>Service recording name <small>Optional</small></span><input v-model="title" type="text" maxlength="100" aria-label="Service recording name" :disabled="!!broadcast.busy" placeholder="Service or event name" /></label>
            <ul v-if="attentionChecks.length" class="broadcast-confirm-checks"><li v-for="check in attentionChecks" :key="check.id" :class="`check-${checkState(check)}`"><CircleAlert :size="14" /><span>{{ check.message }}</span></li></ul>
            <p v-else class="broadcast-confirm-ready"><CircleCheck :size="15" />{{ passedCount }} checks passed. Your stream is ready.</p>
            <p class="broadcast-caption">YouTube and Facebook may still require you to publish the event. Manage platform titles in their live dashboard.</p>
          </section>
          <section v-else class="broadcast-confirmation" aria-label="Confirm stream end">
            <button type="button" class="broadcast-text-button" :disabled="!!broadcast.busy" @click="phase = 'main'"><ArrowLeft :size="13" />Back to setup</button>
            <h2>End this stream?</h2><p>Stop sending Program to all destinations. Your Studio stays as it is.</p>
            <label class="broadcast-stop-choice" :class="{ selected: !stopRecording }"><input v-model="stopRecording" type="radio" :value="false" name="broadcast-stop-recording" aria-label="Keep recording when ending stream" :disabled="!!broadcast.busy" /><span><strong>Keep recording<em>Recommended</em></strong><small>Leave the local recording running.</small></span></label>
            <label class="broadcast-stop-choice" :class="{ selected: stopRecording }"><input v-model="stopRecording" type="radio" :value="true" name="broadcast-stop-recording" aria-label="Stop recording when ending stream" :disabled="!!broadcast.busy" /><span><strong>Stop stream and recording</strong><small>Finish the local recording as well.</small></span></label>
            <p class="broadcast-caption">Your scenes, camera sources and Main audio stay unchanged.</p>
          </section>
        </template>
        <p v-if="broadcast.snapshot?.session?.error" class="broadcast-error" role="alert"><CircleAlert :size="14" /><span>{{ broadcast.snapshot.session.error }}</span></p>
        <p v-if="broadcast.error" class="broadcast-error" role="alert"><CircleAlert :size="14" /><span>{{ broadcast.error }}</span><button v-if="!config" type="button" class="broadcast-text-button" @click="broadcast.refresh()">Retry</button></p>
      </div>
      <footer v-if="config" class="broadcast-panel-footer">
        <span v-if="phase === 'main' && dirty" class="broadcast-footer-message is-unsaved"><CircleAlert :size="13" />Save setup before going live.</span>
        <span v-else-if="saved && phase === 'main'" class="broadcast-footer-message is-saved" role="status"><Check :size="13" />Setup saved</span>
        <span v-else class="broadcast-footer-message"><ShieldCheck :size="13" />Program + Main audio</span>
        <div class="broadcast-footer-actions">
          <button v-if="phase === 'start'" type="button" class="broadcast-primary" :disabled="!!broadcast.busy || !preflight?.ready || dirty" @click="start"><LoaderCircle v-if="broadcast.busy" :size="14" class="broadcast-spin" /><Radio v-else :size="14" />{{ broadcast.busy === 'start' ? 'Starting stream…' : 'Go Live' }}</button>
          <button v-else-if="phase === 'stop'" type="button" class="broadcast-danger" :disabled="!!broadcast.busy" @click="stop"><LoaderCircle v-if="broadcast.busy" :size="14" class="broadcast-spin" /><Square v-else :size="12" />{{ broadcast.busy === 'stop' ? 'Ending stream…' : 'End stream' }}</button>
          <template v-else>
            <button v-if="dirty" type="button" class="broadcast-secondary" :disabled="settingsDisabled || !dirty" @click="saveSettings"><LoaderCircle v-if="broadcast.busy === 'save'" :size="14" class="broadcast-spin" />Save setup</button>
            <button v-if="broadcast.active" type="button" class="broadcast-danger" :disabled="!!broadcast.busy" @click="prepareStop"><Square :size="12" />End stream</button>
            <button v-else type="button" class="broadcast-primary" :disabled="!!broadcast.busy || dirty" @click="prepareStart"><LoaderCircle v-if="broadcast.busy && broadcast.busy !== 'save'" :size="14" class="broadcast-spin" /><ArrowUpRight v-else :size="14" />Review stream</button>
          </template>
        </div>
      </footer>
    </DialogContent>
  </Dialog>
</template>
