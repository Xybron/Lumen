import type { ClipRecording, ClipSettings, ClipSourceRef, ClipTimeline, ClipTimelineItem, ClipTimelineTrack } from '../../../shared/clips';
import { normalizeTrackTransitions, orderedTransitionItems } from './clip-transitions';

export const MIN_ITEM_MS = 100;
export const MAX_TIMELINE_MS = 2 * 60 * 60 * 1000;
export const copyTimeline = <T>(value: T): T => JSON.parse(JSON.stringify(value)) as T;
export const clipId = (prefix: string) => `${prefix}_${crypto.randomUUID()}`;
export const clamp = (value: number, min: number, max: number) => Math.min(max, Math.max(min, value));
export const endOf = (item: ClipTimelineItem) => item.startMs + item.durationMs;
export const timelineDuration = (timeline: ClipTimeline) => Math.max(0, ...timeline.tracks.flatMap(track => track.items.map(endOf)));
export const findItem = (timeline: ClipTimeline, id: string | null) => {
  for (const track of timeline.tracks) { const item = track.items.find(value => value.id === id); if (item) return { track, item }; }
  return null;
};
function restoreItems(track: ClipTimelineTrack, snapshot: ClipTimelineItem[]) {
  const current = new Map(track.items.map(item => [item.id, item]));
  track.items = snapshot.map(saved => { const value = copyTimeline(saved), item = current.get(saved.id) ?? {} as ClipTimelineItem; for (const key of Object.keys(item)) delete (item as unknown as Record<string, unknown>)[key]; Object.assign(item, value); return item; });
}
export function makeTrack(kind: ClipTimelineTrack['kind'], name: string): ClipTimelineTrack {
  return { id: clipId('track'), kind, name, hidden: false, muted: false, locked: false, items: [] };
}
export function makeItem(kind: ClipTimelineItem['kind'], name: string, durationMs: number, source?: ClipSourceRef): ClipTimelineItem {
  return { id: clipId('item'), kind, name: name.slice(0, 120), ...(source ? { source } : {}), startMs: 0, inMs: 0, durationMs: Math.max(MIN_ITEM_MS, Math.min(MAX_TIMELINE_MS, Math.round(durationMs))),
    x: 0, y: 0, width: 1, height: 1, fit: 'cover', positionX: .5, positionY: .5, opacity: 1, volume: 1, muted: false,
    text: '', fontSize: 64, fontWeight: 600, color: '#ffffff', background: '#00000000', align: 'center' };
}
export function hydrateTimeline(settings: ClipSettings, recording: ClipRecording): ClipTimeline {
  if (settings.timeline) return copyTimeline(settings.timeline);
  const main = makeTrack('video', 'Main video'), item = makeItem('video', recording.name, settings.outMs - settings.inMs, { kind: 'recording', id: recording.id });
  Object.assign(item, { inMs: settings.inMs, fit: settings.fit, positionX: settings.positionX, positionY: settings.positionY });
  main.items.push(item);
  return { version: 1, background: '#000000', tracks: [main, makeTrack('video', 'Overlay'), makeTrack('text', 'Text'), makeTrack('audio', 'Audio')] };
}
export function splitItem(timeline: ClipTimeline, id: string, atMs: number): string | null {
  const selected = findItem(timeline, id); if (!selected || selected.track.locked) return null;
  const { item, track } = selected, offset = Math.round(atMs - item.startMs);
  if (offset < MIN_ITEM_MS || item.durationMs - offset < MIN_ITEM_MS) return null;
  const snapshot = copyTimeline(track.items);
  const right = { ...copyTimeline(item), id: clipId('item'), startMs: item.startMs + offset, inMs: item.kind === 'image' || item.kind === 'text' ? 0 : item.inMs + offset, durationMs: item.durationMs - offset };
  const ordered = orderedTransitionItems(track), index = ordered.findIndex(value => value.id === id);
  delete right.transitionIn; delete right.audioFadeInMs; delete item.audioFadeOutMs;
  item.durationMs = offset; ordered.splice(index + 1, 0, right); track.items = ordered;
  if (!normalizeTrackTransitions(track, ordered).applied) { restoreItems(track, snapshot); return null; }
  return right.id;
}
export function snapTime(ms: number, timeline: ClipTimeline, excludeId: string | null, playhead: number, threshold: number) {
  const points = [0, playhead, ...timeline.tracks.flatMap(track => track.items.filter(item => item.id !== excludeId).flatMap(item => [item.startMs, endOf(item)]))];
  let target = ms, distance = threshold;
  for (const point of points) if (Math.abs(point - ms) < distance) { distance = Math.abs(point - ms); target = point; }
  return Math.round(target);
}
/** Move a main-sequence clip between neighbours, keeping their order gapless. */
export function reorderSequence(track: ClipTimelineTrack, id: string, atMs: number) {
  const item = track.items.find(value => value.id === id); if (!item || track.locked) return;
  const snapshot = copyTimeline(track.items);
  const others = track.items.filter(value => value.id !== id).sort((a, b) => a.startMs - b.startMs);
  const index = others.findIndex(value => atMs < value.startMs + value.durationMs / 2);
  others.splice(index < 0 ? others.length : index, 0, item);
  let start = 0;
  for (const [index, value] of others.entries()) {
    if (index === 0) delete value.transitionIn;
    const previous = others[index - 1];
    const maximum = previous ? Math.floor(Math.min(2000, previous.durationMs / 2, value.durationMs / 2)) : 0;
    if (value.transitionIn) {
      if (maximum < 100 || track.kind !== 'video' || !['video', 'image'].includes(value.kind) || !previous || !['video', 'image'].includes(previous.kind)) delete value.transitionIn;
      else value.transitionIn.durationMs = clamp(Math.round(value.transitionIn.durationMs), 100, maximum);
    }
    value.startMs = start - (value.transitionIn?.durationMs ?? 0); start = value.startMs + value.durationMs;
  }
  track.items = others;
  if (!normalizeTrackTransitions(track, others).applied || others.some(value => endOf(value) > MAX_TIMELINE_MS)) restoreItems(track, snapshot);
}
export function formatClipTime(ms: number, precise = false) {
  const total = Math.max(0, Math.round(ms)), h = Math.floor(total / 3600000), m = Math.floor(total / 60000) % 60, s = Math.floor(total / 1000) % 60;
  return `${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}${precise ? '.' + String(total % 1000).padStart(3, '0') : ''}`;
}
export function parseClipTime(value: string) {
  if (!/^\d+(?::\d{1,2}){0,2}(?:\.\d{1,3})?$/.test(value.trim())) return null;
  const parts = value.trim().split(':').map(Number);
  if (parts.slice(1).some(part => part >= 60) || parts.some(part => !Number.isFinite(part))) return null;
  return Math.round(parts.reduce((total, part) => total * 60 + part, 0) * 1000);
}
