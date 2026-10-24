<script setup lang="ts">
import { computed, nextTick, onMounted, onBeforeUnmount, ref, watch } from 'vue';
import { useRouter } from 'vue-router';
import { toast } from 'vue-sonner';
import { useFullscreen, useResizeObserver } from '@vueuse/core';
import { Aperture, ArrowRightLeft, Plus, Copy, Trash2, Layers, Camera, Monitor,
  Mic, Image, Film, Music2, Presentation, Lock, Volume2, VolumeX, Circle, Square as StopIcon,
  FolderOpen, LoaderCircle, Power, ChevronRight, Headphones, CircleHelp, RotateCcw, Play, Pause, Repeat, PanelRightClose, PanelRightOpen, PanelLeftClose, PanelLeftOpen, Maximize2, Minimize2, AlertCircle, Search, X, LayoutGrid, List, Keyboard, Settings2 } from 'lucide-vue-next';
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogDescription } from '@/components/ui/dialog';
import LoginGate from '@/components/shell/LoginGate.vue';
import WorkspaceHeader from '@/components/shell/WorkspaceHeader.vue';
import LiveViewButton from '@/components/shell/LiveViewButton.vue';
import BroadcastButton from '@/components/broadcast/BroadcastButton.vue';
import MobileControlButton from '@/components/mobile/MobileControlButton.vue';
import ChannelNav from '@/components/shell/ChannelNav.vue';
import StudioMonitor from '@/components/studio/StudioMonitor.vue';
import ScenePoster from '@/components/studio/ScenePoster.vue';
import SourceDialog from '@/components/studio/SourceDialog.vue';
import StudioInspector from '@/components/studio/StudioInspector.vue';
import StudioPropertyInput from '@/components/studio/StudioPropertyInput.vue';
import StudioCanvas from '@/components/studio/StudioCanvas.vue';
import StudioLayersPanel from '@/components/studio/StudioLayersPanel.vue';
import SceneShortcutsDialog from '@/components/studio/SceneShortcutsDialog.vue';
import OutputAudioControl from '@/components/studio/OutputAudioControl.vue';
import StudioOutputsPanel from '@/components/studio/StudioOutputsPanel.vue';
import { useStudioStore } from '@/stores/studio';
import { useIdentityStore } from '@/stores/identity';
import { useContentStore } from '@/stores/content';
import { shortId } from '@/lib/ids';
import { studioApi } from '@/lib/studio/api';
import { useAnimationPreview } from '@/composables/useAnimationPreview';
import { useStudioTransitions } from '@/composables/useStudioTransitions';
import { useConfirmation } from '@/composables/useConfirmation';
import { animationTotalMs } from '@/lib/studio/animation';
import { describeMainAudioStatus } from '@/lib/studio/main-audio-status';
import type { StudioSource, StudioScene } from '../../../shared/production';
import '@/styles/studio.css';
import '@/styles/workspaces.css';

const studio = useStudioStore(), identity = useIdentityStore(), content = useContentStore(), router = useRouter();
const motion = useAnimationPreview();
const { confirmAction } = useConfirmation();
const { fadeDurationInput, setFadeDuration, take, canTake } = useStudioTransitions();
const canOperate = computed(() => identity.can('*', 'author'));
const sourceOpen = ref(false), guideOpen = ref(false);
const propertiesSourceId = ref<string | null>(null);
function addSourceDialog() { propertiesSourceId.value = null; sourceOpen.value = true; }
function editSourceDialog(source: StudioSource) { propertiesSourceId.value = source.id; sourceOpen.value = true; }
const sceneShortcutsOpen = ref(false);
const { isFullscreen, isSupported: fullscreenSupported, toggle: toggleNativeFullscreen } = useFullscreen(document.documentElement);
async function toggleFullscreen() {
  try { await toggleNativeFullscreen(); }
  catch { toast.error('Fullscreen is unavailable in this window. Try opening Lumen in a browser window.'); }
}
const scenesToggle = ref<HTMLButtonElement | null>(null);
const sceneSearch = ref('');
const sceneView = ref<'thumbnails' | 'list'>((() => {
  try { return localStorage.getItem('lumen.studio.scene-view') === 'list' ? 'list' : 'thumbnails'; } catch { return 'thumbnails'; }
})());
watch(sceneView, view => {
  try { localStorage.setItem('lumen.studio.scene-view', view); } catch { /* Optional layout preference. */ }
});
const filteredScenes = computed(() => {
  const query = sceneSearch.value.trim().toLocaleLowerCase();
  return studio.state?.scenes.filter(scene => !query || scene.name.toLocaleLowerCase().includes(query)) ?? [];
});
function sceneNumber(id: string) { return String((studio.state?.scenes.findIndex(scene => scene.id === id) ?? -1) + 1).padStart(2, '0'); }
const scenesCollapsed = ref((() => {
  try { return localStorage.getItem('lumen.studio.scenes-collapsed') === 'true'; } catch { return false; }
})());
watch(scenesCollapsed, collapsed => {
  try { localStorage.setItem('lumen.studio.scenes-collapsed', String(collapsed)); } catch { /* Optional layout preference. */ }
});
async function collapseScenes() {
  scenesCollapsed.value = true;
  await nextTick();
  scenesToggle.value?.focus({ preventScroll: true });
}
const studioHeader = ref<InstanceType<typeof WorkspaceHeader> | null>(null), headerHeight = ref(64);
useResizeObserver(studioHeader, entries => { const entry = entries[0]; if (entry) headerHeight.value = entry.target.getBoundingClientRect().height; });
const engineDiagnostics = ref(''), diagnosticsLoading = ref(false);
const engineError = computed(() => {
  const message = studio.status.error?.replace(/\u001b\[[0-9;]*m/g, '').trim() ?? '';
  return /page\.goto|net::ERR_|Call log:|browserType\./.test(message)
    ? 'The production engine could not connect to Lumen. Try starting it again.' : message;
});
async function showEngineDiagnostics(event: Event) {
  if (!(event.target as HTMLDetailsElement).open) return;
  diagnosticsLoading.value = true;
  try { engineDiagnostics.value = JSON.stringify(await studioApi.diagnostics(), null, 2); }
  catch { engineDiagnostics.value = 'Details are unavailable. Check the station connection and try again.'; }
  finally { diagnosticsLoading.value = false; }
}
const inspectorToggle = ref<HTMLButtonElement | null>(null);
const inspectorCollapsed = ref((() => {
  try { const saved = localStorage.getItem('lumen.studio.inspector-collapsed'); if (saved !== null) return saved === 'true'; } catch { /* Optional layout preference. */ }
  return window.matchMedia('(max-width: 1050px)').matches;
})());
watch(inspectorCollapsed, value => {
  try { localStorage.setItem('lumen.studio.inspector-collapsed', String(value)); } catch { /* Optional layout preference. */ }
});
async function collapseInspector() {
  inspectorCollapsed.value = true;
  await nextTick();
  inspectorToggle.value?.focus({ preventScroll: true });
}
async function inspectLayer() {
  inspectorCollapsed.value = false;
  await nextTick();
  const name = document.querySelector<HTMLInputElement>('[data-inspector-layer-name]');
  name?.focus({ preventScroll: true });
  name?.select();
}
const lowerTab = ref<'sources' | 'audio'>('sources'), monitorAudio = ref(false), programReady = ref(false);
const now = ref(Date.now());
const clock = window.setInterval(() => { now.value = Date.now(); }, 1000);
const engineRunning = computed(() => studio.status.state === 'running');
const recording = computed(() => studio.status.recording);
const broadcastActive = computed(() => ['starting', 'live', 'stopping'].includes(studio.status.broadcast?.state ?? ''));
const selected = computed(() => studio.selectedScene);
const sceneAnimationDuration = computed(() => animationTotalMs(selected.value));
const scenePreviewPlaying = computed(() => motion.playing.value && motion.sceneId.value === selected.value?.id && motion.layerId.value === null);
function previewSceneAnimations() {
  if (!selected.value || !sceneAnimationDuration.value) return;
  motion.setOverride(null);
  if (scenePreviewPlaying.value) motion.pause();
  else motion.play(selected.value.id, null, sceneAnimationDuration.value);
}
function textOnly(source: StudioSource) {
  return source.kind === 'channel' && ['scripture', 'lyrics'].includes(content.channels.find(channel => channel.id === source.channelId)?.kind ?? '');
}
const audioSources = computed(() => studio.state?.sources.filter(source => source.kind !== 'image' && !textOnly(source)) ?? []);
const mainAudio = computed(() => studio.state?.sources.find(source => source.id === studio.state?.mainAudioSourceId));
const textOnlyMain = computed(() => !!mainAudio.value && textOnly(mainAudio.value));
const mainAudioBadge = computed(() => mainAudio.value ? describeMainAudioStatus(mainAudio.value, studio.status.state,
  studio.status.sources[mainAudio.value.id], studio.status.sourceErrors[mainAudio.value.id], textOnlyMain.value) : null);
function mainAudioUnavailable(source: StudioSource) {
  return source.id === studio.state?.mainAudioSourceId && engineRunning.value
    && ['missing', 'error'].includes(studio.status.sources[source.id] ?? 'missing');
}
function setMainAudio(sourceId: string | null) {
  if (studio.saving || (sourceId && !audioSources.value.some(source => source.id === sourceId))) return;
  run(studio.setMainAudio(sourceId));
}
const icons = { camera: Camera, screen: Monitor, microphone: Mic, image: Image, video: Film, audio: Music2, channel: Presentation };
const liveEdited = computed(() => selected.value?.id === studio.state?.program?.id && JSON.stringify(selected.value) !== JSON.stringify(studio.state?.program));

async function init() { studio.reconnect(); await Promise.all([studio.load(), content.load(), studio.refreshRecordings()]); }
onMounted(async () => { await identity.load(); if (identity.isAuthenticated) await init(); });
watch(() => identity.isAuthenticated, value => { if (value && identity.ready) void init(); });
onBeforeUnmount(() => { clearInterval(clock); });

function run(promise: Promise<unknown>) { void promise.catch(() => {}); }
function openRecordings() { window.open('/recordings', '_blank', 'noopener'); }
function value(e: Event) { return (e.target as HTMLInputElement).value; }
function time(ms: number) { const seconds = Math.floor(Math.max(0, ms) / 1000); return `${String(Math.floor(seconds / 3600)).padStart(2, '0')}:${String(Math.floor(seconds / 60) % 60).padStart(2, '0')}:${String(seconds % 60).padStart(2, '0')}`; }
function bytes(n: number) { return n >= 1024 ** 3 ? `${(n / 1024 ** 3).toFixed(1)} GB` : `${(n / 1024 ** 2).toFixed(1)} MB`; }
function db(volume: number) { return volume <= 0 ? '−∞' : (20 * Math.log10(volume)).toFixed(1); }
function isLive(scene: StudioScene) { return studio.state?.program?.id === scene.id; }
async function deleteScene() {
  if (!selected.value || !canOperate.value) return;
  const { id, name } = selected.value;
  if (!await confirmAction({
    title: 'Delete scene?',
    description: `“${name}” will be removed from the scene list.`,
    note: 'Committed live outputs will keep their current picture.',
    confirmLabel: 'Delete scene',
    tone: 'danger',
  })) return;
  if (canOperate.value && studio.state?.scenes.some(scene => scene.id === id)) run(studio.removeScene(id));
}
async function deleteSource(source: StudioSource) {
  if (!canOperate.value) return;
  const { id, name } = source;
  if (!await confirmAction({
    title: 'Remove source?',
    description: `“${name}” and its layers will be removed from draft scenes.`,
    note: 'Sources used in live outputs must be removed from those outputs first.',
    confirmLabel: 'Remove source',
    tone: 'danger',
  })) return;
  if (canOperate.value && studio.state?.sources.some(input => input.id === id)) run(studio.removeSource(id));
}
async function connect(source: StudioSource) { try { await studio.connectSource(source); } catch (e) { toast.error((e as Error).message); } }
function updateAudio(source: StudioSource, patch: Partial<StudioSource['audio']>) {
  if (studio.saving) return;
  const wasMain = source.id === studio.state?.mainAudioSourceId;
  run(studio.edit(draft => {
    // Main can change on another controller while this edit is queued. Never
    // unmute the former main feed or restore an older audio object over it.
    if (wasMain && draft.mainAudioSourceId !== source.id) return;
    const current = draft.sources.find(input => input.id === source.id);
    if (current) Object.assign(current.audio, patch);
  }));
}
function playback(source: StudioSource, restart = false) {
  const current = source.playback ?? { paused: false, restart: 0 };
  run(studio.updateSource(source.id, { playback: restart ? { ...current, paused: false, restart: current.restart + 1 } : { ...current, paused: !current.paused } }));
}
function addOutput() { run(studio.edit(d => d.outputs.push({ id: shortId('output'), name: `Output ${d.outputs.length + 1}`, mode: 'program', scene: null, blanked: false, audioEnabled: false }))); }
function renameOutput(id: string, name: string) {
  // Capture the input's submitted value now, not from a DOM event later when
  // a previous queued save (or an engine status render) has changed the field.
  const current = studio.state?.outputs.find(output => output.id === id);
  const next = name.trim().slice(0, 100) || current?.name;
  if (!next || next === current?.name) return;
  run(studio.edit(draft => {
    const output = draft.outputs.find(item => item.id === id);
    if (output) output.name = next;
  }));
}
async function removeOutput(id: string) {
  const output = studio.state?.outputs.find(item => item.id === id);
  if (!output || !canOperate.value) return;
  const name = output.name;
  if (!await confirmAction({
    title: 'Remove output?',
    description: `“${name}” will be removed. Any screen following this output will disconnect.`,
    confirmLabel: 'Remove output',
    tone: 'danger',
  })) return;
  if (canOperate.value && studio.state?.outputs.some(item => item.id === id)) run(studio.edit(d => { d.outputs = d.outputs.filter(o => o.id !== id); }));
}
function keydown(e: KeyboardEvent) {
  const target = e.target instanceof Element ? e.target : null;
  if (e.defaultPrevented || e.isComposing || e.ctrlKey || e.metaKey || e.altKey ||
    target?.closest('input, textarea, select, a, summary, [contenteditable]:not([contenteditable="false"]), [role="dialog"], [role="menu"], [role="menuitem"]') ||
    document.querySelector('[data-studio-layer-menu], [data-animation-editor]') || sourceOpen.value || guideOpen.value) return;
  const button = target?.closest('button');
  if (!e.repeat && e.key.toLowerCase() === 'f' && fullscreenSupported.value &&
    (!button || button.matches('.scene-card, .transition-button, .studio-fullscreen-toggle'))) {
    e.preventDefault(); void toggleFullscreen(); return;
  }
  // Scene and transition controls keep the Studio shortcuts after a click;
  // Enter still activates the focused button. Other buttons stay native.
  if (button && !button.matches('.scene-card, .transition-button')) return;
  // A held Space must not arm a native button click on keyup after the first
  // shortcut was handled. Separate physical presses continue to swap normally.
  if (e.repeat) { if (e.code === 'Space') e.preventDefault(); return; }
  if (motion.elapsedMs.value !== null) {
    if (e.key === 'Escape') { e.preventDefault(); motion.stop(); }
    if (e.code === 'Space') { e.preventDefault(); if (motion.playing.value) motion.pause(); else if (motion.sceneId.value) motion.play(motion.sceneId.value, motion.layerId.value, motion.durationMs.value); }
    return;
  }
  if (e.code === 'Space' && canOperate.value && selected.value) { e.preventDefault(); take(e.shiftKey ? 'fade' : 'cut'); }
  if (e.key === 'Escape') studio.selectedLayerId = null;
}
onMounted(() => window.addEventListener('keydown', keydown));
onBeforeUnmount(() => window.removeEventListener('keydown', keydown));
</script>

<template>
  <LoginGate v-if="identity.ready && !identity.isAuthenticated" />
  <div v-else-if="!identity.ready || studio.loading && !studio.state" class="studio-loading"><Aperture :size="30" /><span>Preparing your studio…</span></div>
  <div v-else-if="!canOperate" class="studio-loading"><h1>Studio access</h1><p>Your account needs an author or owner role for all channels.</p><button class="s-button" @click="router.push('/')">Back to Present</button></div>
  <div v-else-if="studio.state" class="studio-app" :class="{ 'inspector-collapsed': inspectorCollapsed, 'scenes-collapsed': scenesCollapsed }" :style="{ '--studio-header-height': headerHeight + 'px' }">
    <WorkspaceHeader ref="studioHeader">
      <div class="engine-indicator"><span :class="['status-dot', { online: engineRunning, fault: studio.status.state === 'error' }]" /><span>{{ engineRunning ? 'Engine running' : studio.status.state === 'starting' ? 'Starting engine' : studio.status.state === 'error' ? 'Engine unavailable' : 'Engine offline' }}</span><small v-if="engineRunning">{{ studio.status.fps }} fps</small></div>
      <div class="header-actions">
        <MobileControlButton />
        <BroadcastButton />
        <button type="button" class="s-button recordings-button" aria-label="Recordings" title="Recordings & clips — opens in a new tab" @click="openRecordings"><FolderOpen :size="15" /><span class="button-label">Recordings</span></button>
        <button class="s-button engine-button" :class="{ primary: !engineRunning }" :aria-label="studio.engineBusy ? 'Starting engine' : engineRunning ? 'Stop engine' : 'Start engine'" :title="broadcastActive ? 'End the stream before stopping the engine' : engineRunning ? 'Stop engine' : 'Start engine'" :disabled="studio.engineBusy || !!recording || broadcastActive" @click="studio.toggleEngine"><LoaderCircle v-if="studio.engineBusy" :size="14" class="spin" /><Power v-else :size="14" /><span class="button-label">{{ studio.engineBusy ? 'Starting…' : engineRunning ? 'Stop engine' : 'Start engine' }}</span></button>
        <button class="s-button record-button" :class="{ recording: !!recording }" :disabled="studio.recordingBusy || !engineRunning || !studio.state.program || recording?.status === 'stopping'" @click="studio.toggleRecord"><StopIcon v-if="recording" :size="12" fill="currentColor" /><Circle v-else :size="12" fill="currentColor" />{{ recording ? time(now - Date.parse(recording.createdAt)) : 'Record' }}</button>
        <span class="header-action-divider" />
        <LiveViewButton studio />
      </div>
    </WorkspaceHeader>
    <ChannelNav studio />
    <SceneShortcutsDialog v-model:open="sceneShortcutsOpen" />

    <aside id="studio-scenes" v-show="!scenesCollapsed" class="scene-sidebar" aria-label="Scenes">
      <div class="sidebar-title"><span>Scenes <small class="panel-count">{{ studio.state.scenes.length }}</small></span><button class="s-icon" aria-label="Scene shortcuts" title="Scene shortcuts" @click="sceneShortcutsOpen = true"><Keyboard :size="15" /></button><button class="s-icon" aria-label="Add scene" title="Add scene" @click="run(studio.addScene())"><Plus :size="16" /></button><button class="s-icon" aria-label="Collapse scenes" title="Collapse scenes" @click="collapseScenes"><PanelLeftClose :size="15" /></button></div>
      <div class="scene-browser-tools">
        <label class="scene-search"><Search :size="13" /><input v-model="sceneSearch" aria-label="Find a scene" placeholder="Find a scene…" @keydown.esc.stop="sceneSearch = ''" /><button v-if="sceneSearch" class="s-icon" aria-label="Clear scene search" @click="sceneSearch = ''"><X :size="12" /></button></label>
        <div class="scene-view-controls" role="group" aria-label="Scene list appearance"><button class="s-icon" :aria-pressed="sceneView === 'thumbnails'" aria-label="Show scene thumbnails" title="Thumbnail view" @click="sceneView = 'thumbnails'"><LayoutGrid :size="13" /></button><button class="s-icon" :aria-pressed="sceneView === 'list'" aria-label="Show compact scene list" title="Compact list" @click="sceneView = 'list'"><List :size="14" /></button></div>
      </div>
      <div :class="['scene-list', { 'is-compact': sceneView === 'list' }]"><button v-for="scene in filteredScenes" :key="scene.id" :class="['scene-card', { selected: selected?.id === scene.id }]" :aria-pressed="selected?.id === scene.id" @click="run(studio.selectScene(scene.id))">
        <div class="scene-thumbnail"><ScenePoster :scene="scene" :sources="studio.state.sources" /><span v-if="isLive(scene)" class="scene-live"><span />PROGRAM</span><span class="scene-number">{{ sceneNumber(scene.id) }}</span></div>
        <div class="scene-meta"><div class="scene-label"><span>{{ scene.name }}</span><span v-if="selected?.id === scene.id" class="preview-dot" /></div><small>{{ scene.layers.length }} layers<span v-if="isLive(scene)" class="scene-inline-live">Program</span></small></div>
      </button><div v-if="!filteredScenes.length" class="scene-search-empty"><Search v-if="sceneSearch.trim()" :size="18" /><Layers v-else :size="18" /><b>{{ sceneSearch.trim() ? 'No matching scenes' : 'No scenes yet' }}</b><span>{{ sceneSearch.trim() ? 'Try a different name.' : 'Start with a scene for your service.' }}</span><button v-if="sceneSearch.trim()" class="s-button" @click="sceneSearch = ''">Clear search</button><button v-else class="s-button" @click="run(studio.addScene())"><Plus :size="12" />New scene</button></div></div>
      <div class="scene-sidebar-footer"><button class="s-button" @click="run(studio.addScene())"><Plus :size="13" /> New scene</button><button class="s-icon" title="Duplicate scene" aria-label="Duplicate scene" :disabled="!selected" @click="run(studio.addScene(true))"><Copy :size="14" /></button><button class="s-icon" title="Delete scene" aria-label="Delete scene" :disabled="!selected" @click="deleteScene"><Trash2 :size="14" /></button></div>
    </aside>

    <main class="studio-workspace">
      <h1 class="sr-only">Production Studio</h1>
      <div class="workspace-heading"><div class="workspace-context"><button ref="scenesToggle" class="s-icon panel-toggle scenes-toggle" :aria-label="scenesCollapsed ? 'Show scenes' : 'Hide scenes'" :title="scenesCollapsed ? 'Show scenes' : 'Hide scenes'" :aria-expanded="!scenesCollapsed" aria-controls="studio-scenes" @click="scenesCollapsed = !scenesCollapsed"><PanelLeftOpen v-if="scenesCollapsed" :size="17" /><PanelLeftClose v-else :size="17" /></button><Layers :size="15" class="workspace-scene-icon" /><span class="workspace-scene-label">Scene</span><ChevronRight :size="12" class="workspace-scene-label" /><b>{{ selected?.name ?? 'Select a scene' }}</b><span v-if="liveEdited" class="scene-edit-status">Unpublished changes</span></div><div class="workspace-heading-tools"><button v-if="fullscreenSupported" class="s-icon panel-toggle studio-fullscreen-toggle" :aria-label="isFullscreen ? 'Exit fullscreen' : 'Enter fullscreen'" :title="isFullscreen ? 'Exit fullscreen — F or Esc' : 'Enter fullscreen — F'" aria-keyshortcuts="F" :aria-pressed="isFullscreen" @click="toggleFullscreen"><Minimize2 v-if="isFullscreen" :size="16" /><Maximize2 v-else :size="16" /></button><button class="s-icon" aria-label="Studio guide" title="Studio guide" @click="guideOpen = true"><CircleHelp :size="17" /></button><button ref="inspectorToggle" class="s-icon inspector-toggle" :aria-label="inspectorCollapsed ? 'Show inspector' : 'Hide inspector'" :title="inspectorCollapsed ? 'Show inspector' : 'Hide inspector'" :aria-expanded="!inspectorCollapsed" aria-controls="studio-inspector" @click="inspectorCollapsed = !inspectorCollapsed"><PanelRightOpen v-if="inspectorCollapsed" :size="18" /><PanelRightClose v-else :size="18" /></button></div></div>
      <div v-if="engineError" class="studio-banner engine-alert" role="alert">
        <div class="engine-alert-message"><AlertCircle :size="17" /><div><b>Engine unavailable</b><p>{{ engineError }}</p></div><button class="s-button" :disabled="studio.engineBusy || !!recording" @click="studio.toggleEngine"><RotateCcw :size="13" />{{ studio.engineBusy ? 'Starting…' : 'Retry' }}</button></div>
        <details class="engine-diagnostics" @toggle="showEngineDiagnostics"><summary>Technical details</summary><pre>{{ diagnosticsLoading ? 'Loading details…' : engineDiagnostics }}</pre></details>
      </div>
      <div v-if="studio.state.channelInsert" class="studio-banner" role="status">An earlier channel override is still on Program. Cut or Fade a Studio scene to return to scene-only control.</div>
      <div class="monitors-grid">
        <section class="monitor-panel preview-panel"><div class="monitor-title"><span><span class="tiny-dot" />PREVIEW</span><small>{{ selected?.name ?? 'Choose a scene' }}<i v-if="liveEdited">Unpublished edits</i></small></div>
          <StudioCanvas :scene="selected" :sources="studio.state.sources" :engine-running="engineRunning" @inspect="inspectLayer" />
          <div class="monitor-bottom"><span>Draft · 1920 × 1080</span><button v-if="sceneAnimationDuration" class="scene-rehearsal-button" :aria-label="scenePreviewPlaying ? 'Pause scene animation preview' : 'Preview scene animations'" title="Rehearse all element animations locally" @click="previewSceneAnimations"><Pause v-if="scenePreviewPlaying" :size="11" /><Play v-else :size="11" />{{ scenePreviewPlaying ? 'Pause' : 'Rehearse' }}</button><span>16:9</span></div>
        </section>
        <div class="transition-controls" role="group" aria-label="Scene transitions">
          <button class="transition-button" aria-label="Cut" aria-keyshortcuts="Space" title="Cut and swap Preview / Program — Space" :disabled="!canTake" @click="take('cut')"><span>Cut<ArrowRightLeft :size="14" /></span><kbd aria-hidden="true">Space</kbd></button>
          <button class="transition-button fade-button" aria-label="Fade" aria-keyshortcuts="Shift+Space" title="Fade and swap Preview / Program — Shift + Space" :disabled="!canTake" @click="take('fade')"><span>Fade<ArrowRightLeft :size="14" /></span><kbd aria-hidden="true">⇧ Space</kbd></button>
          <label class="transition-duration"><span>Duration</span><span class="duration-field"><input v-model="fadeDurationInput" type="number" aria-label="Fade duration" min="100" max="3000" step="50" @change="setFadeDuration" /><span>ms</span></span></label>
        </div>
        <section class="monitor-panel program-panel"><div class="monitor-title"><span><span class="tiny-dot" />PROGRAM</span><small>{{ studio.state.program?.name ?? 'Nothing on air yet' }}</small></div>
          <div class="monitor-frame"><div v-if="!programReady" class="program-empty"><Monitor :size="28" :stroke-width="1.25" /><b>{{ studio.state.program ? engineRunning ? 'Connecting to Program…' : 'Engine offline' : 'No scene on Program' }}</b><p>{{ studio.state.program ? studio.state.program.name : 'Choose a scene, then Cut or Fade to Program.' }}</p></div><StudioMonitor output-id="program" :audible="monitorAudio" @ready="programReady = $event" @blocked="monitorAudio = false" /><span v-if="programReady" class="program-badge"><span />LIVE PROGRAM</span><span v-if="recording && programReady" class="recording-badge">● REC</span></div>
          <div class="monitor-bottom"><span>{{ recording ? 'Recording Program + master audio' : 'Live composition' }}</span><button :class="{ active: monitorAudio }" @click="monitorAudio = !monitorAudio" :title="monitorAudio ? 'Mute monitoring' : 'Monitor audio — use headphones'"><Headphones :size="12" />{{ monitorAudio ? 'Listening' : 'Monitor' }}</button></div>
        </section>
      </div>
      <p class="preview-note"><Lock :size="11" />Edits stay in Preview until you Cut or Fade.</p>

      <div class="production-tools">
        <StudioLayersPanel @add-source="addSourceDialog" @inspect="inspectLayer" />
        <section class="tool-panel source-audio-panel"><div class="tool-heading"><div class="tool-tabs" role="group" aria-label="Source and audio panels"><button :class="{ active: lowerTab === 'sources' }" :aria-pressed="lowerTab === 'sources'" @click="lowerTab = 'sources'">Sources <span>{{ studio.state.sources.length }}</span></button><button :class="{ active: lowerTab === 'audio' }" :aria-pressed="lowerTab === 'audio'" @click="lowerTab = 'audio'">Audio mixer</button></div><button class="s-icon" aria-label="Add production source" @click="addSourceDialog"><Plus :size="15" /></button></div>
          <div v-if="lowerTab === 'sources'" class="source-list">
            <div v-if="!studio.state.sources.length" class="sources-empty"><div class="source-empty-icons"><Camera :size="20" /><Mic :size="20" /><Image :size="20" /></div><b>No sources added</b><p>Connect a camera or microphone,<br />or add media and presentation channels.</p><button class="s-button" @click="addSourceDialog"><Plus :size="13" /> Add source</button></div>
            <div v-for="source in studio.state.sources" :key="source.id" class="source-row" :data-source-id="source.id">
              <span class="source-type-icon"><component :is="icons[source.kind]" :size="15" /></span>
              <button type="button" class="source-name source-properties-trigger" :aria-label="'Open properties for ' + source.name" title="Source properties" @click="editSourceDialog(source)"><div class="source-name-line"><b :title="source.name">{{ source.name }}</b><span v-if="source.id === studio.state.mainAudioSourceId && mainAudioBadge" class="main-audio-badge source-main-audio-badge" data-testid="source-main-audio-badge" :data-state="mainAudioBadge.state" :title="mainAudioBadge.title" role="status"><VolumeX v-if="mainAudioBadge.state === 'muted'" :size="10" aria-hidden="true" /><AlertCircle v-else-if="['disconnected', 'error', 'no-audio'].includes(mainAudioBadge.state)" :size="10" aria-hidden="true" />{{ mainAudioBadge.label }}</span></div><small :class="{ 'danger-text': studio.status.sources[source.id] === 'error' }" :title="studio.status.sourceErrors[source.id]">{{ studio.status.sourceErrors[source.id] || (source.playback?.paused ? 'Paused' : studio.status.sources[source.id] === 'ready' ? 'Ready' : studio.status.sources[source.id] === 'loading' && ['camera', 'screen'].includes(source.kind) ? 'Waiting for video signal' : ['camera', 'screen', 'microphone'].includes(source.kind) ? 'Input not connected' : engineRunning ? studio.status.sources[source.id] || 'Loading' : 'Ready when engine starts') }}</small></button>
              <template v-if="['video', 'audio'].includes(source.kind)">
                <button class="s-icon" :aria-label="(source.playback?.paused ? 'Play ' : 'Pause ') + source.name" :title="source.playback?.paused ? 'Play source' : 'Pause source'" @click="playback(source)"><Play v-if="source.playback?.paused" :size="13" /><Pause v-else :size="13" /></button>
                <button class="s-icon" :aria-label="'Restart ' + source.name" title="Restart source" @click="playback(source, true)"><RotateCcw :size="13" /></button>
                <button class="s-icon" :class="{ 'source-looping': source.loop }" :aria-label="'Loop ' + source.name" :aria-pressed="source.loop" title="Toggle loop" @click="run(studio.updateSource(source.id, { loop: !source.loop }))"><Repeat :size="13" /></button>
              </template>
              <button v-if="!['microphone', 'audio'].includes(source.kind)" class="s-icon" :aria-label="'Add ' + source.name + ' to scene'" title="Add to scene" :disabled="!selected" @click="run(studio.addLayer({ kind: 'source', name: source.name, sourceId: source.id, x: 0, y: 0, width: 100, height: 100 }))"><Plus :size="13" /></button>
              <button v-if="['camera', 'screen', 'microphone'].includes(source.kind)" class="source-connect" @click="studio.connectedSources.includes(source.id) ? studio.disconnectSource(source.id) : connect(source)">{{ studio.connectedSources.includes(source.id) ? 'Disconnect' : 'Connect' }}</button>
              <button class="s-icon" :aria-label="'Properties for ' + source.name" title="Source properties" @click="editSourceDialog(source)"><Settings2 :size="14" /></button>
              <button class="s-icon" title="Remove source" :aria-label="'Remove ' + source.name" @click="deleteSource(source)"><Trash2 :size="12" /></button>
            </div>
          </div>
          <div v-else class="audio-list">
            <div v-if="textOnlyMain && mainAudio" class="audio-main-warning legacy-main-warning" data-testid="main-audio-status" role="status"><AlertCircle :size="12" /><span><b>{{ mainAudio.name }}</b> is text-only. Choose an audio input as Main.</span><button class="s-icon" aria-label="Clear Main audio" title="Clear Main audio and mute this input" :disabled="!!studio.saving" @click="setMainAudio(null)"><X :size="12" /></button></div>
            <div v-if="!audioSources.length" class="panel-empty"><Mic :size="22" /><span>Add a microphone, video, or audio file<br />to start mixing.</span></div>
            <div v-for="source in audioSources" :key="source.id" class="audio-strip" :class="{ 'is-main-audio': source.id === studio.state.mainAudioSourceId }" data-testid="audio-mixer-source" :data-source-id="source.id">
              <div class="audio-strip-top"><b :title="source.name">{{ source.name }}</b><div class="main-audio-actions" data-testid="main-audio-actions"><template v-if="source.id === studio.state.mainAudioSourceId"><span class="main-audio-badge" data-testid="main-audio-badge" title="Main audio · persists across every scene">Main</span><button class="s-icon clear-main-audio" aria-label="Clear Main audio" title="Clear Main audio and mute this input" :disabled="!!studio.saving" @click="setMainAudio(null)"><X :size="11" /></button></template><button v-else class="set-main-audio" :aria-label="'Set ' + source.name + ' as Main audio'" title="Keep this audio input across every scene" :disabled="!!studio.saving" @click="setMainAudio(source.id)">Set as Main</button></div><span>{{ db(source.audio.volume) }} dB</span><button class="s-icon" :class="{ muted: source.audio.muted }" :aria-label="(source.audio.muted ? 'Unmute ' : 'Mute ') + source.name" :aria-pressed="source.audio.muted" :disabled="!!studio.saving" @click="updateAudio(source, { muted: !source.audio.muted })"><VolumeX v-if="source.audio.muted" :size="14" /><Volume2 v-else :size="14" /></button></div>
              <div v-if="mainAudioUnavailable(source)" class="audio-main-warning" data-testid="main-audio-status" role="status"><AlertCircle :size="12" /><span :title="studio.status.sourceErrors[source.id]">{{ studio.status.sourceErrors[source.id] || 'Main input disconnected. No automatic fallback.' }}</span><button @click="lowerTab = 'sources'">Check Sources</button></div>
              <div class="audio-meter"><span :style="{ width: (studio.status.levels[source.id] ?? 0) * 100 + '%' }" /></div>
              <StudioPropertyInput type="range" :identity="source.id + ':volume'" min="0" max="1" step="0.01" :aria-label="source.name + ' volume'" :value="source.audio.volume" :pending="!!studio.saving" :disabled="!!studio.saving" @commit="updateAudio(source, { volume: Number($event) })" />
              <div class="audio-routing"><span v-if="source.id === studio.state.mainAudioSourceId" class="main-audio-routing">Every scene</span><select v-else :aria-label="source.name + ' audio mode'" :value="source.audio.mode" :disabled="!!studio.saving" @change="updateAudio(source, { mode: value($event) as 'always' | 'follow' })"><option value="always">Always on</option><option value="follow">Follow scene</option></select><label>Delay <StudioPropertyInput type="number" :identity="source.id + ':delay'" min="0" max="2000" step="10" integer :value="source.audio.delayMs" :aria-label="source.name + ' delay'" :pending="!!studio.saving" :disabled="!!studio.saving" @commit="updateAudio(source, { delayMs: Number($event) })" /> ms</label></div>
            </div>
          </div>
          <OutputAudioControl />
        </section>
      </div>
      <StudioOutputsPanel :outputs="studio.state.outputs" :scenes="studio.state.scenes" :pending="!!studio.saving" :can-operate="canOperate" @add="addOutput" @rename="renameOutput" @route="(id, sceneId) => run(studio.command({ type: 'route', outputId: id, sceneId }))" @blank="(id, blanked) => run(studio.command({ type: 'blank', outputId: id, blanked }))" @audio="id => run(studio.edit(d => { const output = d.outputs.find(item => item.id === id); if (output) output.audioEnabled = !output.audioEnabled; }))" @refresh="id => { const output = studio.state?.outputs.find(item => item.id === id); if (output?.scene) run(studio.command({ type: 'route', outputId: id, sceneId: output.scene.id })); }" @remove="removeOutput" />
    </main>

    <StudioInspector v-show="!inspectorCollapsed" @collapse="collapseInspector" />
    <footer class="studio-statusbar"><span><span class="tiny-dot" :class="{ online: engineRunning }" />{{ studio.saving ? 'Saving…' : 'All changes saved' }}</span><span>LOCAL STATION<ChevronRight :size="10" />{{ studio.state.scenes.length }} scenes<ChevronRight :size="10" />{{ studio.state.outputs.length }} outputs</span><span>{{ recording ? recording.status === 'stopping' ? 'Finishing recording…' : `Recording · ${bytes(recording.bytes)} saved` : '1920 × 1080 · 30 fps' }}</span></footer>
    <SourceDialog v-model:open="sourceOpen" :source-id="propertiesSourceId" />
    <Dialog v-model:open="guideOpen"><DialogContent class="studio-dialog sm:max-w-[520px]"><DialogHeader><DialogTitle>Your production, in focus.</DialogTitle><DialogDescription>A quick guide to the Studio workflow.</DialogDescription></DialogHeader><ol class="studio-guide"><li><b>Build your scenes.</b><span>Add sources and arrange layers in Preview. Select a layer to edit it; drag to move and use its corner to resize.</span></li><li><b>Start the engine.</b><span>The station runs a dedicated renderer. File playback, outputs, and recording continue when you change workspaces or close the control page.</span></li><li><b>Take the moment live.</b><span>Cut instantly with Space, or Fade with Shift + Space. Preview goes live and the previous Program scene returns to Preview, ready to switch back. Set the fade duration between the monitors. Shortcuts pause while you type or use a dialog. Draft edits stay separate from Program and pinned output snapshots.</span></li><li><b>Choose each screen’s picture.</b><span>Follow Program, or pin a scene. Reapply a pinned scene with its refresh button. Blanking only hides that output’s picture; audio has its own control.</span></li><li><b>Keep a record.</b><span>Record captures Program plus master audio. Browser cameras and screen shares require their publishing tab to remain open. Use headphones for monitoring.</span></li></ol></DialogContent></Dialog>
  </div>
</template>
