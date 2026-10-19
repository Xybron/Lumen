import type { Item } from '../../types';

export interface OverlayTextBlock {
  lines: string[];
  fontSize: number;
  fontWeight: number;
  top: number;
  lineHeight: number;
  opacity: number;
}

export interface ChannelOverlayLayout {
  padding: number;
  contentWidth: number;
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
  requestedWeight: number, measure: (text: string, fontSize: number, fontWeight: number) => number): ChannelOverlayLayout {
  const padding = Math.max(2, Math.min(30, width * .025, height * .1));
  const contentWidth = Math.max(1, width - padding * 2), contentHeight = Math.max(1, height - padding * 2);
  const body = channelText(item).trim();
  const reference = item.reference?.trim() ?? '';
  const credit = item.id.startsWith('cue_') ? item.subtitle?.trim() ?? '' : '';
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
  const maxSize = Math.max(1, Math.min(requestedSize, contentHeight / 1.24));
  let result: OverlayTextBlock[] = [];
  for (let size = maxSize; ; size = Math.max(1, size - 1)) {
    const blocks: OverlayTextBlock[] = [];
    const add = (text: string, fontSize: number, fontWeight: number, opacity: number) => {
      if (text) blocks.push({ lines: wrap(text, fontSize, fontWeight), fontSize, fontWeight, top: 0, lineHeight: fontSize * 1.24, opacity });
    };
    add(body, size, requestedWeight, 1);
    add(reference, Math.max(1, size * .62), 600, .94);
    add(credit, Math.max(1, size * .4), 400, .68);
    const gap = Math.min(12, size * .22);
    const totalHeight = blocks.reduce((sum, block) => sum + block.lines.length * block.lineHeight, 0) + Math.max(0, blocks.length - 1) * gap;
    result = blocks;
    if (totalHeight <= contentHeight || size <= 1) {
      let top = padding + Math.max(0, (contentHeight - totalHeight) / 2);
      for (const block of blocks) { block.top = top; top += block.lines.length * block.lineHeight + gap; }
      break;
    }
  }
  return { padding, contentWidth, blocks: result };
}
