import { computed, onScopeDispose, ref, shallowRef, watch } from 'vue';
import { defineStore } from 'pinia';
import type { BroadcastConfigInput, BroadcastDestinationId, BroadcastSnapshot } from '../../../shared/broadcast';
import { broadcastApi } from '@/lib/broadcast-api';
import { useIdentityStore } from '@/stores/identity';

export const useBroadcastStore = defineStore('broadcast', () => {
  const identity = useIdentityStore(), open = ref(false), snapshot = shallowRef<BroadcastSnapshot | null>(null), error = ref(''), loading = ref(false), busy = ref('');
  const canOperate = computed(() => identity.ready && identity.isAuthenticated && identity.can('*', 'author'));
  const active = computed(() => busy.value === 'start' || !!snapshot.value?.session && ['starting', 'live', 'stopping'].includes(snapshot.value.session.state));
  let consumers = 0, generation = 0, readSequence = 0, timer: ReturnType<typeof setTimeout> | undefined, read: AbortController | undefined, mutation: AbortController | undefined;
  function clearTimer() { if (timer) clearTimeout(timer); timer = undefined; }
  function schedule() { clearTimer(); if (consumers && canOperate.value && !document.hidden) timer = setTimeout(() => { void refresh(); }, active.value ? 2000 : 6000); }
  async function refresh() {
    if (!canOperate.value || !consumers) return null;
    read?.abort(); const controller = new AbortController(), token = generation, requestId = ++readSequence; read = controller; loading.value = !snapshot.value;
    try { const value = await broadcastApi.snapshot(controller.signal); if (token !== generation || requestId !== readSequence) return null; snapshot.value = value; if (!busy.value) error.value = ''; return value; }
    catch (cause) { if (!controller.signal.aborted && token === generation) error.value = (cause as Error).message; return null; }
    finally { if (read === controller) read = undefined; if (token === generation && requestId === readSequence) { loading.value = false; schedule(); } }
  }
  async function run(name: string, action: (signal: AbortSignal) => Promise<BroadcastSnapshot>) {
    if (!canOperate.value || busy.value) return false;
    const token = generation, controller = new AbortController(); mutation = controller; busy.value = name; error.value = ''; clearTimer(); read?.abort(); readSequence++;
    try { const result = await action(controller.signal); if (token !== generation || controller.signal.aborted) return false; read?.abort(); readSequence++; snapshot.value = result; return true; }
    catch (cause) { if (token === generation && !controller.signal.aborted) error.value = (cause as Error).message; return false; }
    finally { if (mutation === controller) mutation = undefined; if (token === generation) { busy.value = ''; schedule(); } }
  }
  async function check() {
    if (!canOperate.value || busy.value) return null;
    const token = generation, controller = new AbortController(); mutation = controller; busy.value = 'check'; error.value = ''; clearTimer();
    try { const value = await broadcastApi.preflight(controller.signal); if (token !== generation || controller.signal.aborted) return null; if (snapshot.value) snapshot.value = { ...snapshot.value, preflight: value }; return value; }
    catch (cause) { if (token === generation && !controller.signal.aborted) error.value = (cause as Error).message; return null; }
    finally { if (mutation === controller) mutation = undefined; if (token === generation) { busy.value = ''; schedule(); } }
  }
  function detach() { consumers = Math.max(0, consumers - 1); if (!consumers) { clearTimer(); read?.abort(); } }
  function attach() { consumers++; if (canOperate.value) void refresh(); return detach; }
  function reset() { generation++; readSequence++; clearTimer(); read?.abort(); mutation?.abort(); read = mutation = undefined; snapshot.value = null; busy.value = ''; error.value = ''; loading.value = false; open.value = false; }
  const stopIdentity = watch(() => [identity.ready, identity.me?.id, canOperate.value], () => { reset(); if (consumers && canOperate.value) void refresh(); });
  function visibility() { if (document.hidden) { clearTimer(); read?.abort(); } else if (consumers) void refresh(); }
  if (typeof document !== 'undefined') document.addEventListener('visibilitychange', visibility);
  onScopeDispose(() => { stopIdentity(); reset(); if (typeof document !== 'undefined') document.removeEventListener('visibilitychange', visibility); });
  return { open, snapshot, error, loading, busy, active, canOperate, attach, refresh, check,
    save: (config: BroadcastConfigInput) => identity.me?.isAdmin ? run('save', signal => broadcastApi.configure(config, signal)) : Promise.resolve(false),
    start: (record: boolean, title?: string) => run('start', signal => broadcastApi.start(record, title, signal)),
    stop: (stopRecording: boolean) => run('stop', signal => broadcastApi.stop(stopRecording, signal)),
    retry: (id: BroadcastDestinationId | 'watch') => run(`retry:${id}`, signal => broadcastApi.retry(id, signal)),
    stopDestination: (id: BroadcastDestinationId | 'watch') => run(`stop:${id}`, signal => broadcastApi.stopDestination(id, signal)),
  };
});
