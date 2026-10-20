import type { ProductionState, StudioScene } from '../../../../shared/production';
import type { AnimationRun } from './animation';
import { weightedScene, type SceneWeight } from './transition';

export type ProgramChannelInsert = NonNullable<ProductionState['channelInsert']>;
export interface ProgramPicture extends SceneWeight { inserts: ProgramChannelInsert[] }

// Visual pictures are separate from scene audio weights. During a Studio Fade,
// an outgoing scripture insert is still on the picture, but its channel media
// must never replace or acquire the preacher's microphone route.
export function blendProgramPictures(from: ProgramPicture[], to: StudioScene | null, progress: number,
  run?: AnimationRun | null): ProgramPicture[] {
  const amount = Math.min(1, Math.max(0, progress));
  return [
    ...from.map(entry => ({ ...entry, weight: entry.weight * (1 - amount) })),
    { ...weightedScene(to, amount, run), inserts: [] },
  ].filter(entry => entry.weight > 0);
}

export function withProgramInsert(pictures: ProgramPicture[], insert: ProgramChannelInsert | undefined): ProgramPicture[] {
  if (!insert) return pictures;
  return pictures.map(entry => entry.inserts.some(existing => existing.id === insert.id)
    ? entry : { ...entry, inserts: [...entry.inserts, insert] });
}

export function programPictureSources(pictures: ProgramPicture[]): Set<string> {
  const sources = new Set<string>();
  for (const picture of pictures) {
    if (picture.weight <= 0) continue;
    for (const layer of picture.scene?.layers ?? []) if (layer.visible && layer.kind === 'source' && layer.sourceId) sources.add(layer.sourceId);
    for (const insert of picture.inserts) sources.add(insert.sourceId);
  }
  return sources;
}
