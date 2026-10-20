import type { SceneLayer } from '../../../../shared/production';

export const CANVAS_WIDTH = 1920;
export const CANVAS_HEIGHT = 1080;
export type LayerAlignment = 'left' | 'center' | 'right' | 'top' | 'middle' | 'bottom';
export type LayerPreset = 'center' | 'full' | 'lower-third' | 'upper-third';
export type LayerArrangeAction = 'forward' | 'backward' | 'front' | 'back';
export type LayerGeometry = Pick<SceneLayer, 'x' | 'y' | 'width' | 'height'>;

const clamp = (value: number, min: number, max: number) => Math.min(max, Math.max(min, value));
const precise = (value: number) => Math.round(value * 1_000_000) / 1_000_000;

export function layerAlignment(layer: LayerGeometry, alignment: LayerAlignment): Partial<LayerGeometry> {
  switch (alignment) {
    case 'left': return { x: 0 };
    case 'center': return { x: precise((100 - layer.width) / 2) };
    case 'right': return { x: precise(100 - layer.width) };
    case 'top': return { y: 0 };
    case 'middle': return { y: precise((100 - layer.height) / 2) };
    case 'bottom': return { y: precise(100 - layer.height) };
  }
}

export function layerPreset(layer: LayerGeometry, preset: LayerPreset): LayerGeometry {
  if (preset === 'full') return { x: 0, y: 0, width: 100, height: 100 };
  if (preset === 'lower-third') return { x: 5, y: 78, width: 90, height: 16 };
  if (preset === 'upper-third') return { x: 5, y: 6, width: 90, height: 16 };
  return { x: precise((100 - layer.width) / 2), y: precise((100 - layer.height) / 2), width: layer.width, height: layer.height };
}

/** Storage is back-to-front; placement is expressed in the visible, top-down list. */
export function reorderLayers(layers: SceneLayer[], id: string, targetId: string, placement: 'before' | 'after'): SceneLayer[] {
  const moving = layers.find(layer => layer.id === id);
  if (!moving || moving.locked || id === targetId || !layers.some(layer => layer.id === targetId)) return layers;
  const visual = [...layers].reverse().filter(layer => layer.id !== id);
  const target = visual.findIndex(layer => layer.id === targetId);
  visual.splice(target + (placement === 'after' ? 1 : 0), 0, moving);
  return visual.reverse();
}

export function arrangeLayers(layers: SceneLayer[], id: string, action: LayerArrangeAction): SceneLayer[] {
  const from = layers.findIndex(layer => layer.id === id);
  if (from < 0 || layers[from].locked) return layers;
  const to = action === 'front' ? layers.length - 1 : action === 'back' ? 0 : clamp(from + (action === 'forward' ? 1 : -1), 0, layers.length - 1);
  if (from === to) return layers;
  const next = [...layers];
  const [layer] = next.splice(from, 1);
  next.splice(to, 0, layer);
  return next;
}

export function nudgeLayerGeometry(layer: LayerGeometry, dx: number, dy: number): Partial<LayerGeometry> {
  return {
    x: precise(clamp(layer.x + dx / CANVAS_WIDTH * 100, -100, 100)),
    y: precise(clamp(layer.y + dy / CANVAS_HEIGHT * 100, -100, 100)),
  };
}

export function layerGeometryValue(value: number, axis: 'x' | 'y' | 'width' | 'height', unit: 'px' | '%'): number {
  return unit === '%' ? value : value * (axis === 'x' || axis === 'width' ? CANVAS_WIDTH : CANVAS_HEIGHT) / 100;
}

export function layerGeometryInput(value: number, axis: 'x' | 'y' | 'width' | 'height', unit: 'px' | '%'): number | null {
  if (!Number.isFinite(value)) return null;
  const percent = unit === '%' ? value : value / (axis === 'x' || axis === 'width' ? CANVAS_WIDTH : CANVAS_HEIGHT) * 100;
  return precise(clamp(percent, axis === 'x' || axis === 'y' ? -100 : 1, axis === 'x' || axis === 'y' ? 100 : 200));
}
