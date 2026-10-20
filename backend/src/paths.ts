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

// Staging area for phone/contributor uploads. Deliberately NOT in MEDIA_KINDS so
// it isn't publicly listable/servable via /media — pending files are only
// reachable through the authenticated /api/staging endpoints until approved.
export const INCOMING_DIR = path.join(MEDIA_DIR, 'incoming');

// Resolve a user-supplied relative path inside DATA_DIR. Returns null on traversal.
export function safeMediaPath(kind: MediaKind, filename: string): string | null {
  if (!filename || filename.includes('..') || path.isAbsolute(filename)) return null;
  const target = path.resolve(MEDIA_DIR, kind, filename);
  const expected = path.resolve(MEDIA_DIR, kind);
  if (!target.startsWith(expected + path.sep) && target !== expected) return null;
  return target;
}

// Traversal-safe resolution of a filename inside the incoming/ staging dir.
export function safeIncomingPath(filename: string): string | null {
  if (!filename || filename.includes('..') || path.isAbsolute(filename)) return null;
  const target = path.resolve(INCOMING_DIR, filename);
  if (!target.startsWith(INCOMING_DIR + path.sep)) return null;
  return target;
}
