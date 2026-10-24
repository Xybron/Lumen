<script setup lang="ts">
import { computed, nextTick, onBeforeUnmount, onMounted, ref, watch } from 'vue';
import { useRoute, useRouter } from 'vue-router';
import { DialogRoot, DialogPortal, DialogOverlay, DialogContent, DialogTitle, DialogDescription, DialogClose } from 'reka-ui';
import { ArrowLeft, ArrowUpRight, Check, ChevronDown, Clapperboard, Copy, Download, Film, FolderOpen, Grid2X2, HardDrive, Link2, List, LoaderCircle, Music2, PanelLeftClose, PanelLeftOpen, Play, RefreshCw, Scissors, Search, ShieldCheck, Users, X } from 'lucide-vue-next';
import { toast } from 'vue-sonner';
import WorkspaceHeader from '@/components/shell/WorkspaceHeader.vue';
import LoginGate from '@/components/shell/LoginGate.vue';
import RecordingThumbnail from '@/components/clips/RecordingThumbnail.vue';
import LibraryActions from '@/components/clips/LibraryActions.vue';
import type { LibraryAction } from '@/components/clips/LibraryActions.vue';
import { clipsApi } from '@/lib/clips';
import { copyTimeline, timelineDuration } from '@/lib/clip-timeline';
import { audioExport, exportLabel, exportOptions } from '@/lib/clip-export';
import { studioApi } from '@/lib/studio/api';
import { useIdentityStore } from '@/stores/identity';
import type { ClipDraft, ClipExport, ClipRecording, ClipSettings, ClipWorkspace } from '../../../shared/clips';
import '@/styles/clips.css';
import '@/styles/recording-library.css';

type Collection = 'recordings' | 'mine' | 'team' | 'exports';
const identity = useIdentityStore(), route = useRoute(), router = useRouter();
const workspace = ref<ClipWorkspace | null>(null), loading = ref(false), error = ref('');
const search = ref(''), filter = ref<'all' | 'ready'>('all'), recovering = ref(''), copying = ref(''), cancelling = ref('');
const sidebarOpen = ref(true), view = ref<'grid' | 'list'>('grid'), order = ref<'recent' | 'name'>('recent'), searchField = ref<HTMLInputElement | null>(null);
const newProjectOpen = ref(false), newProjectSearch = ref(''), newProjectField = ref<HTMLInputElement | null>(null);
const collection = computed<Collection>(() => ['mine', 'team', 'exports'].includes(String(route.query.collection)) ? route.query.collection as Collection : 'recordings');
const titles: Record<Collection, string> = { recordings: 'All recordings', mine: 'My projects', team: 'Team projects', exports: 'Previous exports' };
const descriptions: Record<Collection, string> = { recordings: 'Original recordings, ready for your next edit.', mine: 'Your saved edits. Pick up where you left off.', team: 'Browse your team’s work, or make a copy to edit.', exports: 'Earlier exports kept on this station. New exports save to your device instead.' };
let sequence = 0, timer: ReturnType<typeof setInterval> | undefined;
const mine = computed(() => workspace.value?.drafts.filter(draft => draft.ownerId === identity.me?.id) ?? []);
const team = computed(() => workspace.value?.drafts.filter(draft => draft.ownerId !== identity.me?.id) ?? []);
const readyCount = computed(() => workspace.value?.recordings.filter(recording => recording.status === 'complete').length ?? 0);
const previousExports = computed(() => workspace.value?.exports.filter(job => !job.temporary) ?? []);
const activeExports = computed(() => previousExports.value.filter(job => ['queued', 'waiting-live', 'exporting'].includes(job.status)).length);
const navigation = computed(() => [
  { id: 'recordings' as const, label: 'All recordings', icon: Film, count: workspace.value?.recordings.length ?? 0 },
  { id: 'mine' as const, label: 'My projects', icon: Scissors, count: mine.value.length },
  { id: 'team' as const, label: 'Team projects', icon: Users, count: team.value.length },
  ...(previousExports.value.length ? [{ id: 'exports' as const, label: 'Previous exports', icon: Download, count: previousExports.value.length }] : []),
]);
function matching(...values: (string | undefined)[]) { const words = search.value.toLocaleLowerCase().trim().split(/\s+/).filter(Boolean), text = values.filter(Boolean).join(' ').toLocaleLowerCase(); return words.every(word => text.includes(word)); }
function sorted<T extends { name: string; createdAt: string; updatedAt?: string }>(items: T[]) { return [...items].sort((a, b) => order.value === 'name' ? a.name.localeCompare(b.name) : (b.updatedAt ?? b.createdAt).localeCompare(a.updatedAt ?? a.createdAt)); }
const recordings = computed(() => sorted((workspace.value?.recordings ?? []).filter(recording => (filter.value === 'all' || recording.status === 'complete') && matching(recording.name))));
const projects = computed(() => sorted((collection.value === 'mine' ? mine.value : team.value).filter(draft => matching(draft.name, draft.ownerName, recordingFor(draft.recordingId)?.name))));
const exports = computed(() => sorted(previousExports.value.filter(job => matching(job.name, job.status, ownerFor(job.ownerId)))));
const visibleCount = computed(() => collection.value === 'recordings' ? recordings.value.length : collection.value === 'exports' ? exports.value.length : projects.value.length);
const totalCount = computed(() => navigation.value.find(item => item.id === collection.value)?.count ?? 0);
const availableRecordings = computed(() => [...workspace.value?.recordings ?? []].filter(recording => recording.status === 'complete' && recording.name.toLocaleLowerCase().includes(newProjectSearch.value.trim().toLocaleLowerCase())).sort((a, b) => b.createdAt.localeCompare(a.createdAt)));
const storedBytes = computed(() => workspace.value?.recordings.reduce((sum, recording) => sum + recording.bytes, 0) ?? 0);
function collectionUrl(id: Collection) { return id === 'recordings' ? '/recordings' : { path: '/recordings', query: { collection: id } }; }
function editorUrl(id: string, draftId?: string, play = false) { return `/recordings/${encodeURIComponent(id)}/editor${draftId ? `?draft=${encodeURIComponent(draftId)}` : play ? '?play=1' : ''}`; }
function recordingFor(id: string) { return workspace.value?.recordings.find(recording => recording.id === id); }
function ownerFor(id: string) { return id === identity.me?.id ? 'You' : workspace.value?.drafts.find(draft => draft.ownerId === id)?.ownerName ?? 'Team member'; }
function initial(name: string) { return name.trim().charAt(0).toUpperCase() || 'L'; }
function date(value: string) { return new Date(value).toLocaleDateString(undefined, { month: 'short', day: 'numeric', year: 'numeric' }); }
function fullDate(value: string) { return new Date(value).toLocaleString(undefined, { month: 'short', day: 'numeric', year: 'numeric', hour: 'numeric', minute: '2-digit' }); }
function size(bytes: number) { return bytes >= 1024 ** 3 ? `${(bytes / 1024 ** 3).toFixed(1)} GB` : `${(bytes / 1024 ** 2).toFixed(1)} MB`; }
function duration(ms: number) { const seconds = Math.max(0, Math.round(ms / 1000)), hours = Math.floor(seconds / 3600); return `${hours ? hours + ':' : ''}${String(Math.floor(seconds / 60) % 60).padStart(2, '0')}:${String(seconds % 60).padStart(2, '0')}`; }
function projectDuration(settings: ClipSettings) { return duration(settings.timeline ? timelineDuration(settings.timeline) : settings.outMs - settings.inMs); }
function status(value: string) { return ({ complete: 'Ready to edit', finalizing: 'Processing', stopping: 'Processing', error: 'Needs attention', interrupted: 'Interrupted', recording: 'Recording', starting: 'Starting' } as Record<string, string>)[value] ?? value; }
function exportStatus(job: ClipExport) { return ({ complete: 'Ready to download', 'waiting-live': 'Waiting for Studio to be idle', queued: 'Queued', exporting: `Exporting · ${Math.round(job.progress * 100)}%`, cancelled: 'Cancelled', error: 'Export failed', interrupted: 'Interrupted' } as Record<string, string>)[job.status]; }
function isActive(job: ClipExport) { return ['queued', 'waiting-live', 'exporting'].includes(job.status); }
async function load(quiet = false) {
  const run = ++sequence; if (!quiet) loading.value = true;
  try { const result = await clipsApi.workspace(); if (run === sequence) { workspace.value = result; error.value = ''; } }
  catch (cause) { if (run === sequence) error.value = (cause as Error).message; }
  finally { if (run === sequence) loading.value = false; }
}
async function recover(id: string) {
  if (recovering.value) return; recovering.value = id;
  try { await studioApi.recover(id); toast.success('Recovery started. Original chunks are retained.'); await load(true); }
  catch (cause) { toast.error((cause as Error).message); }
  finally { recovering.value = ''; }
}
async function copyLink(url: string) { try { await navigator.clipboard.writeText(new URL(url, window.location.origin).href); toast.success('Link copied. Teammates will need to sign in to this station.'); } catch { toast.error('Could not copy the link. Open the editor and copy its address instead.'); } }
async function copyProject(draft: ClipDraft) {
  if (copying.value) return; copying.value = draft.id;
  try {
    const saved = await clipsApi.create(draft.recordingId, { name: `${draft.name.slice(0, 113)} · Copy`, inMs: draft.inMs, outMs: draft.outMs, format: draft.format, fit: draft.fit, positionX: draft.positionX, positionY: draft.positionY, ...(draft.timeline ? { timeline: copyTimeline(draft.timeline) } : {}) });
    await router.push(editorUrl(draft.recordingId, saved.id));
  } catch (cause) { toast.error((cause as Error).message); }
  finally { copying.value = ''; }
}
async function cancelExport(job: ClipExport) {
  if (cancelling.value) return; cancelling.value = job.id;
  try { await clipsApi.cancel(job.id); await load(true); toast.success('Export cancelled. The saved project is unchanged.'); }
  catch (cause) { toast.error((cause as Error).message); }
  finally { cancelling.value = ''; }
}
function recordingActions(recording: ClipRecording): LibraryAction[] {
  const actions: LibraryAction[] = [];
  if (recording.status === 'complete') actions.push(
    { label: 'Open editor', icon: Play, run: () => { void router.push(editorUrl(recording.id, undefined, true)); } },
    { label: 'Create a new project', icon: Scissors, run: () => { void router.push(editorUrl(recording.id)); } },
    { label: 'Download original', icon: Download, href: clipsApi.original(recording.id) },
    { label: 'Copy recording link', icon: Link2, run: () => { void copyLink(editorUrl(recording.id)); } },
  );
  else if (['interrupted', 'error'].includes(recording.status) && identity.can('*', 'author')) actions.push({ label: 'Recover recording', icon: RefreshCw, disabled: !!recovering.value, run: () => { void recover(recording.id); } });
  return actions;
}
function projectActions(draft: ClipDraft): LibraryAction[] { return [
  { label: draft.canEdit ? 'Open project' : 'View project', icon: Scissors, run: () => { void router.push(editorUrl(draft.recordingId, draft.id)); } },
  { label: 'Make your own copy', icon: Copy, disabled: !!copying.value, run: () => { void copyProject(draft); } },
  { label: 'Copy project link', icon: Link2, run: () => { void copyLink(editorUrl(draft.recordingId, draft.id)); } },
]; }
function keyboard(event: KeyboardEvent) { if ((event.metaKey || event.ctrlKey) && event.key.toLocaleLowerCase() === 'k' && !newProjectOpen.value && !document.querySelector('[role="dialog"][data-state="open"]')) { event.preventDefault(); searchField.value?.focus(); searchField.value?.select(); } }
function libraryChanged() { if (identity.isAuthenticated) void load(true); }
function focusProjectSearch(event: Event) { event.preventDefault(); void nextTick(() => newProjectField.value?.focus()); }
watch(collection, () => { search.value = ''; filter.value = 'all'; });
watch(() => identity.ready && identity.isAuthenticated, authenticated => { if (authenticated) void load(); else { sequence++; workspace.value = null; newProjectOpen.value = false; } }, { immediate: true });
onMounted(async () => { window.addEventListener('keydown', keyboard); window.addEventListener('lumen:library-imported', libraryChanged); if (!identity.ready) await identity.load(); timer = setInterval(() => { if (identity.isAuthenticated && !document.hidden) void load(true); }, 5000); });
onBeforeUnmount(() => { sequence++; if (timer) clearInterval(timer); window.removeEventListener('keydown', keyboard); window.removeEventListener('lumen:library-imported', libraryChanged); });
</script>

<template>
  <LoginGate v-if="identity.ready && !identity.isAuthenticated" />
  <main v-else class="clips-app recording-library" data-testid="recording-library">
    <WorkspaceHeader>
      <div class="clips-header-location library-header-location"><span class="clips-header-divider" /><Clapperboard :size="15" /><span>Post-production</span></div>
      <div class="clips-header-actions"><span class="clips-safe-label"><ShieldCheck :size="14" />Separate from live production</span><RouterLink :to="identity.can('*', 'author') ? '/studio' : '/'" class="clip-button clip-button-quiet"><ArrowLeft :size="14" /><span>{{ identity.can('*', 'author') ? 'Back to Studio' : 'Back to Lumen' }}</span></RouterLink></div>
    </WorkspaceHeader>
    <div class="library-workspace" :class="{ 'library-sidebar-collapsed': !sidebarOpen }">
      <aside class="library-sidebar" aria-label="Recording collections">
        <div class="library-station"><span class="library-station-icon"><FolderOpen :size="20" :stroke-width="1.5" /></span><div><strong>Media workspace</strong><span>Saved on this station</span></div><button class="clip-icon-button library-sidebar-toggle" :aria-label="sidebarOpen ? 'Collapse library sidebar' : 'Expand library sidebar'" :aria-expanded="sidebarOpen" @click="sidebarOpen = !sidebarOpen"><PanelLeftClose v-if="sidebarOpen" :size="16" /><PanelLeftOpen v-else :size="16" /></button></div>
        <div class="library-nav-label">LIBRARY</div>
        <nav class="library-navigation" aria-label="Library navigation"><RouterLink v-for="item in navigation" :key="item.id" :to="collectionUrl(item.id)" :aria-label="item.label" :aria-current="collection === item.id ? 'page' : undefined" :class="{ active: collection === item.id }" :title="item.label"><component :is="item.icon" :size="17" :stroke-width="1.6" /><span>{{ item.label }}</span><small>{{ item.count }}</small></RouterLink></nav>
        <div class="library-sidebar-bottom"><div class="library-station-health" :class="{ protected: workspace?.liveProtected }"><ShieldCheck :size="16" /><div><strong>{{ workspace?.liveProtected ? 'Live production active' : 'Production stays separate' }}</strong><p>{{ workspace?.liveProtected ? 'Edit freely. Exports wait until Studio is idle.' : 'Your edits never change the live Program.' }}</p></div></div><div class="library-storage"><HardDrive :size="14" /><span>{{ workspace?.recordings.length ?? 0 }} recordings · {{ size(storedBytes) }}</span></div><div class="library-user"><span><img src="/images/lumen-profile-abstract.png" alt="" width="29" height="29" /></span><div><strong>{{ identity.me?.displayName || identity.me?.username }}</strong><small>Your editing workspace</small></div></div></div>
      </aside>
      <section class="library-main" aria-label="Media library">
        <header class="library-main-header"><div><div class="library-breadcrumb"><FolderOpen :size="13" /><span>Library</span><span>/</span><span>{{ titles[collection] }}</span></div><h1>{{ titles[collection] }}</h1><p>{{ descriptions[collection] }}</p></div><div class="library-main-actions"><button class="clip-icon-button" :disabled="loading" aria-label="Refresh recordings" title="Refresh library" @click="load()"><RefreshCw :size="15" :class="{ 'clip-spin': loading }" /></button><button v-if="readyCount && collection !== 'exports'" class="clip-button clip-button-primary" @click="newProjectSearch = ''; newProjectOpen = true"><Scissors :size="14" />New project</button></div></header>
        <div class="library-toolbar">
          <div v-if="collection === 'recordings'" class="library-tabs" aria-label="Filter recordings"><button :aria-pressed="filter === 'all'" :class="{ active: filter === 'all' }" @click="filter = 'all'">All recordings <span>{{ workspace?.recordings.length ?? 0 }}</span></button><button :aria-pressed="filter === 'ready'" :class="{ active: filter === 'ready' }" @click="filter = 'ready'">Ready to edit <span>{{ readyCount }}</span></button></div>
          <div v-else class="library-collection-count">{{ totalCount }} {{ collection === 'exports' ? 'exports' : 'projects' }}<span v-if="collection === 'exports' && activeExports">{{ activeExports }} in progress</span></div>
          <div class="library-tool-options"><label class="library-search"><Search :size="15" /><input ref="searchField" v-model="search" :aria-label="collection === 'recordings' ? 'Search recordings' : collection === 'exports' ? 'Search exports' : 'Search projects'" :placeholder="collection === 'recordings' ? 'Search recordings…' : collection === 'exports' ? 'Search exports…' : 'Search projects or people…'" /><button v-if="search" class="library-search-clear" aria-label="Clear search" @click="search = ''"><X :size="12" /></button><kbd v-else>⌘ K</kbd></label><label class="library-sort"><span class="sr-only">Sort library</span><select v-model="order" aria-label="Sort library"><option value="recent">Recent first</option><option value="name">Name A–Z</option></select><ChevronDown :size="12" /></label><div class="library-view-options" aria-label="Library layout"><button :aria-pressed="view === 'grid'" :class="{ active: view === 'grid' }" aria-label="Grid view" title="Grid view" @click="view = 'grid'"><Grid2X2 :size="15" /></button><button :aria-pressed="view === 'list'" :class="{ active: view === 'list' }" aria-label="List view" title="List view" @click="view = 'list'"><List :size="16" /></button></div></div>
        </div>
        <div class="library-scroll-area">
          <div v-if="error" class="clips-inline-error library-error" role="alert"><span>{{ error }}</span><button class="clip-button" @click="load()">Try again</button></div>
          <div v-if="loading && !workspace" class="clips-empty"><LoaderCircle :size="26" class="clip-spin" /><h2>Loading your library</h2></div>
          <div v-else-if="!visibleCount && !error" class="clips-empty library-empty"><Search v-if="search || filter === 'ready'" :size="30" :stroke-width="1.2" /><Download v-else-if="collection === 'exports'" :size="30" :stroke-width="1.2" /><Users v-else-if="collection === 'team'" :size="30" :stroke-width="1.2" /><Scissors v-else-if="collection === 'mine'" :size="30" :stroke-width="1.2" /><Film v-else :size="32" :stroke-width="1.2" /><h2>{{ search || filter === 'ready' ? collection === 'recordings' ? 'No matching recordings' : 'Nothing matches your search' : collection === 'mine' ? 'Your next project starts here' : collection === 'team' ? 'A space for your team’s projects' : collection === 'exports' ? 'Your finished exports will appear here' : 'Your recordings start here' }}</h2><p>{{ search || filter === 'ready' ? 'Try a different search or show everything in this collection.' : collection === 'mine' ? 'Open a recording, build your edit, and save a project to return to it later.' : collection === 'team' ? 'Projects saved by other teammates appear here. View their work or make a separate copy.' : collection === 'exports' ? 'Export a saved project from the editor to create a video or audio file.' : 'Record Program in Studio. Completed recordings appear here, ready to edit.' }}</p><button v-if="search || filter === 'ready'" class="clip-button" @click="search = ''; filter = 'all'">Clear filters</button><RouterLink v-else-if="collection !== 'recordings'" to="/recordings" class="clip-button">Browse recordings<ArrowUpRight :size="14" /></RouterLink></div>
          <div v-else-if="collection === 'recordings'" class="library-cards" :class="`library-view-${view}`">
            <article v-for="recording in recordings" :key="recording.id" class="library-card library-recording" data-testid="recording-card" :data-recording-id="recording.id">
              <RouterLink v-if="recording.status === 'complete'" :to="editorUrl(recording.id, undefined, true)" class="library-card-preview clips-recording-open" :aria-label="`Edit recording ${recording.name}`"><RecordingThumbnail :recording="recording" playable /></RouterLink><div v-else class="library-card-preview"><RecordingThumbnail :recording="recording" /></div>
              <div class="library-card-details"><div class="library-card-title"><h2><RouterLink v-if="recording.status === 'complete'" :to="editorUrl(recording.id)">{{ recording.name }}</RouterLink><span v-else>{{ recording.name }}</span></h2><LibraryActions v-if="recordingActions(recording).length" :label="`Actions for recording ${recording.name}`" :actions="recordingActions(recording)" /></div><div class="library-card-summary"><span :title="fullDate(recording.createdAt)">{{ date(recording.createdAt) }}</span><i />{{ size(recording.bytes) }}<span v-if="recording.width && recording.height" class="library-resolution">{{ recording.width }} × {{ recording.height }}</span></div><p v-if="recording.error" class="library-card-error">{{ recording.error }}</p><div class="library-card-footer"><span class="clips-status" :class="`clips-status-${recording.status}`"><i />{{ status(recording.status) }}</span><a v-if="recording.status === 'complete'" :href="clipsApi.original(recording.id)" class="clip-icon-button" :aria-label="`Download original ${recording.name}`" title="Download original"><Download :size="15" /></a><button v-else-if="['interrupted', 'error'].includes(recording.status) && identity.can('*', 'author')" class="clip-link" :disabled="!!recovering" @click="recover(recording.id)">{{ recovering === recording.id ? 'Recovering…' : 'Recover' }}</button></div></div>
            </article>
          </div>
          <div v-else-if="collection === 'mine' || collection === 'team'" class="library-cards" :class="`library-view-${view}`">
            <article v-for="draft in projects" :key="draft.id" class="library-card library-project" data-testid="project-card" :data-draft-id="draft.id">
              <RouterLink :to="editorUrl(draft.recordingId, draft.id)" class="library-card-preview clips-recording-open" :aria-label="`${draft.canEdit ? 'Edit' : 'View'} project ${draft.name}`"><RecordingThumbnail v-if="recordingFor(draft.recordingId)" :recording="recordingFor(draft.recordingId)!" /><span v-else class="library-no-preview"><Film :size="27" /></span><span class="library-project-format">{{ draft.format }}</span><span class="clip-thumbnail-duration library-output-duration">{{ projectDuration(draft) }}</span></RouterLink>
              <div class="library-card-details"><div class="library-card-title"><h2><RouterLink :to="editorUrl(draft.recordingId, draft.id)">{{ draft.name }}</RouterLink></h2><LibraryActions :label="`Actions for project ${draft.name}`" :actions="projectActions(draft)" /></div><div class="library-card-summary"><span :title="fullDate(draft.updatedAt)">Edited {{ date(draft.updatedAt) }}</span><i />{{ projectDuration(draft) }}</div><div class="library-card-footer"><span class="library-owner"><i>{{ initial(draft.ownerName) }}</i><span>{{ draft.ownerId === identity.me?.id ? 'You' : draft.ownerName }}</span></span><span class="library-project-access"><Check v-if="draft.canEdit" :size="11" />{{ draft.canEdit ? 'Saved project' : 'View or copy' }}</span></div></div>
            </article>
          </div>
          <div v-else class="library-cards" :class="`library-view-${view}`"><article v-for="job in exports" :key="job.id" class="library-card library-export" data-testid="export-card" :data-export-id="job.id">
            <a v-if="job.status === 'complete'" :href="clipsApi.download(job.id)" class="library-card-preview clips-recording-open" :aria-label="`Download ${exportLabel(job)} ${job.name}`"><span v-if="audioExport(exportOptions(job).container)" class="library-no-preview"><Music2 :size="32" :stroke-width="1.2" /></span><RecordingThumbnail v-else-if="recordingFor(job.recordingId)" :recording="recordingFor(job.recordingId)!" /><span v-else class="library-no-preview"><Film :size="27" /></span><span class="library-export-file">{{ exportLabel(job) }} <Download :size="12" /></span><span class="clip-thumbnail-duration library-output-duration">{{ projectDuration(job.settings) }}</span></a>
            <div v-else class="library-card-preview"><span v-if="audioExport(exportOptions(job).container)" class="library-no-preview"><Music2 :size="32" :stroke-width="1.2" /></span><RecordingThumbnail v-else-if="recordingFor(job.recordingId)" :recording="recordingFor(job.recordingId)!" /><span v-else class="library-no-preview"><Film :size="27" /></span><span class="library-export-file">{{ exportLabel(job) }}</span><span class="clip-thumbnail-duration library-output-duration">{{ projectDuration(job.settings) }}</span></div>
            <div class="library-card-details"><div class="library-card-title"><h2>{{ job.name }}</h2><a v-if="job.status === 'complete'" :href="clipsApi.download(job.id)" class="clip-icon-button" :aria-label="`Download export ${job.name}`" :title="`Download ${exportLabel(job)}`"><Download :size="16" /></a><button v-else-if="job.canCancel && isActive(job)" class="clip-icon-button" :disabled="!!cancelling" :aria-label="`Cancel export ${job.name}`" title="Cancel export" @click="cancelExport(job)"><X :size="15" /></button></div><div class="library-card-summary"><span>{{ exportLabel(job) }} · {{ audioExport(exportOptions(job).container) ? 'Audio' : exportOptions(job).resolution }}</span><i /><span>{{ date(job.createdAt) }}</span><i />{{ projectDuration(job.settings) }}<span v-if="job.status === 'complete'">· {{ size(job.bytes) }}</span></div><div v-if="isActive(job)" class="library-export-progress" role="progressbar" :aria-label="`Export progress ${job.name}`" :aria-valuenow="Math.round(job.progress * 100)" aria-valuemin="0" aria-valuemax="100"><span :style="{ width: `${Math.max(0, Math.min(100, job.progress * 100))}%` }" /></div><p v-if="job.error" class="library-card-error">{{ job.error }}</p><div class="library-card-footer"><span class="library-export-status" :class="`library-export-status-${job.status}`"><LoaderCircle v-if="isActive(job)" :size="12" :class="{ 'clip-spin': job.status === 'exporting' }" /><Check v-else-if="job.status === 'complete'" :size="12" />{{ exportStatus(job) }}</span><RouterLink :to="editorUrl(job.recordingId, job.draftId)" class="library-open-project" :aria-label="`Open project for ${job.name}`" title="Open source project"><ArrowUpRight :size="14" /></RouterLink></div></div>
          </article></div>
          <footer v-if="visibleCount" class="library-results-footer"><span>{{ visibleCount }} {{ collection === 'recordings' ? 'recordings' : collection === 'exports' ? 'exports' : 'projects' }}{{ visibleCount !== totalCount ? ` of ${totalCount}` : '' }}</span><span><ShieldCheck :size="12" />Originals stay untouched</span></footer>
        </div>
      </section>
    </div>
    <DialogRoot v-model:open="newProjectOpen">
      <DialogPortal><DialogOverlay class="library-picker-overlay" /><DialogContent class="library-picker" @open-auto-focus="focusProjectSearch">
        <div class="library-picker-heading"><div><DialogTitle class="library-picker-title">Start a project</DialogTitle><DialogDescription class="library-picker-description">Choose a recording to open in the editor. Your original stays untouched.</DialogDescription></div><DialogClose class="clip-icon-button library-picker-close" aria-label="Close recording picker"><X :size="17" /></DialogClose></div>
        <label class="library-search library-picker-search"><Search :size="15" /><input ref="newProjectField" v-model="newProjectSearch" aria-label="Find a recording for your project" placeholder="Find a recording…" /></label>
        <div class="library-picker-recordings"><RouterLink v-for="recording in availableRecordings" :key="recording.id" :to="editorUrl(recording.id)" class="library-picker-recording" @click="newProjectOpen = false"><RecordingThumbnail :recording="recording" /><span><strong>{{ recording.name }}</strong><small>{{ date(recording.createdAt) }} · {{ duration(recording.durationMs) }}</small></span><ArrowUpRight :size="15" /></RouterLink><p v-if="!availableRecordings.length" class="library-picker-no-results">No matching recordings. Try another name.</p></div>
      </DialogContent></DialogPortal>
    </DialogRoot>
  </main>
</template>
