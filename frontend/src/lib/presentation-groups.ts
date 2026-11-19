import type { Item, Playlist, PresentationGroup } from '@/types';

export type OutlineRow = { key: string; depth: number; group?: PresentationGroup; item?: Item; index?: number };
// Group metadata never becomes an audience slide. Flat items remain the playback
// record, so legacy playlists retain their exact cue order until explicitly edited.
export function presentationOutline(playlist: Playlist): OutlineRow[] {
  const groups = playlist.groups ?? [];
  const byId = new Map(groups.map(group => [group.id, group]));
  const parent = (group: PresentationGroup) => group.parentId && byId.has(group.parentId) ? group.parentId : undefined;
  const visited = new Set<string>();
  const rows: OutlineRow[] = [];
  function walk(parentId: string | undefined, depth: number) {
    const children = groups.filter(group => parent(group) === parentId);
    const direct = playlist.items.filter(item => (byId.has(item.groupId ?? '') ? item.groupId : undefined) === parentId);
    const entries: Array<{ item?: Item; group?: PresentationGroup; at: number }> = direct.map(item => ({ item, at: playlist.items.indexOf(item) }));
    for (const group of children) {
      const descendants = groupDescendants(groups, group.id);
      const first = playlist.items.findIndex(item => !!item.groupId && descendants.has(item.groupId));
      entries.push({ group, at: first < 0 ? Number.MAX_SAFE_INTEGER : first });
    }
    entries.sort((a, b) => a.at - b.at);
    for (const entry of entries) {
      if (entry.item) rows.push({ key: entry.item.id, item: entry.item, index: playlist.items.indexOf(entry.item), depth });
      else if (entry.group && !visited.has(entry.group.id)) {
        visited.add(entry.group.id);
        rows.push({ key: entry.group.id, group: entry.group, depth });
        walk(entry.group.id, depth + 1);
      }
    }
  }
  walk(undefined, 0);
  // Malformed imported group references must never hide audience content.
  for (const item of playlist.items) if (!rows.some(row => row.item?.id === item.id)) rows.push({ key: item.id, item, index: playlist.items.indexOf(item), depth: 0 });
  return rows;
}
export function groupDescendants(groups: PresentationGroup[], id: string): Set<string> {
  const found = new Set([id]);
  for (let pass = 0; pass < groups.length; pass++) for (const group of groups) if (group.parentId && found.has(group.parentId)) found.add(group.id);
  return found;
}
export function orderPresentationGroups(playlist: Playlist) {
  playlist.items = presentationOutline(playlist).flatMap(row => row.item ? [row.item] : []);
}
export function groupOptions(playlist: Playlist) {
  return presentationOutline(playlist).filter(row => row.group).map(row => ({ id: row.group!.id, label: `${'— '.repeat(row.depth)}${row.group!.name}` }));
}
