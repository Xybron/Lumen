import { nextTick, onScopeDispose, readonly, shallowReactive, watch, type Ref } from 'vue';
import { SourceStillCapture } from '@/lib/studio/source-still-capture';

export interface SourceStillInput { id: string; track: MediaStreamTrack }
interface Entry extends SourceStillInput { due: number; removeListeners: () => void }

const refreshMs = 5_000, failureMs = 10_000, spacingMs = 750;
const posters = shallowReactive<Record<string, string>>({});
const consumers = new Map<symbol, readonly SourceStillInput[]>();
const entries = new Map<string, Entry>();
const capture = new SourceStillCapture();
let active: { entry: Entry; controller: AbortController } | undefined;
let timer: number | undefined, idle: number | undefined, lastStarted = -Infinity;

function usable(track: MediaStreamTrack) { return track.readyState === 'live' && track.enabled && !track.muted; }
function clearPoster(id: string) {
  const previous = posters[id];
  delete posters[id];
  if (previous) void nextTick(() => URL.revokeObjectURL(previous));
}
function cancelScheduled() {
  clearTimeout(timer); timer = undefined;
  if (idle !== undefined) window.cancelIdleCallback(idle);
  idle = undefined;
}
function drop(entry: Entry) {
  entry.removeListeners();
  if (active?.entry === entry) active.controller.abort();
  entries.delete(entry.id);
  clearPoster(entry.id);
}
function sync() {
  const wanted = new Map<string, MediaStreamTrack>();
  if (!document.hidden) for (const inputs of consumers.values()) for (const input of inputs) wanted.set(input.id, input.track);
  for (const entry of entries.values()) if (wanted.get(entry.id) !== entry.track) drop(entry);
  for (const [id, track] of wanted) {
    if (entries.has(id)) continue;
    const entry: Entry = { id, track, due: 0, removeListeners: () => {} };
    const changed = () => {
      if (!usable(track)) {
        clearPoster(id);
        if (active?.entry === entry) active.controller.abort();
      }
      entry.due = 0;
      schedule();
    };
    // Track lifetime belongs to Studio. Never overwrite its onended handler.
    for (const event of ['ended', 'mute', 'unmute']) track.addEventListener(event, changed);
    entry.removeListeners = () => { for (const event of ['ended', 'mute', 'unmute']) track.removeEventListener(event, changed); };
    entries.set(id, entry);
  }
  if (!entries.size) { cancelScheduled(); capture.dispose(); }
  else schedule();
}
function schedule() {
  cancelScheduled();
  if (active || document.hidden || !entries.size) return;
  const candidates = [...entries.values()].filter(entry => entry.track.readyState === 'live');
  if (!candidates.length) return;
  const due = Math.max(lastStarted + spacingMs, Math.min(...candidates.map(entry => entry.due)));
  timer = window.setTimeout(() => {
    timer = undefined;
    // Thumbnails yield to the operator and live rendering when the UI is busy.
    if (typeof window.requestIdleCallback === 'function') idle = window.requestIdleCallback(() => { idle = undefined; void sample(); });
    else void sample();
  }, Math.max(0, due - performance.now()));
}
async function sample() {
  if (active || document.hidden) return;
  const now = performance.now();
  const ready = [...entries.values()].filter(entry => entry.track.readyState === 'live' && entry.due <= now)
    .sort((a, b) => a.due - b.due);
  const entry = ready.find(candidate => usable(candidate.track));
  for (const candidate of ready) if (!usable(candidate.track)) { clearPoster(candidate.id); candidate.due = now + refreshMs; }
  if (!entry) { schedule(); return; }
  const task = { entry, controller: new AbortController() };
  active = task; lastStarted = now;
  let successful = false;
  try {
    const blob = await capture.capture(entry.track, task.controller.signal);
    if (entries.get(entry.id) !== entry || task.controller.signal.aborted || document.hidden || !usable(entry.track)) return;
    if (blob) {
      const previous = posters[entry.id];
      posters[entry.id] = URL.createObjectURL(blob);
      if (previous) void nextTick(() => URL.revokeObjectURL(previous));
      successful = true;
    } else clearPoster(entry.id);
  } catch {
    if (entries.get(entry.id) === entry) clearPoster(entry.id);
  } finally {
    entry.due = performance.now() + (successful ? refreshMs : failureMs);
    if (active === task) active = undefined;
    schedule();
  }
}

/** One still per source shared by visible cards, with one capture in flight. */
export function useSourceStillPosters(inputs: Ref<readonly SourceStillInput[]>) {
  const owner = Symbol('scene thumbnail');
  if (!consumers.size) document.addEventListener('visibilitychange', sync);
  consumers.set(owner, []);
  const stop = watch(inputs, value => { consumers.set(owner, value); sync(); }, { immediate: true });
  onScopeDispose(() => {
    stop(); consumers.delete(owner); sync();
    if (!consumers.size) document.removeEventListener('visibilitychange', sync);
  });
  return readonly(posters);
}
