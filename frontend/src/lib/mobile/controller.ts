import { computed, onBeforeUnmount, onMounted, ref, shallowRef } from 'vue';
import type { MobileAction, MobileSearchResults, MobileSessionStatus, MobileSnapshot } from '../../../../shared/mobile-controller';

export class MobileRequestError extends Error {
  constructor(message: string, readonly status: number) { super(message); }
}
export async function mobileRequest<T>(path: string, options: RequestInit = {}): Promise<T> {
  const response = await fetch(`/api/mobile${path}`, { credentials: 'same-origin', cache: 'no-store', ...options,
    signal: options.signal ?? AbortSignal.timeout(4500),
    headers: { ...(options.body ? { 'Content-Type': 'application/json' } : {}), ...options.headers } });
  const value = await response.json().catch(() => null);
  if (!response.ok) throw new MobileRequestError(value?.error || `Station request failed (${response.status}).`, response.status);
  return value as T;
}

/** Live commands are deliberately never queued, retried, or persisted. */
export function useMobileController() {
  const session = shallowRef<MobileSessionStatus | null>(null), snapshot = shallowRef<MobileSnapshot | null>(null);
  const busy = ref(false), loading = ref(true), error = ref(''), lastReceived = ref(0), clock = ref(Date.now());
  const visible = ref(!document.hidden), online = ref(navigator.onLine), reading = ref(false);
  let stopped = false, polling: AbortController | null = null, timer: ReturnType<typeof setInterval> | undefined;
  let lastRenewed = 0, readSequence = 0, sessionChecking = false;
  const fresh = computed(() => online.value && visible.value && lastReceived.value > 0 && clock.value - lastReceived.value < 4000);
  const leaseOwned = computed(() => !!snapshot.value?.lease && snapshot.value.lease.deviceId === snapshot.value.device.id &&
    snapshot.value.lease.expiresAt > snapshot.value.serverTime + Math.max(0, clock.value - lastReceived.value));
  const canControl = computed(() => fresh.value && leaseOwned.value && !busy.value && !!snapshot.value?.ticket &&
    snapshot.value.ticketExpiresAt > snapshot.value.serverTime + Math.max(0, clock.value - lastReceived.value));
  const connection = computed(() => !online.value ? 'Offline' : !visible.value ? 'Paused' : fresh.value ? 'Connected' : session.value?.paired === false ? 'Ready to pair' : loading.value ? 'Connecting' : 'Reconnecting');
  function accept(value: MobileSnapshot) {
    if (stopped) return;
    snapshot.value = value; lastReceived.value = Date.now(); clock.value = Date.now();
    session.value = { paired: true, workspaceId: value.workspaceId, device: value.device };
  }
  function invalidate() { lastReceived.value = 0; polling?.abort(); polling = null; readSequence++; }
  function failure(cause: unknown) {
    invalidate();
    if (cause instanceof DOMException && cause.name === 'AbortError') return;
    if (cause instanceof MobileRequestError && cause.status === 401) { session.value = { paired: false, workspaceId: session.value?.workspaceId ?? '' }; snapshot.value = null; }
    error.value = cause instanceof Error ? cause.message : 'The station could not be reached. No action will be retried.';
  }
  async function refresh() {
    if (stopped || busy.value || reading.value || !online.value || !visible.value || !session.value?.paired) return;
    const sequence = ++readSequence; reading.value = true;
    const request = new AbortController(); polling = request;
    const timeout = setTimeout(() => request.abort(), 3500);
    try {
      const value = await mobileRequest<MobileSnapshot>('/state', { signal: request.signal });
      if (sequence === readSequence && !busy.value) accept(value);
    } catch (cause) { if (sequence === readSequence) failure(cause); }
    finally { clearTimeout(timeout); if (polling === request) polling = null; reading.value = false; loading.value = false; }
  }
  async function initialize() {
    if (stopped || sessionChecking || !online.value || !visible.value) return;
    sessionChecking = true;
    try { session.value = await mobileRequest<MobileSessionStatus>('/session'); await refresh(); }
    catch (cause) { failure(cause); }
    finally { loading.value = false; sessionChecking = false; }
  }
  async function pair(code: string, name: string) {
    if (busy.value || !online.value) return;
    busy.value = true; error.value = '';
    try { session.value = await mobileRequest<MobileSessionStatus>('/session', { method: 'POST', body: JSON.stringify({ code: code.trim(), name: name.trim() || 'Phone operator' }) }); }
    catch (cause) { failure(cause); }
    finally { busy.value = false; }
    await refresh();
  }
  async function lease(takeover = false) {
    if (busy.value || !fresh.value) return;
    busy.value = true; error.value = ''; polling?.abort(); readSequence++;
    try { accept(await mobileRequest<MobileSnapshot>('/lease', { method: 'POST', body: JSON.stringify({ takeover }) })); lastRenewed = Date.now(); }
    catch (cause) { failure(cause); }
    finally { busy.value = false; }
  }
  async function release() {
    if (busy.value || !fresh.value) return;
    busy.value = true; error.value = ''; polling?.abort(); readSequence++;
    try { await mobileRequest('/lease', { method: 'DELETE' }); }
    catch (cause) { failure(cause); }
    finally { busy.value = false; }
    await refresh();
  }
  async function command(action: MobileAction) {
    const current = snapshot.value;
    if (!canControl.value || !current?.lease) return false;
    busy.value = true; error.value = ''; polling?.abort(); readSequence++;
    // The ticket and lease are captured once. Ambiguous results must be checked
    // on the next state read, never repeated against a newer Program revision.
    try { accept(await mobileRequest<MobileSnapshot>('/control', { method: 'POST', body: JSON.stringify({ ticket: current.ticket, leaseId: current.lease.id, action }) })); return true; }
    catch (cause) { failure(cause); return false; }
    finally { busy.value = false; }
  }
  async function disconnect() {
    if (busy.value) return;
    busy.value = true; polling?.abort(); readSequence++;
    try { await mobileRequest('/session', { method: 'DELETE' }); session.value = null; snapshot.value = null; lastReceived.value = 0; }
    catch (cause) { failure(cause); }
    finally { busy.value = false; }
  }
  async function search(channelId: string, q: string, signal?: AbortSignal) {
    return mobileRequest<MobileSearchResults>(`/search?${new URLSearchParams({ channelId, q })}`, { signal });
  }
  function connectivity() {
    online.value = navigator.onLine; visible.value = !document.hidden;
    invalidate();
    if (online.value && visible.value) { if (session.value === null) void initialize(); else void refresh(); }
  }
  onMounted(() => {
    void initialize();
    window.addEventListener('online', connectivity); window.addEventListener('offline', connectivity); document.addEventListener('visibilitychange', connectivity);
    timer = setInterval(() => {
      clock.value = Date.now();
      if (session.value === null) { void initialize(); return; }
      if (!fresh.value && !online.value) return;
      if (leaseOwned.value && fresh.value && Date.now() - lastRenewed > 10000 && !busy.value && !reading.value) void lease();
      else void refresh();
    }, 1000);
  });
  onBeforeUnmount(() => {
    stopped = true; polling?.abort(); clearInterval(timer);
    window.removeEventListener('online', connectivity); window.removeEventListener('offline', connectivity); document.removeEventListener('visibilitychange', connectivity);
  });
  return { session, snapshot, busy, loading, error, fresh, canControl, leaseOwned, connection, pair, lease, release, command, disconnect, search, refresh };
}
