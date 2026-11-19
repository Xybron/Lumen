import type { Content } from './schema.js';
import type { ProductionState, StudioScene } from '../../shared/production.js';
import type { ClipIndex } from './clips.js';
import type { ClipTimeline } from '../../shared/clips.js';
import type { MediaUsage } from '../../shared/media-library.js';

/** Preserve literal legacy filenames as well as their URL-encoded spellings.
 * A filename may literally contain %20, # or ?. Ambiguous legacy references
 * conservatively protect both candidates instead of making either deletable.
 */
export function mediaReferences(value: string | undefined): string[] {
  if (!value) return [];
  const candidates = new Set<string>();
  const add = (candidate: string) => {
    const clean = candidate.replace(/^\/+/, '');
    if (clean.startsWith('media/')) candidates.add(clean);
    try { const decoded = decodeURIComponent(clean).replace(/^\/+/, ''); if (decoded.startsWith('media/')) candidates.add(decoded); } catch { /* Literal percent. */ }
  };
  add(value);
  try {
    const parsed = new URL(value, 'http://lumen.local/');
    // Matching a remote /media path conservatively is safe for old content
    // moved between station hostnames; external images are never catalogued.
    if (['http:', 'https:'].includes(parsed.protocol)) add(parsed.pathname);
  } catch { /* A raw legacy filename is still checked above. */ }
  return [...candidates];
}

const location = (pathname: string, query: Record<string, string>) => `${pathname}?${new URLSearchParams({ ...query, from: 'media' })}`;
export type MediaUsageIndex = Map<string, MediaUsage[]>;
export type MediaTransitionSnapshot = { program: StudioScene | null; channelInsert?: ProductionState['channelInsert']; sources: ProductionState['sources']; expiresAt: number; revision?: number };

/** One resolver powers the catalogue and the final, locked deletion check. */
export function resolveMediaUsage(content: Content, production: ProductionState, clips?: ClipIndex,
  transitions: MediaTransitionSnapshot[] = [], retainedExports = new Set<string>()): MediaUsageIndex {
  const result: MediaUsageIndex = new Map();
  const add = (keys: string[] | string | null | undefined, usage: MediaUsage) => {
    for (const key of Array.isArray(keys) ? keys : keys ? [keys] : []) {
      const values = result.get(key) ?? [];
      if (!values.some(value => value.id === usage.id)) values.push(usage);
      result.set(key, values);
    }
  };
  for (const playlist of content.playlists) {
    const channels = content.channels.filter(channel => channel.playlistId === playlist.id);
    for (const [index, item] of playlist.items.entries()) {
      const key = mediaReferences(item.background?.src);
      for (const channel of channels.length ? channels : [null]) {
        add(key, { id: `slide:${channel?.id ?? playlist.id}:${item.id}`, type: 'presentation',
          label: channel?.name ?? playlist.name, detail: `Slide ${index + 1}${item.title ? ` · ${item.title}` : ''} · ${item.type === 'image' ? 'Image' : item.type === 'video' ? 'Video' : 'Background'}`,
          href: location('/', { ...(channel ? { channel: channel.id } : { playlist: playlist.id }), slide: item.id }) });
      }
    }
  }
  for (const source of content.sources) if (source.kind === 'media' || source.kind === 'music') {
    add(mediaReferences(source.ref), { id: `routing:${source.id}`, type: 'routing', label: source.label || 'Media source',
      detail: 'Routing source', href: location('/switch', { source: source.id }) });
  }
  for (const [index, value] of [content.music.current, ...content.music.queue].entries()) {
    add(mediaReferences(value), { id: `music:${index}`, type: 'music', label: 'Music playback', detail: index ? `Queued track ${index}` : 'Current track', href: location('/', { music: value ?? '' }) });
  }
  for (const source of production.sources) {
    const scenes = production.scenes.filter(scene => scene.layers.some(layer => layer.sourceId === source.id));
    add(mediaReferences(source.url), { id: `source:${source.id}`, type: 'source', label: source.name,
      detail: scenes.length ? `Studio source · ${scenes.map(scene => scene.name).join(', ')}` : 'Saved Studio source',
      href: location('/studio', { source: source.id }) });
  }
  const scanScene = (scene: StudioScene, scope: string, sources: ProductionState['sources'], type: MediaUsage['type'], label: string, href: string, live = false) => {
    for (const layer of scene.layers) {
      add(mediaReferences(layer.mediaBackground?.url), { id: `${scope}:background:${layer.id}`, type,
        label, detail: `${layer.name} · ${live ? 'Output background' : 'Scene background'}`, href: live ? href : location('/studio', { scene: scene.id, layer: layer.id }), ...(live ? { live: true } : {}) });
      if (live && layer.sourceId) add(mediaReferences(sources.find(source => source.id === layer.sourceId)?.url), {
        id: `${scope}:source:${layer.id}`, type, label, detail: `${scene.name} · ${layer.name}`, href, live: true,
      });
    }
  };
  for (const scene of production.scenes) scanScene(scene, `scene:${scene.id}`, production.sources, 'background', scene.name, '');
  if (production.program) scanScene(production.program, 'program', production.sources, 'program', 'Program', location('/studio', { output: 'program' }), true);
  for (const output of production.outputs) if (output.scene) scanScene(output.scene, `output:${output.id}`, production.sources, 'output', output.name, location('/studio', { output: output.id }), true);
  if (production.channelInsert) add(mediaReferences(production.channelInsert.layer.mediaBackground?.url), {
    id: 'program:channel-insert', type: 'program', label: 'Program channel insert', detail: `${production.channelInsert.layer.name} · Background`, href: location('/studio', { output: 'program' }), live: true,
  });
  for (const [index, snapshot] of transitions.entries()) if (snapshot.expiresAt > Date.now()) {
    if (snapshot.program) scanScene(snapshot.program, `transition:${index}`, snapshot.sources, 'program', 'Program transition', location('/studio', { output: 'program' }), true);
    if (snapshot.channelInsert) add(mediaReferences(snapshot.channelInsert.layer.mediaBackground?.url), {
      id: `transition:${index}:channel-insert`, type: 'program', label: 'Program transition',
      detail: `${snapshot.channelInsert.layer.name} · Outgoing channel background`, href: location('/studio', { output: 'program' }), live: true,
    });
  }
  const scanTimeline = (timeline: ClipTimeline | undefined, scope: string, type: 'clip' | 'export', name: string, recordingId: string, draftId: string, exportId?: string) => {
    for (const track of timeline?.tracks ?? []) for (const item of track.items) if (item.source?.kind === 'asset') {
      add(`clip:${item.source.id}`, { id: `${scope}:${track.id}:${item.id}`, type, label: name,
        detail: `${type === 'export' ? 'Saved export' : 'Clip project'} · ${track.name} · ${item.name}`,
        href: exportId ? location('/recordings', { export: exportId }) : location(`/recordings/${encodeURIComponent(recordingId)}/editor`, { draft: draftId, item: item.id }) });
    }
  };
  for (const draft of clips?.drafts ?? []) scanTimeline(draft.timeline, `draft:${draft.id}`, 'clip', draft.name, draft.recordingId, draft.id);
  for (const job of clips?.exports ?? []) {
    // Delivered/expired scratch exports cannot be replayed or re-exported.
    if (!retainedExports.has(job.id) && job.temporary && (job.deliveredAt || job.expiredAt || ['cancelled', 'error', 'interrupted'].includes(job.status)
      || job.expiresAt && Date.parse(job.expiresAt) <= Date.now())) continue;
    scanTimeline(job.settings.timeline, `export:${job.id}`, 'export', job.name, job.recordingId, job.draftId, job.id);
  }
  return result;
}
