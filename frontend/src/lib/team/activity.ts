// Transient, advisory cursor data only. This is never a document, permission or
// queued offline operation. Presence is reserved for the slow-changing roster.
export interface TeamActivity {
  version: 1;
  sessionId: string;
  userId: string;
  sequence: number;
  active: boolean;
  surface?: string;
  x?: number;
  y?: number;
}

export const activityId = /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i;
export function parseActivity(value: unknown): TeamActivity | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const frame = value as Record<string, unknown>;
  if (frame.version !== 1 || typeof frame.sessionId !== 'string' || frame.sessionId.length !== 36 || !activityId.test(frame.sessionId)
    || typeof frame.userId !== 'string' || frame.userId.length !== 36 || !activityId.test(frame.userId)
    || typeof frame.sequence !== 'number' || !Number.isSafeInteger(frame.sequence) || frame.sequence < 1
    || typeof frame.active !== 'boolean') return null;
  const base: TeamActivity = { version: 1, sessionId: frame.sessionId, userId: frame.userId, sequence: frame.sequence, active: frame.active };
  // An inactive frame deliberately has no pointer coordinates or surface.
  if (!frame.active) return base;
  if (typeof frame.surface !== 'string' || !frame.surface.length || frame.surface.length > 100
    || typeof frame.x !== 'number' || !Number.isFinite(frame.x) || frame.x < 0 || frame.x > 1
    || typeof frame.y !== 'number' || !Number.isFinite(frame.y) || frame.y < 0 || frame.y > 1) return null;
  return { ...base, surface: frame.surface, x: frame.x, y: frame.y };
}

interface ActivityClock { now(): number; schedule(callback: () => void, delay: number): () => void }
const clock: ActivityClock = {
  now: () => Date.now(),
  schedule(callback, delay) { const timer = setTimeout(callback, delay); return () => clearTimeout(timer); },
};

// Coalesce pointer bursts, but always deliver the final position. Re-read the
// latest state at send time; never retain a motion payload across Focus/offline.
export function activityPublisher(canSend: () => boolean, sendLatest: () => void, scheduler: ActivityClock = clock) {
  let cancelPending: (() => void) | undefined, lastSent = -Infinity;
  const cancel = () => { cancelPending?.(); cancelPending = undefined; };
  function publish(urgent = false) {
    if (!canSend()) { cancel(); return; }
    const delay = Math.max(0, 250 - (scheduler.now() - lastSent));
    if (urgent || !delay) {
      cancel(); lastSent = scheduler.now(); sendLatest();
    } else if (!cancelPending) {
      cancelPending = scheduler.schedule(() => { cancelPending = undefined; publish(); }, delay);
    }
  }
  return { publish, cancel };
}
