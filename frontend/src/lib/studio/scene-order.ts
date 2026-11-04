import type { StudioScene } from '../../../../shared/production';

// Target IDs keep a drop meaningful even when the list is filtered. Moving a
// scene never changes the relative order of the other scenes or their contents.
export function reorderScenes(scenes: StudioScene[], id: string, targetId: string, placement: 'before' | 'after'): StudioScene[] {
  const moving = scenes.find(scene => scene.id === id);
  if (!moving || id === targetId || !scenes.some(scene => scene.id === targetId)) return scenes;
  const reordered = scenes.filter(scene => scene.id !== id);
  const target = reordered.findIndex(scene => scene.id === targetId);
  reordered.splice(target + (placement === 'after' ? 1 : 0), 0, moving);
  return reordered.every((scene, index) => scene === scenes[index]) ? scenes : reordered;
}
