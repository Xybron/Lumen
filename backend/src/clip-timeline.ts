import path from 'node:path';
import sharp from 'sharp';
import { z } from 'zod';
import type { ClipExportOptions, ClipFormat, ClipSourceRef, ClipTimeline, ClipTimelineItem } from '../../shared/clips.js';
import { CLIP_SIZES, MAX_CLIP_MS, clipExportDimensions, clipExportProfile, clipOutputArguments } from './clip-media.js';

export const MAX_TIMELINE_TRACKS = 12;
export const MAX_TIMELINE_ITEMS = 120;
export const MAX_TIMELINE_INPUTS = 64;
const id = z.string().regex(/^[a-zA-Z0-9][a-zA-Z0-9_-]{0,119}$/);
const color = z.string().regex(/^#[\da-fA-F]{6}(?:[\da-fA-F]{2})?$/);
const ms = z.number().int().min(0).max(MAX_CLIP_MS);
const itemSchema = z.object({
  id, name: z.string().trim().min(1).max(120), kind: z.enum(['video', 'image', 'audio', 'text']),
  source: z.object({ kind: z.enum(['recording', 'asset']), id }).strict().optional(),
  startMs: ms, inMs: z.number().int().min(0).max(24 * 60 * 60 * 1000), durationMs: z.number().int().min(100).max(MAX_CLIP_MS),
  x: z.number().min(-1).max(1), y: z.number().min(-1).max(1),
  width: z.number().min(.01).max(2), height: z.number().min(.01).max(2),
  fit: z.enum(['cover', 'contain']), positionX: z.number().min(0).max(1), positionY: z.number().min(0).max(1),
  opacity: z.number().min(0).max(1), volume: z.number().min(0).max(1), muted: z.boolean(),
  text: z.string().max(5000).refine(value => !/[\u0000-\u0008\u000b\u000c\u000e-\u001f]/.test(value), 'Text contains unsupported control characters.'), fontSize: z.number().int().min(12).max(300),
  fontWeight: z.number().int().min(100).max(900).multipleOf(100), color, background: color,
  align: z.enum(['left', 'center', 'right']),
  transitionIn: z.object({ kind: z.enum(['dissolve', 'wipe-left', 'wipe-right', 'slide-left', 'slide-right']), durationMs: z.number().int().min(100).max(2000) }).strict().optional(),
  audioFadeInMs: z.number().int().min(0).max(2000).optional(), audioFadeOutMs: z.number().int().min(0).max(2000).optional(),
}).strict();

/** Untrusted timelines contain opaque IDs, never filesystem paths or FFmpeg expressions. */
export const timelineSchema = z.object({
  version: z.literal(1), background: color,
  tracks: z.array(z.object({
    id, name: z.string().trim().min(1).max(120), kind: z.enum(['video', 'audio', 'text']),
    muted: z.boolean(), hidden: z.boolean(), locked: z.boolean(),
    items: z.array(itemSchema).max(MAX_TIMELINE_ITEMS),
  }).strict()).min(1).max(MAX_TIMELINE_TRACKS),
}).strict().superRefine((timeline, ctx) => {
  const trackIds = new Set<string>(), itemIds = new Set<string>();
  let count = 0;
  for (const [trackIndex, track] of timeline.tracks.entries()) {
    if (trackIds.has(track.id)) ctx.addIssue({ code: z.ZodIssueCode.custom, message: 'Each timeline track needs a unique ID.', path: ['tracks', trackIndex, 'id'] });
    trackIds.add(track.id);
    const ordered = track.items.map((item, index) => ({ item, index })).sort((a, b) => a.item.startMs - b.item.startMs || a.index - b.index).map(value => value.item);
    for (const [itemIndex, item] of track.items.entries()) {
      count++;
      const issue = (message: string) => ctx.addIssue({ code: z.ZodIssueCode.custom, message, path: ['tracks', trackIndex, 'items', itemIndex] });
      if (itemIds.has(item.id)) issue('Each timeline item needs a unique ID.');
      itemIds.add(item.id);
      if (item.startMs + item.durationMs > MAX_CLIP_MS) issue('Keep the timeline within two hours.');
      if (item.kind === 'text' ? item.source !== undefined : item.source === undefined) issue('Choose a valid media source for this item.');
      if (item.kind === 'text' && item.inMs !== 0) issue('Text items cannot have a source trim.');
      if (item.kind === 'image' && item.inMs !== 0) issue('Still images cannot have a source trim.');
      if (track.kind === 'text' && item.kind !== 'text' || track.kind === 'audio' && item.kind !== 'audio' || track.kind === 'video' && !['video', 'image'].includes(item.kind)) issue('This item belongs on a matching video, audio or text track.');
      if (item.source?.kind === 'recording' && item.kind !== 'video') issue('Recordings can only be used as video items.');
      for (const fade of [item.audioFadeInMs, item.audioFadeOutMs]) if (fade !== undefined && ((item.kind !== 'audio' && item.kind !== 'video') || fade > Math.floor(item.durationMs / 2))) issue('Audio fades belong on audio or video clips and cannot exceed half their duration.');
      if (item.transitionIn) {
        const previous = ordered[ordered.findIndex(value => value.id === item.id) - 1];
        if (track.kind !== 'video' || !['video', 'image'].includes(item.kind) || !previous || !['video', 'image'].includes(previous.kind)) issue('A transition needs a previous video or image on the same video track.');
        else if (item.transitionIn.durationMs > Math.floor(Math.min(previous.durationMs / 2, item.durationMs / 2))) issue('Keep a transition within half the duration of each neighbouring clip.');
        else if (Math.abs(item.startMs - (previous.startMs + previous.durationMs - item.transitionIn.durationMs)) > 1) issue('A transition must own the matching overlap at the neighbouring cut.');
      }
    }
  }
  if (count === 0) ctx.addIssue({ code: z.ZodIssueCode.custom, message: 'Add at least one timeline item.', path: ['tracks'] });
  if (count > MAX_TIMELINE_ITEMS) ctx.addIssue({ code: z.ZodIssueCode.custom, message: `Use no more than ${MAX_TIMELINE_ITEMS} timeline items.`, path: ['tracks'] });
  const inputs = timeline.tracks.reduce((sum, track) => sum + track.items.filter(item => visible(track, item) || audible(track, item)).length, 0);
  if (inputs > MAX_TIMELINE_INPUTS) ctx.addIssue({ code: z.ZodIssueCode.custom, message: `Use no more than ${MAX_TIMELINE_INPUTS} enabled media or text items per export.`, path: ['tracks'] });
  const maximumOverlap = (condition: (track: ClipTimeline['tracks'][number], item: ClipTimelineItem) => boolean) => {
    const events = timeline.tracks.flatMap(track => track.items.filter(item => condition(track, item)).flatMap(item => [[item.startMs, 1], [item.startMs + item.durationMs, -1]]));
    events.sort((a, b) => a[0] - b[0] || a[1] - b[1]);
    let current = 0, maximum = 0;
    for (const [, delta] of events) { current += delta; maximum = Math.max(current, maximum); }
    return maximum;
  };
  if (maximumOverlap(visible) > 8) ctx.addIssue({ code: z.ZodIssueCode.custom, message: 'Use no more than eight visible items at the same time.', path: ['tracks'] });
  if (maximumOverlap(audible) > 16) ctx.addIssue({ code: z.ZodIssueCode.custom, message: 'Use no more than sixteen audio sources at the same time.', path: ['tracks'] });
});

export interface TimelineSourceInfo {
  kind: 'video' | 'image' | 'audio';
  durationMs: number;
  width: number;
  height: number;
  /** Required for video audio. Unknown/silent videos must not address a nonexistent stream. */
  hasAudio?: boolean;
}
export interface ResolvedTimelineSource extends TimelineSourceInfo { path: string }
export class TimelineError extends Error { status = 422; }
export const timelineSourceKey = (source: ClipSourceRef) => `${source.kind}:${source.id}`;
export function timelineDuration(timeline: ClipTimeline) {
  return timeline.tracks.reduce((duration, track) => Math.max(duration, ...track.items.map(item => item.startMs + item.durationMs)), 0);
}

function visible(track: { hidden: boolean }, item: ClipTimelineItem) {
  return !track.hidden && item.kind !== 'audio' && item.opacity > 0;
}
function audible(track: { muted: boolean }, item: ClipTimelineItem) {
  return !track.muted && !item.muted && item.volume > 0 && (item.kind === 'audio' || item.kind === 'video');
}

/** Pure server-side bounds check, after every source ID has been resolved by the caller. */
export function validateTimelineSources(timeline: ClipTimeline, sources: ReadonlyMap<string, TimelineSourceInfo>): void {
  const parsed = timelineSchema.safeParse(timeline);
  if (!parsed.success) throw new TimelineError(parsed.error.issues[0]?.message ?? 'Invalid timeline.');
  for (const track of timeline.tracks) for (const item of track.items) {
    if (!item.source) continue;
    const source = sources.get(timelineSourceKey(item.source));
    if (!source) throw new TimelineError(`The media for “${item.name}” is unavailable.`);
    if (source.kind !== item.kind) throw new TimelineError(`The media type for “${item.name}” does not match its track.`);
    if (!Number.isFinite(source.durationMs) || item.kind !== 'image' && (source.durationMs <= 0 || item.inMs >= source.durationMs || item.inMs + item.durationMs > source.durationMs + 100)) {
      throw new TimelineError(`The trim for “${item.name}” extends outside its source.`);
    }
    if (item.kind !== 'audio' && (!Number.isInteger(source.width) || !Number.isInteger(source.height) || source.width < 2 || source.height < 2 || source.width > 16384 || source.height > 16384)) throw new TimelineError(`The dimensions for “${item.name}” are unavailable or unsupported.`);
  }
}

/** Extract metadata from the bounded diagnostic output of a caller-owned FFmpeg probe. */
export function parseTimelineMediaInfo(stderr: string, kind: TimelineSourceInfo['kind'], fallbackDurationMs = 0): TimelineSourceInfo | null {
  const duration = stderr.match(/Duration:\s*(\d+):(\d{2}):(\d{2}(?:\.\d+)?)/);
  const durationMs = duration ? Math.round((Number(duration[1]) * 3600 + Number(duration[2]) * 60 + Number(duration[3])) * 1000) : fallbackDurationMs;
  const hasAudio = /Stream.*Audio:/.test(stderr);
  if (kind === 'audio') return hasAudio && durationMs > 0 && Number.isFinite(durationMs) ? { kind, durationMs, width: 0, height: 0, hasAudio: true } : null;
  // Codec tags such as "0x0000" appear before the real size in FFmpeg's
  // stream description. Positive dimensions and token delimiters keep those
  // hexadecimal identifiers from being mistaken for tiny image geometry.
  const match = stderr.split(/\r?\n/).find(line => /Stream.*Video:/.test(line))?.match(/(?:^|[\s,])([1-9]\d{0,4})x([1-9]\d{0,4})(?=$|[\s,])/);
  if (!match) return null;
  const width = Number(match[1]), height = Number(match[2]);
  if (width < 2 || height < 2 || width > 16384 || height > 16384 || !Number.isFinite(durationMs) || kind !== 'image' && durationMs <= 0) return null;
  return { kind, durationMs: kind === 'image' ? Math.max(0, durationMs) : durationMs, width, height, hasAudio };
}

const escapeMarkup = (value: string) => value.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&apos;');
const rgba = (value: string) => ({ r: parseInt(value.slice(1, 3), 16), g: parseInt(value.slice(3, 5), 16), b: parseInt(value.slice(5, 7), 16), alpha: value.length === 9 ? parseInt(value.slice(7, 9), 16) / 255 : 1 });
const even = (value: number) => Math.max(2, Math.round(value / 2) * 2);

/** Rasterise bounded Pango text, not user-authored SVG/filter syntax. The directory is worker-private. */
export async function prepareTimelineText(timeline: ClipTimeline, format: ClipFormat, privateDir: string, shouldStop: () => boolean = () => false): Promise<Map<string, string>> {
  timelineSchema.parse(timeline);
  if (!path.isAbsolute(privateDir)) throw new TimelineError('A private absolute export directory is required.');
  const result = new Map<string, string>(), [frameWidth, frameHeight] = CLIP_SIZES[format];
  for (const track of timeline.tracks) for (const item of track.items) {
    if (item.kind !== 'text' || !visible(track, item)) continue;
    if (shouldStop()) throw new TimelineError('Export interrupted before preparing its text.');
    const width = even(frameWidth * item.width), height = even(frameHeight * item.height);
    const foreground = rgba(item.color), background = rgba(item.background);
    let canvas = sharp({ create: { width, height, channels: 4, background } });
    if (item.text.trim()) {
      // Font sizes use 1080px-high reference coordinates, like the browser stage.
      const fontSize = Math.max(6, Math.round(item.fontSize * frameHeight / 1080));
      // Text outside the box is clipped in the browser. Do not ask Pango to
      // allocate an arbitrarily tall image for 5,000 characters in a tiny box.
      // Keeping two framefuls leaves ample glyph-width slack before clipping.
      const maxLines = Math.max(1, Math.ceil(height / fontSize) + 1);
      const maxCharacters = Math.max(4, Math.ceil(width / fontSize * 2) * maxLines);
      const renderedText = item.text.split('\n').slice(0, maxLines).join('\n').slice(0, maxCharacters);
      const text = await sharp({ text: {
        text: `<span foreground="${item.color.slice(0, 7)}" alpha="${Math.round(foreground.alpha * 65535)}" weight="${item.fontWeight}">${escapeMarkup(renderedText)}</span>`,
        font: `Arial ${fontSize}`, width, rgba: true, dpi: 72,
        align: item.align === 'center' ? 'centre' : item.align, spacing: Math.round(fontSize * .15),
      } }).png().toBuffer();
      const metadata = await sharp(text).metadata(), textHeight = metadata.height ?? 1, textWidth = metadata.width ?? 1;
      const clipped = await sharp(text).extract({ left: 0, top: 0, width: Math.min(width, textWidth), height: Math.min(height, textHeight) }).png().toBuffer();
      const left = item.align === 'center' ? Math.floor((width - Math.min(width, textWidth)) / 2) : item.align === 'right' ? width - Math.min(width, textWidth) : 0;
      canvas = canvas.composite([{ input: clipped, top: Math.max(0, Math.floor((height - Math.min(height, textHeight)) / 2)), left }]);
    }
    if (shouldStop()) throw new TimelineError('Export interrupted before preparing its text.');
    const target = path.join(privateDir, `text-${item.id}.png`);
    await canvas.png().toFile(target);
    result.set(item.id, target);
  }
  return result;
}

const secs = (ms: number) => (ms / 1000).toFixed(3);
const ffColor = (value: string) => `0x${value.slice(1)}`;
export const TIMELINE_INPUT_FORMATS = 'mov,matroska,webm,mp3,wav,ogg,flac,aac,image2,png_pipe,jpeg_pipe,webp_pipe,gif';

/** Low-priority worker supplies only resolved local source paths and private text PNGs. */
export function exportTimelineArguments(timeline: ClipTimeline, format: ClipFormat, sources: ReadonlyMap<string, ResolvedTimelineSource>, output: string, textPaths: ReadonlyMap<string, string> = new Map(), options?: ClipExportOptions): string[] {
  validateTimelineSources(timeline, sources);
  if (!path.isAbsolute(output)) throw new TimelineError('An absolute export destination is required.');
  const [width, height] = clipExportDimensions(format, options), profile = clipExportProfile(options), durationMs = timelineDuration(timeline), duration = secs(durationMs);
  const args = ['-hide_banner', '-nostdin', '-y', '-threads', '1'];
  const filters = [
    ...(profile.video ? [`color=c=${ffColor(timeline.background)}:s=${width}x${height}:r=30:d=${duration},format=rgba[base0]`] : []),
    `anullsrc=r=48000:cl=stereo,atrim=duration=${duration}[silence]`,
  ];
  const audio = ['[silence]'];
  let inputIndex = 0, visualIndex = 0;
  for (const track of timeline.tracks) for (const item of track.items.map((value, index) => ({ value, index })).sort((a, b) => a.value.startMs - b.value.startMs || a.index - b.index).map(value => value.value)) {
    const visual = profile.video && visible(track, item), source = item.source && sources.get(timelineSourceKey(item.source));
    const sound = audible(track, item) && (item.kind === 'audio' || source?.hasAudio === true);
    if (!visual && !sound) continue;
    const sourcePath = item.kind === 'text' ? textPaths.get(item.id) : source?.path;
    if (!sourcePath || !path.isAbsolute(sourcePath)) throw new TimelineError(`The media for “${item.name}” has not been prepared.`);
    const still = item.kind === 'text' || item.kind === 'image';
    args.push('-protocol_whitelist', 'file,pipe', '-format_whitelist', TIMELINE_INPUT_FORMATS, '-threads', '1');
    if (still) args.push('-loop', '1', '-framerate', '30');
    else args.push('-ss', secs(item.inMs));
    args.push('-t', secs(item.durationMs), '-i', sourcePath);
    if (visual) {
      const itemWidth = even(width * item.width), itemHeight = even(height * item.height);
      const fitted = item.fit === 'contain'
        ? `scale=${itemWidth}:${itemHeight}:force_original_aspect_ratio=decrease:force_divisible_by=2,pad=${itemWidth}:${itemHeight}:(ow-iw)/2:(oh-ih)/2:color=0x00000000`
        : `scale=${itemWidth}:${itemHeight}:force_original_aspect_ratio=increase:force_divisible_by=2,crop=${itemWidth}:${itemHeight}:(iw-ow)*${item.positionX}:(ih-oh)*${item.positionY}`;
      const effect = item.transitionIn, progress = effect ? `min(1,max(0,(T-${secs(item.startMs)})/${secs(effect.durationMs)}))` : '1';
      const alpha = effect?.kind === 'dissolve' ? `alpha(X,Y)*(${progress})` : effect?.kind === 'wipe-left' ? `alpha(X,Y)*gte(X,W*(1-(${progress})))` : effect?.kind === 'wipe-right' ? `alpha(X,Y)*lt(X,W*(${progress}))` : null;
      const transition = alpha ? `,geq=r='r(X,Y)':g='g(X,Y)':b='b(X,Y)':a='${alpha}':enable='lt(t,${secs(item.startMs + effect!.durationMs)})'` : '';
      const move = effect && (effect.kind === 'slide-left' || effect.kind === 'slide-right') ? `${effect.kind === 'slide-left' ? '+' : '-'}${itemWidth}*max(0,1-(t-${secs(item.startMs)})/${secs(effect.durationMs)})` : '';
      filters.push(`[${inputIndex}:v:0]trim=duration=${secs(item.durationMs)},setpts=PTS-STARTPTS+${secs(item.startMs)}/TB,fps=30,format=rgba,${fitted},setsar=1,colorchannelmixer=aa=${item.opacity}${transition}[visual${visualIndex}]`);
      filters.push(`[base${visualIndex}][visual${visualIndex}]overlay=x='${Math.round(width * item.x)}${move}':y=${Math.round(height * item.y)}:eof_action=pass:repeatlast=0:enable='gte(t,${secs(item.startMs)})*lt(t,${secs(item.startMs + item.durationMs)})'[base${visualIndex + 1}]`);
      visualIndex++;
    }
    if (sound) {
      const label = `audio${inputIndex}`;
      const fades = `${item.audioFadeInMs ? `,afade=t=in:st=0:d=${secs(item.audioFadeInMs)}` : ''}${item.audioFadeOutMs ? `,afade=t=out:st=${secs(item.durationMs - item.audioFadeOutMs)}:d=${secs(item.audioFadeOutMs)}` : ''}`;
      filters.push(`[${inputIndex}:a:0]atrim=duration=${secs(item.durationMs)},asetpts=PTS-STARTPTS,aresample=48000,aformat=sample_fmts=fltp:channel_layouts=stereo,volume=${item.volume}${fades},adelay=${item.startMs}:all=1[${label}]`);
      audio.push(`[${label}]`);
    }
    inputIndex++;
  }
  if (profile.video) filters.push(`[base${visualIndex}]format=yuv420p[video]`);
  filters.push(`${audio.join('')}amix=inputs=${audio.length}:duration=longest:dropout_transition=0:normalize=0,atrim=duration=${duration},alimiter=level=false[audio]`);
  args.push('-filter_complex_threads', '1', '-filter_threads', '1', '-filter_complex', filters.join(';'),
    ...(profile.video ? ['-map', '[video]'] : []), '-map', '[audio]', '-t', duration, '-sn', '-dn', ...clipOutputArguments(output, options));
  return args;
}
