import { z } from 'zod';

export const BackgroundSchema = z.object({
  kind: z.enum(['image', 'video', 'color', 'gradient']),
  src: z.string().optional(),
  color: z.string().optional(),
  gradient: z.string().optional(),
  fit: z.enum(['cover', 'contain', 'fill']).optional(),
  overlayOpacity: z.number().min(0).max(1).optional(),
});

export const TypographySchema = z.object({
  size: z.enum(['sm', 'md', 'lg', 'xl', '2xl']).optional(),
  align: z.enum(['left', 'center', 'right']).optional(),
  weight: z.number().min(100).max(900).optional(),
});

export const ItemSchema = z.object({
  id: z.string(),
  type: z.enum(['scripture', 'text', 'image', 'video', 'section', 'prayer', 'prayer-sub']),
  title: z.string().optional().default(''),
  body: z.string().optional().default(''),
  reference: z.string().optional().default(''),
  durationMs: z.number().int().nonnegative().default(30000),
  background: BackgroundSchema.optional(),
  typography: TypographySchema.optional(),
  color: z.string().optional(), // for section dividers
});

export const PlaylistSchema = z.object({
  id: z.string(),
  name: z.string(),
  items: z.array(ItemSchema).default([]),
});

export const SettingsSchema = z.object({
  defaultDurationMs: z.number().int().positive().default(30000),
  warningAtMs: z.number().int().nonnegative().default(300000),
  countdownAtMs: z.number().int().nonnegative().default(10000),
  transitionMs: z.number().int().nonnegative().default(600),
  fontFamily: z.string().default('Inter'),
  globalFontScale: z.number().positive().default(1),
});

export const MusicSchema = z.object({
  mode: z.enum(['loop', 'playlist', 'off']).default('off'),
  volume: z.number().min(0).max(1).default(0.6),
  fadeInMs: z.number().int().nonnegative().default(1500),
  fadeOutMs: z.number().int().nonnegative().default(1500),
  current: z.string().optional(),
  queue: z.array(z.string()).default([]),
});

export const ContentSchema = z.object({
  version: z.literal(1),
  updatedAt: z.string(),
  settings: SettingsSchema,
  playlists: z.array(PlaylistSchema).default([]),
  music: MusicSchema,
});

export type Content = z.infer<typeof ContentSchema>;
export type Item = z.infer<typeof ItemSchema>;
export type Playlist = z.infer<typeof PlaylistSchema>;
