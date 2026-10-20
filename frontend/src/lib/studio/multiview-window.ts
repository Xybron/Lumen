export interface MultiviewWindowBox { x: number; y: number; width: number; height: number }

/** Fit operator-only window preferences to the current screen, never offscreen. */
export function fitMultiviewWindow(saved: Partial<MultiviewWindowBox> | null, viewportWidth: number, viewportHeight: number): MultiviewWindowBox {
  const maxWidth = Math.max(1, Math.min(1120, viewportWidth - 24));
  const maxHeight = Math.max(1, viewportHeight - 24);
  const clamp = (value: unknown, fallback: number, min: number, max: number) =>
    Math.max(min, Math.min(typeof value === 'number' && Number.isFinite(value) ? value : fallback, max));
  const width = clamp(saved?.width, 640, Math.min(340, maxWidth), maxWidth);
  const height = clamp(saved?.height, Math.min(640, viewportHeight - 110), Math.min(300, maxHeight), maxHeight);
  return { width, height,
    x: clamp(saved?.x, viewportWidth - width - 24, 12, Math.max(12, viewportWidth - width - 12)),
    y: clamp(saved?.y, 84, 12, Math.max(12, viewportHeight - height - 12)),
  };
}
