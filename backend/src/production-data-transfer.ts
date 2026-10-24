import { z } from 'zod';
import fs from 'node:fs/promises';
import syncFs from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { AnimationPresetSchema, SceneSchema, SourceSchema, ProductionSchema, animationPresetNameKey } from './production-schema.js';
import { ProductionStore, ProductionError } from './production-store.js';
import { RecordingStore, type SavedRecording } from './production-recordings.js';
import { atomicWriteJson } from './atomic.js';
import type { ProductionState } from '../../shared/production.js';
import type { ClipTimeline } from '../../shared/clips.js';
import { savedDraftSchema, savedExportSchema, clipDraftInputSchema, clipIndexSchema, type ClipTransferAccess, type ClipTransferSession } from './clips.js';
import { clipExportProfile } from './clip-media.js';
import { clipAssetSchema } from './clip-assets.js';
import type { TransferItem } from '../../shared/data-transfer.js';

export const PortableStudioSchema = z.object({
  scenes: z.array(SceneSchema).max(60), sources: z.array(SourceSchema).max(40),
  animationPresets: z.array(AnimationPresetSchema).max(100),
}).strict().superRefine((value, ctx) => {
  for (const group of [value.scenes, value.sources, value.animationPresets])
    if (new Set(group.map(item => item.id)).size !== group.length) ctx.addIssue({ code: 'custom', message: 'Duplicate Studio IDs.' });
  for (const scene of value.scenes) {
    if (new Set(scene.layers.map(layer => layer.id)).size !== scene.layers.length) ctx.addIssue({ code: 'custom', message: 'Duplicate layer IDs.' });
    for (const layer of scene.layers) if (layer.kind === 'source' && !value.sources.some(source => source.id === layer.sourceId))
      ctx.addIssue({ code: 'custom', message: 'Studio scene is missing a source.' });
  }
});
export const PortableScenesSchema = PortableStudioSchema;
export type PortableStudio = z.infer<typeof PortableStudioSchema>;
export const PortableRecordingSchema = z.object({
  id: z.string().regex(/^rec_[\w-]+$/).max(110), name: z.string().min(1).max(160),
  createdAt: z.string().datetime(), durationMs: z.number().finite().nonnegative(), bytes: z.number().int().positive().max(Number.MAX_SAFE_INTEGER),
}).strict();
export type PortableRecording = z.infer<typeof PortableRecordingSchema>;
export const PortableClipsSchema = z.object({
  drafts: z.array(savedDraftSchema).max(10000),
  exports: z.array(savedExportSchema.refine(job => job.status === 'complete' && !job.temporary && !job.expiredAt && !job.deliveredAt, 'Only permanent completed clip exports are portable.')).max(10000),
  assets: z.array(clipAssetSchema).max(2000),
}).strict().superRefine((value, ctx) => {
  for (const group of [value.drafts, value.exports, value.assets]) if (new Set(group.map(item => item.id)).size !== group.length)
    ctx.addIssue({ code: 'custom', message: 'Duplicate Clips IDs.' });
  for (const job of value.exports) if (!value.drafts.some(draft => draft.id === job.draftId)) ctx.addIssue({ code: 'custom', message: 'Clip export is missing its project.' });
  for (const draft of value.drafts) {
    const { name, inMs, outMs, format, fit, positionX, positionY, timeline } = draft;
    if (!clipDraftInputSchema.safeParse({ name, inMs, outMs, format, fit, positionX, positionY, ...(timeline ? { timeline } : {}) }).success)
      ctx.addIssue({ code: 'custom', message: 'Clip project has invalid trim settings.' });
  }
  for (const job of value.exports) if (!clipDraftInputSchema.safeParse({ name: job.name, ...job.settings }).success)
    ctx.addIssue({ code: 'custom', message: 'Clip export has invalid trim settings.' });
  const { assetIds } = portableClipsDependencies(value);
  if (assetIds.some(id => !value.assets.some(asset => asset.id === id))) ctx.addIssue({ code: 'custom', message: 'Clip project is missing a private media asset.' });
});
export type PortableClips = z.infer<typeof PortableClipsSchema>;
export type PortableFile = { id: string; path: string; bytes: number };
export function selectPortableStudio(bundle: PortableStudio, ids: string[]): PortableStudio {
  const scenes = bundle.scenes.filter(scene => ids.includes(scene.id));
  const required = new Set(scenes.flatMap(scene => scene.layers.flatMap(layer => layer.sourceId ? [layer.sourceId] : [])));
  return { scenes, sources: bundle.sources.filter(source => required.has(source.id)), animationPresets: scenes.length ? bundle.animationPresets : [] };
}
export function portableStudioDependencies(bundle: PortableStudio) {
  return {
    mediaIds: [...new Set(bundle.sources.flatMap(source => source.url ? [source.url.replace(/^\//, '')] : []))],
    channelIds: [...new Set(bundle.sources.flatMap(source => source.channelId ? [source.channelId] : []))],
    warnings: bundle.sources.some(source => ['camera', 'screen', 'microphone'].includes(source.kind)) ? ['Imported cameras, screens and microphones must be reconnected on this station.'] : [],
  };
}
export function portableClipsDependencies(bundle: PortableClips) {
  const recordingIds = new Set<string>(), assetIds = new Set<string>();
  for (const value of [...bundle.drafts, ...bundle.exports.map(job => ({ recordingId: job.recordingId, ...job.settings }))]) {
    recordingIds.add(value.recordingId);
    for (const item of value.timeline?.tracks.flatMap(track => track.items) ?? []) if ('source' in item && item.source) {
      (item.source.kind === 'recording' ? recordingIds : assetIds).add(item.source.id);
    }
  }
  return { recordingIds: [...recordingIds], assetIds: [...assetIds] };
}
export function selectPortableClips(bundle: PortableClips, ids: string[]): PortableClips {
  const selected = { drafts: bundle.drafts.filter(draft => ids.includes(draft.id)), exports: bundle.exports.filter(job => ids.includes(job.draftId)), assets: bundle.assets };
  const { assetIds } = portableClipsDependencies(selected);
  return { ...selected, assets: selected.assets.filter(asset => assetIds.includes(asset.id)) };
}
export function portableClipFiles(bundle: PortableClips): { id: string; bytes: number }[] {
  return [
    ...bundle.assets.map(asset => ({ id: `clips/assets/${asset.id}.${asset.extension}`, bytes: asset.bytes })),
    ...bundle.exports.map(job => ({ id: `clips/exports/${job.id}.${clipExportProfile(job.options).extension}`, bytes: job.bytes })),
  ];
}
export interface ProductionTransferTransaction {
  importScenes(bundle: PortableStudio, maps: { media: Record<string, string>; channels: Record<string, string> }): Promise<number>;
  importRecordings(items: { recording: PortableRecording; path: string }[]): Promise<Record<string, string>>;
  importClips(bundle: PortableClips, maps: { recordings: Record<string, string>; files: Record<string, string>; owner: { id: string; name: string } }): Promise<number>;
  clearScenes(ids: string[]): Promise<number>;
  clearRecordings(ids: string[]): Promise<number>;
  clearClips(ids: string[]): Promise<number>;
  removeChannels(ids: string[]): Promise<void>;
  removeMedia(ids: string[]): Promise<void>;
  prepare(): Promise<void>;
  commitSync(): void;
  rollbackSync(): void;
  publish(): void;
}
export interface ProductionTransferAdapter {
  catalog(): { scenes: TransferItem[]; recordings: TransferItem[]; clips: TransferItem[] };
  exportScenes(ids: string[]): Promise<PortableStudio>;
  exportRecordings(ids: string[]): Promise<(PortableRecording & { path: string })[]>;
  exportClips(ids: string[]): Promise<{ bundle: PortableClips; files: PortableFile[]; recordingIds: string[] }>;
  transaction<T>(backupPath: string, operation: (tx: ProductionTransferTransaction) => Promise<T>): Promise<T>;
  clearPlan(selection: ProductionClearSelection): Promise<{ blockers: string[]; warnings: string[] }>;
  isLive(): boolean;
  revisionKey(): string;
}
export interface ProductionClearSelection { scenes: string[]; recordings: string[]; clips: string[]; channels?: string[]; media?: string[] }

function fail(message: string): never { throw new ProductionError(409, message); }
function selected<T extends { id: string }>(items: T[], ids: string[], label: string): T[] {
  if (new Set(ids).size !== ids.length || ids.some(id => !items.some(item => item.id === id))) fail(`${label} selection changed. Refresh and select again.`);
  return items.filter(item => ids.includes(item.id));
}
function references(value: { recordingId: string; timeline?: ClipTimeline }) {
  return [value.recordingId, ...(value.timeline?.tracks.flatMap(track => track.items.flatMap(item => item.source?.kind === 'recording' ? [item.source.id] : [])) ?? [])];
}
function assetReferences(value: { timeline?: ClipTimeline }) {
  return value.timeline?.tracks.flatMap(track => track.items.flatMap(item => item.source?.kind === 'asset' ? [item.source.id] : [])) ?? [];
}
function retainedSourceIds(state: ProductionState): Set<string> {
  return new Set([...state.scenes, state.program, ...state.outputs.map(output => output.scene)].flatMap(scene => scene?.layers.flatMap(layer => layer.sourceId ? [layer.sourceId] : []) ?? [])
    .concat(state.channelInsert ? [state.channelInsert.sourceId] : [], state.mainAudioSourceId ? [state.mainAudioSourceId] : []));
}
function clearSceneDraft(state: ProductionState, ids: string[], live: boolean) {
  const scenes = selected(state.scenes, ids, 'Scene');
  if (live && (state.program && ids.includes(state.program.id) || state.outputs.some(output => output.scene && ids.includes(output.scene.id)))) fail('Stop Studio before clearing scenes used by Program or a pinned output.');
  const candidates = new Set(scenes.flatMap(scene => scene.layers.flatMap(layer => layer.sourceId ? [layer.sourceId] : [])));
  state.scenes = state.scenes.filter(scene => !ids.includes(scene.id));
  if (state.previewSceneId && ids.includes(state.previewSceneId)) state.previewSceneId = state.scenes[0]?.id ?? null;
  if (state.program && ids.includes(state.program.id)) {
    state.program = null; delete state.programTransition; delete state.programCueGate; delete state.programCueGates; delete state.channelInsert;
  }
  for (const output of state.outputs) if (output.scene && ids.includes(output.scene.id)) { output.scene = null; output.mode = 'program'; delete output.sceneRunId; }
  if (!live && state.mainAudioSourceId && candidates.has(state.mainAudioSourceId)
    && !retainedSourceIds({ ...state, mainAudioSourceId: null }).has(state.mainAudioSourceId)) state.mainAudioSourceId = null;
  // Shared inputs and the current audio mix remain available even when their
  // last draft is removed. Only unused visual sources are reclaimed here.
  const retained = retainedSourceIds(state);
  state.sources = state.sources.filter(source => !candidates.has(source.id) || retained.has(source.id) || live && !source.audio.muted && source.audio.mode === 'always');
  return scenes.length;
}
function removeSourceDependencies(state: ProductionState, ids: string[], kind: 'channel' | 'media', live: boolean) {
  const candidates = state.sources.filter(source => kind === 'channel' ? !!source.channelId && ids.includes(source.channelId) : !!source.url && ids.includes(source.url.replace(/^\//, '')));
  if (!live && state.mainAudioSourceId && candidates.some(source => source.id === state.mainAudioSourceId)
    && !retainedSourceIds({ ...state, mainAudioSourceId: null }).has(state.mainAudioSourceId)) state.mainAudioSourceId = null;
  const retained = retainedSourceIds(state);
  if (candidates.some(source => retained.has(source.id) || live && !source.audio.muted && source.audio.mode === 'always')) fail(`Selected ${kind === 'channel' ? 'presentation channels' : 'media'} are still used by Studio. Clear their scenes or remove their sources first.`);
  const removing = new Set(candidates.map(source => source.id));
  state.sources = state.sources.filter(source => !removing.has(source.id));
}
async function regularFile(filename: string, expectedBytes?: number) {
  if ((await fs.lstat(path.dirname(filename))).isSymbolicLink()) fail('Data transfer cannot follow symbolic links.');
  const stat = await fs.lstat(filename);
  if (!stat.isFile() || stat.isSymbolicLink() || expectedBytes !== undefined && stat.size !== expectedBytes) fail('A selected media file changed or is unavailable. Refresh and retry.');
  return stat;
}
function stationPathParts(root: string, filename: string) {
  const relative = path.relative(path.resolve(root), path.resolve(filename));
  if (relative.startsWith(`..${path.sep}`) || relative === '..' || path.isAbsolute(relative)) fail('Data transfer path is outside the station directory.');
  let current = path.resolve(root);
  return [current, ...relative.split(path.sep).filter(Boolean).map(part => current = path.join(current, part))];
}
async function safeStationPath(root: string, filename: string) {
  for (const part of stationPathParts(root, filename)) {
    try { if ((await fs.lstat(part)).isSymbolicLink()) fail('Data transfer cannot follow symbolic links.'); }
    catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
  }
}
function safeStationPathSync(root: string, filename: string) {
  for (const part of stationPathParts(root, filename)) {
    try { if (syncFs.lstatSync(part).isSymbolicLink()) fail('Data transfer cannot follow symbolic links.'); }
    catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
  }
}

/** Coordinates the live stores; no caller may replace their files behind them. */
export class ProductionDataTransfer implements ProductionTransferAdapter {
  constructor(private store: ProductionStore, private recordings: RecordingStore, private clips: ClipTransferAccess | undefined,
    private live: () => boolean = () => false) {}
  isLive() { return this.live(); }
  revisionKey() { return JSON.stringify({ revision: this.store.get().revision, recordings: this.recordings.list(), clips: this.clips?.snapshot() }); }
  catalog() {
    const snapshot = this.clips?.snapshot();
    return {
      scenes: this.store.get().scenes.map(scene => ({ id: scene.id, name: scene.name, detail: `${scene.layers.length} layers` })),
      recordings: this.recordings.list().map(recording => ({ id: recording.id, name: recording.name, bytes: recording.bytes,
        detail: recording.status, ...(recording.status !== 'complete' ? { blockedReason: 'Only finalized recordings can be exported.' } : {}) })),
      clips: snapshot?.data.drafts.map(draft => ({ id: draft.id, name: draft.name, detail: `${snapshot.data.exports.filter(job => job.draftId === draft.id && job.status === 'complete' && !job.temporary).length} saved exports` })) ?? [],
    };
  }
  async exportScenes(ids: string[]) {
    const state = this.store.get(); selected(state.scenes, ids, 'Scene');
    return PortableStudioSchema.parse(selectPortableStudio({ ...state, animationPresets: state.animationPresets ?? [] }, ids));
  }
  async exportRecordings(ids: string[]) {
    return Promise.all(selected(this.recordings.list(), ids, 'Recording').map(async recording => {
      const { path: filename } = this.recordings.download(recording.id);
      const stat = await regularFile(filename, recording.bytes);
      return { ...PortableRecordingSchema.parse({ id: recording.id, name: recording.name, createdAt: recording.createdAt, durationMs: recording.durationMs, bytes: stat.size }), path: filename };
    }));
  }
  async exportClips(ids: string[]) {
    if (!this.clips) { if (ids.length) fail('The Clips workspace is unavailable.'); return { bundle: { drafts: [], exports: [], assets: [] }, files: [], recordingIds: [] }; }
    const snapshot = this.clips.snapshot(); selected(snapshot.data.drafts, ids, 'Clip project');
    const bundle = PortableClipsSchema.parse(selectPortableClips({ drafts: snapshot.data.drafts,
      exports: snapshot.data.exports.filter(job => job.status === 'complete' && !job.temporary && !job.deliveredAt && !job.expiredAt), assets: snapshot.assets }, ids));
    const files = await Promise.all(portableClipFiles(bundle).map(async descriptor => {
      const asset = bundle.assets.find(value => descriptor.id === `clips/assets/${value.id}.${value.extension}`);
      const filename = asset ? this.clips!.resolveAsset(asset.id) : this.clips!.resolveExport(bundle.exports.find(job => descriptor.id.startsWith(`clips/exports/${job.id}.`))!.id);
      await regularFile(filename, descriptor.bytes); return { ...descriptor, path: filename };
    }));
    return { bundle, files, recordingIds: portableClipsDependencies(bundle).recordingIds };
  }
  async clearPlan(selection: ProductionClearSelection) {
    const blockers: string[] = [];
    const state = this.store.get(), clipState = this.clips?.snapshot().data;
    const attempt = (operation: () => void) => { try { operation(); } catch (error) { blockers.push((error as Error).message); } };
    attempt(() => { this.checkClipClear(clipState, selection.clips); });
    if (clipState) { clipState.drafts = clipState.drafts.filter(draft => !selection.clips.includes(draft.id)); clipState.exports = clipState.exports.filter(job => !selection.clips.includes(job.draftId)); }
    attempt(() => this.checkRecordingClear(this.recordings.list(), clipState, selection.recordings));
    attempt(() => { clearSceneDraft(state, selection.scenes, this.live()); });
    attempt(() => removeSourceDependencies(state, selection.channels ?? [], 'channel', this.live()));
    attempt(() => removeSourceDependencies(state, selection.media ?? [], 'media', this.live()));
    return { blockers: [...new Set(blockers)], warnings: selection.scenes.length ? ['Cleared scenes are removed from Preview. When Studio is stopped, their saved Program and pinned snapshots are also cleared.'] : [] };
  }
  private checkClipClear(data: ClipTransferSession['data'] | undefined, ids: string[], downloads = new Set<string>()) {
    if (!data) { if (ids.length) fail('The Clips workspace is unavailable.'); return; }
    selected(data.drafts, ids, 'Clip project');
    if (data.exports.some(job => ids.includes(job.draftId) && (['queued', 'waiting-live', 'exporting'].includes(job.status) || downloads.has(job.id)))) fail('Cancel pending clip exports and wait for downloads to finish before clearing their projects.');
  }
  private checkRecordingClear(records: { id: string; status: string }[], data: ClipTransferSession['data'] | undefined, ids: string[]) {
    if (ids.length && !this.clips) fail('The Clips workspace must be available to check recording dependencies before clearing.');
    if (selected(records, ids, 'Recording').some(recording => this.recordings.busy(recording.id) || ['starting', 'recording', 'stopping', 'finalizing'].includes(recording.status))) fail('Stop and finish active recordings before clearing them.');
    const values = [...data?.drafts ?? [], ...data?.exports.map(job => ({ recordingId: job.recordingId, ...job.settings })) ?? []];
    if (values.some(value => references(value).some(id => ids.includes(id)))) fail('A selected recording is used by a retained clip project or export. Clear those projects first.');
  }
  transaction<T>(backupPath: string, operation: (tx: ProductionTransferTransaction) => Promise<T>): Promise<T> {
    return this.store.withTransferLock(production => this.recordings.withTransferLock(recordings => {
      const run = (clips?: ClipTransferSession) => this.runTransaction(backupPath, production, recordings, clips, operation);
      return this.clips ? this.clips.withLock(run) : run();
    }));
  }
  private async runTransaction<T>(backupPath: string,
    production: Parameters<Parameters<ProductionStore['withTransferLock']>[0]>[0],
    recordingStore: Parameters<Parameters<RecordingStore['withTransferLock']>[0]>[0],
    clips: ClipTransferSession | undefined, operation: (tx: ProductionTransferTransaction) => Promise<T>): Promise<T> {
    const originalProduction = structuredClone(production.state), originalRecords = structuredClone(recordingStore.records);
    const originalClips = clips ? structuredClone(clips.data) : undefined, originalAssets = clips ? structuredClone(clips.assets) : undefined;
    const stationRoot = path.dirname(production.file);
    let state = structuredClone(originalProduction), records = structuredClone(originalRecords), clipData = clips ? structuredClone(clips.data) : undefined, assets = clips ? structuredClone(clips.assets) : [];
    let productionChanged = false, recordingsChanged = false, clipsChanged = false, prepared = false, committed = false, published = false;
    const stage = path.join(backupPath, `.production-stage-${randomUUID()}`);
    const moves: { from: string; to: string }[] = [], applied: { from: string; to: string }[] = [];
    const newRecordingDirs: { recording: SavedRecording; source: string }[] = [];
    const newFiles: { source: string; target: string; bytes: number }[] = [];
    const deletedPaths: string[] = [];
    const clearedScenes: string[] = [];
    const assertMutable = () => { if (prepared || committed) throw new Error('Transfer was already prepared.'); };
    const rollbackSync = () => {
      for (const move of applied.splice(0).reverse()) syncFs.renameSync(move.to, move.from);
      production.replaceSync(originalProduction); recordingStore.replaceSync(originalRecords);
      if (clips && originalClips && originalAssets) clips.replaceSync(originalClips, originalAssets);
      committed = false;
    };
    const tx: ProductionTransferTransaction = {
      importScenes: async (input, maps) => {
        assertMutable(); const bundle = PortableStudioSchema.parse(input);
        const sourceIds = new Map(bundle.sources.map(source => [source.id, randomUUID()]));
        for (const source of bundle.sources) {
          const copy = structuredClone(source); copy.id = sourceIds.get(source.id)!; copy.audio.muted = true; copy.playback = { paused: true, restart: 0 };
          if (copy.url) { const key = copy.url.replace(/^\//, ''); if (!maps.media[key]) fail('A Studio source is missing its media dependency.'); copy.url = maps.media[key]; }
          if (copy.channelId) { if (!maps.channels[copy.channelId]) fail('A Studio source is missing its channel dependency.'); copy.channelId = maps.channels[copy.channelId]; }
          state.sources.push(copy);
        }
        for (const scene of bundle.scenes) state.scenes.push({ ...structuredClone(scene), id: randomUUID(), layers: scene.layers.map(layer => ({ ...structuredClone(layer), id: randomUUID(), ...(layer.sourceId ? { sourceId: sourceIds.get(layer.sourceId)! } : {}) })) });
        const existingNames = new Set((state.animationPresets ?? []).map(preset => animationPresetNameKey(preset.name)));
        for (const preset of bundle.animationPresets) {
          const sameName = state.animationPresets?.find(existing => animationPresetNameKey(existing.name) === animationPresetNameKey(preset.name));
          if (sameName && JSON.stringify(sameName.animation) === JSON.stringify(preset.animation)) continue;
          let name = preset.name, suffix = 1;
          while (existingNames.has(animationPresetNameKey(name))) name = `${preset.name.slice(0, 80)} (imported ${suffix++})`;
          (state.animationPresets ??= []).push({ ...structuredClone(preset), id: randomUUID(), name }); existingNames.add(animationPresetNameKey(name));
        }
        productionChanged ||= bundle.scenes.length > 0; return bundle.scenes.length;
      },
      importRecordings: async items => {
        assertMutable(); const mapping: Record<string, string> = {};
        for (const item of items) {
          const recording = PortableRecordingSchema.parse(item.recording);
          if (mapping[recording.id]) fail('Duplicate recording IDs.');
          const id = `rec_${randomUUID()}`;
          const saved: SavedRecording = { ...recording, id, status: 'complete', nextChunk: 0 };
          records.push(saved); mapping[recording.id] = id; newRecordingDirs.push({ recording: saved, source: item.path });
        }
        recordingsChanged ||= items.length > 0; return mapping;
      },
      importClips: async (input, maps) => {
        assertMutable(); if (!clips || !clipData) fail('The Clips workspace is unavailable.');
        const bundle = PortableClipsSchema.parse(input), assetMap = new Map<string, string>(), draftMap = new Map<string, string>();
        const ownerId = z.string().min(1).max(150).parse(maps.owner.id), ownerName = z.string().min(1).max(150).parse(maps.owner.name);
        for (const asset of bundle.assets) {
          const id = `asset_${randomUUID()}`, fileId = `clips/assets/${asset.id}.${asset.extension}`;
          if (!maps.files[fileId]) fail('A Clips media dependency is missing.');
          assetMap.set(asset.id, id); assets.push({ ...structuredClone(asset), id, ownerId, ownerName });
          newFiles.push({ source: maps.files[fileId], target: path.join(clips.assetDir, `${id}.${asset.extension}`), bytes: asset.bytes });
        }
        const remapRecording = (id: string) => maps.recordings[id] ?? fail('A Clips recording dependency is missing.');
        const remapTimeline = (timeline?: ClipTimeline) => timeline ? { ...structuredClone(timeline), tracks: timeline.tracks.map(track => ({ ...structuredClone(track), id: `track_${randomUUID()}`, items: track.items.map(item => ({ ...structuredClone(item), id: `item_${randomUUID()}`, ...(item.source ? { source: { ...item.source, id: item.source.kind === 'recording' ? remapRecording(item.source.id) : assetMap.get(item.source.id) ?? fail('A Clips media dependency is missing.') } } : {}) })) })) } : undefined;
        for (const draft of bundle.drafts) {
          const id = `draft_${randomUUID()}`; draftMap.set(draft.id, id);
          clipData.drafts.push({ ...structuredClone(draft), id, recordingId: remapRecording(draft.recordingId), ownerId, ownerName, revision: 0, ...(draft.timeline ? { timeline: remapTimeline(draft.timeline) } : {}) });
        }
        for (const job of bundle.exports) {
          const id = `export_${randomUUID()}`, extension = clipExportProfile(job.options).extension, fileId = `clips/exports/${job.id}.${extension}`;
          if (!maps.files[fileId]) fail('A saved clip export is missing.');
          clipData.exports.push({ ...structuredClone(job), id, draftId: draftMap.get(job.draftId)!, draftRevision: 0, recordingId: remapRecording(job.recordingId), ownerId,
            settings: { ...structuredClone(job.settings), ...(job.settings.timeline ? { timeline: remapTimeline(job.settings.timeline) } : {}) } });
          newFiles.push({ source: maps.files[fileId], target: path.join(clips.exportsDir, `${id}.${extension}`), bytes: job.bytes });
        }
        clipsChanged ||= bundle.drafts.length > 0; return bundle.drafts.length;
      },
      clearScenes: async ids => { assertMutable(); const count = clearSceneDraft(state, ids, this.live()); clearedScenes.push(...ids); productionChanged ||= count > 0; return count; },
      clearRecordings: async ids => {
        assertMutable(); this.checkRecordingClear(records, clipData, ids);
        deletedPaths.push(...selected(records, ids, 'Recording').map(recording => path.join(recordingStore.dir, recording.id)));
        records = records.filter(recording => !ids.includes(recording.id)); recordingsChanged ||= ids.length > 0; return ids.length;
      },
      clearClips: async ids => {
        assertMutable(); this.checkClipClear(clipData, ids, clips?.downloads);
        if (!clips || !clipData) return 0;
        const removedAssets = new Set([
          ...clipData.drafts.filter(draft => ids.includes(draft.id)).flatMap(assetReferences),
          ...clipData.exports.filter(job => ids.includes(job.draftId)).flatMap(job => assetReferences(job.settings)),
        ]);
        for (const job of clipData.exports.filter(job => ids.includes(job.draftId))) {
          const dir = job.temporary ? path.join(path.dirname(clips.exportsDir), 'scratch') : clips.exportsDir;
          deletedPaths.push(path.join(dir, `${job.id}.${clipExportProfile(job.options).extension}`), path.join(dir, `${job.id}.thumbnail.jpg`));
        }
        clipData.drafts = clipData.drafts.filter(draft => !ids.includes(draft.id)); clipData.exports = clipData.exports.filter(job => !ids.includes(job.draftId));
        const retainedAssets = new Set([...clipData.drafts.flatMap(assetReferences), ...clipData.exports.flatMap(job => assetReferences(job.settings))]);
        const removingAssets = assets.filter(asset => removedAssets.has(asset.id) && !retainedAssets.has(asset.id));
        deletedPaths.push(...removingAssets.map(asset => path.join(clips.assetDir, `${asset.id}.${asset.extension}`)));
        const removedAssetIds = new Set(removingAssets.map(asset => asset.id));
        assets = assets.filter(asset => !removedAssetIds.has(asset.id));
        clipsChanged ||= ids.length > 0; return ids.length;
      },
      removeChannels: async ids => { assertMutable(); const before = state.sources.length; removeSourceDependencies(state, ids, 'channel', this.live()); productionChanged ||= before !== state.sources.length; },
      removeMedia: async ids => { assertMutable(); const before = state.sources.length; removeSourceDependencies(state, ids, 'media', this.live()); productionChanged ||= before !== state.sources.length; },
      prepare: async () => {
        assertMutable();
        if (productionChanged) { state.revision++; state.updatedAt = new Date().toISOString(); state = ProductionSchema.parse(state); }
        if (clipsChanged && clipData) { clipData = clipIndexSchema.parse(clipData); assets = z.array(clipAssetSchema).max(2000).parse(assets); }
        for (const filename of [production.file, recordingStore.dir, backupPath, ...newFiles.map(file => file.target), ...deletedPaths,
          ...(clips ? [clips.file, clips.assetFile, clips.assetDir, clips.exportsDir] : [])]) await safeStationPath(stationRoot, filename);
        await fs.mkdir(stage, { recursive: true });
        const stageJson = async (target: string, value: unknown, label: string) => {
          const temp = path.join(stage, label); await atomicWriteJson(temp, value);
          const backup = path.join(backupPath, label); await fs.mkdir(path.dirname(backup), { recursive: true });
          try { await fs.lstat(target); moves.push({ from: target, to: backup }); } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
          moves.push({ from: temp, to: target });
        };
        if (productionChanged) await stageJson(production.file, state, 'production.json');
        if (clipsChanged && clips) { await stageJson(clips.file, clipData, 'clips.json'); await stageJson(clips.assetFile, assets, 'clip-assets.json'); }
        for (const item of newRecordingDirs) {
          if (!path.relative(stationRoot, item.source).startsWith('..')) await safeStationPath(stationRoot, item.source);
          await regularFile(item.source, item.recording.bytes);
          const dir = path.join(stage, item.recording.id); await fs.mkdir(dir);
          await fs.copyFile(item.source, path.join(dir, 'recording.webm'), syncFs.constants.COPYFILE_FICLONE);
          const handle = await fs.open(path.join(dir, 'recording.webm'), 'r'); try { await handle.sync(); } finally { await handle.close(); }
          await atomicWriteJson(path.join(dir, 'recording.json'), item.recording);
          moves.push({ from: dir, to: path.join(recordingStore.dir, item.recording.id) });
        }
        for (const file of newFiles) {
          if (!path.relative(stationRoot, file.source).startsWith('..')) await safeStationPath(stationRoot, file.source);
          await regularFile(file.source, file.bytes); const temp = path.join(stage, randomUUID());
          await fs.copyFile(file.source, temp, syncFs.constants.COPYFILE_FICLONE);
          const handle = await fs.open(temp, 'r'); try { await handle.sync(); } finally { await handle.close(); }
          moves.push({ from: temp, to: file.target });
        }
        for (const filename of deletedPaths) {
          try { await fs.lstat(filename); } catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') continue; throw error; }
          const target = path.join(backupPath, 'removed', `${randomUUID()}-${path.basename(filename)}`); await fs.mkdir(path.dirname(target), { recursive: true });
          moves.push({ from: filename, to: target });
        }
        await atomicWriteJson(path.join(backupPath, 'production-transfer.json'), { version: 1, moves: moves.filter(move => !move.from.startsWith(stage)), createdAt: new Date().toISOString() });
        prepared = true;
      },
      commitSync: () => {
        if (!prepared || committed) throw new Error('Transfer must be prepared exactly once before commit.');
        // Engine startup does not edit the revisioned document, so check its
        // live latch again after async file staging and before removing scenes.
        if (this.live()) {
          clearSceneDraft(structuredClone(originalProduction), clearedScenes, true);
          if (originalProduction.sources.some(source => !state.sources.some(next => next.id === source.id) && !source.audio.muted && source.audio.mode === 'always')) fail('Studio started during this clear operation. Stop Studio and retry.');
        }
        try {
          for (const move of moves) { safeStationPathSync(stationRoot, move.from); safeStationPathSync(stationRoot, move.to); }
          for (const move of moves) { syncFs.renameSync(move.from, move.to); applied.push(move); }
          if (productionChanged) production.replaceSync(state); if (recordingsChanged) recordingStore.replaceSync(records);
          if (clipsChanged && clips && clipData) clips.replaceSync(clipData, assets);
          committed = true;
        } catch (error) { rollbackSync(); throw error; }
      },
      rollbackSync,
      publish: () => {
        if (!committed) throw new Error('Transfer must commit before publishing.');
        published = true;
        try { if (productionChanged) production.publish(); if (recordingsChanged) recordingStore.publish(); }
        catch (error) { console.warn('[transfer] Saved data committed; clients will refresh on reconnect:', (error as Error).message); }
      },
    };
    try { const result = await operation(tx); if (committed && !published) throw new Error('Transfer committed without publishing.'); return result; }
    catch (error) { if (!published && (committed || applied.length)) rollbackSync(); throw error; }
    finally { await fs.rm(stage, { recursive: true, force: true }).catch(error => console.warn('[transfer] Temporary staging cleanup will need a retry:', (error as Error).message)); }
  }
}
