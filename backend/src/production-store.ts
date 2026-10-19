import fs from 'node:fs/promises';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { atomicWriteJson } from './atomic.js';
import { animationPresetNameKey, initialProduction, ProductionSchema } from './production-schema.js';
import type { ProductionState, StudioCommand } from '../../shared/production.js';
import { programChannelVisible } from '../../shared/program-channel.js';

export class ProductionError extends Error {
  constructor(public status: number, message: string) { super(message); }
}

// A separate revisioned document: legacy whole-deck saves cannot overwrite a
// Studio edit. Every mutation is serialized and checked against its base revision.
export class ProductionStore {
  private state!: ProductionState;
  private chain: Promise<unknown> = Promise.resolve();
  constructor(private dir: string, private changed: (state: ProductionState) => void = () => {},
    private cueGates: (channelIds: string[]) => Promise<NonNullable<ProductionState['programCueGates']>> = async () => []) {}
  async init() {
    await fs.mkdir(this.dir, { recursive: true });
    try { this.state = ProductionSchema.parse(JSON.parse(await fs.readFile(path.join(this.dir, 'production.json'), 'utf8'))); }
    catch (e) {
      if ((e as NodeJS.ErrnoException).code !== 'ENOENT') throw e;
      this.state = initialProduction();
      await atomicWriteJson(path.join(this.dir, 'production.json'), this.state);
    }
  }
  get(): ProductionState { return structuredClone(this.state); }
  private mutate(revision: number, fn: (draft: ProductionState) => void | boolean | Promise<void | boolean>, commit?: () => void) {
    const run = this.chain.then(async () => {
      if (revision !== this.state.revision) throw new ProductionError(409, 'Studio changed on another device. Your view has been refreshed; please retry.');
      const next = this.get();
      // A channel already present in Program needs a content update only. Keep
      // the production revision and animation run IDs stable in that case.
      if (await fn(next) === false) { commit?.(); return this.get(); }
      next.revision++;
      next.updatedAt = new Date().toISOString();
      const parsed = ProductionSchema.safeParse(next);
      if (!parsed.success) throw new ProductionError(422, parsed.error.issues[0].message);
      await atomicWriteJson(path.join(this.dir, 'production.json'), parsed.data);
      try { commit?.(); }
      catch (error) {
        // The cue store is revisioned independently. If its final synchronous
        // check rejects, restore the unpublished production document as well.
        await atomicWriteJson(path.join(this.dir, 'production.json'), this.state);
        throw error;
      }
      this.state = parsed.data;
      this.changed(this.get());
      return this.get();
    });
    this.chain = run.catch(() => {});
    return run;
  }
  save(input: ProductionState) {
    return this.mutate(input.revision, draft => {
      // Committed program and pinned scene snapshots may only change via a
      // deliberate TAKE/route command, never through an inspector save.
      // The station animation library likewise changes only through its commands;
      // legacy clients or stale/forged whole-document saves cannot replace it.
      const previous = new Map(draft.outputs.map(o => [o.id, o]));
      draft.scenes = input.scenes;
      draft.sources = input.sources;
      draft.previewSceneId = input.previewSceneId;
      draft.masterVolume = input.masterVolume;
      draft.masterMuted = input.masterMuted;
      draft.outputs = input.outputs.map(o => {
        const committed = previous.get(o.id);
        const output = {
          ...o, mode: committed?.mode ?? 'program',
          scene: committed?.scene ?? null, blanked: committed?.blanked ?? false,
        };
        if (committed?.sceneRunId) output.sceneRunId = committed.sceneRunId;
        else delete output.sceneRunId;
        return output;
      });
    });
  }
  command(revision: number, command: StudioCommand) {
    return this.mutate(revision, async draft => {
      if (command.type === 'take') {
        const scene = draft.scenes.find(s => s.id === command.sceneId);
        if (!scene) throw new ProductionError(404, 'Scene not found.');
        const previousProgramId = draft.program?.id;
        const sourceIds = new Set(scene.layers.filter(layer => layer.kind === 'source' && layer.visible && layer.opacity > 0
          && layer.x < 100 && layer.y < 100 && layer.x + layer.width > 0 && layer.y + layer.height > 0).map(layer => layer.sourceId));
        const channels = [...new Set(draft.sources.filter(source => source.kind === 'channel' && sourceIds.has(source.id)).map(source => source.channelId!))];
        const gates = await this.cueGates(channels);
        draft.program = structuredClone(scene);
        delete draft.channelInsert;
        delete draft.programCueGate;
        if (gates.length) draft.programCueGates = gates;
        else delete draft.programCueGates;
        const kind = command.transition ?? 'cut';
        draft.programTransition = { id: randomUUID(), kind, durationMs: kind === 'fade' ? command.durationMs ?? 300 : 0 };
        if (command.swapPreview) {
          // One revision/broadcast exchanges both buses. Do not restore the
          // committed snapshot over its saved draft or resurrect a deleted
          // scene. First/same-scene Takes keep the incoming scene in Preview.
          draft.previewSceneId = previousProgramId && draft.scenes.some(s => s.id === previousProgramId)
            ? previousProgramId : scene.id;
        }
      } else if (command.type === 'set-main-audio') {
        const source = command.sourceId ? draft.sources.find(source => source.id === command.sourceId) : null;
        if (command.sourceId && !source) throw new ProductionError(404, 'Main audio source not found.');
        if (source?.kind === 'image') throw new ProductionError(422, 'An image cannot supply main audio.');
        const previous = draft.sources.find(source => source.id === draft.mainAudioSourceId);
        if (previous && previous.id !== source?.id) previous.audio.muted = true;
        if (source) source.audio.muted = false;
        draft.mainAudioSourceId = source?.id ?? null;
      } else if (command.type === 'route' || command.type === 'blank') {
        const output = draft.outputs.find(o => o.id === command.outputId);
        if (!output) throw new ProductionError(404, 'Output not found.');
        if (command.type === 'blank') output.blanked = command.blanked;
        else {
          const scene = command.sceneId ? draft.scenes.find(s => s.id === command.sceneId) : null;
          if (command.sceneId && !scene) throw new ProductionError(404, 'Scene not found.');
          output.mode = scene ? 'scene' : 'program';
          output.scene = scene ? structuredClone(scene) : null;
          if (scene) output.sceneRunId = randomUUID();
          else delete output.sceneRunId;
        }
      } else {
        const presets = draft.animationPresets ??= [];
        if (command.type === 'delete-animation-preset') {
          const index = presets.findIndex(preset => preset.id === command.presetId);
          if (index === -1) throw new ProductionError(404, 'Animation preset not found.');
          presets.splice(index, 1);
          return;
        }
        const name = command.name.trim();
        const preset = command.type === 'rename-animation-preset'
          ? presets.find(preset => preset.id === command.presetId) : undefined;
        if (command.type === 'rename-animation-preset' && !preset) throw new ProductionError(404, 'Animation preset not found.');
        if (presets.some(other => other.id !== preset?.id && animationPresetNameKey(other.name) === animationPresetNameKey(name))) {
          throw new ProductionError(409, 'An animation preset with this name already exists. Choose another name.');
        }
        const now = new Date().toISOString();
        if (preset) {
          preset.name = name;
          preset.updatedAt = now;
        } else if (command.type === 'save-animation-preset') {
          if (presets.length >= 100) throw new ProductionError(409, 'The animation library is full. Delete a preset before saving another.');
          presets.push({
            id: randomUUID(), name,
            animation: { ...structuredClone(command.animation), enabled: true, preset: 'custom' },
            createdAt: now, updatedAt: now,
          });
        }
      }
    });
  }

  /** @deprecated Internal legacy compatibility only; operator routes no longer expose channel takeovers. */
  channelProgram(revision: number, channel: { id: string; name: string }, mode: 'auto' | 'fullscreen', authorize: (routing: boolean) => void, commitCue?: () => void, expectedRevision?: number) {
    let routing = false;
    const channelName = channel.name.trim().slice(0,100) || 'Channel';
    return this.mutate(revision, draft => {
      if (!draft.program) throw new ProductionError(409, 'Take a Studio scene to Program before showing a channel.');
      const alreadyVisible = mode === 'auto' && programChannelVisible(draft, channel.id);
      const sameFullscreen = mode === 'fullscreen' && draft.channelInsert?.mode === 'fullscreen' && draft.channelInsert.channelId === channel.id;
      routing = !alreadyVisible && !sameFullscreen;
      authorize(routing);
      if (!routing) return false;
      if (expectedRevision !== undefined) draft.programCueGate = { channelId: channel.id, revision: expectedRevision };
      else delete draft.programCueGate;
      // A different fullscreen insert may be the only thing hiding an existing
      // live channel. Reveal that original layer instead of drawing a duplicate
      // over it (which would double translucent graphics and text).
      if (mode === 'auto' && draft.channelInsert && programChannelVisible({ ...draft, channelInsert: undefined }, channel.id)) {
        delete draft.channelInsert;
        return;
      }
      // Preserve the user's configured geometry if a hidden channel layer is
      // already part of the committed scene. Never edit that original layer.
      const matching = draft.program.layers.find(layer => layer.kind === 'source'
        && layer.x < 100 && layer.y < 100 && layer.x + layer.width > 0 && layer.y + layer.height > 0
        && draft.sources.some(source => source.id === layer.sourceId && source.kind === 'channel' && source.channelId === channel.id));
      let source = matching ? draft.sources.find(source => source.id === matching.sourceId) : draft.sources.find(source => source.kind === 'channel' && source.channelId === channel.id);
      const originalSource = source;
      // Channel video is decoded lazily when it is first painted. Reusing a
      // dormant, unmuted 'always' source for a visual insert could unexpectedly
      // start its soundtrack. Keep that source untouched and use a muted visual
      // copy instead. Follow sources remain silent unless the base already uses
      // them, so they are safe to reuse without changing the existing audio mix.
      if (source && !source.audio.muted && source.audio.mode === 'always') {
        source = draft.sources.find(candidate => candidate.kind === 'channel' && candidate.channelId === channel.id && candidate.audio.muted);
      }
      if (!source) {
        if (draft.sources.length >= 40) throw new ProductionError(409, 'The source library is full. Remove an unused source before showing this channel.');
        source = originalSource ? {
          ...structuredClone(originalSource), id: randomUUID(), name: `${channelName.slice(0,93)} visual`,
          audio: {...structuredClone(originalSource.audio), muted: true, mode: 'follow'},
        } : { id: randomUUID(), name: channelName, kind: 'channel', channelId: channel.id, loop: false, audio: { volume: 1, muted: true, mode: 'follow', delayMs: 0 } };
        draft.sources.push(source);
      }
      const fullscreen = mode === 'fullscreen';
      const layer = !fullscreen && matching ? { ...structuredClone(matching), id: randomUUID(), sourceId:source.id, visible: true, opacity: 1 } : {
        id: randomUUID(), name: channelName, kind: 'source' as const, sourceId: source.id,
        visible: true, locked: false, x: fullscreen ? 0 : 8, y: fullscreen ? 0 : 68,
        width: fullscreen ? 100 : 84, height: fullscreen ? 100 : 26,
        opacity: 1, fit: 'contain' as const, text: '', color: '#ffffff',
        background: fullscreen ? '#00000000' : '#11151be6', fontSize: 48,
        fontWeight: 500, align: fullscreen ? 'center' as const : 'left' as const,
        radius: fullscreen ? 0 : 16, channelStyle: fullscreen ? 'slide' as const : 'overlay' as const,
      };
      draft.channelInsert = { id: randomUUID(), channelId: channel.id, sourceId: source.id, mode: fullscreen ? 'fullscreen' : 'overlay', layer };
    }, () => { authorize(routing); commitCue?.(); });
  }

  returnToStudio(revision: number, insertId: string, authorize: () => void = () => {}) {
    return this.mutate(revision, draft => {
      authorize();
      if (!draft.channelInsert || draft.channelInsert.id !== insertId) throw new ProductionError(409, 'Program changed. Refresh before returning to Studio.');
      delete draft.channelInsert;
      delete draft.programCueGate;
    }, authorize);
  }
}
