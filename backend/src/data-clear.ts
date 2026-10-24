import fs from 'node:fs/promises';
import sync from 'node:fs';
import path from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import { z } from 'zod';
import { DataTransfer } from './data-transfer.js';
import { ContentSchema, SettingsSchema, type Content } from './schema.js';
import { ensureChannels } from './migrate-content.js';
import { withContentLock } from './content-writer.js';
import { atomicWriteJson } from './atomic.js';
import { invalidateLyricsSearch } from './lyrics-search.js';
import { ProductionError } from './production-store.js';
import type { WorshipLibrary } from './worship-library.js';
import type { ProductionTransferAdapter, ProductionTransferTransaction } from './production-data-transfer.js';
import type { ClearResult, TransferCatalog, TransferCounts, TransferSelection } from '../../shared/data-transfer.js';
import type { CueSelection, WorshipWorkspace } from '../../shared/worship.js';

const keys = ['bibles','songs','presentations','media','scenes','recordings','setlists','clips'] as const;
const ids = z.array(z.string().min(1).max(240)).max(100000).default([]);
const selectionSchema = z.object({ bibles: ids, songs: ids, presentations: ids, media: ids, scenes: ids, recordings: ids, setlists: ids, clips: ids, settings: z.boolean() }).strict();
function fail(message: string, status = 409): never { throw new ProductionError(status, message); }
export interface ClearPlan {
  selection: TransferSelection; counts: TransferCounts; warnings: string[]; blockers: string[]; fingerprint: string;
}

/** Destructive operations are planned against a snapshot, then backed up and
 * committed under the same locks as imports. Removed files remain recoverable. */
export class DataClear {
  private readonly transfer: DataTransfer;
  constructor(private readonly library: WorshipLibrary, private readonly root: string, private readonly production?: ProductionTransferAdapter) {
    this.transfer = new DataTransfer(library, root, production);
  }
  async catalog(): Promise<TransferCatalog> {
    const catalog = await this.transfer.catalog();
    // Failed/interrupted recordings can be cleared even though they cannot be exported.
    catalog.recordings = catalog.recordings.map(({ blockedReason: _blocked, ...item }) => ({ ...item,
      ...(['starting','recording','stopping','finalizing'].includes(item.detail ?? '') ? { blockedReason: 'Finish this recording before clearing it.' } : {}) }));
    return catalog;
  }
  private async regular(relative: string) {
    let current = this.root;
    for (const part of ['', ...relative.split('/')]) {
      if (part === '..' || part === '.' || part.includes('\\')) fail('Unsafe data path.', 422);
      if (part) current = path.join(current, part);
      try { if ((await fs.lstat(current)).isSymbolicLink()) fail('Data clearing cannot follow symbolic links.', 422); }
      catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
    }
    return current;
  }
  private async content() {
    const file = await this.regular('content.json');
    const raw = await fs.readFile(file);
    return { raw, value: ContentSchema.parse(ensureChannels(JSON.parse(raw.toString('utf8')))) };
  }
  private dbRevision() {
    return JSON.stringify([this.library.db.prepare('SELECT total_changes() AS n').get(), this.library.db.pragma('data_version')]);
  }
  private fingerprint(raw: Buffer, media: string, database = this.dbRevision()) {
    return createHash('sha256').update(raw).update(database).update(media).update(this.production?.revisionKey() ?? '').update(String(this.production?.isLive() ?? false)).digest('hex');
  }
  private async mediaStamp(selection: TransferSelection) {
    return JSON.stringify(await Promise.all(selection.media.map(async id => {
      const stat = await fs.stat(await this.regular(id), { bigint: true });
      return [id, String(stat.ino), String(stat.size), String(stat.mtimeNs)];
    })));
  }
  private removesCue(selection: TransferSelection, cue: CueSelection) {
    return cue.kind === 'lyrics' ? selection.songs.includes(cue.songId) : selection.bibles.includes(cue.versionId);
  }
  private channels(content: Content, selection: TransferSelection) {
    return content.channels.filter(channel => selection.presentations.includes(channel.playlistId)).map(channel => channel.id);
  }
  private touchesOutput(selection: TransferSelection) {
    return selection.settings || ['bibles','songs','presentations','media','scenes','setlists'].some(key => selection[key as typeof keys[number]].length);
  }
  async preview(rawSelection: unknown): Promise<ClearPlan> {
    const parsed = selectionSchema.safeParse(rawSelection);
    if (!parsed.success) fail('Invalid clear selection.', 422);
    const selection = parsed.data;
    if (!selection.settings && !keys.some(key => selection[key].length)) fail('Select something to clear.', 422);
    const catalog = await this.catalog();
    for (const key of keys) {
      if (new Set(selection[key]).size !== selection[key].length || selection[key].some(id => !catalog[key].some(item => item.id === id))) fail('The library changed. Refresh your selection.');
    }
    const { raw, value: content } = await this.content();
    const channels = this.channels(content, selection), warnings: string[] = [], blockers: string[] = [];
    if (this.production?.isLive() && this.touchesOutput(selection)) blockers.push('Stop Studio before clearing content that could affect an output.');
    for (const workspace of this.library.workspaces()) {
      if (!channels.includes(workspace.channelId) && !selection.setlists.includes(workspace.channelId) && workspace.setlist.some(id => selection.songs.includes(id)))
        blockers.push(`Selected songs are used by the retained setlist “${content.channels.find(c => c.id === workspace.channelId)?.name ?? workspace.channelId}”. Select that setlist too.`);
      if (workspace.live && this.removesCue(selection, workspace.live.selection)) warnings.push('Live cues and recent selections that use cleared Bibles or songs will be removed.');
    }
    for (const playlist of content.playlists.filter(p => !selection.presentations.includes(p.id))) {
      if (playlist.items.some(item => item.background?.src && selection.media.includes(item.background.src.replace(/^\//, ''))))
        blockers.push(`Selected media is used by “${playlist.name}”. Select that presentation too.`);
    }
    if (content.music.current && selection.media.includes(content.music.current.replace(/^\//, '')) || content.music.queue.some(id => selection.media.includes(id.replace(/^\//, ''))))
      warnings.push('Selected audio will be removed from the music queue. If it is playing, playback will stop.');
    if (channels.length) warnings.push('The channels belonging to selected presentations and their saved workspaces will also be removed.');
    if (selection.setlists.length) warnings.push('Selected service setlists will be emptied; their songs stay in the library unless selected separately.');
    if (selection.settings) warnings.push('Presentation display and timing preferences will return to their defaults.');
    if (this.production) {
      const plan = await this.production.clearPlan({ ...selection, channels }); warnings.push(...plan.warnings); blockers.push(...plan.blockers);
    }
    const counts = { ...Object.fromEntries(keys.map(key => [key, selection[key].length])), settings: Number(selection.settings) } as TransferCounts;
    return { selection, counts, warnings: [...new Set(warnings)], blockers: [...new Set(blockers)], fingerprint: this.fingerprint(raw, await this.mediaStamp(selection)) };
  }
  async clear(plan: ClearPlan, authorize: () => void = () => {}): Promise<ClearResult & { changedChannels: string[] }> {
    return withContentLock(async () => {
      const current = await this.preview(plan.selection);
      if (current.fingerprint !== plan.fingerprint) fail('Data changed after this review. Review your selection again.');
      if (current.blockers.length) fail(current.blockers.join(' '));
      const { raw, value: content } = await this.content(), selection = current.selection;
      const databaseRevision = this.dbRevision(), stamp = await this.mediaStamp(selection);
      const removedChannels = this.channels(content, selection), changedChannels = new Set(removedChannels);
      const backupRelative = `backups/data-clear/${new Date().toISOString().replace(/[:.]/g, '-')}-${randomUUID()}`;
      const backupPath = await this.regular(backupRelative);
      await fs.mkdir(backupPath, { recursive: true, mode: 0o700 });
      await this.library.db.backup(path.join(backupPath, 'worship.db'));
      const backupFile = await fs.open(path.join(backupPath, 'content.json'), 'wx', 0o600);
      try { await backupFile.writeFile(raw); await backupFile.sync(); } finally { await backupFile.close(); }
      const next = structuredClone(content);
      next.playlists = next.playlists.filter(p => !selection.presentations.includes(p.id));
      next.channels = next.channels.filter(c => !removedChannels.includes(c.id));
      const removedSources = next.sources.filter(source => source.kind === 'channel' && removedChannels.includes(source.ref) || source.kind === 'media' && selection.media.includes(source.ref.replace(/^\//, ''))).map(source => source.id);
      next.sources = next.sources.filter(source => !removedSources.includes(source.id));
      next.routes = next.routes.filter(route => !removedSources.includes(route.sourceId));
      if (next.program.programSourceId && removedSources.includes(next.program.programSourceId)) next.program.programSourceId = null;
      if (next.program.previewSourceId && removedSources.includes(next.program.previewSourceId)) next.program.previewSourceId = null;
      next.music.queue = next.music.queue.filter(id => !selection.media.includes(id.replace(/^\//, '')));
      if (next.music.current && selection.media.includes(next.music.current.replace(/^\//, ''))) { delete next.music.current; next.music.mode = 'off'; }
      if (selection.settings) next.settings = SettingsSchema.parse({});
      next.updatedAt = new Date(Math.max(Date.now(), Date.parse(content.updatedAt) + 1)).toISOString();
      ContentSchema.parse(next);
      const contentFile = path.join(this.root, 'content.json'), stagedContent = path.join(backupPath, '.next-content.json');
      await atomicWriteJson(stagedContent, next);
      const moves = await Promise.all(selection.media.map(async id => {
        const from = await this.regular(id), to = path.join(backupPath, 'removed', id);
        await fs.mkdir(path.dirname(to), { recursive: true }); return { from, to };
      }));
      await atomicWriteJson(path.join(backupPath, 'clear-manifest.json'), { version: 1, selection, createdAt: new Date().toISOString(), media: moves });
      const run = async (tx?: ProductionTransferTransaction) => {
        if (tx) {
          await tx.clearClips(selection.clips); await tx.clearRecordings(selection.recordings); await tx.clearScenes(selection.scenes);
          await tx.removeChannels(removedChannels); await tx.removeMedia(selection.media); await tx.prepare();
        }
        // Online backups and filesystem preparation yield to other library writes.
        // Recheck immediately before the synchronous SQLite/filesystem commit.
        if (databaseRevision !== this.dbRevision() || this.fingerprint(raw, stamp, databaseRevision) !== plan.fingerprint || stamp !== await this.mediaStamp(selection))
          fail('Data changed while preparing the backup. Review your selection again.');
        const applied: typeof moves = []; let contentChanged = false;
        try {
          this.library.db.transaction(() => {
            authorize();
            if (databaseRevision !== this.dbRevision()) fail('The library changed. Review your selection again.');
            if (this.production?.isLive() && this.touchesOutput(selection)) fail('Stop Studio before clearing this content.');
            for (const id of selection.songs) {
              this.library.db.prepare('DELETE FROM songs_fts WHERE id=?').run(id);
              this.library.db.prepare('DELETE FROM song_sections_fts WHERE songId=?').run(id);
              this.library.db.prepare('DELETE FROM songs WHERE id=?').run(id);
            }
            for (const id of selection.bibles) this.library.db.prepare('DELETE FROM bible_versions WHERE id=?').run(id);
            if (selection.bibles.includes('KJV')) this.library.db.prepare("INSERT OR REPLACE INTO worship_preferences(key,value) VALUES('suppress_default_kjv','1')").run();
            for (const workspace of this.library.workspaces()) {
              if (removedChannels.includes(workspace.channelId)) { this.library.db.prepare('DELETE FROM worship_workspaces WHERE channelId=?').run(workspace.channelId); continue; }
              const before = JSON.stringify(workspace);
              if (selection.setlists.includes(workspace.channelId)) workspace.setlist = [];
              workspace.recent = workspace.recent.filter(cue => !this.removesCue(selection, cue));
              if (workspace.live && this.removesCue(selection, workspace.live.selection)) { workspace.live = null; workspace.blanked = false; }
              if (selection.bibles.includes(workspace.versionId)) workspace.versionId = this.library.versions().find(version => version.installed)?.id ?? 'KJV';
              if (JSON.stringify(workspace) !== before) { workspace.revision++; changedChannels.add(workspace.channelId); this.saveWorkspace(workspace); }
            }
            for (const move of moves) { sync.renameSync(move.from, move.to); applied.push(move); }
            sync.renameSync(stagedContent, contentFile); contentChanged = true;
            tx?.commitSync();
          }).immediate();
        } catch (error) {
          tx?.rollbackSync();
          for (const move of applied.reverse()) sync.renameSync(move.to, move.from);
          if (contentChanged) { const restore = `${contentFile}.${randomUUID()}.tmp`; sync.writeFileSync(restore, raw); sync.renameSync(restore, contentFile); }
          throw error;
        }
        invalidateLyricsSearch(this.library.db);
        try { tx?.publish(); } catch { /* Persisted success must not be reported as a failed clear. */ }
        return { removed: current.counts, backupPath, warnings: current.warnings, changedChannels: [...changedChannels] };
      };
      return this.production ? this.production.transaction(backupPath, run) : run();
    });
  }
  private saveWorkspace(workspace: WorshipWorkspace) {
    this.library.db.prepare('INSERT OR REPLACE INTO worship_workspaces(channelId,state) VALUES(?,?)').run(workspace.channelId, JSON.stringify(workspace));
  }
}
