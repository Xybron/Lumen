import { MULTIVIEW_COLUMNS, MULTIVIEW_TILE_HEIGHT, MULTIVIEW_TILE_WIDTH } from '../../../../shared/multiview-layout';

/** Display geometry only: the transmitted atlas always remains two columns. */
export function multiviewDisplaySize(sceneCount: number, columns: number) {
  const count = Number.isFinite(sceneCount) ? Math.max(0, Math.floor(sceneCount)) : 0;
  const slotCount = Math.max(2, Math.ceil(count / MULTIVIEW_COLUMNS) * MULTIVIEW_COLUMNS);
  const displayColumns = columns === 4 ? 4 : MULTIVIEW_COLUMNS;
  const rows = Math.ceil(slotCount / displayColumns);
  return { columns: displayColumns, rows, slotCount,
    width: displayColumns * MULTIVIEW_TILE_WIDTH, height: rows * MULTIVIEW_TILE_HEIGHT };
}

/** Row-major crops preserve paired empty slots without inventing new scenes. */
export function multiviewAtlasCells(sceneCount: number, columns: number) {
  const layout = multiviewDisplaySize(sceneCount, columns);
  return Array.from({ length: layout.slotCount }, (_, index) => ({
    sourceX: index % MULTIVIEW_COLUMNS * MULTIVIEW_TILE_WIDTH,
    sourceY: Math.floor(index / MULTIVIEW_COLUMNS) * MULTIVIEW_TILE_HEIGHT,
    targetX: index % layout.columns * MULTIVIEW_TILE_WIDTH,
    targetY: Math.floor(index / layout.columns) * MULTIVIEW_TILE_HEIGHT,
    width: MULTIVIEW_TILE_WIDTH, height: MULTIVIEW_TILE_HEIGHT,
  }));
}
