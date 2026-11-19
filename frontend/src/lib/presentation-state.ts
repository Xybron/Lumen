import type { Item, ProjectionState } from '../types';

/** State and content arrive independently. An index is only a legacy fallback:
 * after a reorder it can point at a neighbour in the receiver's old manifest. */
export function presentationItem(items: readonly Item[] | undefined, state?: Pick<ProjectionState, 'itemId' | 'index'>): Item | undefined {
  return state?.itemId ? items?.find(item => item.id === state.itemId) : items?.[state?.index ?? 0];
}

export function samePresentationItem(previous: ProjectionState | undefined, incoming: ProjectionState): boolean {
  return !!previous && previous.playlistId === incoming.playlistId && (previous.itemId && incoming.itemId
    ? previous.itemId === incoming.itemId : previous.index === incoming.index);
}
