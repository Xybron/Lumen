import type { SceneLayer } from '../../../../shared/production';
import { layerPreset, type LayerPreset } from './layer-layout';

/** Full screen keeps the note's saved slide design; compact placements use
 * the scene layer's typography/background and leave the rest of the scene clear. */
export function notesLayerPreset(layer: SceneLayer, preset: LayerPreset): Partial<SceneLayer> {
  if (preset === 'full') return { ...layerPreset(layer, preset), channelStyle: 'slide' };
  if (preset === 'lower-third' || preset === 'upper-third') return {
    x: 5, y: preset === 'lower-third' ? 68 : 6, width: 90, height: 26, channelStyle: 'overlay',
  };
  return layerPreset(layer, preset);
}

export function notesLayerPlacement(layer: SceneLayer): 'full' | 'bottom' | 'top' | null {
  if (layer.channelStyle !== 'overlay' && layer.x === 0 && layer.y === 0 && layer.width === 100 && layer.height === 100) return 'full';
  if (layer.channelStyle !== 'overlay' || layer.x !== 5 || layer.width !== 90 || layer.height !== 26) return null;
  return layer.y === 68 ? 'bottom' : layer.y === 6 ? 'top' : null;
}
