import type { MediaLibraryAsset, MediaUsage } from '../../../shared/media-library';
import { mediaExtensions } from '@/lib/studio/media-library';

export type { MediaLibraryAsset, MediaUsage } from '../../../shared/media-library';
export interface MediaLibraryResponse { assets: MediaLibraryAsset[]; warning?: string }
export interface MediaDeleteResult { deleted: string[]; blocked: { id: string; error: string; usage: MediaUsage[] }[] }
export type MediaLibraryKind = 'image' | 'video' | 'audio';

async function request<T>(path: string, options: RequestInit = {}): Promise<T> {
  const response = await fetch(`/api/media-library${path}`, { credentials: 'include', ...options });
  if (!response.ok) {
    let detail = '';
    try {
      const body = await response.json();
      if (typeof body.error === 'string' && body.error.length <= 400 && !/[<>\r\n]/.test(body.error)) detail = body.error;
    } catch { /* Keep proxy/error HTML out of user-facing messages. */ }
    throw new Error(detail || (response.status === 401 ? 'Your session has expired. Sign in to manage media.'
      : response.status === 403 ? 'You need author access to manage this media library.'
        : 'The media library could not be updated. Please try again.'));
  }
  return response.json() as Promise<T>;
}

export const mediaLibraryApi = {
  list: (signal?: AbortSignal) => request<MediaLibraryResponse>('', { signal }),
  rename: (id: string, displayName: string) => request<MediaLibraryAsset>(`/${encodeURIComponent(id)}`, {
    method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ displayName }),
  }),
  async remove(ids: string[]): Promise<MediaDeleteResult> {
    const unique = [...new Set(ids)], result: MediaDeleteResult = { deleted: [], blocked: [] };
    for (let offset = 0; offset < unique.length; offset += 200) {
      try {
        const batch = await request<MediaDeleteResult>('/delete', {
          method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ ids: unique.slice(offset, offset + 200) }),
        });
        result.deleted.push(...batch.deleted); result.blocked.push(...batch.blocked);
      } catch (cause) {
        if (result.deleted.length) throw new Error(`${result.deleted.length} files were deleted before the remaining cleanup stopped. ${(cause as Error).message}`);
        throw cause;
      }
    }
    return result;
  },
};

export function mediaImageName(asset: MediaLibraryAsset): string { return asset.displayName || asset.name.replace(/^\d{13}-/, ''); }
export function mediaImageFormat(asset: MediaLibraryAsset): string { return asset.name.split('.').pop()?.toUpperCase() || mediaAssetKind(asset).toUpperCase(); }
export function mediaAssetKind(asset: MediaLibraryAsset): MediaLibraryKind { return asset.kind || (mediaExtensions.video.test(asset.name) ? 'video' : mediaExtensions.audio.test(asset.name) ? 'audio' : 'image'); }
export function mediaKindLabel(kind: MediaLibraryKind, plural = false): string { return kind === 'image' ? plural ? 'images' : 'image' : kind === 'video' ? plural ? 'videos' : 'video' : plural ? 'audio files' : 'audio file'; }
export function mediaDuration(value: number | undefined): string {
  if (value === undefined || !Number.isFinite(value) || value < 0) return '';
  const seconds = Math.floor(value / 1000), hours = Math.floor(seconds / 3600), minutes = Math.floor(seconds / 60) % 60;
  return hours ? `${hours}:${String(minutes).padStart(2, '0')}:${String(seconds % 60).padStart(2, '0')}` : `${minutes}:${String(seconds % 60).padStart(2, '0')}`;
}
/** Stored source references stay raw; encoded URLs belong only in browser media elements. */
export function mediaAssetReference(asset: MediaLibraryAsset, playable = false): string {
  if (playable && asset.playbackPath) return asset.playbackPath;
  return asset.libraryPath || `media/${asset.id.startsWith('music:') ? 'music' : 'backgrounds'}/${asset.name}`;
}
export function mediaUsageLabel(usage: MediaUsage): string {
  return ({ source: 'Studio source', presentation: 'Presentation', background: 'Scene background', program: 'Program', output: 'Output', routing: 'Source routing', clip: 'Clip project', export: 'Clip export', music: 'Music' } as Record<string, string>)[usage.type] || 'Saved content';
}

export function mediaLibraryReturnUrl(assetId: string): string { return `/media?asset=${encodeURIComponent(assetId)}`; }
export function mediaUsageUrl(usage: MediaUsage, assetId: string): string {
  // Usage navigation stays within the station and never issues a playback or Take command.
  if (!usage.href || !usage.href.startsWith('/') || usage.href.startsWith('//')) return '/media';
  const target = new URL(usage.href, window.location.origin);
  target.searchParams.set('returnTo', mediaLibraryReturnUrl(assetId));
  return `${target.pathname}${target.search}${target.hash}`;
}
