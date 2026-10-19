import { z } from 'zod';
import type { ProductionState, SceneLayer } from '../../shared/production.js';
import { PROGRAM_MONITOR_OUTPUT_ID } from '../../shared/program-monitor.js';

const id = z.string().regex(/^[a-zA-Z0-9_-]{1,80}$/);
const name = z.string().trim().min(1).max(100);
const color = z.string().regex(/^#[0-9a-fA-F]{6}([0-9a-fA-F]{2})?$/);
const unit = z.number().finite().min(0).max(1);
export const AnimationKeyframeSchema = z.object({
  offset: unit,
  x: z.number().finite().min(-3840).max(3840),
  y: z.number().finite().min(-2160).max(2160),
  scale: z.number().finite().min(.05).max(4),
  opacity: unit,
  rotation: z.number().finite().min(-360).max(360),
}).strict();
export const LayerAnimationSchema = z.object({
  enabled: z.boolean(),
  preset: z.enum(['fade', 'slide-up', 'slide-down', 'slide-left', 'slide-right', 'scale', 'custom']),
  durationMs: z.number().int().min(100).max(10000),
  delayMs: z.number().int().min(0).max(10000),
  easing: z.enum(['linear', 'ease-in', 'ease-out', 'ease-in-out']),
  keyframes: z.array(AnimationKeyframeSchema).min(2).max(12),
}).strict().superRefine((animation, ctx) => {
  const frames = animation.keyframes, first = frames[0], last = frames[frames.length - 1];
  if (first?.offset !== 0 || last?.offset !== 1) ctx.addIssue({ code: 'custom', message: 'Animation keyframes must start at 0 and finish at 1.' });
  if (frames.some((frame, i) => i > 0 && frame.offset <= frames[i - 1].offset)) ctx.addIssue({ code: 'custom', message: 'Animation keyframes must be in increasing time order.' });
  if (last && (last.x !== 0 || last.y !== 0 || last.scale !== 1 || last.opacity !== 1 || last.rotation !== 0)) {
    ctx.addIssue({ code: 'custom', message: 'An entrance animation must finish at the element’s saved design position.' });
  }
});
export const AnimationPresetSchema = z.object({
  id, name, animation: LayerAnimationSchema,
  createdAt: z.string().datetime(), updatedAt: z.string().datetime(),
}).strict();

export const animationPresetNameKey = (value: string) => value.normalize('NFKC').trim().toLowerCase();

export const LayerSchema = z.object({
  id, name, kind: z.enum(['source', 'text', 'shape']), sourceId: id.optional(),
  visible: z.boolean(), locked: z.boolean(),
  x: z.number().finite().min(-100).max(100), y: z.number().finite().min(-100).max(100),
  width: z.number().finite().min(1).max(200), height: z.number().finite().min(1).max(200),
  opacity: unit, fit: z.enum(['cover', 'contain']), text: z.string().max(8000),
  color, background: color, fontSize: z.number().finite().min(12).max(300),
  fontWeight: z.number().int().min(100).max(900), align: z.enum(['left', 'center', 'right']),
  radius: z.number().finite().min(0).max(200),
  channelStyle: z.enum(['slide', 'overlay']).optional(),
  animation: LayerAnimationSchema.optional(),
}).strict();
export const SceneSchema = z.object({ id, name, background: color, layers: z.array(LayerSchema).max(40) }).strict();
export const SourceSchema = z.object({
  id, name, kind: z.enum(['camera', 'screen', 'microphone', 'image', 'video', 'audio', 'channel']),
  // Only the station's uploaded files can enter the compositor. No remote URLs,
  // arbitrary file paths, data URLs or credentials in a saved scene.
  url: z.string().regex(/^\/?media\/(backgrounds|music)\/[\w.\-]+$/).optional(),
  channelId: id.optional(), loop: z.boolean(),
  playback: z.object({ paused: z.boolean(), restart: z.number().int().nonnegative() }).strict().optional(),
  audio: z.object({ volume: unit, muted: z.boolean(), mode: z.enum(['always', 'follow']), delayMs: z.number().int().min(0).max(2000) }).strict(),
}).strict().superRefine((s, ctx) => {
  if (['image', 'video', 'audio'].includes(s.kind) && !s.url) ctx.addIssue({ code: 'custom', message: 'A media source needs a file.' });
  if (s.kind === 'channel' && !s.channelId) ctx.addIssue({ code: 'custom', message: 'Choose a presentation channel.' });
});
const OutputSchema = z.object({
  id, name, mode: z.enum(['program', 'scene']), scene: SceneSchema.nullable(),
  sceneRunId: id.optional(),
  blanked: z.boolean(), audioEnabled: z.boolean(),
}).strict();
const transitionDuration = z.number().int().min(100).max(3000);
const ProgramTransitionSchema = z.discriminatedUnion('kind', [
  z.object({ id, kind: z.literal('cut'), durationMs: z.literal(0) }).strict(),
  z.object({ id, kind: z.literal('fade'), durationMs: transitionDuration }).strict(),
]);
export const ProductionSchema = z.object({
  version: z.literal(1), revision: z.number().int().nonnegative(), updatedAt: z.string(),
  scenes: z.array(SceneSchema).max(60), sources: z.array(SourceSchema).max(40),
  previewSceneId: id.nullable(), program: SceneSchema.nullable(),
  programTransition: ProgramTransitionSchema.optional(),
  channelInsert: z.object({ id, channelId: id, sourceId: id, mode: z.enum(['overlay', 'fullscreen']), layer: LayerSchema }).strict().optional(),
  programCueGate: z.object({ channelId: id, revision: z.number().int().nonnegative() }).strict().optional(),
  programCueGates: z.array(z.object({ channelId: id, revision: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER) }).strict()).max(40).optional(),
  // Older station documents predate the animation library.
  animationPresets: z.array(AnimationPresetSchema).max(100).default([]),
  outputs: z.array(OutputSchema).min(1).max(6), masterVolume: unit, masterMuted: z.boolean(),
  mainAudioSourceId: id.nullable().default(null),
}).strict().superRefine((s, ctx) => {
  const check = (items: { id: string }[], label: string) => {
    if (new Set(items.map(i => i.id)).size !== items.length) ctx.addIssue({ code: 'custom', message: `Duplicate ${label} IDs.` });
  };
  check(s.scenes, 'scene'); check(s.sources, 'source'); check(s.outputs, 'output');
  if (new Set(s.programCueGates?.map(gate => gate.channelId)).size !== (s.programCueGates?.length ?? 0)) {
    ctx.addIssue({ code: 'custom', message: 'Duplicate Program cue channels.' });
  }
  check(s.animationPresets, 'animation preset');
  if (new Set(s.animationPresets.map(preset => animationPresetNameKey(preset.name))).size !== s.animationPresets.length) {
    ctx.addIssue({ code: 'custom', message: 'Animation preset names must be unique.' });
  }
  if (s.outputs.some(o => ['program', 'preview', 'multiview', 'recording', PROGRAM_MONITOR_OUTPUT_ID].includes(o.id))) ctx.addIssue({ code: 'custom', message: 'Reserved output ID.' });
  if (s.previewSceneId && !s.scenes.some(scene => scene.id === s.previewSceneId)) ctx.addIssue({ code: 'custom', message: 'Preview scene does not exist.' });
  if (s.mainAudioSourceId && !s.sources.some(source => source.id === s.mainAudioSourceId && source.kind !== 'image')) {
    ctx.addIssue({ code: 'custom', message: 'Choose another main audio input or None before removing this source.' });
  }
  for (const scene of [...s.scenes, s.program, ...s.outputs.map(o => o.scene)]) {
    if (!scene) continue;
    check(scene.layers, 'layer');
    for (const layer of scene.layers) {
      if (layer.kind === 'source' && !s.sources.some(source => source.id === layer.sourceId)) {
        ctx.addIssue({ code: 'custom', message: `Source missing for layer “${layer.name}”. Remove it from live outputs before deleting it.` });
      }
    }
  }
  if (s.outputs.some(o => o.mode === 'scene' && !o.scene)) ctx.addIssue({ code: 'custom', message: 'Pinned outputs need a scene.' });
  if (s.channelInsert) {
    const insert = s.channelInsert;
    const source = s.sources.find(source => source.id === insert.sourceId);
    if (source?.kind !== 'channel' || source.channelId !== insert.channelId || insert.layer.kind !== 'source' || insert.layer.sourceId !== insert.sourceId) {
      ctx.addIssue({ code: 'custom', message: 'The Program channel insert needs its matching channel source.' });
    }
  }
});

export const CommandSchema = z.discriminatedUnion('type', [
  z.object({ type: z.literal('take'), sceneId: id, transition: z.enum(['cut', 'fade']).optional(), durationMs: transitionDuration.optional(), swapPreview: z.boolean().optional() }).strict(),
  z.object({ type: z.literal('route'), outputId: id, sceneId: id.nullable() }).strict(),
  z.object({ type: z.literal('blank'), outputId: id, blanked: z.boolean() }).strict(),
  z.object({ type: z.literal('set-main-audio'), sourceId: id.nullable() }).strict(),
  z.object({ type: z.literal('save-animation-preset'), name, animation: LayerAnimationSchema }).strict(),
  z.object({ type: z.literal('rename-animation-preset'), presetId: id, name }).strict(),
  z.object({ type: z.literal('delete-animation-preset'), presetId: id }).strict(),
]);

export function initialProduction(): ProductionState {
  const layer = (patch: Partial<SceneLayer>): SceneLayer => ({
    id: 'title', name: 'Title', kind: 'text', visible: true, locked: false,
    x: 8, y: 36, width: 84, height: 18, opacity: 1, fit: 'contain',
    text: 'A place to belong.', color: '#f4f3ee', background: '#00000000',
    fontSize: 104, fontWeight: 600, align: 'center', radius: 0, ...patch,
  });
  return {
    version: 1, revision: 0, updatedAt: new Date().toISOString(), sources: [],
    scenes: [
      { id: 'scene_welcome', name: 'Welcome', background: '#182526', layers: [
        layer({ id: 'eyebrow', name: 'Service label', y: 24, height: 7, text: 'WELCOME HOME', fontSize: 24, color: '#b9c5bb', fontWeight: 500 }),
        layer({}),
        layer({ id: 'subtitle', name: 'Subtitle', y: 58, height: 8, text: 'We’re glad you’re here.', fontSize: 32, color: '#c2cbc5', fontWeight: 400 }),
        layer({ id: 'accent', name: 'Accent line', kind: 'shape', x: 47, y: 74, width: 6, height: 0.2 + 1, background: '#c5dbb5', radius: 8 }),
      ] },
      { id: 'scene_message', name: 'The message', background: '#101316', layers: [
        layer({ id: 'speaker_bg', name: 'Nameplate', kind: 'shape', x: 5, y: 76, width: 38, height: 17, background: '#11181feb', radius: 16 }),
        layer({ id: 'speaker', name: 'Speaker name', x: 7, y: 78, width: 34, height: 7, text: 'Speaker name', fontSize: 46, align: 'left' }),
        layer({ id: 'message', name: 'Message title', x: 7, y: 85, width: 34, height: 5, text: 'A message of hope', fontSize: 26, color: '#bdc5d1', align: 'left', fontWeight: 400 }),
      ] },
      { id: 'scene_close', name: 'See you next week', background: '#29241e', layers: [
        layer({ text: 'Go with hope.', fontSize: 112 }),
        layer({ id: 'thanks', name: 'Closing line', y: 59, height: 8, text: 'Thank you for being part of today.', fontSize: 30, color: '#d4c7b8', fontWeight: 400 }),
      ] },
    ],
    previewSceneId: 'scene_welcome', program: null, animationPresets: [],
    outputs: [
      { id: 'screen_main', name: 'Auditorium', mode: 'program', scene: null, blanked: false, audioEnabled: false },
      { id: 'screen_broadcast', name: 'Program', mode: 'program', scene: null, blanked: false, audioEnabled: true },
    ], masterVolume: 0.8, masterMuted: false, mainAudioSourceId: null,
  };
}
