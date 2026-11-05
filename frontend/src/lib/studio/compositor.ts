import type { ProductionState, SceneLayer, StudioScene, StudioSource } from '../../../../shared/production';
import type { Item } from '@/types';
import { SourceBank, type MediaInput, type SceneSourceBank } from './sources';
import { blendScenes, sceneSourceWeights, transitionProgress, weightedScene, type SceneWeight } from './transition';
import { AnimationRunTracker, sampleAnimation } from './animation';
import { channelText, layoutChannelOverlay, type ChannelOverlayLayout } from './channel-overlay';
import { drawPreparedText, measureStyledText, prepareTextLine, textFont, textMetricsKey, transformText, type PreparedTextLine, type TextOptions } from './text-style';
import { blendProgramPictures, programPictureSources, withProgramInsert, type ProgramPicture } from './program-picture';
import { outputAudioEnabled, sourceAudioWeight } from './audio-routing';
import { BroadcastVideoSource, captureCanvasFrames } from './broadcast-capture';
import { ProgramFrameTiming } from './program-frame-timing';
import type { BroadcastProfile } from '../../../../shared/broadcast';
import { PROGRAM_MONITOR_OUTPUT_ID, PROGRAM_MONITOR_WIDTH, PROGRAM_MONITOR_HEIGHT, PROGRAM_MONITOR_FRAME_RATE } from '../../../../shared/program-monitor.js';
import { MULTIVIEW_OUTPUT_ID, MULTIVIEW_COLUMNS, MULTIVIEW_TILE_WIDTH, MULTIVIEW_TILE_HEIGHT,
  multiviewCanvasSize, multiviewSlots } from '../../../../shared/multiview-layout';

function drawFitted(ctx: CanvasRenderingContext2D, media: CanvasImageSource, x: number, y: number, w: number, h: number, fit: 'cover' | 'contain' | 'fill') {
  const m = media as HTMLVideoElement & HTMLImageElement;
  const mw = m.videoWidth || m.naturalWidth || m.width, mh = m.videoHeight || m.naturalHeight || m.height;
  if (!mw || !mh) return;
  if (fit === 'fill') { try { ctx.drawImage(media, x, y, w, h); } catch { /* media is not ready */ } return; }
  const scale = fit === 'cover' ? Math.max(w / mw, h / mh) : Math.min(w / mw, h / mh);
  try { ctx.drawImage(media, x + (w - mw * scale) / 2, y + (h - mh * scale) / 2, mw * scale, mh * scale); } catch { /* media is not ready */ }
}

function textLines(ctx: CanvasRenderingContext2D, text: string, width: number, measure = (value: string) => ctx.measureText(value).width) {
  const lines: string[] = [];
  for (const paragraph of text.split('\n')) {
    let line = '';
    for (const word of paragraph.split(/\s+/)) {
      const next = line ? `${line} ${word}` : word;
      if (line && measure(next) > width) { lines.push(line); line = word; } else line = next;
    }
    lines.push(line);
  }
  return lines;
}

type TextStyle = Pick<SceneLayer, 'fontWeight' | 'fontSize' | 'color' | 'align' | 'text'> & TextOptions;
let wrappedText = new WeakMap<TextStyle, { width: number; font: string; text: string; lines: PreparedTextLine[] }>();
function drawText(ctx: CanvasRenderingContext2D, style: TextStyle, w: number, h: number, bank?: SceneSourceBank) {
  const font = textFont(style, style.fontSize, style.fontWeight), content = transformText(style.text, style);
  ctx.font = font;
  const metrics = font + textMetricsKey(style);
  let cached = wrappedText.get(style);
  if (!cached || cached.width !== w || cached.font !== metrics || cached.text !== content) {
    const measure = (value: string) => measureStyledText(ctx, value, style, style.fontSize, style.fontWeight);
    cached = { width: w, font: metrics, text: content, lines: textLines(ctx, content, Math.max(1, w - 16), measure)
      .map(line => prepareTextLine(ctx, line, style, style.fontSize, style.fontWeight)) };
    wrappedText.set(style, cached);
  }
  const { lines } = cached, lineHeight = style.fontSize * (style.lineHeight ?? 1.24);
  const x = style.align === 'left' ? 8 : style.align === 'right' ? w - 8 : w / 2;
  const available = Math.max(0, h - lines.length * lineHeight);
  const top = lineHeight / 2 + (style.verticalAlign === 'top' ? 0 : style.verticalAlign === 'bottom' ? available : available / 2);
  const paint = (target: CanvasRenderingContext2D) => {
    target.fillStyle = style.color; target.textBaseline = 'middle';
    lines.forEach((line, i) => drawPreparedText(target, line, x, top + i * lineHeight, style.fontSize, style.fontWeight, style, style.align));
  };
  paintStyledText(ctx, bank, cached, style, w, h, paint,
    { top: top - style.fontSize, bottom: top + Math.max(0, lines.length - 1) * lineHeight + style.fontSize });
}

// The source bank supplies a new Item when the channel content changes. Keep
// the fitted text for that snapshot, independent of its moving background.
interface SlideText { width: number; height: number; body: TextStyle; reference?: TextStyle; credit?: TextStyle }
let slideText = new WeakMap<Item, SlideText>();
function fitSize(ctx: CanvasRenderingContext2D, text: string, width: number, height: number,
  size: number, weight: number, step: number) {
  while (size > 4) {
    if ('letterSpacing' in ctx) ctx.letterSpacing = '0px';
    ctx.font = `${weight} ${size}px sans-serif`;
    if (textLines(ctx, text, width).length * size * 1.24 <= height) break;
    size -= step;
  }
  return size;
}
function fittedSlideText(ctx: CanvasRenderingContext2D, item: Item, w: number, h: number): SlideText {
  const cached = slideText.get(item);
  if (cached && cached.width === w && cached.height === h) return cached;
  const text = channelText(item);
  const size = ({ sm: 42, md: 54, lg: 68, xl: 82, '2xl': 100 })[item.typography?.size ?? 'lg'];
  const style = { fontWeight: item.typography?.weight ?? 500, color: item.color ?? '#ffffff', align: item.typography?.align ?? 'center' };
  const layout: SlideText = { width: w, height: h, body: { ...style, text, fontSize: fitSize(ctx, text, w * .86, h * .66, size, style.fontWeight, 2) } };
  if (item.reference) layout.reference = { ...style, text: item.reference, fontSize: 28 };
  if (item.id.startsWith('cue_') && item.subtitle) {
    layout.credit = { ...style, text: item.subtitle, fontSize: fitSize(ctx, item.subtitle, w * .84, h * .06, 18, 500, 1) };
  }
  slideText.set(item, layout);
  return layout;
}

function drawItem(ctx: CanvasRenderingContext2D, item: Item, bank: SceneSourceBank, video: HTMLVideoElement | null, w: number, h: number) {
  const bg = item.background;
  ctx.fillStyle = bg?.color ?? '#121820'; ctx.fillRect(0, 0, w, h);
  if (bg?.kind === 'image' && bg.src) drawFitted(ctx, bank.image(bg.src), 0, 0, w, h, bg.fit ?? 'cover');
  if (bg?.kind === 'video' && video) drawFitted(ctx, video, 0, 0, w, h, bg.fit ?? 'cover');
  if (bg?.kind === 'gradient') {
    const colors = bg.gradient?.match(/#[a-fA-F0-9]{6}/g) ?? ['#101923', '#243a40'];
    const gradient = ctx.createLinearGradient(0, 0, w, h);
    colors.forEach((color, i) => gradient.addColorStop(i / Math.max(1, colors.length - 1), color));
    ctx.fillStyle = gradient; ctx.fillRect(0, 0, w, h);
  }
  if (bg?.overlayOpacity) { ctx.fillStyle = `rgba(0,0,0,${bg.overlayOpacity})`; ctx.fillRect(0, 0, w, h); }
  if (['image', 'video'].includes(item.type)) return;
  const layout = fittedSlideText(ctx, item, w, h);
  ctx.save(); ctx.translate(w * 0.07, h * 0.14);
  drawText(ctx, layout.body, w * 0.86, h * 0.66); ctx.restore();
  if (layout.reference) {
    ctx.save(); ctx.translate(w * 0.08, h * 0.83);
    drawText(ctx, layout.reference, w * 0.84, h * 0.06); ctx.restore();
  }
  if (layout.credit) {
    ctx.save(); ctx.translate(w * 0.08, h * 0.92); ctx.globalAlpha *= .65;
    drawText(ctx, layout.credit, w * .84, h * .06); ctx.restore();
  }
}

export function paintScene(canvas: HTMLCanvasElement, scene: StudioScene | null, bank: SceneSourceBank, blank = false, elapsedMs: number | null = null) {
  const ctx = canvas.getContext('2d', { alpha: false })!;
  ctx.setTransform(canvas.width / 1920, 0, 0, canvas.height / 1080, 0, 0);
  ctx.globalAlpha = 1; ctx.fillStyle = blank ? '#000000' : scene?.background ?? '#090b0e'; ctx.fillRect(0, 0, 1920, 1080);
  if (!scene || blank) return;
  paintLayers(ctx, scene.layers, bank, elapsedMs);
}

/** Small final-pose scene drafts, not new output buses or animation runs. */
export function paintMultiview(canvas: HTMLCanvasElement, scenes: readonly StudioScene[], bank: SceneSourceBank) {
  const size = multiviewCanvasSize(scenes.length);
  if (canvas.width !== size.width) canvas.width = size.width;
  if (canvas.height !== size.height) canvas.height = size.height;
  const ctx = canvas.getContext('2d', { alpha: false })!;
  ctx.setTransform(1, 0, 0, 1, 0, 0);
  ctx.globalAlpha = 1; ctx.globalCompositeOperation = 'source-over';
  ctx.fillStyle = '#090b0e'; ctx.fillRect(0, 0, canvas.width, canvas.height);
  multiviewSlots(scenes).forEach((scene, index) => {
    if (!scene) return;
    const x = index % MULTIVIEW_COLUMNS * MULTIVIEW_TILE_WIDTH;
    const y = Math.floor(index / MULTIVIEW_COLUMNS) * MULTIVIEW_TILE_HEIGHT;
    ctx.save(); ctx.beginPath(); ctx.rect(x, y, MULTIVIEW_TILE_WIDTH, MULTIVIEW_TILE_HEIGHT); ctx.clip();
    ctx.translate(x, y); ctx.scale(MULTIVIEW_TILE_WIDTH / 1920, MULTIVIEW_TILE_HEIGHT / 1080);
    ctx.fillStyle = scene.background; ctx.fillRect(0, 0, 1920, 1080);
    paintLayers(ctx, scene.layers, bank, null);
    ctx.restore();
  });
}

function paintLayers(ctx: CanvasRenderingContext2D, layers: SceneLayer[], bank: SceneSourceBank, elapsedMs: number | null) {
  for (const layer of layers) {
    if (!layer.visible) continue;
    const x = layer.x * 19.2, y = layer.y * 10.8, w = layer.width * 19.2, h = layer.height * 10.8;
    const pose = sampleAnimation(layer.animation, elapsedMs);
    if (pose.opacity <= 0) continue;
    ctx.save(); ctx.translate(x + pose.x + w / 2, y + pose.y + h / 2);
    ctx.rotate(pose.rotation * Math.PI / 180); ctx.scale(pose.scale, pose.scale); ctx.translate(-w / 2, -h / 2);
    ctx.globalAlpha = layer.opacity * pose.opacity;
    const input = layer.sourceId ? bank.inputs.get(layer.sourceId) : undefined;
    const clearBackground = layer.background.length === 9 && layer.background.endsWith('00');
    const multipleDraws = !!layer.mediaBackground || layer.kind !== 'shape' && (!clearBackground || input?.source.kind === 'channel');
    if (ctx.globalAlpha > 0 && ctx.globalAlpha < 1 && multipleDraws) {
      // Opacity belongs to the complete element, not each overlapping draw.
      // Rendering its fill and text/media separately at half alpha would tint
      // text with its own background and disagree with the editor's CSS pose.
      const surface = opacitySurface(bank, w, h), surfaceContext = surface.getContext('2d')!;
      surfaceContext.setTransform(1, 0, 0, 1, 0, 0);
      surfaceContext.globalAlpha = 1;
      surfaceContext.clearRect(0, 0, Math.ceil(w), Math.ceil(h));
      drawLayerContent(surfaceContext, layer, bank, w, h);
      ctx.drawImage(surface, 0, 0, w, h, 0, 0, w, h);
    } else {
      drawLayerContent(ctx, layer, bank, w, h);
    }
    ctx.restore();
  }
}

// One reusable alpha surface per renderer/source bank. It grows only when
// needed, avoiding canvas allocation/resizing for every layer on every frame.
// Fully opaque elements and single-draw transparent elements bypass it.
const opacitySurfaces = new WeakMap<SceneSourceBank, HTMLCanvasElement>();
function opacitySurface(bank: SceneSourceBank, width: number, height: number) {
  let surface = opacitySurfaces.get(bank);
  if (!surface) { surface = document.createElement('canvas'); opacitySurfaces.set(bank, surface); }
  if (surface.width < width) surface.width = Math.ceil(width);
  if (surface.height < height) surface.height = Math.ceil(height);
  return surface;
}
function drawLayerContent(ctx: CanvasRenderingContext2D, layer: SceneLayer, bank: SceneSourceBank, w: number, h: number) {
  const input = layer.sourceId ? bank.inputs.get(layer.sourceId) : undefined;
  const channel = layer.kind === 'source' && input?.source.kind === 'channel';
  const item = channel ? bank.channelItem(input) : undefined;
  // Dedicated worship channels supply content only, including legacy layers
  // that once requested a channel theme. Studio owns every design property.
  const styledText = channel && (bank.isTextChannel(input) || layer.channelStyle === 'overlay');
  // Clearing live content reveals underlying camera/media, never a stale fill.
  if (styledText && !item) return;
  ctx.save();
  ctx.beginPath(); ctx.roundRect(0, 0, w, h, Math.min(layer.radius, w / 2, h / 2)); ctx.clip();
  ctx.fillStyle = layer.background; ctx.fillRect(0, 0, w, h);
  if (layer.mediaBackground) {
    const background = layer.mediaBackground;
    const media = bank.layerBackground?.(layer) ?? (background.kind === 'image' ? bank.image(background.url) : undefined);
    if (media) drawFitted(ctx, media, 0, 0, w, h, background.fit);
    if (background.dim > 0) { ctx.fillStyle = `rgba(0,0,0,${background.dim})`; ctx.fillRect(0, 0, w, h); }
  }
  if (layer.kind === 'text') drawText(ctx, layer, w, h, bank);
  else if (layer.kind === 'source' && layer.sourceId) {
    if (channel) {
      if (item && styledText) drawChannelOverlay(ctx, item, layer, bank, input, w, h);
      else if (item) { ctx.save(); ctx.scale(w / 1920, h / 1080); drawItem(ctx, item, bank, input.element instanceof HTMLVideoElement ? input.element : null, 1920, 1080); ctx.restore(); }
    } else if (input?.element && !(input.element instanceof HTMLAudioElement)) {
      drawFitted(ctx, input.element, 0, 0, w, h, layer.fit);
    }
  }
  ctx.restore();
}

interface PaintedOverlayLayout extends ChannelOverlayLayout { prepared: PreparedTextLine[][] }
let overlayLayouts = new WeakMap<Item, Map<string, PaintedOverlayLayout>>();
let styledTextSurfaces = new WeakMap<SceneSourceBank, Map<string, { canvas: HTMLCanvasElement; usedAt: number }>>();
let textLayoutIds = new WeakMap<object, number>(), nextTextLayoutId = 0;
// Effects are rasterised once per text/geometry/style variant, not blurred on
// every moving video frame. Per-bank storage is capped at four million pixels
// (~16 MB), and old cues/layouts are evicted before new artwork is retained.
function paintStyledText(ctx: CanvasRenderingContext2D, bank: SceneSourceBank | undefined, layout: object,
  style: TextStyle | SceneLayer, w: number, h: number, paint: (target: CanvasRenderingContext2D) => void,
  bounds: { top: number; bottom: number }) {
  const spread = (style.textShadow?.blur ?? 0) * 2 + Math.abs(style.textShadow?.offsetY ?? 0) + (style.textStroke?.width ?? 0) + 2;
  const top = Math.max(0, Math.floor(bounds.top - spread)), bottom = Math.min(Math.ceil(h), Math.ceil(bounds.bottom + spread));
  const pixels = Math.ceil(w) * Math.max(1, bottom - top);
  if (!bank || !style.textStroke?.width && !style.textShadow || pixels > 4_000_000) { paint(ctx); return; }
  let cache = styledTextSurfaces.get(bank);
  if (!cache) { cache = new Map(); styledTextSurfaces.set(bank, cache); }
  let layoutId = textLayoutIds.get(layout);
  if (layoutId === undefined) { layoutId = ++nextTextLayoutId; textLayoutIds.set(layout, layoutId); }
  const key = JSON.stringify([layoutId, w, h, top, bottom, style.color, style.align, style.underline, style.textStroke, style.textShadow]);
  const now = performance.now();
  let surface = cache.get(key);
  if (!surface) {
    let used = [...cache.values()].reduce((sum, value) => sum + value.canvas.width * value.canvas.height, 0);
    while (cache.size && (used + pixels > 4_000_000 || cache.size >= 12)) {
      const oldest = cache.keys().next().value!;
      const evicted = cache.get(oldest)!;
      // Several active outputs must not evict each other's artwork every
      // frame. Over-budget variants paint directly until a slot goes idle.
      if (now - evicted.usedAt < 100) { paint(ctx); return; }
      used -= evicted.canvas.width * evicted.canvas.height; cache.delete(oldest);
    }
    const canvas = document.createElement('canvas'); canvas.width = Math.ceil(w); canvas.height = Math.max(1, bottom - top);
    const target = canvas.getContext('2d');
    if (!target) { paint(ctx); return; }
    target.translate(0, -top); paint(target); surface = { canvas, usedAt: now }; cache.set(key, surface);
  } else { surface.usedAt = now; cache.delete(key); cache.set(key, surface); }
  ctx.drawImage(surface.canvas, 0, top);
}
function clearTextLayouts() {
  wrappedText = new WeakMap();
  slideText = new WeakMap();
  overlayLayouts = new WeakMap();
  styledTextSurfaces = new WeakMap();
  textLayoutIds = new WeakMap();
}
function drawChannelOverlay(ctx: CanvasRenderingContext2D, item: Item, layer: SceneLayer, bank: SceneSourceBank,
  input: MediaInput, w: number, h: number) {
  if (item.type === 'image' && item.background?.src) { drawFitted(ctx, bank.image(item.background.src), 0, 0, w, h, layer.fit); return; }
  if (item.type === 'video' && input.element instanceof HTMLVideoElement) { drawFitted(ctx, input.element, 0, 0, w, h, layer.fit); return; }
  // A live cue usually remains unchanged for hundreds of frames. Cache its
  // measured layout rather than wrapping and measuring it 30 times a second.
  let layouts = overlayLayouts.get(item);
  if (!layouts) { layouts = new Map(); overlayLayouts.set(item, layouts); }
  const key = `${w}:${h}:${layer.fontSize}:${layer.fontWeight}:${textMetricsKey(layer)}`;
  let layout = layouts.get(key);
  if (!layout) {
    const measured = layoutChannelOverlay(item, w, h, layer.fontSize, layer.fontWeight,
      (text, size, weight) => measureStyledText(ctx, text, layer, size, weight), layer);
    layout = { ...measured, prepared: measured.blocks.map(block => block.lines.map(line => prepareTextLine(ctx, line, layer, block.fontSize, block.fontWeight))) };
    if (layouts.size >= 32) layouts.clear();
    layouts.set(key, layout);
  }
  const x = layer.align === 'left' ? layout.padding : layer.align === 'right' ? w - layout.padding : w / 2;
  const current = layout;
  paintStyledText(ctx, bank, current, layer, w, h, target => {
    target.fillStyle = layer.color; target.textBaseline = 'top';
    current.blocks.forEach((block, blockIndex) => {
      target.save(); target.globalAlpha *= block.opacity;
      current.prepared[blockIndex].forEach((line, index) => drawPreparedText(target, line, x, block.top + index * block.lineHeight, block.fontSize, block.fontWeight, layer, layer.align));
      target.restore();
    });
  }, { top: current.blocks[0]?.top ?? 0,
    bottom: current.blocks.reduce((last, block) => Math.max(last, block.top + block.lines.length * block.lineHeight + block.fontSize), 0) });
}

// This is a visual insert into the final Program picture, not a replacement
// Studio scene. Audio routing and entrance clocks keep following the base mix.
// Program-follow screens and the recorder consume this same composited canvas.
export function paintProgramChannel(canvas: HTMLCanvasElement, state: ProductionState, bank: SourceBank) {
  paintChannelInsert(canvas, state.channelInsert, bank);
}

function paintChannelInsert(canvas: HTMLCanvasElement, insert: ProductionState['channelInsert'], bank: SourceBank) {
  if (!insert) return;
  const input = bank.inputs.get(insert.sourceId);
  if (!input || input.source.kind !== 'channel' || !bank.channelItem(input)) return;
  const ctx = canvas.getContext('2d', { alpha: false })!;
  ctx.setTransform(canvas.width / 1920, 0, 0, canvas.height / 1080, 0, 0);
  ctx.globalAlpha = 1; ctx.globalCompositeOperation = 'source-over';
  paintLayers(ctx, [insert.layer], bank, null);
}

interface Bus {
  canvas: HTMLCanvasElement;
  destination: MediaStreamAudioDestinationNode;
  master: GainNode;
  analyser: AnalyserNode;
  routes: Map<string, { gain: GainNode; input: GainNode; target: number }>;
  masterTarget?: number;
  stream: MediaStream;
  requestFrame?: () => void;
}

interface ProgramFade {
  startedAt: number;
  durationMs: number;
  from: SceneWeight[];
  pictures: ProgramPicture[];
  sources: StudioSource[];
}
interface HeldProgram {
  mix: SceneWeight[];
  pictures: ProgramPicture[];
  sources: StudioSource[];
}

export class StudioCompositor {
  readonly audio = new AudioContext({ sampleRate: 48000 });
  readonly bank = new SourceBank(this.audio);
  private buses = new Map<string, Bus>();
  private timer: number;
  readonly timing = new ProgramFrameTiming();
  private masterSamples = new Float32Array(2048);
  private heldMasterLevel = 0;
  private fade: ProgramFade | null = null;
  private heldProgram: HeldProgram | null = null;
  private cueWaitAt: number | null = null;
  private animationRuns: AnimationRunTracker;
  private programCanvas = document.createElement('canvas');
  private sceneCanvas = document.createElement('canvas');
  private previewPaintedAt = -Infinity;
  private multiview: { canvas: HTMLCanvasElement; stream: MediaStream; paintedAt: number } | null = null;
  private programMonitor: { canvas: HTMLCanvasElement; stream: MediaStream; paintedAt: number } | null = null;
  private broadcastVideo: BroadcastVideoSource | null = null;
  private broadcastRecovery = 0;
  constructor(private state: ProductionState) {
    document.fonts.addEventListener('loadingdone', clearTextLayouts);
    this.animationRuns = new AnimationRunTracker(state);
    this.programCanvas.width = this.sceneCanvas.width = 1920;
    this.programCanvas.height = this.sceneCanvas.height = 1080;
    this.bank.sync(state.sources);
    if (!this.bank.programCueReady(state.programCueGate) || !this.bank.programCuesReady(state.programCueGates)) {
      // A restarted renderer has only shown black until authoritative replay.
      // A superseding Take must not treat its saved-but-unready scene as live.
      this.heldProgram = { mix: [], pictures: [{ ...weightedScene(null, 1), inserts: [] }], sources: [] };
    }
    this.bus('program');
    void this.audio.resume();
    this.timer = window.setInterval(() => this.draw(), 1000 / 30);
    this.draw();
  }
  update(state: ProductionState) {
    const transition = state.programTransition;
    // A persisted transition describes the last Take, not an animation to replay
    // on engine start, reconnection, or an unrelated inspector save.
    const now = performance.now(), outgoing = this.programMix(now), outgoingPictures = this.programPictures(now);
    if (this.animationRuns.update(state, now)) {
      this.cueWaitAt = now;
      const sources = [...this.bank.inputs.values()].map(input => input.source);
      const ready = this.bank.programCueReady(state.programCueGate) && this.bank.programCuesReady(state.programCueGates);
      // A pending Take has not appeared on screen. If it is superseded, the
      // next transition must start from the held picture, never that unready
      // scene (which could contain the previous verse).
      this.heldProgram = ready ? null : { mix: outgoing, pictures: outgoingPictures, sources };
      this.fade = transition?.kind === 'fade' && transition.durationMs > 0 ? {
        startedAt: now, durationMs: transition.durationMs,
        from: outgoing, pictures: outgoingPictures, sources,
      } : null;
    }
    this.state = state;
    this.syncSources();
    this.previewPaintedAt = -Infinity;
    if (this.multiview) this.multiview.paintedAt = -Infinity;
    // The next Program tick paints the latest state. A burst of operator
    // edits should not insert extra full-resolution draws between ticks.
  }
  private previewHasMotion(scene: StudioScene | null) {
    return scene?.layers.some(layer => {
      if (!layer.visible || layer.kind !== 'source' || !layer.sourceId) return false;
      const input = this.bank.inputs.get(layer.sourceId);
      if (!input) return false;
      if (['camera', 'screen', 'video'].includes(input.source.kind)) return true;
      const item = input.source.kind === 'channel' ? this.bank.channelItem(input, false) : undefined;
      return !!item && (layer.mediaBackground?.kind === 'video' || item.background?.kind === 'video');
    }) ?? false;
  }
  private programMix(now: number): SceneWeight[] {
    if (this.heldProgram) return this.heldProgram.mix;
    return this.fade ? blendScenes(this.fade.from, this.state.program,
      transitionProgress(this.fade.startedAt, this.fade.durationMs, now), this.animationRuns.program) :
      [weightedScene(this.state.program, 1, this.animationRuns.program)];
  }
  private programPictures(now: number): ProgramPicture[] {
    if (this.heldProgram) return this.heldProgram.pictures;
    const pictures = this.fade ? blendProgramPictures(this.fade.pictures, this.state.program,
      transitionProgress(this.fade.startedAt, this.fade.durationMs, now), this.animationRuns.program) :
      [{ ...weightedScene(this.state.program, 1, this.animationRuns.program), inserts: [] }];
    return withProgramInsert(pictures, this.state.channelInsert);
  }
  private syncSources() {
    const sources = [...this.state.sources], present = new Set(sources.map(source => source.id));
    const retained = this.heldProgram ? { mix: this.heldProgram.mix, pictures: this.heldProgram.pictures, sources: this.heldProgram.sources } :
      this.fade ? { mix: this.fade.from, pictures: this.fade.pictures, sources: this.fade.sources } : null;
    if (retained) {
      const outgoing = sceneSourceWeights(retained.mix);
      const visualSources = programPictureSources(retained.pictures);
      for (const source of retained.sources) {
        if (!present.has(source.id) && (outgoing.has(source.id) || visualSources.has(source.id) || source.audio.mode === 'always')) sources.push(source);
      }
    }
    this.bank.sync(sources);
  }
  private paintProgram(now: number) {
    const elapsed = (entry: SceneWeight) => entry.animationStartedAt === undefined ? null : now - entry.animationStartedAt;
    const pictures = this.programPictures(now);
    if (!this.fade) {
      const picture = pictures[0];
      paintScene(this.programCanvas, picture.scene, this.bank, false, elapsed(picture));
      for (const insert of picture.inserts) paintChannelInsert(this.programCanvas, insert, this.bank);
      return;
    }
    const ctx = this.programCanvas.getContext('2d', { alpha: false })!;
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.globalAlpha = 1; ctx.globalCompositeOperation = 'source-over';
    ctx.fillStyle = '#000000'; ctx.fillRect(0, 0, 1920, 1080);
    // Add weighted opaque frames over black. Ordinary source-over at both
    // weights would darken the middle of a crossfade.
    ctx.globalCompositeOperation = 'lighter';
    for (const entry of pictures) {
      paintScene(this.sceneCanvas, entry.scene, this.bank, !entry.scene, elapsed(entry));
      for (const insert of entry.inserts) paintChannelInsert(this.sceneCanvas, insert, this.bank);
      ctx.globalAlpha = entry.weight; ctx.drawImage(this.sceneCanvas, 0, 0);
    }
    ctx.globalAlpha = 1; ctx.globalCompositeOperation = 'source-over';
  }
  private bus(id: string) {
    let bus = this.buses.get(id);
    if (!bus) {
      // Program is already painted at output resolution. Capture that canvas
      // directly instead of copying another 1920 × 1080 frame on every tick.
      const canvas = id === 'program' ? this.programCanvas : document.createElement('canvas');
      if (id !== 'program') { canvas.width = id === 'preview' ? 960 : 1920; canvas.height = id === 'preview' ? 540 : 1080; }
      const destination = this.audio.createMediaStreamDestination(), master = this.audio.createGain(), analyser = this.audio.createAnalyser();
      analyser.fftSize = 2048;
      master.connect(analyser); analyser.connect(destination);
      // Projector tracks should publish the completed screen draw. Program's
      // recording track and the operator Preview retain their native cadence.
      const { stream, requestFrame } = id === 'program' || id === 'preview'
        ? { stream: canvas.captureStream(30), requestFrame: undefined }
        : captureCanvasFrames(canvas, 30);
      destination.stream.getAudioTracks().forEach(t => stream.addTrack(t));
      bus = { canvas, destination, master, analyser, routes: new Map(), stream, requestFrame }; this.buses.set(id, bus);
    }
    return bus;
  }
  stream(id: string) {
    if (id === PROGRAM_MONITOR_OUTPUT_ID) {
      if (!this.programMonitor) {
        const canvas = document.createElement('canvas');
        canvas.width = PROGRAM_MONITOR_WIDTH; canvas.height = PROGRAM_MONITOR_HEIGHT;
        canvas.getContext('2d', { alpha: false })!.drawImage(this.programCanvas, 0, 0, canvas.width, canvas.height);
        // One shared, video-only operator bus. It never creates an audio route.
        this.programMonitor = { canvas, stream: canvas.captureStream(PROGRAM_MONITOR_FRAME_RATE), paintedAt: performance.now() };
      }
      return this.programMonitor.stream;
    }
    if (id !== MULTIVIEW_OUTPUT_ID) return this.bus(id).stream;
    if (!this.multiview) {
      const canvas = document.createElement('canvas');
      this.paintMultiview(canvas);
      // Deliberately video-only: no destination node, source route, or audio
      // track is created for the atlas. All viewers share this one capture.
      this.multiview = { canvas, stream: canvas.captureStream(7.5), paintedAt: performance.now() };
    }
    return this.multiview.stream;
  }
  broadcastStream(profile: BroadcastProfile) {
    this.broadcastVideo?.close();
    this.broadcastRecovery = 0;
    const video = new BroadcastVideoSource(this.programCanvas, this.bus('program').stream, profile);
    this.broadcastVideo = video;
    return { stream: video.stream, release: () => { video.close(); if (this.broadcastVideo === video) this.broadcastVideo = null; } };
  }
  get broadcastFrameRate() { return this.broadcastVideo?.frameRate ?? null; }
  get renderedOutputs() { return [...this.buses.keys()]; }
  releaseOutput(id: string) {
    if (id === MULTIVIEW_OUTPUT_ID) { this.releaseMultiview(); return; }
    if (id === PROGRAM_MONITOR_OUTPUT_ID) { this.releaseProgramMonitor(); return; }
    const bus = this.buses.get(id);
    if (id === 'program' || !bus) return;
    this.dispose(bus);
    bus.canvas.width = bus.canvas.height = 0;
    this.buses.delete(id);
    if (id === 'preview') this.previewPaintedAt = -Infinity;
  }
  releaseProgramMonitor() {
    if (!this.programMonitor) return;
    this.programMonitor.stream.getVideoTracks().forEach(track => track.stop());
    this.programMonitor.canvas.width = this.programMonitor.canvas.height = 0;
    this.programMonitor = null;
  }
  releaseMultiview() {
    if (this.multiview) {
      this.multiview.stream.getTracks().forEach(track => track.stop());
      this.multiview.canvas.width = this.multiview.canvas.height = 0;
      this.multiview = null;
    }
    this.bank.releaseMultiview();
  }
  private paintMultiview(canvas: HTMLCanvasElement) {
    const sourceIds = new Set(this.state.scenes.flatMap(scene => scene.layers.filter(layer => layer.visible && layer.sourceId).map(layer => layer.sourceId!)));
    paintMultiview(canvas, this.state.scenes, this.bank.multiviewView(sourceIds));
  }
  private syncLayerBackgrounds(now: number) {
    const active: SceneLayer[] = [];
    const retain = (layers: readonly SceneLayer[], elapsedMs: number | null = null) => {
      for (const layer of layers) {
        if (!layer.mediaBackground || !layer.visible || layer.opacity <= 0 || sampleAnimation(layer.animation, elapsedMs).opacity <= 0) continue;
        const input = layer.kind === 'source' && layer.sourceId ? this.bank.inputs.get(layer.sourceId) : undefined;
        if (input?.source.kind === 'channel' && (this.bank.isTextChannel(input) || layer.channelStyle === 'overlay') && !this.bank.channelItem(input, false)) continue;
        active.push(layer);
      }
    };
    // Retain both snapshots during fades and pending cue handoffs. An edit to
    // the draft cannot replace the committed Program background's player.
    for (const picture of this.programPictures(now)) {
      if (picture.weight <= 0) continue;
      retain(picture.scene?.layers ?? [], picture.animationStartedAt === undefined ? null : now - picture.animationStartedAt);
      for (const insert of picture.inserts) retain([insert.layer]);
    }
    if (this.buses.has('preview')) retain(this.state.scenes.find(scene => scene.id === this.state.previewSceneId)?.layers ?? []);
    for (const output of this.state.outputs) {
      if (!this.buses.has(output.id) || output.mode !== 'scene' || output.blanked) continue;
      const run = this.animationRuns.output(output.id);
      retain(output.scene?.layers ?? [], run ? now - run.startedAt : null);
    }
    this.bank.syncLayerBackgrounds(active);
  }
  private draw() {
    const now = performance.now();
    const cueReady = this.bank.programCueReady(this.state.programCueGate) && this.bank.programCuesReady(this.state.programCueGates);
    if (this.cueWaitAt !== null) {
      const waitingMs = now - this.cueWaitAt;
      // Start the entrance/fade when its text is actually ready, not while
      // holding the previous picture across an independently delayed socket.
      if (this.fade) this.fade.startedAt += waitingMs;
      if (this.animationRuns.program) this.animationRuns.program.startedAt += waitingMs;
    }
    this.cueWaitAt = cueReady ? null : now;
    if (cueReady && this.heldProgram) {
      this.heldProgram = null;
      this.syncSources();
    }
    if (this.fade && transitionProgress(this.fade.startedAt, this.fade.durationMs, now) >= 1) {
      this.fade = null;
      this.syncSources();
    }
    // A channel insert changes the picture only. In particular, full-screen
    // scripture must not duck/remove the preacher's follow-scene microphone.
    const programMix = this.programMix(now), programWeights = sceneSourceWeights(programMix);
    const outgoingWeight = this.fade ? 1 - transitionProgress(this.fade.startedAt, this.fade.durationMs, now) : 0;
    const currentSources = new Set(this.state.sources.map(source => source.id));
    const mainInput = this.state.mainAudioSourceId ? this.bank.inputs.get(this.state.mainAudioSourceId) : undefined;
    // A presentation channel selected for service audio may not appear in the
    // current picture. Resolve its media independently of visual painting.
    if (mainInput?.source.kind === 'channel') this.bank.channelItem(mainInput);
    this.syncLayerBackgrounds(now);
    // A newly routed cue arrives on the channel connection independently from
    // Studio state. Keep the last good Program frame until its authoritative
    // cue revision has arrived; never paint (or activate) a stale channel item.
    // Audio, Preview, pinned screens and peer streams continue normally while
    // this usually millisecond-long handoff waits. On restart it starts black.
    if (cueReady) this.paintProgram(now);
    const ids = ['program', 'preview', ...this.state.outputs.map(o => o.id)];
    for (const id of this.buses.keys()) {
      if (!ids.includes(id)) this.releaseOutput(id);
    }
    for (const id of ids) {
      const output = this.state.outputs.find(o => o.id === id);
      const scene = id === 'preview' ? this.state.scenes.find(s => s.id === this.state.previewSceneId) ?? null :
        output?.mode === 'scene' ? output.scene : this.state.program;
      const bus = this.buses.get(id);
      if (!bus) {
        // A channel video on Preview or a pinned scene still follows its
        // playback clock and audio settings when there is no display watching.
        if ((id === 'preview' || output?.mode === 'scene') && !output?.blanked) {
          const run = id === 'preview' ? null : this.animationRuns.output(id);
          for (const layer of scene?.layers ?? []) {
            const input = layer.visible && layer.kind === 'source' && layer.sourceId && this.bank.inputs.get(layer.sourceId);
            if (input && input.source.kind === 'channel' && sampleAnimation(layer.animation, run ? now - run.startedAt : null).opacity > 0) this.bank.channelItem(input);
          }
        }
        continue;
      }
      const followsProgram = id !== 'preview' && output?.mode !== 'scene';
      let painted = true;
      if (id === 'preview' && !this.previewHasMotion(scene) && now - this.previewPaintedAt < 100) {
        // Static Preview scenes need no full canvas repaint every Program tick.
        // A cue arriving independently will appear within 100 ms.
        painted = false;
      } else if (followsProgram && !output?.blanked) {
        if (bus.canvas !== this.programCanvas) {
          const ctx = bus.canvas.getContext('2d', { alpha: false })!;
          ctx.setTransform(1, 0, 0, 1, 0, 0); ctx.globalAlpha = 1;
          ctx.drawImage(this.programCanvas, 0, 0, bus.canvas.width, bus.canvas.height);
        }
      } else {
        const run = id === 'preview' ? null : this.animationRuns.output(id);
        paintScene(bus.canvas, scene, this.bank, output?.blanked, run ? now - run.startedAt : null);
      }
      if (id === 'preview' && painted) this.previewPaintedAt = now;
      bus.requestFrame?.();
      const audioEnabled = outputAudioEnabled(id, output?.audioEnabled);
      if (!audioEnabled) {
        if (bus.masterTarget !== 0) {
          bus.master.gain.setTargetAtTime(0, this.audio.currentTime, 0.015);
          bus.masterTarget = 0;
        }
        continue;
      }
      const weights = followsProgram ? programWeights : sceneSourceWeights([{ scene, weight: 1 }]);
      for (const [sourceId, route] of bus.routes) {
        if (this.bank.inputs.get(sourceId)?.gain !== route.input) {
          try { route.input.disconnect(route.gain); } catch { /* source was disposed */ }
          route.gain.disconnect(); bus.routes.delete(sourceId);
        }
      }
      for (const [sourceId, input] of this.bank.inputs) {
        let route = bus.routes.get(sourceId);
        if (!route) { const gain = this.audio.createGain(); gain.gain.value = 0; input.gain.connect(gain); gain.connect(bus.master); route = { gain, input: input.gain, target: 0 }; bus.routes.set(sourceId, route); }
        const weight = sourceAudioWeight(input.source, this.state.mainAudioSourceId, currentSources.has(sourceId), followsProgram, outgoingWeight, weights.get(sourceId) ?? 0);
        if (weight !== route.target) {
          route.gain.gain.setTargetAtTime(weight, this.audio.currentTime, 0.015);
          route.target = weight;
        }
      }
      const masterTarget = !this.state.masterMuted ? this.state.masterVolume : 0;
      if (bus.masterTarget !== masterTarget) {
        bus.master.gain.setTargetAtTime(masterTarget, this.audio.currentTime, 0.015);
        bus.masterTarget = masterTarget;
      }
    }
    if (this.multiview && now - this.multiview.paintedAt >= 1000 / 7.5) {
      this.paintMultiview(this.multiview.canvas);
      this.multiview.paintedAt = now;
    }
    this.broadcastVideo?.draw(now);
    if (this.programMonitor && now - this.programMonitor.paintedAt >= 1000 / PROGRAM_MONITOR_FRAME_RATE) {
      this.programMonitor.canvas.getContext('2d', { alpha: false })!.drawImage(this.programCanvas, 0, 0, PROGRAM_MONITOR_WIDTH, PROGRAM_MONITOR_HEIGHT);
      this.programMonitor.paintedAt = now;
    }
    this.bank.sampleLevels();
    this.bus('program').analyser.getFloatTimeDomainData(this.masterSamples);
    for (const sample of this.masterSamples) this.heldMasterLevel = Math.max(this.heldMasterLevel, Math.abs(sample));
    if (this.timing.record(performance.now())) this.adjustBroadcastCadence();
  }
  private adjustBroadcastCadence() {
    // Only the optional 720p stream yields frames. Preview, Program, recording
    // and projection keep their own 30 fps sources and never inherit this rate.
    const video = this.broadcastVideo;
    if (video?.settings.profile !== '720p') return;
    this.broadcastRecovery = this.timing.fps >= 29 ? this.broadcastRecovery + 1 : 0;
    if (this.timing.fps < 26) video.setFrameRate(video.frameRate === 30 ? 20 : 15);
    else if (this.broadcastRecovery >= 4) {
      video.setFrameRate(video.frameRate === 15 ? 20 : 30);
      this.broadcastRecovery = 0;
    }
  }
  status() {
    const data = this.bank.status();
    const main = this.state.mainAudioSourceId ? this.bank.inputs.get(this.state.mainAudioSourceId) : undefined;
    if (main && ['camera', 'microphone', 'screen'].includes(main.source.kind) && main.stream
      && !main.stream.getAudioTracks().some(track => track.readyState === 'live')) {
      data.sources[main.source.id] = 'missing';
      data.sourceErrors[main.source.id] = main.source.kind === 'camera'
        ? 'This camera is connected without sound. Enable Include audio in Camera settings, or set a microphone as Main.'
        : main.source.kind === 'microphone'
          ? 'The Main microphone has no live sound. Reconnect it or choose another microphone.'
          : 'Main input has no live audio track. Share screen audio or set a microphone as Main.';
    }
    data.levels.master = Math.min(1, this.heldMasterLevel);
    this.heldMasterLevel = 0;
    return { fps: this.timing.fps, ...data };
  }
  private dispose(bus: Bus) {
    for (const route of bus.routes.values()) { try { route.input.disconnect(route.gain); } catch { /* removed input */ } route.gain.disconnect(); }
    bus.master.disconnect(); bus.analyser.disconnect(); bus.stream.getTracks().forEach(t => t.stop());
  }
  close() { document.fonts.removeEventListener('loadingdone', clearTextLayouts); clearInterval(this.timer); this.broadcastVideo?.close(); this.broadcastVideo = null; this.releaseProgramMonitor(); this.releaseMultiview(); for (const bus of this.buses.values()) this.dispose(bus); this.bank.close(); void this.audio.close(); }
}
