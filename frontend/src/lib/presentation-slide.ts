import type { Item } from '../types';

/** A slide's numbering belongs to its playlist, not to the saved Item. */
export interface PresentationRenderContext { prayerLabel?: string }
export interface PresentationTextBlock {
  role: 'label' | 'title' | 'body' | 'reference';
  lines: string[];
  x: number;
  y: number;
  width: number;
  fontSize: number;
  lineHeight: number;
  weight: number;
  color: string;
  tracking: number;
  align: CanvasTextAlign;
}
const fontFamily = 'Inter, system-ui, -apple-system, sans-serif';
const titleSizes = { sm: 36, md: 52, lg: 60, xl: 72, '2xl': 96 };
let layouts = new WeakMap<Item, { key: string; blocks: PresentationTextBlock[] }>();
// Rasterising static text once also keeps the canvas antialiasing/compositing
// identical in the DOM preview and the opaque Program canvas. Four 1080p
// surfaces bound this cache to about 32 MiB; video backgrounds remain live.
const surfaces = new Map<Item, { blocks: PresentationTextBlock[]; canvas: HTMLCanvasElement }>();
const gradientColors = new Map<string, number[]>();
let colorProbe: CanvasRenderingContext2D | null = null;
function colorChannels(color: string) {
  const cached = gradientColors.get(color); if (cached) return cached;
  if (!colorProbe) { const canvas = document.createElement('canvas'); canvas.width = canvas.height = 1; colorProbe = canvas.getContext('2d')!; }
  colorProbe.fillStyle = color;
  const normalized = String(colorProbe.fillStyle), hex = normalized.match(/^#([a-f\d]{6})$/i), rgb = normalized.match(/^rgba?\(([^)]+)\)$/);
  let channels: number[];
  if (hex) channels = [0, 2, 4].map(index => parseInt(hex[1].slice(index, index + 2), 16)).concat(1);
  else if (rgb) { channels = rgb[1].split(',').map(Number); if (channels.length === 3) channels.push(1); }
  else { colorProbe.clearRect(0, 0, 1, 1); colorProbe.fillRect(0, 0, 1, 1); channels = Array.from(colorProbe.getImageData(0, 0, 1, 1).data); channels[3] /= 255; }
  gradientColors.set(color, channels); if (gradientColors.size > 128) gradientColors.delete(gradientColors.keys().next().value!);
  return channels;
}

/** Match the CSS linear gradients used behind the original slide preview,
 * including their direction, explicit stops and colours with alpha. */
export function drawPresentationGradient(ctx: CanvasRenderingContext2D, css: string | undefined, width: number, height: number): boolean {
  const match = css?.trim().match(/^linear-gradient\((.*)\)$/is);
  if (!match) return false;
  const parts: string[] = []; let depth = 0, start = 0;
  for (let i = 0; i < match[1].length; i++) {
    const c = match[1][i];
    if (c === '(') depth++; else if (c === ')') depth--;
    else if (c === ',' && depth === 0) { parts.push(match[1].slice(start, i).trim()); start = i + 1; }
  }
  parts.push(match[1].slice(start).trim());
  let dx = 0, dy = 1;
  const angle = parts[0]?.match(/^(-?[\d.]+)(deg|turn|rad|grad)$/);
  if (angle) {
    parts.shift(); const radians = Number(angle[1]) * ({ deg: Math.PI / 180, turn: Math.PI * 2, rad: 1, grad: Math.PI / 200 }[angle[2]] ?? 1);
    dx = Math.sin(radians); dy = -Math.cos(radians);
  } else if (parts[0]?.startsWith('to ')) {
    const direction = parts.shift()!;
    dx = direction.includes('right') ? 1 : direction.includes('left') ? -1 : 0;
    dy = direction.includes('bottom') ? 1 : direction.includes('top') ? -1 : 0;
    if (dx && dy) { dx *= height; dy *= width; }
    const magnitude = Math.hypot(dx, dy); if (!magnitude) return false;
    dx /= magnitude; dy /= magnitude;
  }
  const length = Math.abs(width * dx) + Math.abs(height * dy);
  const stops = parts.flatMap(part => {
    const positioned = part.match(/^(.*?)\s+([+-]?(?:\d*\.)?\d+)(%|px)(?:\s+([+-]?(?:\d*\.)?\d+)(%|px))?$/);
    if (!positioned) return [{ color: part, at: undefined as number | undefined }];
    const stop = (value: string, unit: string) => Number(value) / (unit === '%' ? 100 : length);
    const values = [{ color: positioned[1], at: stop(positioned[2], positioned[3]) }];
    if (positioned[4]) values.push({ color: positioned[1], at: stop(positioned[4], positioned[5]) });
    return values;
  });
  if (stops.length < 2) return false;
  stops[0].at ??= 0; stops[stops.length - 1].at ??= 1;
  let previous = 0;
  for (let i = 1; i < stops.length; i++) {
    if (stops[i].at === undefined) continue;
    stops[i].at = Math.max(stops[previous].at!, stops[i].at!);
    for (let j = previous + 1; j < i; j++) stops[j].at = stops[previous].at! + (stops[i].at! - stops[previous].at!) * (j - previous) / (i - previous);
    previous = i;
  }
  const low = Math.min(0, stops[0].at!), high = Math.max(1, stops[stops.length - 1].at!);
  const sx = width / 2 - dx * length / 2, sy = height / 2 - dy * length / 2;
  const gradient = ctx.createLinearGradient(sx + dx * length * low, sy + dy * length * low, sx + dx * length * high, sy + dy * length * high);
  try { stops.forEach(stop => gradient.addColorStop((stop.at! - low) / (high - low), stop.color)); }
  catch { return false; }
  // CSS interpolates translucent stops in premultiplied colour, while Canvas
  // gradients interpolate the raw channels. Subdivide only those intervals.
  for (let i = 1; i < stops.length; i++) {
    const left = stops[i - 1], right = stops[i], a = colorChannels(left.color), b = colorChannels(right.color);
    if (a[3] === b[3] || left.at === right.at) continue;
    for (let step = 1; step < 64; step++) {
      const t = step / 64, alpha = a[3] * (1 - t) + b[3] * t;
      const rgb = [0, 1, 2].map(channel => alpha ? (a[channel] * a[3] * (1 - t) + b[channel] * b[3] * t) / alpha : 0);
      gradient.addColorStop((left.at! + (right.at! - left.at!) * t - low) / (high - low), `rgba(${rgb.join(',')},${alpha})`);
    }
  }
  ctx.fillStyle = gradient; ctx.fillRect(0, 0, width, height); return true;
}

export function hasStructuredPresentation(item: Item) {
  return !item.id.startsWith('cue_') && (['prayer', 'prayer-sub', 'notes'].includes(item.type) || item.type === 'text' && !!item.layout);
}
function font(ctx: CanvasRenderingContext2D, size: number, weight: number, tracking: number) {
  ctx.font = `${weight} ${size}px ${fontFamily}`;
  if ('letterSpacing' in ctx) ctx.letterSpacing = `${tracking}px`;
}
function wrap(ctx: CanvasRenderingContext2D, text: string, width: number): string[] {
  const lines: string[] = [];
  for (const paragraph of text.split('\n')) {
    let line = '';
    for (const word of paragraph.trim().split(/\s+/).filter(Boolean)) {
      if (line && ctx.measureText(`${line} ${word}`).width > width) { lines.push(line); line = ''; }
      // Imported references and notes can contain an unbroken URL or word.
      if (ctx.measureText(word).width > width) {
        for (const char of word) {
          if (line && ctx.measureText(line + char).width > width) { lines.push(line); line = ''; }
          line += char;
        }
      } else line = line ? `${line} ${word}` : word;
    }
    lines.push(line);
  }
  return lines;
}

/** Canonical 1920×1080 geometry shared by the operator preview and Program. */
export function layoutPresentationText(ctx: CanvasRenderingContext2D, item: Item, context: PresentationRenderContext = {}): PresentationTextBlock[] {
  const key = JSON.stringify([item.type, item.layout, item.title, item.body, item.reference, item.typography, item.color, context.prayerLabel]);
  const cached = layouts.get(item);
  if (cached?.key === key) return cached.blocks;
  const prayer = item.type === 'prayer' || item.type === 'prayer-sub';
  const layout = item.layout ?? (item.type === 'notes' ? 'key-points' : 'general');
  const notes = layout === 'key-points', quote = layout === 'quote', statement = layout === 'statement';
  const align = item.typography?.align ?? (notes ? 'left' : 'center');
  const baseSize = titleSizes[item.typography?.size ?? 'lg'];
  const titleSize = quote ? baseSize * .6 : statement ? baseSize * (item.body?.trim() ? .5 : 1.6) : baseSize;
  const bodySize = notes ? 38 * (item.type === 'notes' ? baseSize / titleSizes.lg : 1) : quote ? baseSize : statement ? baseSize * 1.6 : prayer ? 30 : baseSize;
  const definitions = [
    ...(prayer && context.prayerLabel ? [{ role: 'label' as const, text: `PRAYER ${context.prayerLabel}`, size: 30, line: 36, weight: 600, width: 1664, color: '#7dd3fc', tracking: 5.4 }] : []),
    ...(item.title ? [{ role: 'title' as const, text: item.title, size: titleSize, line: titleSize * 1.2, weight: item.typography?.weight ?? 500, width: 1664, color: item.color ?? '#ffffff', tracking: -titleSize * .025 }] : []),
    ...(item.body ? [{ role: 'body' as const, text: notes ? item.body.split('\n').filter(line => line.trim()).map(line => `• ${line.trim().replace(/^(?:[-*•]\s+|\d+[.)]\s+)/, '')}`).join('\n') : quote ? `“${item.body}”` : item.body,
      size: bodySize, line: bodySize * (notes ? 1.58 : prayer && layout === 'general' ? 1.5 : 1.3), weight: quote || !prayer ? 500 : 400,
      width: notes ? 1500 : prayer && layout === 'general' ? 896 : 1500, color: prayer && layout === 'general' ? 'rgba(255,255,255,.8)' : item.color ?? '#ffffff', tracking: 0 }] : []),
    ...(item.reference ? [{ role: 'reference' as const, text: item.reference, size: 24, line: 32, weight: 500, width: 1664, color: 'rgba(125,211,252,.9)', tracking: .6 }] : []),
  ];
  function measure(scale: number) {
    return definitions.map(d => {
      font(ctx, d.size * scale, d.weight, d.tracking * scale);
      let lines = wrap(ctx, d.text, d.width);
      // Balance a multi-line prayer title without changing its chosen size.
      if (d.role === 'title' && lines.length > 1 && !d.text.includes('\n')) {
        let low = d.width / 2, high = d.width;
        for (let i = 0; i < 10; i++) {
          const middle = (low + high) / 2;
          if (wrap(ctx, d.text, middle).length <= lines.length) high = middle; else low = middle;
        }
        lines = wrap(ctx, d.text, high);
      }
      return { role: d.role, lines, width: d.width, x: align === 'left' ? (1920 - d.width) / 2 : align === 'right' ? (1920 + d.width) / 2 : 960,
        y: 0, fontSize: d.size * scale, lineHeight: d.line * scale, weight: d.weight, color: d.color, tracking: d.tracking * scale, align } satisfies PresentationTextBlock;
    });
  }
  const height = (blocks: PresentationTextBlock[], scale: number) => blocks.reduce((sum, block) => sum + block.lines.length * block.lineHeight, 0) + Math.max(0, blocks.length - 1) * 24 * scale;
  let scale = 1, blocks = measure(scale);
  if (height(blocks, scale) > 840) {
    let low = .05, high = 1;
    for (let i = 0; i < 14; i++) {
      const middle = (low + high) / 2;
      if (height(measure(middle), middle) <= 840) low = middle; else high = middle;
    }
    scale = low; blocks = measure(scale);
  }
  let y = (1080 - height(blocks, scale)) / 2;
  for (const block of blocks) { block.y = y; y += block.lines.length * block.lineHeight + 24 * scale; }
  layouts.set(item, { key, blocks });
  return blocks;
}

export function clearPresentationTextLayouts() { layouts = new WeakMap(); surfaces.clear(); }

/** Text only, so the same layout works over live video without recapturing DOM. */
export function drawPresentationText(ctx: CanvasRenderingContext2D, item: Item, context: PresentationRenderContext = {}, width = 1920, height = 1080) {
  ctx.save();
  const blocks = layoutPresentationText(ctx, item, context);
  let surface = surfaces.get(item);
  if (!surface || surface.blocks !== blocks) {
    const canvas = document.createElement('canvas'); canvas.width = 1920; canvas.height = 1080;
    const target = canvas.getContext('2d')!;
    target.textBaseline = 'middle';
    for (const block of blocks) {
      font(target, block.fontSize, block.weight, block.tracking);
      target.fillStyle = block.color; target.textAlign = block.align;
      target.shadowColor = block.role === 'label' ? 'rgba(125,211,252,.45)' : 'rgba(0,0,0,.65)';
      target.shadowBlur = block.role === 'label' ? 18 : block.role === 'title' ? 24 : 0;
      target.shadowOffsetY = block.role === 'title' ? 10 : 2;
      block.lines.forEach((line, index) => target.fillText(line, block.x, block.y + block.lineHeight * (index + .5)));
    }
    surface = { blocks, canvas };
  }
  surfaces.delete(item); surfaces.set(item, surface);
  while (surfaces.size > 4) surfaces.delete(surfaces.keys().next().value!);
  ctx.drawImage(surface.canvas, 0, 0, width, height);
  ctx.restore();
}
