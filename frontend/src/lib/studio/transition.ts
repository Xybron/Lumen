import type { StudioScene } from '../../../../shared/production';
import type { AnimationRun } from './animation';

export interface SceneWeight {
  scene: StudioScene | null;
  weight: number;
  animationStartedAt?: number;
  runId?: string;
}

export function weightedScene(scene: StudioScene | null, weight: number, run?: AnimationRun | null): SceneWeight {
  return run ? { scene, weight, animationStartedAt: run.startedAt, runId: run.id } : { scene, weight };
}

export function transitionProgress(startedAt: number, durationMs: number, now: number) {
  return Math.min(1, Math.max(0, (now - startedAt) / Math.max(1, durationMs)));
}

// Keeping the outgoing mix as scenes (rather than a still frame) lets cameras
// keep moving, including when another Fade interrupts the current transition.
export function blendScenes(from: SceneWeight[], to: StudioScene | null, progress: number, run?: AnimationRun | null): SceneWeight[] {
  const amount = Math.min(1, Math.max(0, progress));
  const mix = new Map<StudioScene | string | null, SceneWeight>();
  const add = (entry: SceneWeight, weight: number) => {
    const key = entry.runId ?? entry.scene, previous = mix.get(key);
    mix.set(key, { ...(previous ?? entry), weight: (previous?.weight ?? 0) + weight });
  };
  for (const entry of from) add(entry, entry.weight * (1 - amount));
  add(weightedScene(to, amount, run), amount);
  return [...mix.values()].filter(entry => entry.weight > 0);
}

export function sceneSourceWeights(mix: SceneWeight[]) {
  const weights = new Map<string, number>();
  for (const { scene, weight } of mix) {
    // A source used by several layers is still one audio route, not several.
    const ids = new Set(scene?.layers.filter(layer => layer.visible && layer.kind === 'source' && layer.sourceId).map(layer => layer.sourceId!) ?? []);
    for (const id of ids) weights.set(id, Math.min(1, (weights.get(id) ?? 0) + weight));
  }
  return weights;
}
