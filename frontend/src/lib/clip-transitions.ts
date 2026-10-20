import type { ClipTimeline, ClipTimelineItem, ClipTimelineTrack, ClipTransition } from '../../../shared/clips';

export const TRANSITION_PRESETS: ReadonlyArray<{ kind: ClipTransition['kind']; label: string; description: string }> = [
  { kind: 'dissolve', label: 'Dissolve', description: 'Blend the incoming picture over the previous clip.' },
  { kind: 'wipe-left', label: 'Wipe left', description: 'Reveal the incoming picture from right to left.' },
  { kind: 'wipe-right', label: 'Wipe right', description: 'Reveal the incoming picture from left to right.' },
  { kind: 'slide-left', label: 'Slide left', description: 'Move the incoming picture in from the right.' },
  { kind: 'slide-right', label: 'Slide right', description: 'Move the incoming picture in from the left.' },
];
const clamp = (value: number, low: number, high: number) => Math.min(high, Math.max(low, value));
const end = (item: ClipTimelineItem) => item.startMs + item.durationMs;
const visual = (item: ClipTimelineItem) => item.kind === 'video' || item.kind === 'image';
const MAX_TIMELINE_MS = 2 * 60 * 60 * 1000;
export function orderedTransitionItems(track: ClipTimelineTrack): ClipTimelineItem[] { return track.items.map((item, index) => ({ item, index })).sort((a, b) => a.item.startMs - b.item.startMs || a.index - b.index).map(value => value.item); }
export function transitionAtCut(track: ClipTimelineTrack, itemId: string) {
  const ordered = orderedTransitionItems(track), index = ordered.findIndex(value => value.id === itemId), item = ordered[index], previous = ordered[index - 1];
  const maxDurationMs = item && previous ? Math.floor(Math.min(2000, item.durationMs / 2, previous.durationMs / 2)) : 0;
  const durationMs = item?.transitionIn?.durationMs ?? 0;
  let reason = '';
  if (!item) reason = 'Select a clip on this track.';
  else if (track.locked) reason = 'Unlock this track to change its transition.';
  else if (track.kind !== 'video' || !visual(item)) reason = 'Transitions belong between video or image clips.';
  else if (!previous) reason = 'The first clip has no previous picture to transition from.';
  else if (!visual(previous)) reason = 'Choose a cut between two video or image clips.';
  else if (Math.abs(item.startMs - (end(previous) - durationMs)) > 1) reason = 'Move this clip next to its previous clip to add a transition.';
  else if (maxDurationMs < 100) reason = 'Both clips need at least 0.2 seconds for a transition.';
  return { previous, item, durationMs, maxDurationMs, eligible: !reason, reason };
}
function shiftFollowing(ordered: ClipTimelineItem[], index: number, delta: number) { if (!delta) return; for (const item of ordered.slice(index)) item.startMs = Math.round(item.startMs + delta); }
export function applyTransition(track: ClipTimelineTrack, itemId: string, transition: ClipTransition | null): { applied: boolean; durationMs: number; reason?: string } {
  const info = transitionAtCut(track, itemId);
  if (!info.eligible) return { applied: false, durationMs: info.durationMs, reason: info.reason };
  if (transition && !TRANSITION_PRESETS.some(value => value.kind === transition.kind)) return { applied: false, durationMs: info.durationMs, reason: 'Choose an available transition.' };
  const durationMs = transition ? Math.round(clamp(transition.durationMs, 100, info.maxDurationMs)) : 0;
  const ordered = orderedTransitionItems(track), index = ordered.findIndex(item => item.id === itemId);
  const delta = end(info.previous!) - durationMs - info.item!.startMs;
  if (ordered.slice(index).some(item => item.startMs + delta < 0 || end(item) + delta > MAX_TIMELINE_MS)) return { applied: false, durationMs: info.durationMs, reason: 'This change would extend the project beyond two hours. Shorten its ending first.' };
  shiftFollowing(ordered, index, delta);
  if (transition) info.item!.transitionIn = { kind: transition.kind, durationMs }; else delete info.item!.transitionIn;
  return { applied: true, durationMs };
}

export interface TransitionBulkSummary { eligible: number; changed: number; skipped: number; reason?: string }
export interface TransitionBulkResult { applied: boolean; changed: number; skipped: number; reason?: string }

function maximumConcurrent(timeline: ClipTimeline, include: (track: ClipTimelineTrack, item: ClipTimelineItem) => boolean): number {
  const events = timeline.tracks.flatMap(track => track.items.filter(item => include(track, item)).flatMap(item => [[item.startMs, 1], [end(item), -1]]));
  events.sort((a, b) => a[0]! - b[0]! || a[1]! - b[1]!);
  let current = 0, maximum = 0;
  for (const [, delta] of events) { current += delta!; maximum = Math.max(maximum, current); }
  return maximum;
}

/** Build a bounded, private timing plan. The user's objects stay untouched until every track passes. */
function planTransitionToAll(timeline: ClipTimeline, transition: ClipTransition): { summary: TransitionBulkSummary; tracks?: ClipTimelineTrack[] } {
  const total = timeline.tracks.reduce((sum, track) => sum + (track.kind === 'video' ? Math.max(0, track.items.length - 1) : 0), 0);
  const summary: TransitionBulkSummary = { eligible: 0, changed: 0, skipped: total };
  if (!TRANSITION_PRESETS.some(value => value.kind === transition.kind) || !Number.isInteger(transition.durationMs) || transition.durationMs < 100 || transition.durationMs > 2000) {
    summary.reason = 'Choose a transition duration from 0.10 to 2.00 seconds.'; return { summary };
  }
  if (timeline.tracks.length > 12 || timeline.tracks.reduce((sum, track) => sum + track.items.length, 0) > 120) {
    summary.reason = 'Keep the project within 12 tracks and 120 clips.'; return { summary };
  }
  const tracks = timeline.tracks.map(track => ({ ...track, items: track.items.map(item => ({ ...item, ...(item.transitionIn ? { transitionIn: { ...item.transitionIn } } : {}) })) }));
  for (let trackIndex = 0; trackIndex < tracks.length; trackIndex++) {
    const original = timeline.tracks[trackIndex]!, planned = tracks[trackIndex]!;
    if (original.kind !== 'video' || original.locked) continue;
    // Eligibility is measured at the existing cut, before any ripple. The same
    // suffix shift preserves each later gap or already-owned overlap exactly.
    const ordered = orderedTransitionItems(planned), originalOrder = orderedTransitionItems(original);
    for (let index = 1; index < ordered.length; index++) {
      const item = ordered[index]!, previous = ordered[index - 1]!, originalItem = originalOrder[index]!;
      const info = transitionAtCut(original, originalItem.id);
      if (!info.eligible || transition.durationMs > info.maxDurationMs) continue;
      summary.eligible++; summary.skipped--;
      const delta = end(previous) - transition.durationMs - item.startMs;
      if (item.transitionIn?.kind === transition.kind && item.transitionIn.durationMs === transition.durationMs && delta === 0) continue;
      shiftFollowing(ordered, index, delta);
      item.transitionIn = { ...transition }; summary.changed++;
    }
  }
  if (!summary.changed) {
    summary.reason = summary.eligible ? 'All suitable cuts already use this transition and duration.' : 'No adjoining, unlocked video cuts can use this exact duration.';
    return { summary };
  }
  const plannedTimeline = { ...timeline, tracks };
  let reason: string | undefined;
  if (tracks.some(track => track.items.some(item => !Number.isFinite(item.startMs) || item.startMs < 0 || end(item) > MAX_TIMELINE_MS))) reason = 'This change would extend the project beyond two hours. Shorten its ending first.';
  const visible = (track: ClipTimelineTrack, item: ClipTimelineItem) => !track.hidden && item.kind !== 'audio' && item.opacity > 0;
  const audible = (track: ClipTimelineTrack, item: ClipTimelineItem) => !track.muted && !item.muted && item.volume > 0 && (item.kind === 'audio' || item.kind === 'video');
  if (!reason && tracks.reduce((sum, track) => sum + track.items.filter(item => visible(track, item) || audible(track, item)).length, 0) > 64) reason = 'Use no more than 64 enabled media or text clips per export.';
  if (!reason && maximumConcurrent(plannedTimeline, visible) > 8) reason = 'These overlaps would show more than eight items at once. Hide or simplify an overlay track first.';
  if (!reason && maximumConcurrent(plannedTimeline, audible) > 16) reason = 'These overlaps would play more than sixteen audio sources at once. Mute a track first.';
  if (reason) { summary.reason = reason; return { summary }; }
  return { summary, tracks };
}

/** Counts use the same exact-duration and final-project checks as the bulk action. */
export function transitionBulkSummary(timeline: ClipTimeline, transition: ClipTransition): TransitionBulkSummary {
  return planTransitionToAll(timeline, transition).summary;
}

/** One atomic edit across unlocked video tracks; never clamps a cut to a different duration. */
export function applyTransitionToAll(timeline: ClipTimeline, transition: ClipTransition): TransitionBulkResult {
  const { summary, tracks } = planTransitionToAll(timeline, transition);
  if (!tracks) return { applied: false, changed: 0, skipped: summary.skipped, reason: summary.reason };
  for (let trackIndex = 0; trackIndex < tracks.length; trackIndex++) {
    const planned = tracks[trackIndex]!, original = timeline.tracks[trackIndex]!;
    if (original.locked || original.kind !== 'video') continue;
    for (let itemIndex = 0; itemIndex < planned.items.length; itemIndex++) {
      const from = planned.items[itemIndex]!, to = original.items[itemIndex]!;
      to.startMs = from.startMs;
      if (from.transitionIn) to.transitionIn = { ...from.transitionIn };
      else delete to.transitionIn;
    }
  }
  return { applied: true, changed: summary.changed, skipped: summary.skipped };
}
/** Metadata is removed without silently dragging manually moved clips back. */
export function detachTransitionLinks(track: ClipTimelineTrack, itemId: string): void {
  if (track.locked) return;
  const ordered = orderedTransitionItems(track), index = ordered.findIndex(item => item.id === itemId), item = ordered[index], next = ordered[index + 1];
  if (!item) return;
  if (next?.transitionIn && Math.abs(next.startMs - (end(item) - next.transitionIn.durationMs)) <= 1) delete next.transitionIn;
  delete item.transitionIn;
}
/** Existing transition metadata owns its cut. Plain gaps and other tracks stay. */
export function normalizeTrackTransitions(track: ClipTimelineTrack, logicalOrder = orderedTransitionItems(track)): { applied: boolean; reason?: string } {
  if (track.locked) return { applied: true };
  const before = logicalOrder.map(item => ({ item, startMs: item.startMs, transitionIn: item.transitionIn ? { ...item.transitionIn } : undefined, audioFadeInMs: item.audioFadeInMs, audioFadeOutMs: item.audioFadeOutMs }));
  for (let index = 0; index < logicalOrder.length; index++) {
    const item = logicalOrder[index]!, previous = logicalOrder[index - 1];
    for (const field of ['audioFadeInMs', 'audioFadeOutMs'] as const) if (item[field] !== undefined) {
      if (item.kind !== 'video' && item.kind !== 'audio') delete item[field];
      else item[field] = Math.round(clamp(item[field]!, 0, Math.min(2000, Math.floor(item.durationMs / 2))));
    }
    const transition = item.transitionIn;
    if (!transition) continue;
    if (track.kind !== 'video' || !previous || !visual(item) || !visual(previous)) { delete item.transitionIn; continue; }
    const maximum = Math.floor(Math.min(2000, item.durationMs / 2, previous.durationMs / 2)), duration = maximum >= 100 ? Math.round(clamp(transition.durationMs, 100, maximum)) : 0;
    shiftFollowing(logicalOrder, index, end(previous) - duration - item.startMs);
    if (duration) item.transitionIn = { kind: transition.kind, durationMs: duration }; else delete item.transitionIn;
  }
  if (logicalOrder.some(item => item.startMs < 0 || end(item) > MAX_TIMELINE_MS)) {
    for (const value of before) { value.item.startMs = value.startMs; for (const key of ['transitionIn', 'audioFadeInMs', 'audioFadeOutMs'] as const) { delete value.item[key]; if (value[key] !== undefined) Object.assign(value.item, { [key]: value[key] }); } }
    return { applied: false, reason: 'This edit would extend the project beyond two hours. Shorten its ending first.' };
  }
  return { applied: true };
}
export function transitionVisual(item: ClipTimelineItem, atMs: number) {
  const effect = item.transitionIn, progress = effect ? clamp((atMs - item.startMs) / effect.durationMs, 0, 1) : 1;
  return { progress, opacityMultiplier: effect?.kind === 'dissolve' ? progress : 1,
    translateXFraction: effect?.kind === 'slide-left' ? 1 - progress : effect?.kind === 'slide-right' ? progress - 1 : 0,
    clipInsetLeft: effect?.kind === 'wipe-left' ? 1 - progress : 0, clipInsetRight: effect?.kind === 'wipe-right' ? 1 - progress : 0 };
}
export function audioFadeGain(item: ClipTimelineItem, atMs: number) {
  const local = atMs - item.startMs;
  if (local < 0 || local >= item.durationMs) return 0;
  return (item.audioFadeInMs ? clamp(local / item.audioFadeInMs, 0, 1) : 1) * (item.audioFadeOutMs ? clamp((item.durationMs - local) / item.audioFadeOutMs, 0, 1) : 1);
}
