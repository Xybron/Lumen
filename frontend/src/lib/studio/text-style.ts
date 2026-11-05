import type { SceneLayer } from '../../../../shared/production';
import { textPaddingKey } from './text-padding';

export const FONT_FAMILIES = [
  { value: 'system', label: 'System', css: '-apple-system, BlinkMacSystemFont, "Inter", "Segoe UI", sans-serif' },
  { value: 'arial', label: 'Arial', css: 'Arial, Helvetica, sans-serif' },
  { value: 'verdana', label: 'Verdana', css: 'Verdana, Geneva, sans-serif' },
  { value: 'trebuchet', label: 'Trebuchet MS', css: '"Trebuchet MS", Arial, sans-serif' },
  { value: 'georgia', label: 'Georgia', css: 'Georgia, "Times New Roman", serif' },
  { value: 'times', label: 'Times New Roman', css: '"Times New Roman", Times, serif' },
  { value: 'courier', label: 'Courier New', css: '"Courier New", Courier, monospace' },
] as const;
export type TextOptions = Pick<SceneLayer, 'fontFamily' | 'italic' | 'underline' | 'lineHeight' | 'letterSpacing' | 'verticalAlign' | 'textTransform' | 'textStroke' | 'textShadow' | 'textPadding'>;
export const fontFamily = (style: TextOptions = {}) => FONT_FAMILIES.find(font => font.value === style.fontFamily)?.css ?? FONT_FAMILIES[0].css;
export const textFont = (style: TextOptions, size: number, weight: number) => `${style.italic ? 'italic ' : ''}${weight} ${size}px ${fontFamily(style)}`;
export const transformText = (text: string, style: TextOptions = {}) => style.textTransform === 'uppercase' ? text.toUpperCase() : style.textTransform === 'lowercase' ? text.toLowerCase() : text;
export const textMetricsKey = (style: TextOptions = {}) => JSON.stringify([style.fontFamily ?? 'system', !!style.italic, style.lineHeight ?? 1.24, style.letterSpacing ?? 0, style.verticalAlign ?? 'middle', style.textTransform ?? 'none', textPaddingKey(style.textPadding)]);

const segmenter = typeof Intl.Segmenter === 'function' ? new Intl.Segmenter(undefined, { granularity: 'grapheme' }) : null;
const nativeSpacing = (ctx: CanvasRenderingContext2D): boolean => 'letterSpacing' in ctx;
const graphemes = (text: string) => segmenter ? Array.from(segmenter.segment(text), item => item.segment) : Array.from(text);
export function setTextFont(ctx: CanvasRenderingContext2D, style: TextOptions, size: number, weight: number) {
  ctx.font = textFont(style, size, weight);
  if (nativeSpacing(ctx)) ctx.letterSpacing = `${style.letterSpacing ?? 0}px`;
}
export function measureStyledText(ctx: CanvasRenderingContext2D, text: string, style: TextOptions, size: number, weight: number) {
  setTextFont(ctx, style, size, weight);
  const width = ctx.measureText(text).width;
  return nativeSpacing(ctx) || !style.letterSpacing ? width : Math.max(0, width + Math.max(0, graphemes(text).length - 1) * style.letterSpacing);
}
export interface PreparedTextLine { text: string; width: number; glyphs?: { text: string; x: number }[] }
export function prepareTextLine(ctx: CanvasRenderingContext2D, text: string, style: TextOptions, size: number, weight: number): PreparedTextLine {
  const width = measureStyledText(ctx, text, style, size, weight);
  if (!style.letterSpacing || nativeSpacing(ctx)) return { text, width };
  let prefix = '';
  const glyphs = graphemes(text).map((character, index) => {
    const x = ctx.measureText(prefix).width + index * style.letterSpacing!;
    prefix += character; return { text: character, x };
  });
  return { text, width, glyphs };
}
export function drawPreparedText(ctx: CanvasRenderingContext2D, line: PreparedTextLine, x: number, y: number,
  size: number, weight: number, style: TextOptions, align: CanvasTextAlign) {
  setTextFont(ctx, style, size, weight);
  const stroke = style.textStroke, shadow = style.textShadow;
  ctx.save();
  ctx.textAlign = align;
  if (shadow) { ctx.shadowColor = shadow.color; ctx.shadowBlur = shadow.blur; ctx.shadowOffsetX = shadow.offsetX; ctx.shadowOffsetY = shadow.offsetY; }
  if (stroke?.width) { ctx.strokeStyle = stroke.color; ctx.lineWidth = stroke.width * 2; ctx.lineJoin = 'round'; }
  const draw = (method: 'fillText' | 'strokeText') => {
    if (!line.glyphs) ctx[method](line.text, x, y);
    else {
      ctx.textAlign = 'left';
      const left = x - (align === 'center' ? line.width / 2 : align === 'right' || align === 'end' ? line.width : 0);
      for (const glyph of line.glyphs) ctx[method](glyph.text, left + glyph.x, y);
    }
  };
  if (stroke?.width) {
    draw('strokeText');
    // One shadow, rather than painting the same shadow again with the fill.
    ctx.shadowColor = 'transparent';
  }
  draw('fillText');
  if (style.underline && line.text) {
    const left = x - (align === 'center' ? line.width / 2 : align === 'right' || align === 'end' ? line.width : 0);
    const baseline = ctx.textBaseline === 'middle' ? y + size * .45 : y + size * .92;
    ctx.fillRect(left, baseline, line.width, Math.max(1, size / 18));
  }
  ctx.restore();
}

/** CSS sizes are expressed relative to the complete 1920px scene, not the layer. */
export function textCss(style: TextOptions, scale = 1) {
  const px = (value: number) => `${value * scale / 19.2}cqw`;
  return {
    fontFamily: fontFamily(style), fontStyle: style.italic ? 'italic' : 'normal',
    letterSpacing: px(style.letterSpacing ?? 0), textDecorationLine: style.underline ? 'underline' : 'none',
    textTransform: style.textTransform ?? 'none', lineHeight: style.lineHeight ?? 1.24,
    WebkitTextStroke: style.textStroke?.width ? `${px(style.textStroke.width * 2)} ${style.textStroke.color}` : undefined,
    paintOrder: 'stroke fill',
    textShadow: style.textShadow ? `${px(style.textShadow.offsetX)} ${px(style.textShadow.offsetY)} ${px(style.textShadow.blur)} ${style.textShadow.color}` : undefined,
  };
}
