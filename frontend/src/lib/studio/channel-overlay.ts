import type { Item } from '../../types';
import { transformText, type TextOptions } from './text-style';
import { resolveTextPadding, type TextPaddingInsets } from './text-padding';

export interface OverlayTextBlock {
  lines: string[];
  fontSize: number;
  fontWeight: number;
  top: number;
  lineHeight: number;
  opacity: number;
}

export interface ChannelOverlayLayout {
  /** Legacy uniform inset; use insets when positioning new content. */
  padding: number;
  insets: TextPaddingInsets;
  contentWidth: number;
  contentHeight: number;
  blocks: OverlayTextBlock[];
}

export function channelText(item: Item): string {
  return item.type === 'lyrics' && item.stanzas?.length
    ? item.stanzas.map(stanza => stanza.lines).join('\n\n')
    : item.body || item.title || '';
}

// Unlike the full-screen slide, a lower third has its own aspect ratio. Layout
// is measured in the actual layer bounds, not a squeezed 1920 × 1080 slide.
export function layoutChannelOverlay(item: Item, width: number, height: number, requestedSize: number,
  requestedWeight: number, measure: (text: string, fontSize: number, fontWeight: number) => number,
  style: TextOptions = {}): ChannelOverlayLayout {
  const insets = resolveTextPadding(width, height, style.textPadding, 'overlay');
  const contentWidth = Math.max(1, width - insets.left - insets.right), contentHeight = Math.max(1, height - insets.top - insets.bottom);
  const body = transformText(channelText(item).trim(), style);
  const reference = transformText(item.reference?.trim() ?? '', style);
  const credit = transformText(item.id.startsWith('cue_') ? item.subtitle?.trim() ?? '' : '', style);
  const wrap = (value: string, size: number, weight: number) => {
    const lines: string[] = [];
    for (const paragraph of value.split('\n')) {
      let line = '';
      for (const word of paragraph.split(/\s+/).filter(Boolean)) {
        const next = line ? `${line} ${word}` : word;
        if (line && measure(next, size, weight) > contentWidth) { lines.push(line); line = ''; }
        // Keep very long words/URLs inside narrow overlay frames as well.
        if (measure(word, size, weight) > contentWidth) {
          for (const character of word) {
            if (line && measure(line + character, size, weight) > contentWidth) { lines.push(line); line = ''; }
            line += character;
          }
        } else line = line ? `${line} ${word}` : word;
      }
      lines.push(line);
    }
    return lines;
  };
  const lineHeight = style.lineHeight ?? 1.24;
  const maxSize = Math.max(1, Math.min(requestedSize, contentHeight / lineHeight));
  let result: OverlayTextBlock[] = [];
  for (let size = maxSize; ; size = Math.max(1, size - 1)) {
    const blocks: OverlayTextBlock[] = [];
    const add = (text: string, fontSize: number, fontWeight: number, opacity: number) => {
      if (text) blocks.push({ lines: wrap(text, fontSize, fontWeight), fontSize, fontWeight, top: 0, lineHeight: fontSize * lineHeight, opacity });
    };
    add(body, size, requestedWeight, 1);
    add(reference, Math.max(1, size * .62), 600, .94);
    add(credit, Math.max(1, size * .4), 400, .68);
    const gap = Math.min(12, size * .22);
    const totalHeight = blocks.reduce((sum, block) => sum + block.lines.length * block.lineHeight, 0) + Math.max(0, blocks.length - 1) * gap;
    result = blocks;
    if (totalHeight <= contentHeight || size <= 1) {
      const remaining = Math.max(0, contentHeight - totalHeight);
      let top = insets.top + (style.verticalAlign === 'top' ? 0 : style.verticalAlign === 'bottom' ? remaining : remaining / 2);
      for (const block of blocks) { block.top = top; top += block.lines.length * block.lineHeight + gap; }
      break;
    }
  }
  return { padding: insets.left, insets, contentWidth, contentHeight, blocks: result };
}
