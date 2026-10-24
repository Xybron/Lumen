import { computed, ref, shallowRef } from 'vue';
import { defineStore } from 'pinia';
import { createClient, type SupabaseClient, type User, type RealtimeChannel } from '@supabase/supabase-js';
import type { PowerSyncDatabase } from '@powersync/web';
import { openTeamDatabase } from '@/lib/team/database';
import { overlayPending, validateDraft, type TeamConfig, type TeamResource, type TeamRole, type Team, type TeamConflict, type TeamPeer } from '@/lib/team/model';
import { activityId, activityPublisher, parseActivity, type TeamActivity } from '@/lib/team/activity';
import { checkStationWorkspaceImport } from '@/lib/team/workspace';

interface Actor { database: PowerSyncDatabase; who: string; serial: number }
interface AccountTask { actor: Actor; promise: Promise<void> }
interface Membership { team_id: string; user_id: string; role: TeamRole }
interface QueuedEdit { id: string; team_id: string; resource_id: string; value: string; base_revision: number }

export const useTeamStore = defineStore('team', () => {
  const enabled = ref(false), ready = ref(false), busy = ref(false), error = ref('');
  const user = shallowRef<User | null>(null), profileName = ref(''), teams = ref<Team[]>([]), teamId = ref<string | null>(null), role = ref<TeamRole | null>(null);
  const resources = ref<TeamResource[]>([]), pendingCount = ref(0), conflicts = ref<TeamConflict[]>([]);
  const replicationConnected = ref(false), replicationReady = ref(false), syncState = ref('Not connected'), peers = ref<TeamPeer[]>([]), activityConnected = ref(false);
  const memberships = ref<Membership[]>([]), profileNames = ref<Record<string, string>>({});
  const focusMode = ref(localStorage.getItem('lumen.team.focus') === 'true');
  const sessionId = crypto.randomUUID();
  let client: SupabaseClient | null = null, db: PowerSyncDatabase | null = null, config: TeamConfig, initTask: Promise<void> | null = null;
  let accountChanges: Promise<void> = Promise.resolve();
  let room: RealtimeChannel | null = null, accountId: string | null = null, authSubject: string | null = null;
  let flushTask: AccountTask | null = null, refreshTask: AccountTask | null = null, replicatedTask: AccountTask | null = null;
  let generation = 0, openedGeneration = -1, presenceActive = false, roomReady = false, activitySequence = 0, retryAttempt = 0;
  let retryTimer: ReturnType<typeof setTimeout> | undefined;
  const roster = new Map<string, { userId: string; name: string }>(), peerSequences = new Map<string, number>();
  let confirmedTeams = new Set<string>(), membershipCheckedAt = 0;
  let localPresence = { surface: 'team', x: 0.5, y: 0.5 };
  const activity = activityPublisher(
    () => !!room && roomReady && room.state === 'joined' && !!client?.realtime.isConnected() && presenceActive && !!actorOrNull() && navigator.onLine,
    () => {
      const target = room, expected = actorOrNull();
      if (!target || !expected) return;
      const active = !focusMode.value && !document.hidden;
      const payload: TeamActivity = { version: 1, sessionId, userId: expected.who, sequence: ++activitySequence, active, ...(active ? localPresence : {}) };
      // A joined, connected WebSocket only: SDK send() must never fall back to
      // HTTP or replay old cursor positions after an offline interval.
      void target.send({ type: 'broadcast', event: 'activity', payload }).then(result => {
        if (result !== 'ok' && current(expected) && room === target) scheduleActivityReconnect(target, expected);
      }).catch(() => { if (current(expected) && room === target) scheduleActivityReconnect(target, expected); });
    },
  );
  const canEdit = computed(() => role.value === 'owner' || role.value === 'editor');
  const members = computed(() => memberships.value.filter(member => member.team_id === teamId.value).map(member => ({ user_id: member.user_id, role: member.role, name: profileNames.value[member.user_id] ?? 'Teammate' })));
  function fail(cause: unknown) { error.value = cause instanceof Error ? cause.message : String(cause); }
  function actorOrNull(): Actor | null {
    return db && accountId && user.value?.id === accountId && authSubject === accountId && openedGeneration === generation ? { database: db, who: accountId, serial: generation } : null;
  }
  function actor(): Actor { const value = actorOrNull(); if (!value) throw new Error('Sign in to your team account first.'); return value; }
  function current(value: Actor) { return db === value.database && accountId === value.who && user.value?.id === value.who && authSubject === value.who && generation === value.serial; }
  function assertCurrent(value: Actor) { if (!current(value)) throw new Error('The team account changed. Your unsent edits remain with their original account.'); }
  function sameActor(a: Actor, b: Actor) { return a.database === b.database && a.who === b.who && a.serial === b.serial; }
  function clearVisibleAccount() {
    teams.value = []; teamId.value = null; role.value = null; resources.value = []; conflicts.value = []; pendingCount.value = 0;
    memberships.value = []; profileNames.value = {}; profileName.value = ''; peers.value = [];
  }
  function leavePresence(resetRetries = true) {
    if (retryTimer) clearTimeout(retryTimer); retryTimer = undefined;
    if (resetRetries) retryAttempt = 0;
    activity.cancel(); roomReady = false; activityConnected.value = false;
    const previous = room; room = null; peers.value = []; roster.clear(); peerSequences.clear();
    if (previous) void client?.removeChannel(previous).catch(() => {});
  }
  // Invalidate before the deferred worker close/open. A changed Auth token must
  // never use the previous account's pending database or visible preparations.
  function noteAuthSubject(next: User | null) {
    const nextId = next?.id ?? null;
    if (nextId !== authSubject) {
      generation++; authSubject = nextId; user.value = null;
      replicationConnected.value = false; replicationReady.value = false;
      flushTask = null; refreshTask = null; replicatedTask = null;
      confirmedTeams = new Set(); membershipCheckedAt = 0; leavePresence(); clearVisibleAccount();
    }
  }
  async function boundApi(value: Actor): Promise<SupabaseClient> {
    assertCurrent(value);
    if (!client || !navigator.onLine) throw new Error('Offline · edits are retained on this device.');
    const result = await client.auth.getSession();
    assertCurrent(value);
    if (result.error || result.data.session?.user.id !== value.who) throw new Error('Sign in again to sync this account’s saved edits.');
    const token = result.data.session.access_token;
    // A per-request captured token prevents subject changes between checking
    // getSession() and the global client's authenticated fetch.
    return createClient(config.supabaseUrl!, config.publishableKey!, {
      accessToken: async () => token,
      auth: { persistSession: false, autoRefreshToken: false, detectSessionInUrl: false },
      global: { fetch: (input, options) => fetch(input, { ...options, signal: options?.signal ?? AbortSignal.timeout(12000) }) },
    });
  }
  async function rpc<T>(name: string, args: Record<string, unknown> = {}, expected = actor()): Promise<T> {
    const api = await boundApi(expected), result = await api.rpc(name, args);
    assertCurrent(expected);
    if (result.error) throw Object.assign(new Error(result.error.message), { code: result.error.code, status: result.status });
    return result.data as T;
  }
  async function action<T>(fn: () => Promise<T>): Promise<T> {
    busy.value = true; error.value = '';
    try { return await fn(); } catch (e) { fail(e); throw e; } finally { busy.value = false; }
  }
  async function readLocal(expected = actorOrNull()) {
    if (!expected) return;
    const selected = teamId.value;
    if (!selected) { if (current(expected)) { resources.value = []; conflicts.value = []; pendingCount.value = 0; } return; }
    const [cached, pending, unresolved] = await Promise.all([
      expected.database.getAll<{ value: string }>('SELECT value FROM resource_cache WHERE team_id = ?', [selected]),
      expected.database.getAll<{ resource_id: string; value: string }>('SELECT resource_id, value FROM edit_outbox WHERE team_id = ? ORDER BY resource_id,base_revision,created_at,id', [selected]),
      expected.database.getAll<{ value: string }>('SELECT value FROM edit_conflicts WHERE team_id = ?', [selected]),
    ]);
    if (!current(expected) || teamId.value !== selected) return;
    resources.value = overlayPending(cached.map(row => JSON.parse(row.value)), pending);
    conflicts.value = unresolved.map(row => JSON.parse(row.value)); pendingCount.value = pending.length;
  }
  async function closeAccount() {
    generation++; replicationConnected.value = false; replicationReady.value = false; leavePresence();
    const old = db; db = null; accountId = null; openedGeneration = -1;
    flushTask = null; refreshTask = null; replicatedTask = null; confirmedTeams = new Set(); membershipCheckedAt = 0;
    clearVisibleAccount();
    if (old) await old.close({ disconnect: true });
  }
  function restoreAccount(next: User | null) {
    const nextChange = accountChanges.then(() => restoreAccountNow(next));
    accountChanges = nextChange.catch(() => {});
    return nextChange;
  }
  async function restoreAccountNow(next: User | null) {
    if ((next?.id ?? null) !== authSubject) return;
    if (next?.id === accountId && db && openedGeneration === generation) { user.value = next; return; }
    await closeAccount();
    if ((next?.id ?? null) !== authSubject) return;
    user.value = next;
    if (!next) { syncState.value = 'Sign in to collaborate'; return; }
    const serial = generation, accountOpenedAt = Date.now();
    const opened = await openTeamDatabase(config.projectRef!, next.id);
    if (serial !== generation || authSubject !== next.id) { await opened.close({ disconnect: true }); return; }
    db = opened; accountId = next.id; openedGeneration = serial;
    const expected = actor();
    const cached = await opened.getOptional<{ value: string }>('SELECT value FROM team_cache WHERE id = ?', ['account']);
    if (!current(expected)) return;
    if (cached) {
      const data = JSON.parse(cached.value); teams.value = data.teams ?? []; memberships.value = data.memberships ?? []; profileName.value = data.name ?? ''; profileNames.value = data.profileNames ?? {};
      teamId.value = teams.value.some(team => team.id === data.teamId) ? data.teamId : teams.value[0]?.id ?? null;
      role.value = memberships.value.find(member => member.team_id === teamId.value && member.user_id === next.id)?.role ?? null;
      await readLocal(expected);
    }
    opened.registerListener({ statusChanged(status) {
      if (!current(expected)) return;
      replicationConnected.value = status.connected;
      // A previous account opening's checkpoint cannot authorize fresh streams.
      replicationReady.value = status.connected && status.hasSynced === true && !!status.lastSyncedAt && status.lastSyncedAt.getTime() >= accountOpenedAt;
      if (replicationReady.value) void mergeReplicated(expected).catch(() => {});
    } });
    void opened.connect({
      async fetchCredentials() {
        if (!current(expected) || !client) return null;
        const { data, error: authError } = await client.auth.getSession();
        if (!current(expected) || authError || !data.session || data.session.user.id !== expected.who) return null;
        return { endpoint: config.powerSyncUrl!, token: data.session.access_token, expiresAt: new Date(data.session.expires_at! * 1000) };
      },
      async uploadData() { /* Writes use the durable local-only CAS outbox. */ },
    }).catch(() => { if (current(expected)) { replicationConnected.value = false; replicationReady.value = false; } });
    void (async () => {
      try {
        for await (const _result of opened.watch('SELECT id, revision FROM lumen_resources UNION ALL SELECT id, 0 AS revision FROM lumen_memberships')) {
          if (!current(expected)) break;
          if (replicationReady.value) void mergeReplicated(expected).catch(() => {});
        }
      } catch { /* Account close cancels the SQL watcher. */ }
    })();
    await refresh(expected).catch(() => {});
  }
  async function init() {
    if (initTask) return initTask;
    initTask = (async () => {
      try {
        const response = await fetch('/api/team/config', { cache: 'no-store' });
        if (!response.ok) { enabled.value = false; return; }
        config = await response.json(); enabled.value = config.enabled;
        if (!config.enabled) return;
        client = createClient(config.supabaseUrl!, config.publishableKey!, {
          auth: { storageKey: `lumen.lab.auth.${config.projectRef}`, persistSession: true, autoRefreshToken: true, detectSessionInUrl: false },
          realtime: { params: { eventsPerSecond: 5 } },
        });
        client.auth.onAuthStateChange((_event, session) => {
          const next = session?.user ?? null; noteAuthSubject(next);
          // Do not await another Auth call inside the SDK's Auth callback.
          setTimeout(() => void restoreAccount(next).catch(fail), 0);
        });
        const { data } = await client.auth.getSession();
        noteAuthSubject(data.session?.user ?? null); await restoreAccount(data.session?.user ?? null);
        setInterval(() => { if (actorOrNull() && navigator.onLine) void refresh().catch(() => {}); }, 10000);
        setInterval(() => {
          peers.value = peers.value.filter(peer => Date.now() - peer.updatedAt < 15000);
          if (!focusMode.value && !document.hidden) activity.publish();
        }, 5000);
        window.addEventListener('online', () => { void refresh().catch(() => {}); });
        window.addEventListener('offline', () => { syncState.value = 'Offline · edits saved on this device'; leavePresence(); });
        document.addEventListener('visibilitychange', () => { activity.publish(true); });
      } catch (e) { fail(e); } finally { ready.value = true; }
    })();
    return initTask;
  }
  async function signIn(email: string, password: string) {
    return action(async () => {
      if (!client) throw new Error('Start Lumen with npm run dev:team.');
      const { data, error: authError } = await client.auth.signInWithPassword({ email, password });
      if (authError) throw authError;
      noteAuthSubject(data.user); await restoreAccount(data.user);
    });
  }
  async function signUp(email: string, password: string, name: string) {
    return action(async () => {
      if (!client) throw new Error('Team accounts are not enabled.');
      if (password.length < 12) throw new Error('Use a password with at least 12 characters.');
      const { data, error: authError } = await client.auth.signUp({ email, password, options: { data: { display_name: name.slice(0, 60) } } });
      if (authError) throw authError;
      if (!data.session) { error.value = 'Check your email to confirm your account, then sign in. LAB’s default mail service may require an allowed address or your own SMTP configuration.'; return; }
      noteAuthSubject(data.user); await restoreAccount(data.user); await setProfile(name);
    });
  }
  async function signOut() {
    await action(async () => { const old = client; noteAuthSubject(null); await closeAccount(); user.value = null; const result = await old?.auth.signOut({ scope: 'local' }); if (result?.error) throw result.error; syncState.value = 'Signed out · unsent drafts retained for this account'; });
  }
  async function setProfile(name: string) { const expected = actor(); await rpc('lumen_set_profile', { p_display_name: name }, expected); assertCurrent(expected); profileName.value = name; await refresh(expected); }
  async function createTeam(name: string) { return action(async () => { const expected = actor(); const result = await rpc<{ id?: string; team_id?: string }>('lumen_create_team', { p_name: name }, expected); await refresh(expected); assertCurrent(expected); const id = result.team_id ?? result.id; if (id) await selectTeam(id); }); }
  async function joinTeam(token: string) { return action(async () => { const expected = actor(); await rpc('lumen_join_team', { p_token: token.trim() }, expected); await refresh(expected); }); }
  async function invite(inviteRole: TeamRole = 'editor') { return action(() => rpc<{ token: string; expires_at: string }>('lumen_create_invite', { p_team_id: teamId.value, p_role: inviteRole })); }
  async function setMemberRole(userId: string, nextRole: TeamRole | null) {
    return action(async () => {
      const expected = actor(), selected = teamId.value;
      if (!selected || role.value !== 'owner') throw new Error('Only a current team owner can manage members.');
      await rpc('lumen_set_member_role', { p_team_id: selected, p_user_id: userId, p_role: nextRole }, expected);
      await refresh(expected);
    });
  }
  async function selectTeam(id: string) {
    const expected = actor();
    if (!teams.value.some(team => team.id === id)) throw new Error('Choose one of your teams.');
    teamId.value = id; role.value = memberships.value.find(member => member.team_id === id && member.user_id === expected.who)?.role ?? null;
    resources.value = []; conflicts.value = []; pendingCount.value = 0; leavePresence();
    await readLocal(expected); assertCurrent(expected);
    if (teamId.value !== id) return;
    subscribePresence(); await cacheAccount(expected);
  }
  async function cacheAccount(expected: Actor) {
    assertCurrent(expected);
    const value = JSON.stringify({ teams: teams.value, memberships: memberships.value, name: profileName.value, profileNames: profileNames.value, teamId: teamId.value });
    await expected.database.execute('INSERT OR REPLACE INTO team_cache (id,value) VALUES (?,?)', ['account', value]);
  }
  async function paged<T>(api: SupabaseClient, table: string, columns: string, expected: Actor) {
    const rows: T[] = [];
    for (let page = 0; page < 20; page++) {
      assertCurrent(expected);
      const result = await api.from(table).select(columns).order('id').range(page * 500, page * 500 + 499);
      assertCurrent(expected);
      if (result.error) throw Object.assign(new Error(result.error.message), { code: result.error.code });
      rows.push(...(result.data as T[]));
      if ((result.data?.length ?? 0) < 500) return rows;
    }
    throw new Error('This test workspace is too large for a complete safe snapshot. Existing offline data was preserved.');
  }
  async function mergeCache(expected: Actor, incoming: TeamResource[], allowed: Set<string>, prune: boolean) {
    assertCurrent(expected);
    await expected.database.writeTransaction(async tx => {
      assertCurrent(expected);
      const existing = await tx.getAll<{ id: string; team_id: string; value: string }>('SELECT id,team_id,value FROM resource_cache');
      const revisions = new Map(existing.map(row => [row.id, (JSON.parse(row.value) as TeamResource).revision]));
      if (prune) for (const row of existing) if (!allowed.has(row.team_id)) await tx.execute('DELETE FROM resource_cache WHERE id = ?', [row.id]);
      for (const resource of incoming) {
        assertCurrent(expected);
        if (!allowed.has(resource.team_id) || (revisions.get(resource.id) ?? -1) > resource.revision) continue;
        await tx.execute('INSERT OR REPLACE INTO resource_cache (id,team_id,value) VALUES (?,?,?)', [resource.id, resource.team_id, JSON.stringify(resource)]);
      }
    });
  }
  async function mergeReplicated(expected: Actor) {
    if (!current(expected) || !replicationReady.value || Date.now() - membershipCheckedAt > 30000) return;
    if (replicatedTask && sameActor(replicatedTask.actor, expected)) return replicatedTask.promise;
    const task: AccountTask = { actor: expected, promise: Promise.resolve() };
    task.promise = (async () => {
      // Actual replicated SQLite data, gated independently by recently verified
      // LAB membership. Lagging replication cannot grant a newly revoked team.
      const [ownRows, rows] = await Promise.all([
        expected.database.getAll<{ team_id: string }>('SELECT team_id FROM lumen_memberships WHERE user_id = ?', [expected.who]),
        expected.database.getAll<Omit<TeamResource, 'document'> & { document: string }>('SELECT * FROM lumen_resources'),
      ]);
      if (!current(expected) || !replicationReady.value || Date.now() - membershipCheckedAt > 30000) return;
      const allowed = new Set(ownRows.map(row => row.team_id).filter(id => confirmedTeams.has(id)));
      const incoming: TeamResource[] = [];
      for (const row of rows) {
        if (!allowed.has(row.team_id)) continue;
        try { const document = JSON.parse(row.document); validateDraft(document); incoming.push({ ...row, document, revision: Number(row.revision) }); } catch { /* Invalid shared data never reaches station stores. */ }
      }
      await mergeCache(expected, incoming, allowed, false); await readLocal(expected);
    })().finally(() => { if (replicatedTask === task) replicatedTask = null; });
    replicatedTask = task; return task.promise;
  }
  async function refresh(expected = actorOrNull()) {
    if (!expected || !current(expected)) return;
    if (refreshTask && sameActor(refreshTask.actor, expected)) return refreshTask.promise;
    const task: AccountTask = { actor: expected, promise: Promise.resolve() };
    task.promise = (async () => {
      try {
        const api = await boundApi(expected);
        const [nextTeams, nextMembers, profiles, snapshot] = await Promise.all([
          paged<Team>(api, 'lumen_teams', 'id,name', expected),
          paged<Membership>(api, 'lumen_memberships', 'id,team_id,user_id,role', expected),
          paged<{ id: string; display_name: string }>(api, 'lumen_profiles', 'id,display_name', expected),
          paged<TeamResource>(api, 'lumen_resources', '*', expected),
        ]);
        assertCurrent(expected);
        const allowed = new Set(nextMembers.filter(member => member.user_id === expected.who).map(member => member.team_id));
        teams.value = nextTeams.filter(team => allowed.has(team.id)); memberships.value = nextMembers;
        profileNames.value = Object.fromEntries(profiles.map(profile => [profile.id, profile.display_name])); profileName.value = profileNames.value[expected.who] ?? 'Teammate';
        confirmedTeams = allowed; membershipCheckedAt = Date.now();
        const oldTeam = teamId.value;
        if (!teams.value.some(team => team.id === teamId.value)) teamId.value = teams.value[0]?.id ?? null;
        role.value = memberships.value.find(member => member.team_id === teamId.value && member.user_id === expected.who)?.role ?? null;
        peers.value = peers.value.filter(peer => memberships.value.some(member => member.team_id === teamId.value && member.user_id === peer.userId));
        if (oldTeam !== teamId.value) { resources.value = []; conflicts.value = []; pendingCount.value = 0; leavePresence(); }
        // Preserve acknowledged newer revisions against an older HTTP request
        // that began before the uploader committed. Prune revoked teams only.
        await mergeCache(expected, snapshot, allowed, true);
        assertCurrent(expected); await cacheAccount(expected); await readLocal(expected);
        if (presenceActive && (!room || oldTeam !== teamId.value)) subscribePresence();
        syncState.value = replicationReady.value ? 'PowerSync synced · LAB membership verified' : replicationConnected.value ? 'PowerSync connected · waiting for checkpoint' : 'LAB connected · PowerSync awaiting connection';
        if (replicationReady.value) await mergeReplicated(expected);
        await flush(expected);
      } catch (e) {
        if (current(expected)) syncState.value = navigator.onLine ? 'Connection unavailable · edits retained' : 'Offline · edits saved on this device';
        throw e;
      }
    })().finally(() => { if (refreshTask === task) refreshTask = null; });
    refreshTask = task; return task.promise;
  }
  async function saveResource(input: Partial<TeamResource> & Pick<TeamResource, 'kind' | 'name' | 'document'>, assertTransferCurrent: () => void = () => {}) {
    assertTransferCurrent();
    const expected = actor(), selected = teamId.value;
    if (!selected || !canEdit.value) throw new Error('An owner or editor account is required.');
    validateDraft(input.document);
    if (!input.name.trim() || input.name.length > 100) throw new Error('Use a name from 1 to 100 characters.');
    const id = input.id ?? crypto.randomUUID(), opId = crypto.randomUUID(), document = JSON.parse(JSON.stringify(input.document));
    await expected.database.writeTransaction(async tx => {
      assertCurrent(expected); assertTransferCurrent();
      const queued = await tx.getAll<{ value: string }>('SELECT value FROM edit_outbox WHERE resource_id = ? ORDER BY base_revision DESC,created_at DESC,id DESC LIMIT 1', [id]);
      assertCurrent(expected); assertTransferCurrent();
      const prior = queued[0] ? JSON.parse(queued[0].value) as TeamResource : null;
      if (prior && prior.team_id !== selected) throw new Error('This draft belongs to a different team.');
      if (prior && input.revision !== prior.revision) throw new Error('This draft has a newer edit on this device. Your editor content is still here; reload the saved version or save your work as a new draft.');
      const base = prior?.revision ?? input.revision ?? 0;
      const resource: TeamResource = { id, team_id: selected, kind: input.kind, name: input.name.trim(), document, revision: base + 1, updated_at: new Date().toISOString(), updated_by: expected.who };
      assertTransferCurrent();
      await tx.execute('INSERT INTO edit_outbox (id,team_id,resource_id,value,base_revision,created_at) VALUES (?,?,?,?,?,?)', [opId, selected, id, JSON.stringify(resource), base, new Date().toISOString()]);
    });
    if (!current(expected)) return;
    await readLocal(expected); void flush(expected).catch(e => { if (current(expected)) fail(e); });
  }
  async function recordConflict(expected: Actor, operation: QueuedEdit, resource: TeamResource, server: TeamResource | null, message: string) {
    const conflict: TeamConflict = { id: operation.id, resource_id: resource.id, team_id: resource.team_id, kind: resource.kind, name: resource.name, document: resource.document, serverDocument: server?.document ?? null, revision: server?.revision ?? 0, message };
    assertCurrent(expected);
    await expected.database.execute('INSERT OR REPLACE INTO edit_conflicts (id,team_id,value) VALUES (?,?,?)', [conflict.id, conflict.team_id, JSON.stringify(conflict)]);
  }
  async function flush(expected = actorOrNull()) {
    if (!expected || !current(expected) || !navigator.onLine) return;
    if (flushTask && sameActor(flushTask.actor, expected)) return flushTask.promise;
    const task: AccountTask = { actor: expected, promise: Promise.resolve() };
    task.promise = (async () => {
      await navigator.locks.request(`lumen-team-upload-${config.projectRef}-${expected.who}`, async () => {
        if (!current(expected)) return;
        const pending = await expected.database.getAll<QueuedEdit>('SELECT * FROM edit_outbox ORDER BY resource_id,base_revision,created_at,id');
        const blocked = new Set((await expected.database.getAll<{ value: string }>('SELECT value FROM edit_conflicts')).map(row => (JSON.parse(row.value) as TeamConflict).resource_id));
        for (const operation of pending) {
          if (!current(expected)) return;
          if (blocked.has(operation.resource_id)) continue;
          const resource = JSON.parse(operation.value) as TeamResource;
          try {
            const result = await rpc<{ status: 'saved' | 'conflict'; resource: TeamResource | null }>('lumen_save_resource', { p_id: resource.id, p_team_id: resource.team_id, p_kind: resource.kind, p_name: resource.name, p_document: resource.document, p_base_revision: operation.base_revision, p_operation_id: operation.id }, expected);
            assertCurrent(expected);
            if (!result || !['saved', 'conflict'].includes(result.status)
              || (result.status === 'saved' && (!result.resource || result.resource.id !== resource.id || result.resource.team_id !== resource.team_id || !Number.isSafeInteger(result.resource.revision) || result.resource.revision <= operation.base_revision))) throw new Error('The cloud returned an invalid save acknowledgement. Your local edit has been retained.');
            if (result.resource) validateDraft(result.resource.document);
            if (result.status === 'conflict') {
              await recordConflict(expected, operation, resource, result.resource, 'Another teammate edited this draft. Both versions are retained; choose which to keep.'); blocked.add(operation.resource_id);
            } else {
              if (result.resource) await mergeCache(expected, [result.resource], new Set([resource.team_id]), false);
              assertCurrent(expected); await expected.database.execute('DELETE FROM edit_outbox WHERE id = ?', [operation.id]);
            }
          } catch (e) {
            if (!current(expected)) return;
            if ((e as { code?: string }).code !== '42501') throw e;
            await recordConflict(expected, operation, resource, null, 'Your team permission changed. This offline copy is retained for review; it was not uploaded.');
            blocked.add(operation.resource_id);
          }
        }
        if (current(expected)) await readLocal(expected);
      });
    })().finally(() => { if (flushTask === task) flushTask = null; });
    flushTask = task; return task.promise;
  }
  async function resolveConflict(id: string, choice: 'server' | 'local') {
    const expected = actor(), selected = teamId.value, conflict = conflicts.value.find(item => item.id === id);
    if (!conflict || conflict.team_id !== selected) return;
    const latest = await expected.database.getAll<{ value: string }>('SELECT value FROM edit_outbox WHERE resource_id = ? ORDER BY base_revision DESC,created_at DESC,id DESC LIMIT 1', [conflict.resource_id]);
    assertCurrent(expected); if (teamId.value !== selected) return;
    if (choice === 'local') {
      const value = latest[0] ? JSON.parse(latest[0].value) as TeamResource : conflict;
      await saveResource({ kind: value.kind, name: `${value.name.slice(0, 85)} (my copy)`, document: value.document });
    }
    assertCurrent(expected);
    await expected.database.writeTransaction(async tx => { await tx.execute('DELETE FROM edit_outbox WHERE resource_id = ?', [conflict.resource_id]); await tx.execute('DELETE FROM edit_conflicts WHERE id = ?', [id]); });
    await readLocal(expected); void refresh(expected).catch(() => {});
  }
  function scheduleActivityReconnect(target: RealtimeChannel, expected: Actor) {
    if (room !== target || !current(expected) || !presenceActive) return;
    activity.cancel(); roomReady = false; activityConnected.value = false; peers.value = [];
    if (retryTimer || !navigator.onLine) return;
    // SDK retries transient socket errors itself. This bounded fallback also
    // replaces a CLOSED channel, which the SDK removes from its channel list.
    const selected = teamId.value, delay = Math.min(30000, 2000 * 2 ** Math.min(retryAttempt++, 4));
    retryTimer = setTimeout(() => {
      retryTimer = undefined;
      if (!current(expected) || room !== target || !presenceActive || teamId.value !== selected || !navigator.onLine) return;
      void refresh(expected).then(() => {
        if (current(expected) && room === target && presenceActive && teamId.value === selected && confirmedTeams.has(selected!)) subscribePresence(true);
      }).catch(() => { scheduleActivityReconnect(target, expected); });
    }, delay);
  }
  function subscribePresence(retrying = false) {
    leavePresence(!retrying);
    const expected = actorOrNull(), selected = teamId.value;
    if (!presenceActive || !selected || !client || !expected || !confirmedTeams.has(selected)) return;
    const currentRoom = client.channel(`lumen-team:${selected}`, { config: { private: true, broadcast: { ack: false, self: false }, presence: { key: sessionId } } }); room = currentRoom;
    let tracked = false;
    const belongsHere = () => current(expected) && room === currentRoom && teamId.value === selected && presenceActive;
    currentRoom.on('presence', { event: 'sync' }, () => {
      if (!belongsHere()) return;
      const states = currentRoom.presenceState<Record<string, unknown>>();
      roster.clear();
      // Presence advertises only the session roster, once on join. Cursor
      // motion, keepalives and Focus toggles never call track()/untrack().
      for (const [key, entries] of Object.entries(states)) for (const entry of entries) {
        if (roster.size >= 100 || key === sessionId || !activityId.test(key) || typeof entry.userId !== 'string' || !activityId.test(entry.userId)) continue;
        roster.set(key, { userId: entry.userId, name: typeof entry.name === 'string' ? entry.name.slice(0, 60) : 'Teammate' });
      }
      for (const key of peerSequences.keys()) if (!roster.has(key)) peerSequences.delete(key);
      peers.value = peers.value.filter(peer => roster.get(peer.sessionId)?.userId === peer.userId);
      if (!focusMode.value) activity.publish(); // Let a newly joined viewer see our latest position.
    }).on('broadcast', { event: 'activity' }, ({ payload }) => {
      if (!belongsHere() || focusMode.value) return;
      const frame = parseActivity(payload);
      if (!frame || frame.sessionId === sessionId) return;
      const known = roster.get(frame.sessionId);
      // Advisory identities only. Current database membership authorizes the
      // room; neither roster claims nor cursor payloads grant any capability.
      if (!known || known.userId !== frame.userId || !memberships.value.some(member => member.team_id === selected && member.user_id === frame.userId)
        || frame.sequence <= (peerSequences.get(frame.sessionId) ?? 0)) return;
      peerSequences.set(frame.sessionId, frame.sequence);
      const others = peers.value.filter(peer => peer.sessionId !== frame.sessionId);
      if (!frame.active) { peers.value = others; return; }
      const colors = ['#7dd3fc', '#c4b5fd', '#86efac', '#fcd34d', '#f9a8d4'];
      peers.value = [...others, { sessionId: frame.sessionId, userId: frame.userId, name: profileNames.value[frame.userId] ?? known.name,
        surface: frame.surface!, x: frame.x!, y: frame.y!, color: colors[(frame.sessionId.charCodeAt(0) || 0) % colors.length], updatedAt: Date.now() }].slice(-20);
    }).on('postgres_changes', { event: '*', schema: 'public', table: 'lumen_resources', filter: `team_id=eq.${selected}` }, () => { if (belongsHere()) void refresh(expected).catch(() => {}); })
      .on('system', {}, payload => { if (payload.status === 'error' && belongsHere()) scheduleActivityReconnect(currentRoom, expected); })
      .subscribe(status => {
        if (!belongsHere()) return;
        if (status !== 'SUBSCRIBED') { tracked = false; scheduleActivityReconnect(currentRoom, expected); return; }
        if (retryTimer) clearTimeout(retryTimer); retryTimer = undefined;
        if (tracked) return;
        tracked = true;
        void currentRoom.track({ userId: expected.who, name: profileName.value || 'Teammate' }).then(result => {
          if (!belongsHere() || currentRoom.state !== 'joined' || !client?.realtime.isConnected()) return;
          if (result !== 'ok') { scheduleActivityReconnect(currentRoom, expected); return; }
          retryAttempt = 0; roomReady = true; activityConnected.value = true; activity.publish(true);
        }).catch(() => { if (belongsHere()) scheduleActivityReconnect(currentRoom, expected); });
      });
  }
  function suspendPresence() { presenceActive = false; leavePresence(); }
  function resumePresence() { presenceActive = true; if (actorOrNull() && !room) subscribePresence(); }
  function updatePresence(surface: string, x = localPresence.x, y = localPresence.y) {
    if (!Number.isFinite(x) || !Number.isFinite(y)) return;
    localPresence = { surface: surface.slice(0, 100), x: Math.max(0, Math.min(1, x)), y: Math.max(0, Math.min(1, y)) };
    if (!focusMode.value && !document.hidden) activity.publish();
  }
  function setFocusMode(value: boolean) {
    if (value === focusMode.value) return;
    focusMode.value = value; localStorage.setItem('lumen.team.focus', String(value)); peers.value = [];
    activity.publish(true); // Cancels trailing motion; inactive frames omit coordinates.
  }
  function stationTransferGuard(resource?: TeamResource, requireEditor = false) {
    const expected = actor(), selected = teamId.value;
    const belongsHere = () => current(expected) && teamId.value === selected && !!selected && (!resource || resource.team_id === selected)
      && memberships.value.some(member => member.team_id === selected && member.user_id === expected.who
        && (!requireEditor || member.role === 'owner' || member.role === 'editor'));
    const assertWorkspaceCurrent = () => {
      if (!belongsHere()) throw new Error('The active account, workspace or permission changed. Select the workspace again before copying drafts to or from this station.');
    };
    const verifyWorkspace = async () => {
      assertWorkspaceCurrent();
      await checkStationWorkspaceImport(selected!, belongsHere);
      assertWorkspaceCurrent();
    };
    assertWorkspaceCurrent();
    return { verifyWorkspace, assertWorkspaceCurrent };
  }
  async function captureLocalDrafts() {
    const { verifyWorkspace, assertWorkspaceCurrent } = stationTransferGuard(undefined, true);
    await verifyWorkspace();
    const { captureStationDrafts } = await import('@/lib/team/station-drafts');
    assertWorkspaceCurrent();
    return captureStationDrafts(async draft => {
      await verifyWorkspace();
      return saveResource(draft, assertWorkspaceCurrent);
    }, verifyWorkspace, assertWorkspaceCurrent);
  }
  async function applyToStation(resource: TeamResource) {
    const { verifyWorkspace, assertWorkspaceCurrent } = stationTransferGuard(resource);
    await verifyWorkspace();
    const { applyStationDraft } = await import('@/lib/team/station-drafts');
    assertWorkspaceCurrent();
    return applyStationDraft(resource, verifyWorkspace, assertWorkspaceCurrent);
  }
  return { enabled, ready, busy, error, user, profileName, teams, teamId, role, members, resources, pendingCount, conflicts, syncState, replicationConnected, replicationReady, activityConnected, peers, focusMode, canEdit,
    init, signIn, signUp, signOut, createTeam, joinTeam, selectTeam, invite, setProfile, setMemberRole, saveResource, resolveConflict, setFocusMode, updatePresence, suspendPresence, resumePresence, captureLocalDrafts, applyToStation, refresh };
});
