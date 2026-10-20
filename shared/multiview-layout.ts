/** One private, video-only atlas shared by all operator Multiview surfaces. */
export const MULTIVIEW_OUTPUT_ID = 'multiview';
export const MULTIVIEW_COLUMNS = 2;
export const MULTIVIEW_TILE_WIDTH = 320;
export const MULTIVIEW_TILE_HEIGHT = 180;

/** Empty slots keep the last row balanced; scenes themselves are never added. */
export function multiviewSlots<T>(scenes: readonly T[]): (T | null)[] {
  const slots: (T | null)[] = [...scenes];
  while (slots.length < 2 || slots.length % MULTIVIEW_COLUMNS) slots.push(null);
  return slots;
}

export function multiviewCanvasSize(sceneCount: number): { width: number; height: number } {
  const count = Number.isFinite(sceneCount) ? Math.max(0, Math.floor(sceneCount)) : 0;
  const rows = Math.max(1, Math.ceil(count / MULTIVIEW_COLUMNS));
  return { width: MULTIVIEW_COLUMNS * MULTIVIEW_TILE_WIDTH, height: rows * MULTIVIEW_TILE_HEIGHT };
}
