<script setup lang="ts">
import { computed, onMounted, ref, watch } from 'vue';
import { onBeforeRouteLeave, useRoute, useRouter } from 'vue-router';
import { ArrowLeft, UsersRound, Settings2, Plus, Search, Cloud, CloudOff, Layers, Presentation, BookOpen, Music2, Save, Download, Upload, ShieldCheck, ChevronDown, Copy, LogOut, Check, AlertCircle, Loader2, FolderOpen, UserPlus } from 'lucide-vue-next';
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogDescription } from '@/components/ui/dialog';
import WorkspaceHeader from '@/components/shell/WorkspaceHeader.vue';
import TeamDraftEditor from '@/components/team/TeamDraftEditor.vue';
import TeamMembers from '@/components/team/TeamMembers.vue';
import { useTeamStore } from '@/stores/team';
import { useConfirmation } from '@/composables/useConfirmation';
import { loadStationWorkspace, type StationWorkspace } from '@/lib/team/workspace';
import '@/styles/team.css';

type DraftKind = 'scene' | 'presentation' | 'scripture' | 'lyrics';
type DraftObject = Record<string, unknown>;
const team = useTeamStore(), router = useRouter(), route = useRoute();
const { confirmAction } = useConfirmation();
const authMode = ref<'signin' | 'signup'>('signin'), email = ref(''), password = ref(''), displayName = ref('');
const teamName = ref(''), invitation = ref(''), search = ref(''), kindFilter = ref('all');
const actionError = ref(''), notice = ref(''), actionBusy = ref(false);
const settingsOpen = ref(false), conflictsOpen = ref(false), inviteOpen = ref(false), workspaceOpen = ref(false);
const inviteRole = ref<'editor' | 'viewer'>('editor'), inviteToken = ref(''), inviteExpiry = ref(''), copied = ref(false), profileDraft = ref('');
const stationWorkspace = ref<StationWorkspace | null>(null), stationIdentityBusy = ref(false), stationIdentityError = ref(''), workspaceCopiedId = ref('');
let stationIdentityRequest = 0;
const selectedId = ref<string | null>(null), editing = ref(false), draftName = ref(''), draftKind = ref<DraftKind>('presentation'), draftDocument = ref<DraftObject>({ schemaVersion: 1, items: [] }), draftRevision = ref(0), savedSnapshot = ref('');
const kinds: { id: DraftKind; label: string; icon: typeof Layers }[] = [{ id: 'scene', label: 'Scene', icon: Layers }, { id: 'presentation', label: 'Presentation', icon: Presentation }, { id: 'scripture', label: 'Scripture', icon: BookOpen }, { id: 'lyrics', label: 'Lyrics', icon: Music2 }];
const selected = computed(() => team.resources.find(resource => resource.id === selectedId.value));
const currentTeam = computed(() => team.teams.find(item => item.id === team.teamId));
const readonly = computed(() => team.role !== 'owner' && team.role !== 'editor');
const filteredResources = computed(() => team.resources.filter(resource => (kindFilter.value === 'all' || resource.kind === kindFilter.value) && (!search.value.trim() || resource.name.toLocaleLowerCase().includes(search.value.trim().toLocaleLowerCase()))));
const snapshot = () => JSON.stringify({ name: draftName.value, kind: draftKind.value, document: draftDocument.value });
const dirty = computed(() => editing.value && snapshot() !== savedSnapshot.value);
const newerRevision = computed(() => !!selected.value && selected.value.revision > draftRevision.value);
const connectionLabel = computed(() => team.replicationConnected ? 'PowerSync connected' : 'PowerSync waiting for connection');
const canSave = computed(() => editing.value && !readonly.value && !!draftName.value.trim() && dirty.value && !actionBusy.value && !team.busy);
const stationIdentityLabel = computed(() => stationWorkspace.value?.configured
  ? stationWorkspace.value.id === team.teamId ? 'Station provisioned for this workspace' : 'Station belongs to a different workspace'
  : 'Local station · not provisioned to a cloud workspace');

async function run(action: () => unknown | Promise<unknown>, success?: string) {
  actionError.value = ''; notice.value = ''; actionBusy.value = true;
  try { await action(); if (success) notice.value = success; }
  catch (error) { actionError.value = error instanceof Error ? error.message : 'That action could not be completed. Please try again.'; }
  finally { actionBusy.value = false; }
}
onMounted(() => { void run(() => team.init()); });
watch(() => team.profileName, name => { profileDraft.value = name || ''; }, { immediate: true });
watch(() => team.user?.id, () => { selectedId.value = null; editing.value = false; savedSnapshot.value = ''; });
watch(() => team.teamId, () => { selectedId.value = null; editing.value = false; savedSnapshot.value = ''; inviteToken.value = ''; });
watch([settingsOpen, () => team.teamId, () => team.user?.id], async ([open]) => {
  const request = ++stationIdentityRequest;
  stationWorkspace.value = null; stationIdentityError.value = ''; workspaceCopiedId.value = ''; stationIdentityBusy.value = !!open;
  if (!open) return;
  try {
    const station = await loadStationWorkspace();
    if (request === stationIdentityRequest) stationWorkspace.value = station;
  } catch (error) {
    if (request === stationIdentityRequest) stationIdentityError.value = error instanceof Error ? error.message : 'Station identity unavailable.';
  } finally { if (request === stationIdentityRequest) stationIdentityBusy.value = false; }
});
watch(() => team.resources, () => {
  if (selectedId.value && selected.value && !dirty.value) loadResource(selected.value);
  if (!editing.value && typeof route.query.resource === 'string') {
    const resource = team.resources.find(item => item.id === route.query.resource);
    if (resource) loadResource(resource);
  }
}, { deep: true });

function kindIcon(kind: string) { return kinds.find(item => item.id === kind)?.icon ?? FolderOpen; }
function kindLabel(kind: string) { return kinds.find(item => item.id === kind)?.label ?? 'Draft'; }
function displayDate(value: string) { const parsed = new Date(value); return Number.isNaN(parsed.getTime()) ? '' : parsed.toLocaleString(undefined, { dateStyle: 'medium', timeStyle: 'short' }); }
function clone(value: unknown): DraftObject { return JSON.parse(JSON.stringify(value ?? {})) as DraftObject; }
function loadResource(resource: { id: string; name: string; kind: string; document: unknown; revision: number }) {
  selectedId.value = resource.id; draftName.value = resource.name; draftKind.value = resource.kind as DraftKind; draftDocument.value = clone(resource.document); draftRevision.value = resource.revision; editing.value = true; savedSnapshot.value = snapshot();
}
async function mayDiscard() {
  return !dirty.value || await confirmAction({ title: 'Leave this unsaved draft?', description: 'Your editor changes have not been saved to this device yet. Save the draft first to keep them for offline syncing.', confirmLabel: 'Discard changes', cancelLabel: 'Keep editing' });
}
async function selectResource(resource: Parameters<typeof loadResource>[0]) {
  if (actionBusy.value || resource.id === selectedId.value || !await mayDiscard()) return;
  loadResource(resource); void router.replace({ query: { resource: resource.id } });
}
async function newDraft(kind: DraftKind) {
  if (actionBusy.value || readonly.value || !await mayDiscard()) return;
  selectedId.value = null; draftName.value = `Untitled ${kindLabel(kind).toLocaleLowerCase()}`; draftKind.value = kind;
  draftDocument.value = kind === 'scene' ? { schemaVersion: 1, background: '#151619', layers: [] } : { schemaVersion: 1, items: [] };
  draftRevision.value = 0; editing.value = true; savedSnapshot.value = ''; void router.replace({ query: {} });
}
async function saveDraft() {
  if (!canSave.value) return;
  const saved = snapshot(), id = selectedId.value ?? crypto.randomUUID();
  await run(async () => {
    await team.saveResource({ id, kind: draftKind.value, name: draftName.value.trim(), document: clone(draftDocument.value), revision: draftRevision.value });
    selectedId.value = id; savedSnapshot.value = saved; draftRevision.value = team.resources.find(resource => resource.id === id)?.revision ?? draftRevision.value;
    void router.replace({ query: { resource: id } });
  }, 'Saved on this device. Cloud sync status is shown below.');
}
async function switchTeam(event: Event) {
  const element = event.target as HTMLSelectElement, id = element.value;
  if (actionBusy.value || !await mayDiscard()) { element.value = team.teamId ?? ''; return; }
  await run(() => team.selectTeam(id));
}
async function authenticate() {
  await run(async () => {
    if (authMode.value === 'signup') { await team.signUp(email.value.trim(), password.value, displayName.value.trim()); notice.value = 'Account request sent. Check your email if confirmation is required, then sign in.'; }
    else await team.signIn(email.value.trim(), password.value);
    password.value = '';
  });
}
async function signOut() {
  if (!await mayDiscard()) return;
  if (!await confirmAction({ title: 'Sign out of the team workspace?', description: team.pendingCount ? `${team.pendingCount} change(s) are waiting to sync. Reconnect and finish syncing first, or keep the same account available to recover them. Signing out does not stop live production.` : 'Your local station and live production will stay unchanged.', confirmLabel: 'Sign out' })) return;
  await run(() => team.signOut());
}
async function createTeam() { if (actionBusy.value || !await mayDiscard()) return; await run(async () => { await team.createTeam(teamName.value.trim()); teamName.value = ''; workspaceOpen.value = false; }, 'Team workspace created.'); }
async function joinTeam() { if (actionBusy.value || !await mayDiscard()) return; await run(async () => { await team.joinTeam(invitation.value.trim()); invitation.value = ''; workspaceOpen.value = false; }, 'You have joined the team.'); }
async function createInvite() {
  inviteToken.value = ''; copied.value = false;
  await run(async () => { const result = await team.invite(inviteRole.value); inviteToken.value = result.token; inviteExpiry.value = result.expires_at; });
}
async function copyInvite() {
  await run(async () => { await navigator.clipboard.writeText(inviteToken.value); copied.value = true; });
}
async function copyWorkspaceId() {
  const id = team.teamId; if (!id) return;
  try { await navigator.clipboard.writeText(id); workspaceCopiedId.value = id; }
  catch { actionError.value = 'Clipboard access is unavailable. Select and copy the workspace ID below.'; }
}
async function capture() { await run(() => team.captureLocalDrafts(), 'Selected station drafts copied into this workspace. Keys, inputs and Main audio stay on the station.'); }
async function applyToStation() {
  const resource = selected.value;
  if (!resource || dirty.value) return;
  await run(() => team.applyToStation(resource));
}
async function resolve(id: string, choice: 'server' | 'local') { await run(() => team.resolveConflict(id, choice)); }
onBeforeRouteLeave(async () => await mayDiscard());
</script>

<template>
  <div class="team-workspace">
    <WorkspaceHeader>
      <div class="team-header-location"><UsersRound :size="15" /><span>Team workspace</span><span class="team-test-label">Local test</span></div>
      <RouterLink to="/studio" class="team-back-link"><ArrowLeft :size="14" /> Back to Studio</RouterLink>
    </WorkspaceHeader>

    <main v-if="!team.ready" class="team-loading" aria-live="polite"><Loader2 :size="23" class="team-spinner" /><span>Opening team workspace…</span></main>
    <main v-else-if="!team.enabled" class="team-onboarding"><div class="team-auth-card"><UsersRound :size="25" /><h1>Team workspace is not enabled</h1><p>Start Lumen with the local team test command to connect LAB and PowerSync. Your normal station remains independent.</p><RouterLink to="/studio" class="team-button">Return to Studio</RouterLink></div></main>
    <main v-else-if="!team.user" class="team-onboarding">
      <section class="team-auth-context"><span class="team-eyebrow">Lumen · team preparation</span><h1>One service. <br />A team in sync.</h1><p>Prepare scenes, presentations, Scripture and lyrics together. Keep editing when your internet drops; review conflicts without losing your work.</p><div class="team-safety-line"><ShieldCheck :size="17" /><span>Live switching, saved keys and Main audio stay on the station.</span></div><small>This is a separate team sign-in. It does not replace your local operator account.</small></section>
      <form class="team-auth-card" data-team-private @submit.prevent="authenticate">
        <div class="team-auth-tabs" role="tablist" aria-label="Account action"><button type="button" role="tab" :aria-selected="authMode === 'signin'" :class="{ selected: authMode === 'signin' }" @click="authMode = 'signin'">Sign in</button><button type="button" role="tab" :aria-selected="authMode === 'signup'" :class="{ selected: authMode === 'signup' }" @click="authMode = 'signup'">Create account</button></div>
        <div><h2>{{ authMode === 'signin' ? 'Welcome back' : 'Join your media team' }}</h2><p>{{ authMode === 'signin' ? 'Use your Lumen team account to continue.' : 'Create a personal account, then create or join a team.' }}</p></div>
        <label v-if="authMode === 'signup'" class="team-field">Your name<input v-model="displayName" name="name" autocomplete="name" maxlength="60" required /></label>
        <label class="team-field">Email<input v-model="email" type="email" name="email" autocomplete="email" required /></label>
        <label class="team-field">Password<input v-model="password" type="password" name="password" :autocomplete="authMode === 'signin' ? 'current-password' : 'new-password'" :minlength="authMode === 'signup' ? 12 : 1" required /><small v-if="authMode === 'signup'">At least 12 characters. Use a password unique to this account.</small></label>
        <p v-if="actionError || team.error" class="team-error" role="alert">{{ actionError || team.error }}</p><p v-if="notice" class="team-notice" role="status">{{ notice }}</p>
        <button type="submit" class="team-button primary" :disabled="actionBusy || team.busy"><Loader2 v-if="actionBusy || team.busy" :size="15" class="team-spinner" />{{ authMode === 'signin' ? 'Sign in' : 'Create account' }}</button>
        <p class="team-subtle">Accounts use LAB. Signing in requires internet; saved preparation remains available offline on this device.</p>
      </form>
    </main>

    <template v-else>
      <div class="team-status-strip"><span><component :is="team.replicationConnected ? Cloud : CloudOff" :size="14" />{{ connectionLabel }}</span><span class="team-status-detail">{{ team.syncState }}</span><button v-if="team.conflicts.length" type="button" class="team-text-button warning" @click="conflictsOpen = true"><AlertCircle :size="13" />{{ team.conflicts.length }} to review</button><span v-else-if="team.pendingCount" class="team-pending">{{ team.pendingCount }} waiting to sync</span><span v-else class="team-status-detail">No pending edits</span></div>
      <main v-if="!team.teamId" class="team-onboarding team-join-layout">
        <section class="team-auth-context"><span class="team-eyebrow">Your account is ready</span><h1>Bring your <br />team together.</h1><p>Create a private workspace for your church, or enter a one-use invitation from your team owner.</p><div class="team-account-line"><span class="team-account-avatar">{{ (team.profileName || team.user.email || '?')[0].toUpperCase() }}</span><div><b>{{ team.profileName || 'Your account' }}</b><small>{{ team.user.email }}</small></div><button type="button" class="team-icon-button" title="Sign out of team account" aria-label="Sign out of team account" @click="signOut"><LogOut :size="15" /></button></div></section>
        <div class="team-auth-card"><form @submit.prevent="createTeam"><h2>New team workspace</h2><p>Keep your church's preparations together.</p><label class="team-field">Team name<input v-model="teamName" maxlength="100" placeholder="e.g. Grace Media Team" required /></label><button type="submit" class="team-button primary" :disabled="actionBusy || !teamName.trim()"><Plus :size="15" />Create team</button></form><div class="team-or-divider">or join an existing team</div><form data-team-private @submit.prevent="joinTeam"><label class="team-field">Invitation code<input v-model="invitation" autocomplete="off" spellcheck="false" required /></label><button type="submit" class="team-button" :disabled="actionBusy || !invitation.trim()"><UserPlus :size="15" />Join team</button></form><p v-if="actionError || team.error" class="team-error" role="alert">{{ actionError || team.error }}</p><p v-if="notice" class="team-notice" role="status">{{ notice }}</p></div>
      </main>
      <main v-else class="team-layout">
        <aside class="team-library">
          <div class="team-library-heading"><label class="team-team-select"><span class="sr-only">Team workspace</span><select :value="team.teamId" aria-label="Team workspace" @change="switchTeam"><option v-for="item in team.teams" :key="item.id" :value="item.id">{{ item.name }}</option></select><ChevronDown :size="13" /></label><button type="button" class="team-icon-button" title="Workspace settings" aria-label="Workspace settings" @click="settingsOpen = true"><Settings2 :size="15" /></button></div>
          <div class="team-role-line"><ShieldCheck :size="12" />{{ team.role || 'Checking access' }}<button type="button" class="team-text-button" @click="workspaceOpen = true">Switch / join</button></div>
          <label class="team-search"><Search :size="15" /><input v-model="search" type="search" placeholder="Find a draft…" aria-label="Search shared drafts" /></label>
          <div class="team-library-filters"><label class="sr-only" for="team-kind-filter">Draft type</label><select id="team-kind-filter" v-model="kindFilter"><option value="all">All drafts</option><option v-for="kind in kinds" :key="kind.id" :value="kind.id">{{ kind.label }}</option></select><span>{{ filteredResources.length }}</span></div>
          <div class="team-resource-list"><button v-for="resource in filteredResources" :key="resource.id" type="button" class="team-resource" :class="{ selected: resource.id === selectedId }" @click="selectResource(resource)"><span class="team-resource-icon"><component :is="kindIcon(resource.kind)" :size="18" /></span><span><b>{{ resource.name }}</b><small>{{ kindLabel(resource.kind) }} · Rev {{ resource.revision }}</small></span></button><p v-if="!filteredResources.length" class="team-inline-empty">{{ search ? 'No matching drafts.' : 'Your shared drafts will appear here.' }}</p></div>
          <div class="team-new-drafts"><span class="team-section-label">Create a draft</span><div><button v-for="kind in kinds" :key="kind.id" type="button" class="team-button" :disabled="readonly" @click="newDraft(kind.id)"><component :is="kind.icon" :size="14" />{{ kind.label }}</button></div></div>
          <button type="button" class="team-button team-share-station" :disabled="readonly || actionBusy || !!team.pendingCount" @click="capture"><Upload :size="14" />Copy selected station drafts</button>
          <p class="team-subtle">Copies the selected scene and focused channel only. Local media and live inputs are not uploaded.</p>
          <div class="team-library-account"><span class="team-account-avatar">{{ (team.profileName || team.user.email || '?')[0].toUpperCase() }}</span><div><b>{{ team.profileName || 'Your account' }}</b><small>{{ team.user.email }}</small></div><button type="button" class="team-icon-button" title="Sign out of team account" aria-label="Sign out of team account" @click="signOut"><LogOut :size="14" /></button></div>
        </aside>
        <section class="team-editor-area">
          <div v-if="actionError || team.error" class="team-banner error" role="alert"><AlertCircle :size="14" /><span>{{ actionError || team.error }}</span></div><div v-if="notice" class="team-banner" role="status"><Check :size="14" /><span>{{ notice }}</span></div>
          <template v-if="editing">
            <div class="team-editor-heading"><div><div class="team-editor-title"><component :is="kindIcon(draftKind)" :size="17" /><input v-model="draftName" :readonly="readonly" maxlength="100" aria-label="Draft name" /><span v-if="dirty" class="team-dirty-dot" title="Unsaved changes" aria-label="Unsaved changes" /></div><p>{{ kindLabel(draftKind) }} · {{ selectedId ? `Revision ${draftRevision}` : 'New draft' }}<span v-if="readonly"> · View only</span></p></div><div class="team-editor-actions"><button v-if="selected" type="button" class="team-button" :disabled="dirty || actionBusy || !!team.pendingCount || !!team.conflicts.length" title="Create a separate draft copy on this station. Does not send it live." @click="applyToStation"><Download :size="14" />Use on this station</button><button type="button" class="team-button primary" :disabled="!canSave" @click="saveDraft"><Loader2 v-if="actionBusy" :size="14" class="team-spinner" /><Save v-else :size="14" />Save draft</button></div></div>
            <div v-if="newerRevision && dirty" class="team-banner warning" role="status"><AlertCircle :size="14" /><span>A teammate saved a newer revision. Your unsaved edits are kept; saving will let you review any conflict.</span></div>
            <TeamDraftEditor :kind="draftKind" v-model:document="draftDocument" :readonly="readonly" />
          </template>
          <div v-else class="team-library-welcome"><span class="team-welcome-icon"><FolderOpen :size="28" :stroke-width="1.4" /></span><h1>Ready for the next service.</h1><p>Select a shared draft, create something new, or copy selected preparation from this station.</p><div class="team-welcome-kind-grid"><button v-for="kind in kinds" :key="kind.id" type="button" :disabled="readonly" @click="newDraft(kind.id)"><component :is="kind.icon" :size="20" /><b>{{ kind.label }}</b><span>New draft <Plus :size="12" /></span></button></div><small>Team edits never change Program automatically.</small></div>
          <footer class="team-editor-footer"><ShieldCheck :size="13" /><span>Live scene switching and Main audio stay local</span><span v-if="selected">{{ displayDate(selected.updated_at) }}</span></footer>
        </section>
      </main>
    </template>

    <Dialog :open="settingsOpen" @update:open="settingsOpen = $event">
      <DialogContent class="team-dialog">
        <DialogHeader><DialogTitle>Team preferences</DialogTitle><DialogDescription>Your workspace identity, profile, Focus mode and team access.</DialogDescription></DialogHeader>
        <section class="team-workspace-identity" aria-label="Workspace identity">
          <div><h3>Workspace identity</h3><p>{{ currentTeam?.name || 'Your workspace' }}</p></div>
          <label class="team-field">Workspace ID<input :value="team.teamId || ''" readonly spellcheck="false" aria-label="Workspace ID" @focus="($event.target as HTMLInputElement).select()" /></label>
          <button type="button" class="team-button" :disabled="!team.teamId" @click="copyWorkspaceId"><Check v-if="workspaceCopiedId === team.teamId" :size="14" /><Copy v-else :size="14" />{{ workspaceCopiedId === team.teamId ? 'Workspace ID copied' : 'Copy workspace ID' }}</button>
          <small>Stable identity for this team—not a publishing or viewer key.</small>
          <div class="team-station-identity" aria-live="polite">
            <p v-if="stationIdentityBusy"><Loader2 :size="13" class="team-spinner" />Checking station identity…</p>
            <p v-else-if="stationIdentityError" class="team-error" role="alert">{{ stationIdentityError }}</p>
            <template v-else-if="stationWorkspace"><b>{{ stationIdentityLabel }}</b><code>{{ stationWorkspace.id }}</code><p>{{ stationWorkspace.message }}</p></template>
          </div>
          <p>Switching cloud workspaces never retargets this station, its Watch links or live production. Station provisioning is a separate administrator setup.</p>
        </section>
        <form class="team-dialog-form" @submit.prevent="run(() => team.setProfile(profileDraft), 'Profile updated.')"><label class="team-field">Display name<input v-model="profileDraft" maxlength="60" required /></label><button type="submit" class="team-button" :disabled="actionBusy">Save name</button></form>
        <label class="team-focus-setting"><span><b>Focus mode</b><small>Hide teammate cursors and activity. Your cursor is not shared while Focus mode is on. Drafts continue syncing.</small></span><input type="checkbox" :checked="team.focusMode" @change="team.setFocusMode(($event.target as HTMLInputElement).checked)" /></label>
        <div class="team-settings-status"><Cloud :size="16" /><div><b>{{ connectionLabel }}</b><p>{{ team.syncState }}</p><small>PowerSync needs a working direct IPv6 connection to LAB on the Free plan. Team account access and cloud uploads use HTTPS.</small></div></div>
        <TeamMembers v-if="team.role === 'owner'" /><button v-if="team.role === 'owner'" type="button" class="team-button" @click="settingsOpen = false; inviteOpen = true"><UserPlus :size="15" />Invite a teammate</button><p v-if="actionError" class="team-error" role="alert">{{ actionError }}</p>
      </DialogContent>
    </Dialog>
    <Dialog :open="inviteOpen" @update:open="inviteOpen = $event"><DialogContent class="team-dialog" data-team-private><DialogHeader><DialogTitle>Invite to {{ currentTeam?.name || 'your team' }}</DialogTitle><DialogDescription>One-use invitation, valid for 24 hours. Share it privately with your teammate.</DialogDescription></DialogHeader><form class="team-dialog-form" @submit.prevent="createInvite"><label class="team-field">Team access<select v-model="inviteRole"><option value="editor">Editor · prepare and edit drafts</option><option value="viewer">Viewer · read shared drafts</option></select></label><button type="submit" class="team-button primary" :disabled="actionBusy || team.role !== 'owner'">Generate invitation</button></form><div v-if="inviteToken" class="team-invite-code"><label class="team-field">Invitation code<textarea :value="inviteToken" rows="3" readonly spellcheck="false" @focus="($event.target as HTMLTextAreaElement).select()" /></label><button type="button" class="team-button" @click="copyInvite"><Check v-if="copied" :size="14" /><Copy v-else :size="14" />{{ copied ? 'Copied' : 'Copy code' }}</button><small>Expires {{ displayDate(inviteExpiry) }}</small></div><p v-if="actionError" class="team-error" role="alert">{{ actionError }}</p></DialogContent></Dialog>
    <Dialog :open="workspaceOpen" @update:open="workspaceOpen = $event"><DialogContent class="team-dialog"><DialogHeader><DialogTitle>Team workspaces</DialogTitle><DialogDescription>Create a private workspace or join using an invitation.</DialogDescription></DialogHeader><form class="team-dialog-form" @submit.prevent="createTeam"><label class="team-field">New team name<input v-model="teamName" maxlength="100" required /></label><button type="submit" class="team-button" :disabled="actionBusy || !teamName.trim()"><Plus :size="14" />Create team</button></form><div class="team-inspector-divider" /><form class="team-dialog-form" data-team-private @submit.prevent="joinTeam"><label class="team-field">Invitation code<input v-model="invitation" autocomplete="off" spellcheck="false" required /></label><button type="submit" class="team-button" :disabled="actionBusy || !invitation.trim()">Join team</button></form><p v-if="actionError" class="team-error" role="alert">{{ actionError }}</p></DialogContent></Dialog>
    <Dialog :open="conflictsOpen" @update:open="conflictsOpen = $event"><DialogContent class="team-dialog team-conflict-dialog"><DialogHeader><DialogTitle>Review shared edits</DialogTitle><DialogDescription>Your local edits are preserved when someone else saves the same draft. Choose which version to continue with.</DialogDescription></DialogHeader><div v-for="conflict in team.conflicts" :key="conflict.id" class="team-conflict"><h3>{{ conflict.name || 'Shared draft' }}</h3><p>{{ conflict.message || 'This draft changed while you were editing.' }}</p><div class="team-conflict-versions"><details><summary>Your saved edit</summary><pre>{{ JSON.stringify(conflict.document, null, 2) }}</pre></details><details><summary>Latest cloud version</summary><pre>{{ JSON.stringify(conflict.serverDocument, null, 2) }}</pre></details></div><div class="team-conflict-actions"><button type="button" class="team-button" :disabled="actionBusy" @click="resolve(conflict.id, 'server')">Use cloud version</button><button type="button" class="team-button primary" :disabled="actionBusy" @click="resolve(conflict.id, 'local')">Keep my edit as a copy</button></div></div><p v-if="!team.conflicts.length" class="team-notice">All caught up. No conflicts need review.</p><p v-if="actionError" class="team-error" role="alert">{{ actionError }}</p></DialogContent></Dialog>
  </div>
</template>
