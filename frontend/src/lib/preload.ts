import type { Item } from '@/types';
import { mediaUrl } from './api';

// Cache by URL so repeated hits across slides don't refetch. WeakRefs would be
// nicer but Image objects don't get GC'd while referenced; this is fine for the
// 50-100 backgrounds a real service deck contains.
const seen = new Set<string>();

export function preload(item: Item | undefined): void {
  if (!item?.background) return;
  const url = mediaUrl(item.background.src);
  if (!url || seen.has(url)) return;
  seen.add(url);
  if (item.background.kind === 'image') {
    const img = new Image();
    img.src = url;
  } else if (item.background.kind === 'video') {
    const v = document.createElement('video');
    v.preload = 'auto';
    v.src = url;
  }
}
