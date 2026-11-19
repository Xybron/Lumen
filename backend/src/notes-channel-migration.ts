import fs from 'node:fs/promises';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { atomicWriteJson } from './atomic.js';
import { withContentLock } from './content-writer.js';
import { ensureChannels } from './migrate-content.js';
import { ContentSchema, type Content } from './schema.js';

interface NotesChannelUpgrade {
  content: Content;
  promoted: string[];
  created: string | null;
}

async function preserveOriginal(backup: string, original: string) {
  const temporary = `${backup}.${randomUUID()}.tmp`;
  try {
    const handle = await fs.open(temporary, 'wx', 0o600);
    try { await handle.writeFile(original); await handle.sync(); } finally { await handle.close(); }
    // Linking publishes the complete file atomically and refuses to overwrite
    // the original snapshot on a retry after an interrupted startup.
    try { await fs.link(temporary, backup); }
    catch (error) { if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error; }
  } finally { await fs.rm(temporary, { force: true }); }
}

/** Keep the channel/item keys used by private drafts, transcripts, grants and
 * Studio sources. Mixed presentations retain their original channel and slides. */
export function notesChannelUpgrade(content: Content): NotesChannelUpgrade {
  const next = structuredClone(content), promoted: string[] = [];
  for (const channel of next.channels) {
    if (!['presentation', 'announcement', 'prayer'].includes(channel.kind)) continue;
    const items = next.playlists.find(playlist => playlist.id === channel.playlistId)?.items.filter(item => item.type !== 'section');
    if (items?.length && items.every(item => item.type === 'notes')) {
      channel.kind = 'notes';
      promoted.push(channel.id);
    }
  }
  let created: string | null = null;
  if (!next.channels.some(channel => channel.kind === 'notes')) {
    const occupied = new Set([
      ...next.channels.map(channel => channel.id), ...next.playlists.map(playlist => playlist.id),
      ...next.sources.map(source => source.id), ...next.destinations.map(destination => destination.id),
      ...next.routes.map(route => route.id), ...next.playlists.flatMap(playlist => playlist.items.map(item => item.id)),
    ]);
    const available = (base: string) => {
      let candidate = base, suffix = 2;
      while (occupied.has(candidate)) candidate = `${base}_${suffix++}`;
      occupied.add(candidate);
      return candidate;
    };
    const playlistId = available('plst_notes'), channelId = available('chnl_notes');
    next.playlists.push({ id: playlistId, name: 'Notes', items: [] });
    next.channels.push({ id: channelId, name: 'Notes', kind: 'notes', playlistId, defaultMode: 'manual' });
    next.sources.push({ id: available(`src_${channelId}`), kind: 'channel', ref: channelId });
    created = channelId;
  }
  return { content: next, promoted, created };
}

/** Run once while holding the station startup lease, before serving content.
 * The station-local marker deliberately survives channel deletion: normal
 * reads/saves must never resurrect a channel the operator removed. */
export async function migrateNotesChannel(root: string): Promise<{ promoted: string[]; created: string | null; skipped: boolean }> {
  return withContentLock(async () => {
    const migrations = path.join(root, 'migrations');
    const marker = path.join(migrations, 'notes-channel-v1.json');
    try {
      const completed = JSON.parse(await fs.readFile(marker, 'utf8'));
      if (completed.version !== 1) throw new Error('The Notes channel migration record is invalid.');
      return { promoted: [], created: null, skipped: true };
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
    }
    const file = path.join(root, 'content.json');
    let original: string | undefined;
    try { original = await fs.readFile(file, 'utf8'); }
    catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
    const raw = original === undefined ? { version: 2, updatedAt: new Date().toISOString(), settings: {}, playlists: [], music: {} } : JSON.parse(original);
    const normalized = original === undefined ? ContentSchema.parse(ensureChannels(raw)) : ensureChannels(raw);
    const validated = ContentSchema.parse(normalized);
    const upgrade = notesChannelUpgrade(validated);
    const changed = original === undefined || upgrade.promoted.length > 0 || upgrade.created !== null;
    await fs.mkdir(migrations, { recursive: true });
    if (changed) {
      // Store an exact rollback copy once. If startup stops after the content
      // commit, a retry sees already-promoted IDs and finishes the marker.
      if (original !== undefined) {
        const backup = path.join(migrations, 'notes-channel-v1.before.json');
        await preserveOriginal(backup, original);
      }
      const promoted = new Set(upgrade.promoted);
      // Retain unknown content metadata and each original item verbatim. The
      // schema validates the result; it is not used to strip existing fields.
      const next = {
        ...normalized,
        channels: normalized.channels.map((channel: Content['channels'][number]) => promoted.has(channel.id) ? { ...channel, kind: 'notes' } : channel),
        playlists: [...normalized.playlists], sources: [...normalized.sources],
        updatedAt: new Date(Math.max(Date.now(), (Date.parse(validated.updatedAt) || 0) + 1)).toISOString(),
      };
      if (upgrade.created) {
        const channel = upgrade.content.channels.find(value => value.id === upgrade.created)!;
        next.channels.push(channel);
        next.playlists.push(upgrade.content.playlists.find(value => value.id === channel.playlistId)!);
        next.sources.push(upgrade.content.sources.find(value => value.kind === 'channel' && value.ref === channel.id)!);
      }
      ContentSchema.parse(next);
      await atomicWriteJson(file, next);
    }
    await atomicWriteJson(marker, { version: 1, completedAt: new Date().toISOString(), promoted: upgrade.promoted, created: upgrade.created });
    return { promoted: upgrade.promoted, created: upgrade.created, skipped: false };
  });
}
