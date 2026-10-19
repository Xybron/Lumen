import type { MediaLibraryFile } from '@/lib/api';

export type MediaAssetKind = 'image' | 'video' | 'audio';
export const mediaExtensions: Record<MediaAssetKind, RegExp> = {
  image: /\.(png|jpe?g|webp|gif)$/i,
  video: /\.(mp4|webm|mov|m4v)$/i,
  audio: /\.(mp3|m4a|wav|aac|ogg|flac)$/i,
};
export const mediaAccept: Record<MediaAssetKind, string> = {
  image: '.png,.jpg,.jpeg,.webp,.gif',
  video: '.mp4,.webm,.mov,.m4v',
  audio: '.mp3,.m4a,.wav,.aac,.ogg,.flac',
};
export const mediaFormatHint: Record<MediaAssetKind, string> = {
  image: 'PNG, JPG, WebP or GIF',
  video: 'MP4, WebM, MOV or M4V',
  audio: 'MP3, M4A, WAV, AAC, OGG or FLAC',
};
export const MAX_MEDIA_BYTES = 200 * 1024 * 1024;

export function mediaDisplayName(name: string): string {
  return name.replace(/^\d{13}-/, '');
}
export function mediaSourceName(name: string): string {
  return mediaDisplayName(name).replace(/\.[^.]+$/, '').slice(0, 100);
}
export function mediaAssetUrl(relative: string): string {
  // These are station library paths, never remote/HTML URLs. Encode each
  // filename segment so legacy #, %, ?, and spaces remain literal filenames.
  return `/${relative.replace(/^\/+/, '').split('/').map(segment => encodeURIComponent(segment)).join('/')}`;
}
export function mediaFileSize(bytes: number | undefined): string {
  if (bytes === undefined || !Number.isFinite(bytes) || bytes < 0) return '';
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${Math.round(bytes / 1024)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}
export function mediaFilesForKind(files: MediaLibraryFile[], kind: MediaAssetKind, query = ''): MediaLibraryFile[] {
  const search = query.trim().toLocaleLowerCase();
  return files.filter(file => mediaExtensions[kind].test(file.name) && (!search || mediaDisplayName(file.name).toLocaleLowerCase().includes(search)))
    .sort((a, b) => (Date.parse(b.modifiedAt ?? '') || 0) - (Date.parse(a.modifiedAt ?? '') || 0) || a.name.localeCompare(b.name));
}
