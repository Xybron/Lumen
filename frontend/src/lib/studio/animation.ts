import type { AnimationPose, LayerAnimation, ProductionState, StudioScene, StudioAnimationPreset } from '../../../../shared/production';

// Explicit plain-object copies also accept editor/Vue proxies. Applied motions
// never retain a mutable link to the library or another layer's keyframes.
export function cloneAnimation(animation: LayerAnimation): LayerAnimation {
  return {
    enabled: animation.enabled, preset: animation.preset,
    durationMs: animation.durationMs, delayMs: animation.delayMs, easing: animation.easing,
    keyframes: animation.keyframes.map(frame => ({ offset: frame.offset, x: frame.x, y: frame.y,
      scale: frame.scale, opacity: frame.opacity, rotation: frame.rotation })),
  };
}

export function animationFromPreset(preset: StudioAnimationPreset): LayerAnimation {
  return { ...cloneAnimation(preset.animation), enabled: true, preset: 'custom' };
}

export const ANIMATION_PRESETS: { value: LayerAnimation['preset']; label: string }[] = [
  { value: 'fade', label: 'Fade in' },
  { value: 'slide-up', label: 'Slide up' },
  { value: 'slide-down', label: 'Slide down' },
  { value: 'slide-left', label: 'Slide left' },
  { value: 'slide-right', label: 'Slide right' },
  { value: 'scale', label: 'Scale in' },
  { value: 'custom', label: 'Custom' },
];

const identity = (): AnimationPose => ({ x: 0, y: 0, scale: 1, opacity: 1, rotation: 0 });

export function createAnimation(preset: LayerAnimation['preset']): LayerAnimation {
  const from = { ...identity(), opacity: 0 };
  if (preset === 'slide-up') from.y = 64;
  else if (preset === 'slide-down') from.y = -64;
  else if (preset === 'slide-left') from.x = 96;
  else if (preset === 'slide-right') from.x = -96;
  else if (preset === 'scale') from.scale = .85;
  return {
    enabled: true, preset, durationMs: 600, delayMs: 0, easing: 'ease-out',
    keyframes: [{ offset: 0, ...from }, { offset: 1, ...identity() }],
  };
}

function ease(value: number, easing: LayerAnimation['easing']) {
  if (easing === 'ease-in') return value * value * value;
  if (easing === 'ease-out') return 1 - Math.pow(1 - value, 3);
  if (easing === 'ease-in-out') return value < .5 ? 4 * value * value * value : 1 - Math.pow(-2 * value + 2, 3) / 2;
  return value;
}

// A null clock is the deliberately static design pose. Both operator Preview
// and renderer startup use it, so loading a saved scene cannot replay a Take.
export function sampleAnimation(animation: LayerAnimation | undefined, elapsedMs: number | null): AnimationPose {
  if (!animation?.enabled || elapsedMs === null || !Number.isFinite(elapsedMs)) return identity();
  const { keyframes } = animation;
  if (keyframes.length < 2) return identity();
  const progress = Math.min(1, Math.max(0, (elapsedMs - animation.delayMs) / Math.max(1, animation.durationMs)));
  let index = 1;
  while (index < keyframes.length - 1 && keyframes[index].offset < progress) index++;
  const from = keyframes[index - 1], to = keyframes[index];
  // Ease each segment, not the global playhead: an intermediate keyframe must
  // appear at its actual timeline time in the editor and the live compositor.
  const blend = ease(Math.min(1, Math.max(0, (progress - from.offset) / Math.max(Number.EPSILON, to.offset - from.offset))), animation.easing);
  const lerp = (a: number, b: number) => a + (b - a) * blend;
  return {
    x: lerp(from.x, to.x), y: lerp(from.y, to.y), scale: lerp(from.scale, to.scale),
    opacity: lerp(from.opacity, to.opacity), rotation: lerp(from.rotation, to.rotation),
  };
}

export function animationTotalMs(scene: StudioScene | null) {
  return Math.max(0, ...scene?.layers.filter(layer => layer.visible && layer.animation?.enabled)
    .map(layer => layer.animation!.delayMs + layer.animation!.durationMs) ?? []);
}

export interface AnimationRun { id: string; startedAt: number }

// Track deliberate commits, not scene IDs or revisions: re-taking the same
// scene replays its entrance, while draft edits, blanking and reconnects do not.
export class AnimationRunTracker {
  private programToken: string | undefined;
  private outputTokens: Map<string, string | undefined>;
  private programRun: AnimationRun | null = null;
  private outputRuns = new Map<string, AnimationRun>();
  constructor(state: ProductionState) {
    this.programToken = state.programTransition?.id;
    this.outputTokens = new Map(state.outputs.map(output => [output.id, output.sceneRunId]));
  }
  get program() { return this.programRun; }
  output(id: string) { return this.outputRuns.get(id) ?? null; }
  update(state: ProductionState, now: number) {
    const token = state.programTransition?.id;
    const programChanged = !!token && token !== this.programToken;
    if (programChanged) this.programRun = { id: token, startedAt: now };
    this.programToken = token;
    const ids = new Set(state.outputs.map(output => output.id));
    for (const id of this.outputRuns.keys()) if (!ids.has(id)) this.outputRuns.delete(id);
    for (const output of state.outputs) {
      if (output.mode !== 'scene' || !output.sceneRunId) this.outputRuns.delete(output.id);
      else if (output.sceneRunId !== this.outputTokens.get(output.id)) {
        this.outputRuns.set(output.id, { id: output.sceneRunId, startedAt: now });
      }
    }
    this.outputTokens = new Map(state.outputs.map(output => [output.id, output.sceneRunId]));
    return programChanged;
  }
}
