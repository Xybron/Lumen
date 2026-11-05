import type { LayerTextPadding, SceneLayer } from '../../../../shared/production';

export type TextPaddingInsets = Pick<LayerTextPadding, 'top' | 'right' | 'bottom' | 'left'>;

/** Insets are in 1920 × 1080 design pixels. Geometry/backgrounds never change. */
export function resolveTextPadding(width: number, height: number, padding: LayerTextPadding | undefined,
  mode: 'text' | 'overlay' = 'text'): TextPaddingInsets {
  const implicit = mode === 'overlay' ? Math.max(2, Math.min(30, width * .025, height * .1)) : 8;
  if (!padding) return mode === 'overlay'
    ? { top: implicit, right: implicit, bottom: implicit, left: implicit }
    : { top: 0, right: implicit, bottom: 0, left: implicit };
  const value = (side: number) => Number.isFinite(side) ? Math.max(0, Math.min(3840, side)) : 0;
  let top = value(padding.top), right = value(padding.right), bottom = value(padding.bottom), left = value(padding.left);
  // Resizing or importing can make previously valid insets larger than the
  // frame. Preserve their ratio while retaining a positive text area.
  const horizontal = Math.max(0, width - 1), vertical = Math.max(0, height - 1);
  if (left + right > horizontal) { const scale = horizontal / (left + right); left *= scale; right *= scale; }
  if (top + bottom > vertical) { const scale = vertical / (top + bottom); top *= scale; bottom *= scale; }
  return { top, right, bottom, left };
}

export function textPaddingForLayer(layer: SceneLayer): TextPaddingInsets {
  return resolveTextPadding(layer.width * 19.2, layer.height * 10.8, layer.textPadding, layer.kind === 'text' ? 'text' : 'overlay');
}

/** Link state is an editing preference, not a visual/layout change. */
export const textPaddingKey = (padding?: LayerTextPadding) => padding
  ? [padding.top, padding.right, padding.bottom, padding.left] : null;
