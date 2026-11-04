import { z } from 'zod';
import type { Song } from '../../shared/worship.js';

const key = z.string().regex(/^[\w-]{1,80}$/);
export const SongSectionSchema = z.object({ id: key, label: z.string().trim().max(80).default(''), text: z.string().trim().min(1).max(4000) });
export const SongSchema = z.object({
  id: key.optional(), revision: z.number().int().nonnegative().default(0), title: z.string().trim().min(1).max(160),
  author: z.string().max(300).default(''), copyright: z.string().max(1500).default(''),
  sections: z.array(SongSectionSchema).min(1).max(100), showSectionLabels: z.boolean().optional(),
}).superRefine((song, ctx) => { if (new Set(song.sections.map(s => s.id)).size !== song.sections.length) ctx.addIssue({ code: 'custom', message: 'Song sections need unique IDs.' }); });

type StoredSong = Omit<Song, 'sections' | 'showSectionLabels'> & { sections: string; showSectionLabels?: number };
export function decodeSong(row: unknown): Song {
  const song = row as StoredSong;
  return { ...song, sections: JSON.parse(song.sections), showSectionLabels: song.showSectionLabels !== 0 };
}
