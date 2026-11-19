import type { Item } from '@/types';
import { mediaUrl } from './api';
import { createMediaPreloader } from './media-preloader';

const preloader = createMediaPreloader();

export function preload(owner: string, item: Item | undefined): void {
  const kind = item?.background?.kind, url = mediaUrl(item?.background?.src);
  preloader.prepare(owner, url && (kind === 'image' || kind === 'video') ? { kind, url } : undefined);
}
export const releasePreload = preloader.release;
