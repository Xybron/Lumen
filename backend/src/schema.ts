import { z } from 'zod';

export const BackgroundSchema = z.object({
  kind: z.enum(['image', 'video', 'color', 'gradient']),
  src: z.string().optional(),
  color: z.string().optional(),
  gradient: z.string().optional(),
  fit: z.enum(['cover', 'contain', 'fill']).optional(),
  overlayOpacity: z.number().min(0).max(1).optional(),
  loop: z.boolean().optional(),
  muted: z.boolean().optional(),
  volume: z.number().min(0).max(1).optional(),
});

export const TypographySchema = z.object({
  size: z.enum(['sm', 'md', 'lg', 'xl', '2xl']).optional(),
  align: z.enum(['left', 'center', 'right']).optional(),
  weight: z.number().min(100).max(900).optional(),
});

export const StanzaSchema = z.object({
  id: z.string(),
  label: z.string().optional().default(''),
  lines: z.string().optional().default(''),
});

export const ItemSchema = z.object({
  id: z.string(),
  type: z.enum([
    'scripture',
    'text',
    'image',
    'video',
    'section',
    'prayer',
    'prayer-sub',
    'notes',
    'lyrics',
    'announcement',
  ]),
  title: z.string().optional().default(''),
  body: z.string().optional().default(''),
  reference: z.string().optional().default(''),
  durationMs: z.number().int().nonnegative().default(30000),
  background: BackgroundSchema.optional(),
  typography: TypographySchema.optional(),
  color: z.string().optional(), // for section dividers
  stanzas: z.array(StanzaSchema).optional(), // lyrics
  subtitle: z.string().optional().default(''), // announcement
  layout: z.enum(['general', 'statement', 'quote', 'key-points']).optional(),
  groupId: z.string().optional(),
  // Generated Notes slides keep their source identity for subsequent updates.
  notesSourceId: z.string().regex(/^[\w-]{1,160}$/).optional(),
  document: z.object({ type: z.enum(['pdf', 'powerpoint']), sourceName: z.string(), page: z.number().int().positive(), totalPages: z.number().int().positive() }).optional(),
});

export const PlaylistSchema = z.object({
  id: z.string(),
  name: z.string(),
  items: z.array(ItemSchema).default([]),
  groups: z.array(z.object({ id: z.string(), name: z.string().trim().min(1).max(100), parentId: z.string().optional() })).optional(),
}).superRefine(validatePlaylistGroups);

export function validatePlaylistGroups(playlist: {groups?: Array<{id:string;parentId?:string}>;items:Array<{groupId?:string}>}, context: z.RefinementCtx) {
  const groups = new Map((playlist.groups ?? []).map(group => [group.id, group]));
  const issue = (message: string) => context.addIssue({ code: z.ZodIssueCode.custom, message, path: ['groups'] });
  if (groups.size !== (playlist.groups?.length ?? 0)) issue('Group IDs must be unique.');
  for (const group of groups.values()) {
    const seen = new Set([group.id]);
    let parent = group.parentId;
    while (parent) {
      if (!groups.has(parent)) { issue('A parent group no longer exists.'); break; }
      if (seen.has(parent)) { issue('A group cannot be nested inside itself.'); break; }
      seen.add(parent); parent = groups.get(parent)?.parentId;
    }
  }
  if (playlist.items.some(item => item.groupId && !groups.has(item.groupId))) issue('A slide refers to a missing group.');
}

export const PresentationGraphicsSchema = z.object({
  template: z.enum(['flame', 'minimal', 'broadcast', 'segments', 'ember']),
  progress: z.boolean(), timer: z.boolean(), countdown: z.boolean(), warning: z.boolean(),
  timerMode: z.enum(['elapsed', 'remaining']), position: z.enum(['top', 'bottom']),
  size: z.enum(['small', 'medium', 'large']), color: z.string().regex(/^#[0-9a-fA-F]{6}$/),
  caption: z.boolean().optional(),
  thickness: z.number().min(2).max(24).optional(),
  tip: z.enum(['glow', 'plain', 'icon', 'none']).optional(),
  tipIcon: z.enum(['flame', 'star', 'cross', 'diamond', 'heart']).optional(),
  colorMode: z.enum(['original', 'solid', 'gradient']).optional(),
  gradientColors: z.array(z.string().regex(/^#[0-9a-fA-F]{6}$/)).min(2).max(7).optional(),
});

export const ChannelSchema = z.object({
  id: z.string(),
  name: z.string(),
  kind: z.enum(['presentation', 'prayer', 'lyrics', 'scripture', 'announcement', 'notes']).default('presentation'),
  playlistId: z.string(),
  defaultMode: z.enum(['auto', 'manual']).optional(),
  presentationGraphics: PresentationGraphicsSchema.optional(),
  presentationGraphicPresets: z.array(z.object({ name: z.string().trim().min(1).max(48), graphics: PresentationGraphicsSchema })).max(20).optional(),
});

// Routing-matrix seam.
export const SourceSchema = z.object({
  id: z.string(),
  kind: z.enum(['channel', 'music', 'media', 'webrtc', 'capture']),
  ref: z.string(),
  label: z.string().optional(),
  capture: z
    .object({
      agentId: z.string(),
      inputId: z.string(),
      transport: z.enum(['ndi', 'srt', 'rtmp']),
      signal: z.enum(['sdi', 'hdmi', 'ndi', 'test', 'file']),
      label: z.string().optional(),
    })
    .optional(),
});

export const DestinationSchema = z.object({
  id: z.string(),
  kind: z.enum(['screen', 'stream', 'preview']),
  label: z.string(),
  platform: z.enum(['youtube', 'facebook', 'custom']).optional(),
  enabled: z.boolean().optional(),
});

export const RouteSchema = z.object({
  id: z.string(),
  sourceId: z.string(),
  destinationId: z.string(),
  via: z.enum(['program', 'preview', 'direct']).optional(),
});

export const ProgramSchema = z.object({
  programSourceId: z.string().nullable().default(null),
  previewSourceId: z.string().nullable().default(null),
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
  // Accept both during the transition: legacy on-disk files (and the 10 rolling
  // backups) are v1; ensureChannels() normalizes reads to v2.
  version: z.union([z.literal(1), z.literal(2)]),
  updatedAt: z.string(),
  settings: SettingsSchema,
  playlists: z.array(PlaylistSchema).default([]),
  music: MusicSchema,
  channels: z.array(ChannelSchema).default([]),
  sources: z.array(SourceSchema).default([]),
  destinations: z.array(DestinationSchema).default([]),
  routes: z.array(RouteSchema).default([]),
  program: ProgramSchema.default({ programSourceId: null, previewSourceId: null }),
});

export type Content = z.infer<typeof ContentSchema>;
export type Item = z.infer<typeof ItemSchema>;
export type Playlist = z.infer<typeof PlaylistSchema>;
export type Channel = z.infer<typeof ChannelSchema>;
