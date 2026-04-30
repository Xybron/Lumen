import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

export const ROOT = path.resolve(__dirname, '..', '..');
export const DATA_DIR = process.env.LUMEN_DATA_DIR
  ? path.resolve(process.env.LUMEN_DATA_DIR)
  : path.join(ROOT, 'data');

export const MEDIA_DIR = path.join(DATA_DIR, 'media');
export const BACKUPS_DIR = path.join(DATA_DIR, 'backups');
export const CONTENT_FILE = path.join(DATA_DIR, 'content.json');
export const FRONTEND_DIST = path.join(ROOT, 'frontend', 'dist');

export const MEDIA_KINDS = ['backgrounds', 'music', 'thumbnails'] as const;
export type MediaKind = (typeof MEDIA_KINDS)[number];

// Resolve a user-supplied relative path inside DATA_DIR. Returns null on traversal.
export function safeMediaPath(kind: MediaKind, filename: string): string | null {
  if (!filename || filename.includes('..') || path.isAbsolute(filename)) return null;
  const target = path.resolve(MEDIA_DIR, kind, filename);
  const expected = path.resolve(MEDIA_DIR, kind);
  if (!target.startsWith(expected + path.sep) && target !== expected) return null;
  return target;
}
