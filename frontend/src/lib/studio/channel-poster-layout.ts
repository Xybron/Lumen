import type { Item } from '../../types';
import { channelText, layoutChannelOverlay, type ChannelOverlayLayout } from './channel-overlay';

type Measure = (text: string, fontSize: number, fontWeight: number) => number;

// A channel can be reused in several scenes. Keep only a few geometry variants
// per content object, and let discarded channel content be garbage-collected.
export function createChannelPosterLayoutCache(measure: Measure, variantLimit = 16) {
  const cache = new WeakMap<Item, Map<string, ChannelOverlayLayout>>();
  return (item: Item, width: number, height: number, fontSize: number, fontWeight: number) => {
    // Read every text input here so in-place presentation edits invalidate Vue
    // computeds too; object identity alone is insufficient for editable slides.
    const key = JSON.stringify([channelText(item), item.reference ?? '',
      item.id.startsWith('cue_') ? item.subtitle ?? '' : '', width, height, fontSize, fontWeight]);
    let variants = cache.get(item);
    if (!variants) { variants = new Map(); cache.set(item, variants); }
    const existing = variants.get(key);
    if (existing) return existing;
    const layout = layoutChannelOverlay(item, width, height, fontSize, fontWeight, measure);
    if (variants.size >= variantLimit) variants.delete(variants.keys().next().value!);
    variants.set(key, layout);
    return layout;
  };
}

let context: CanvasRenderingContext2D | null = null;
export const channelPosterLayout = createChannelPosterLayoutCache((text, size, weight) => {
  // Detached measurement only. A shared context avoids allocating a canvas
  // for each scene after every Studio document update or audio fader change.
  context ??= document.createElement('canvas').getContext('2d');
  if (!context) return text.length * size * .55;
  context.font = `${weight} ${size}px -apple-system, BlinkMacSystemFont, "Inter", "Segoe UI", sans-serif`;
  return context.measureText(text).width;
});
