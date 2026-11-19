import type { Item } from '../types';

/** Resolve generated slides only within the presentation being edited. A
 * detached copy or orphan remains independently editable. */
export function notesRoot(items: readonly Item[], item: Item): Item {
  return item.type === 'notes' && item.notesSourceId
    ? items.find(candidate => candidate.id === item.notesSourceId && candidate.type === 'notes' && !candidate.notesSourceId) ?? item
    : item;
}

export function notesSeries(items: readonly Item[], root: Item): Item[] {
  return [root, ...items.filter(item => item.id !== root.id && item.type === 'notes' && item.notesSourceId === root.id)];
}

/** Construct the next presentation atomically. Never replace an unrelated
 * slide merely because a stale editor supplied its ID. */
export function replaceNotesSeries(items: readonly Item[], rootId: string, updates: readonly Item[]): Item[] {
  const root = items.find(item => item.id === rootId && item.type === 'notes');
  if (!root) throw new Error('This Note was removed. Reopen the presentation before updating.');
  if (!updates.length || updates.length > 100 || updates[0].id !== rootId || updates.some(item => item.type !== 'notes' || !item.body?.trim()))
    throw new Error('Add text to each slide before updating. Use up to 100 slides at a time.');
  const owned = new Set(notesSeries(items, root).map(item => item.id));
  const seen = new Set<string>();
  for (const item of updates) {
    if (seen.has(item.id) || items.some(existing => existing.id === item.id && !owned.has(item.id)))
      throw new Error('The slide list changed. Reopen this Note before updating.');
    seen.add(item.id);
  }
  const replacements = updates.map((item, index) => {
    const next = { ...item, groupId: root.groupId };
    if (index === 0) delete next.notesSourceId;
    else next.notesSourceId = rootId;
    return next;
  });
  const next: Item[] = [];
  for (const item of items) {
    if (item.id === rootId) next.push(...replacements);
    else if (!owned.has(item.id)) next.push(item);
  }
  return next;
}
