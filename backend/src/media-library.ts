import fs from 'node:fs/promises';
import type { Dirent } from 'node:fs';
import path from 'node:path';
import { MEDIA_DIR, MEDIA_KINDS, type MediaKind } from './paths.js';

export interface MediaLibraryFile {
  name: string;
  path: string;
  thumbnail: string | null;
  bytes: number;
  modifiedAt: string;
}

const VISUAL_MEDIA = /\.(png|jpe?g|webp|gif|mp4|webm|mov|m4v)$/i;

function thumbnailName(name: string): string {
  // Matches the existing upload thumbnail convention; do not invent a URL for
  // legacy media, failed conversions, or an unrelated orphaned thumbnail.
  return name.replace(/\.[^.]+$/, '') + '.jpg';
}

/** Listing is read-only: expensive image/video conversion only runs on upload. */
export async function listMediaLibrary(kind: MediaKind, mediaDir = MEDIA_DIR): Promise<MediaLibraryFile[]> {
  if (!MEDIA_KINDS.includes(kind)) throw new Error('bad kind');
  // withFileTypes also avoids exposing nested folders and filesystem symlinks.
  const directory = path.join(mediaDir, kind);
  let files: Dirent[];
  try {
    files = (await fs.readdir(directory, { withFileTypes: true }))
      .filter(entry => entry.isFile() && !entry.name.startsWith('.'));
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return [];
    throw error;
  }

  // The old generator uses stems rather than full filenames. If two originals
  // share a stem, neither can safely claim its thumbnail.
  const stems = new Map<string, number>();
  if (kind === 'backgrounds') {
    for (const file of files) {
      if (!VISUAL_MEDIA.test(file.name)) continue;
      const name = thumbnailName(file.name);
      stems.set(name, (stems.get(name) ?? 0) + 1);
    }
  }

  const result: MediaLibraryFile[] = [];
  // Bound filesystem concurrency for large libraries instead of starting a
  // stat operation for every stored asset at once.
  for (let offset = 0; offset < files.length; offset += 32) {
    const batch = await Promise.all(files.slice(offset, offset + 32).map(async file => {
      let stat;
      try {
        stat = await fs.lstat(path.join(directory, file.name));
        if (!stat.isFile()) return null;
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null;
        throw error;
      }
      let thumbnail: string | null = null;
      const thumbName = thumbnailName(file.name);
      if (kind === 'backgrounds' && VISUAL_MEDIA.test(file.name) && stems.get(thumbName) === 1) {
        try {
          const thumb = await fs.lstat(path.join(mediaDir, 'thumbnails', thumbName));
          if (thumb.isFile() && thumb.size > 0 && thumb.mtimeMs >= stat.mtimeMs) {
            thumbnail = `media/thumbnails/${thumbName}`;
          }
        } catch {
          // Missing/unreadable thumbnails should never hide the actual asset.
        }
      }
      return {
        name: file.name,
        path: `media/${kind}/${file.name}`,
        thumbnail,
        bytes: stat.size,
        modifiedAt: stat.mtime.toISOString(),
      };
    }));
    for (const item of batch) if (item) result.push(item);
  }
  return result.sort((a, b) => a.name.localeCompare(b.name));
}
