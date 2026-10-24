import fs from 'node:fs/promises';
import sync from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { createHash, randomUUID } from 'node:crypto';
import { gzipSync, gunzipSync } from 'node:zlib';
import { z } from 'zod';
import { BibleImportSchema, SongSchema, WorshipLibrary } from './worship-library.js';
import { BackgroundSchema, ChannelSchema, ContentSchema, ItemSchema, PlaylistSchema, SettingsSchema, type Content } from './schema.js';
import { ensureChannels } from './migrate-content.js';
import { withContentLock } from './content-writer.js';
import { invalidateLyricsSearch } from './lyrics-search.js';
import { ProductionError } from './production-store.js';
import { MAX_ARCHIVE_BYTES, writeArchiveFile, readArchiveFile, isV2Archive, copyAssetFile, verifyAssetFile, type ArchiveAsset, type ArchiveManifest, type ArchiveSource } from './data-transfer-codec.js';
import { PortableStudioSchema, PortableRecordingSchema, PortableClipsSchema, selectPortableStudio, selectPortableClips, portableStudioDependencies, portableClipsDependencies, portableClipFiles, type ProductionTransferAdapter, type ProductionTransferTransaction } from './production-data-transfer.js';
import type { TransferCatalog, TransferCounts, TransferResult, TransferSelection } from '../../shared/data-transfer.js';

export const MAX_TRANSFER_COMPRESSED_BYTES = 128 * 1024 * 1024;
export const MAX_TRANSFER_DECOMPRESSED_BYTES = 256 * 1024 * 1024;
const MAX_ASSET_BYTES = 128 * 1024 * 1024;
const entityId = z.string().regex(/^[\w-]{1,80}$/);
const idList = z.array(entityId).max(100_000);
const mediaId = z.string().max(240).refine(isMediaId, 'Unsupported or unsafe media path.');
const SelectionSchema = z.object({ bibles: idList, songs: idList, presentations: idList, media: z.array(mediaId).max(10_000), scenes: idList.default([]), recordings: idList.default([]), setlists: idList.default([]), clips: idList.default([]), settings: z.boolean() }).strict();
const background = BackgroundSchema.extend({ src: z.string().max(2048).refine(isMediaReference, 'Unsafe media reference.').optional(), color: z.string().max(100).optional(), gradient: z.string().max(1000).optional() }).strict();
const item = ItemSchema.extend({
  id: entityId, title: z.string().max(1000).default(''), body: z.string().max(100_000).default(''), reference: z.string().max(1000).default(''), subtitle: z.string().max(1000).default(''),
  background: background.optional(), color: z.string().max(100).optional(),
  stanzas: z.array(z.object({ id: entityId, label: z.string().max(1000).default(''), lines: z.string().max(100_000).default('') }).strict()).max(1000).optional(),
}).strict();
const playlist = PlaylistSchema.extend({ id: entityId, name: z.string().trim().min(1).max(300), items: z.array(item).max(10_000) }).strict();
const channel = ChannelSchema.extend({ id: entityId, playlistId: entityId, name: z.string().trim().min(1).max(300) }).strict();
const settings = SettingsSchema.extend({ fontFamily: z.string().max(300), globalFontScale: z.number().positive().max(20) }).strict();
const song = z.object({ id: entityId, title: z.string().trim().min(1).max(160), author: z.string().max(300), copyright: z.string().max(1500), sections: z.array(z.object({ id: entityId, label: z.string().trim().min(1).max(80), text: z.string().trim().min(1).max(4000) }).strict()).min(1).max(100) }).strict();
const bible = BibleImportSchema.omit({ replace: true }).extend({ version: BibleImportSchema.shape.version.strict() }).strict();
const asset = z.object({ id: mediaId, bytes: z.number().int().nonnegative().max(MAX_ARCHIVE_BYTES), sha256: z.string().regex(/^[a-f0-9]{64}$/), data: z.string().max(Math.ceil(MAX_ASSET_BYTES / 3) * 4).optional() }).strict();
const theme = z.object({ background: z.string().regex(/^#[a-f\d]{6}$/i), color: z.string().regex(/^#[a-f\d]{6}$/i), size: z.enum(['sm','md','lg','xl','2xl']), align: z.enum(['left','center','right']) }).strict();
const portableSetlist = z.object({ id: entityId, versionId: entityId, songIds: z.array(entityId).max(100), theme }).strict();
const PayloadSchema = z.object({
  bibles: z.array(bible).max(200), songs: z.array(song).max(100_000),
  presentations: z.array(z.object({ playlist, channels: z.array(channel).max(1000) }).strict()).max(10_000),
  media: z.array(asset).max(10_000), settings: settings.nullable(),
  studio: PortableStudioSchema.nullable().default(null), recordings: z.array(PortableRecordingSchema).max(10000).default([]), setlists: z.array(portableSetlist).max(1000).default([]), clips: PortableClipsSchema.nullable().default(null),
}).strict();
const EnvelopeSchema = z.object({ format: z.literal('lumen'), version: z.literal(1), createdAt: z.string().datetime(), payload: PayloadSchema }).strict();
type Payload = z.infer<typeof PayloadSchema>;
type Asset = Payload['media'][number];
interface PreviewData { payload: Payload; files: Map<string, string>; assets: Map<string, ArchiveAsset>; stagingDir?: string }
declare const archiveBrand: unique symbol;
/** Contents remain private; only a preview from this service can be imported. */
export interface ValidatedArchive { readonly [archiveBrand]: true }

function error(message: string, status = 422): never { throw new ProductionError(status, message); }
function digest(bytes: Buffer) { return createHash('sha256').update(bytes).digest('hex'); }
function isMediaId(value: string) {
  const match = /^media\/(backgrounds|music)\/([^/\\]+)$/.exec(value);
  if (!match || match[2].startsWith('.') || match[2].length > 200 || Buffer.byteLength(match[2]) > 240 || /[\x00-\x1f\x7f%?#:]/.test(match[2]) || match[2].includes('..')) return false;
  return (match[1] === 'backgrounds' ? /\.(png|jpe?g|webp|gif|mp4|webm|mov|m4v)$/i : /\.(mp3|wav|m4a|aac|ogg|flac|opus)$/i).test(match[2]);
}
function localReference(value: string) { return value.startsWith('/media/') ? value.slice(1) : value; }
function isMediaReference(value: string) {
  if (isMediaId(localReference(value))) return true;
  try { const url = new URL(value); return ['https:', 'http:'].includes(url.protocol) && !url.username && !url.password && !/[\x00-\x20\\]/.test(value); } catch { return false; }
}
function unique(values: string[], label: string) { if (new Set(values).size !== values.length) error(`Duplicate ${label} identifiers.`); }
function parseSelection(raw: unknown): TransferSelection {
  const parsed = SelectionSchema.safeParse(raw); if (!parsed.success) error('Invalid transfer selection.');
  for (const key of ['bibles', 'songs', 'presentations', 'media', 'scenes', 'recordings', 'setlists', 'clips'] as const) unique(parsed.data[key], key);
  if (!parsed.data.settings && !parsed.data.bibles.length && !parsed.data.songs.length && !parsed.data.presentations.length && !parsed.data.media.length && !parsed.data.scenes.length && !parsed.data.recordings.length && !parsed.data.setlists.length && !parsed.data.clips.length) error('Choose at least one item to transfer.');
  return parsed.data;
}
function select<T>(items: T[], ids: string[], getId: (item: T) => string, label: string) {
  const map = new Map(items.map(item => [getId(item), item]));
  return ids.map(id => { const item = map.get(id); if (!item) error(`Selected ${label} is no longer available: ${id}`); return item; });
}
function dependencies(presentations: Payload['presentations']) {
  return new Set(presentations.flatMap(p => p.playlist.items.flatMap(i => {
    const src = i.background?.src; return src && isMediaId(localReference(src)) ? [localReference(src)] : [];
  })));
}
function decodeAsset(value: Asset) {
  if (value.data === undefined) error('The archive is missing its media content.');
  if (value.data.length % 4 !== 0 || /[^A-Za-z0-9+/=]/.test(value.data) || /=/.test(value.data.slice(0, -2))) error('Invalid media encoding.');
  const bytes = Buffer.from(value.data, 'base64');
  if (bytes.length !== value.bytes || bytes.toString('base64') !== value.data || digest(bytes) !== value.sha256) error('Media content failed its integrity check.');
  return bytes;
}
function validatePayload(raw: unknown, inline = true): Payload {
  const parsed = PayloadSchema.safeParse(raw); if (!parsed.success) error('The archive contains invalid content.');
  const data = parsed.data;
  if (inline && (data.studio || data.recordings.length || data.setlists.length || data.clips)) error('This content requires a version 2 .lumen archive.');
  unique(data.bibles.map(v => v.version.id.toUpperCase()), 'Bible'); unique(data.songs.map(s => s.id), 'song');
  unique(data.presentations.map(p => p.playlist.id), 'presentation'); unique(data.media.map(m => m.id), 'media');
  unique(data.presentations.flatMap(p => p.channels.map(c => c.id)), 'channel');
  for (const b of data.bibles) {
    b.version.id = b.version.id.toUpperCase();
    const positions = new Set<string>();
    for (const v of b.verses) for (let n = v.verse; n <= (v.endVerse ?? v.verse); n++) {
      const id = `${v.book}:${v.chapter}:${n}`; if (positions.has(id)) error(`Duplicate or overlapping verses in ${b.version.id}.`); positions.add(id);
    }
  }
  for (const s of data.songs) if (!SongSchema.safeParse(s).success) error(`Invalid song: ${s.id}`);
  for (const p of data.presentations) {
    unique(p.playlist.items.map(i => i.id), 'slide');
    for (const i of p.playlist.items) unique((i.stanzas ?? []).map(s => s.id), 'stanza');
    for (const c of p.channels) if (c.playlistId !== p.playlist.id) error('A presentation channel points to another playlist.');
  }
  const assets = new Set(data.media.map(m => m.id));
  for (const id of dependencies(data.presentations)) if (!assets.has(id)) error(`The archive is missing presentation media: ${id}`);
  for (const m of data.media) if (inline) decodeAsset(m);
  unique(data.setlists.map(s => s.id), 'setlist');
  const channelIds = new Set(data.presentations.flatMap(p => p.channels.map(c => c.id)));
  const songIds = new Set(data.songs.map(s => s.id));
  for (const setlist of data.setlists) {
    if (!channelIds.has(setlist.id)) error('A setlist is missing its channel.');
    unique(setlist.songIds, 'setlist song');
    if (setlist.songIds.some(id => !songIds.has(id))) error('A setlist is missing a required song.');
  }
  unique(data.recordings.map(r => r.id), 'recording');
  if (data.studio) {
    const required = portableStudioDependencies(data.studio);
    for (const id of required.mediaIds) if (!assets.has(id)) error(`A Studio scene is missing its media: ${id}`);
    for (const id of required.channelIds) if (!channelIds.has(id)) error(`A Studio scene is missing its channel: ${id}`);
  }
  if (data.clips) {
    const required = portableClipsDependencies(data.clips);
    for (const id of required.recordingIds) if (!data.recordings.some(r => r.id === id)) error(`A Clips project is missing its recording: ${id}`);
    for (const id of required.assetIds) if (!data.clips.assets.some(a => a.id === id)) error(`A Clips project is missing imported media: ${id}`);
  }
  return data;
}
function counts(): TransferCounts { return { bibles: 0, songs: 0, presentations: 0, media: 0, settings: 0, scenes: 0, recordings: 0, setlists: 0, clips: 0 }; }
function warningsFor(data: Payload) {
  const remote = data.presentations.some(p => p.playlist.items.some(i => i.background?.src && /^https?:/.test(i.background.src)));
  const missingVersion = data.setlists.some(setlist => !data.bibles.some(bible => bible.version.id === setlist.versionId));
  return [...(remote ? ['External media links are preserved and still require access to their original host.'] : []), ...(data.studio ? portableStudioDependencies(data.studio).warnings : []),
    ...(missingVersion ? ['Some setlists use Bible editions that were not installed on the source station. Install those editions separately to use them here.'] : [])];
}

export class DataTransfer {
  private readonly previews = new WeakMap<ValidatedArchive, PreviewData>();
  private readonly root: string;
  constructor(private readonly library: WorshipLibrary, dataDir: string, private readonly production?: ProductionTransferAdapter) { this.root = path.resolve(dataDir); }

  private async content() {
    const target = path.join(this.root, 'content.json');
    let raw: Buffer | null = null;
    try { await this.safePath('content.json', true); raw = await fs.readFile(target); } catch (e) { if ((e as NodeJS.ErrnoException).code !== 'ENOENT') throw e; }
    const blank = { version: 2, updatedAt: new Date().toISOString(), settings: {}, playlists: [], music: {}, channels: [], sources: [], destinations: [], routes: [], program: { programSourceId: null, previewSourceId: null } };
    let value: Content;
    try { value = ContentSchema.parse(ensureChannels(raw ? JSON.parse(raw.toString('utf8')) : blank)); } catch { error('Station content could not be read safely.'); }
    return { raw, value };
  }
  /** Never traverse a symlink, including a substituted media directory. */
  private async safePath(relative: string, requireFile = false) {
    const parts = relative.split('/');
    if (parts.some(p => !p || p === '.' || p === '..' || p.includes('\\')) || path.isAbsolute(relative)) error('Unsafe filesystem path.');
    let current = this.root;
    const rootStat = await fs.lstat(current); if (!rootStat.isDirectory() || rootStat.isSymbolicLink()) error('The data directory must be a regular directory.');
    for (let i = 0; i < parts.length; i++) {
      current = path.join(current, parts[i]);
      try {
        const stat = await fs.lstat(current);
        if (stat.isSymbolicLink() || (i < parts.length - 1 && !stat.isDirectory()) || (i === parts.length - 1 && requireFile && !stat.isFile())) error('Symlinks and non-file media are not transferable.');
      } catch (e) { if ((e as NodeJS.ErrnoException).code !== 'ENOENT' || requireFile) throw e; }
    }
    return current;
  }
  private allSongs() {
    return (this.library.db.prepare('SELECT id,title,author,copyright,sections FROM songs ORDER BY title COLLATE NOCASE,id').all() as { id: string; title: string; author: string; copyright: string; sections: string }[]).map(row => ({ ...row, sections: JSON.parse(row.sections) as z.infer<typeof song>['sections'] }));
  }
  private async mediaCatalog() {
    const result: TransferCatalog['media'] = [];
    for (const kind of ['backgrounds', 'music']) {
      const relative = `media/${kind}`; await this.safePath(relative);
      let files: sync.Dirent[]; try { files = await fs.readdir(path.join(this.root, relative), { withFileTypes: true }); } catch (e) { if ((e as NodeJS.ErrnoException).code === 'ENOENT') continue; throw e; }
      for (const file of files) {
        const id = `${relative}/${file.name}`; if (!file.isFile() || !isMediaId(id)) continue;
        const stat = await fs.lstat(path.join(this.root, id)); if (!stat.isFile()) continue;
        result.push({ id, name: file.name, bytes: stat.size, detail: kind === 'music' ? 'Audio' : 'Background' });
      }
    }
    return result.sort((a, b) => a.name.localeCompare(b.name));
  }
  private setlists(content: Content) {
    return content.channels.filter(c => c.kind === 'lyrics' || c.kind === 'scripture').map(c => {
      const state = this.library.workspace(c.id);
      return portableSetlist.parse({ id: c.id, versionId: state.versionId, songIds: state.setlist, theme: state.theme });
    });
  }
  async release(archive: ValidatedArchive) {
    const stored = this.previews.get(archive); this.previews.delete(archive);
    if (stored?.stagingDir) await fs.rm(stored.stagingDir, { recursive: true, force: true });
  }
  async catalog(): Promise<TransferCatalog> {
    const { value } = await this.content();
    return {
      bibles: this.library.versions().filter(v => v.installed).map(v => ({ id: v.id, name: v.name, detail: `${v.verseCount.toLocaleString()} verses` })),
      songs: this.allSongs().map(s => ({ id: s.id, name: s.title, detail: `${s.sections.length} sections` })),
      presentations: value.playlists.map(p => ({ id: p.id, name: p.name, detail: `${p.items.length} slides` })),
      media: await this.mediaCatalog(), settings: true, ...(this.production?.catalog() ?? { scenes: [], recordings: [], clips: [] }),
      setlists: this.setlists(value).map(s => ({ id: s.id, name: value.channels.find(c => c.id === s.id)!.name, detail: `${s.songIds.length} songs` })),
    };
  }
  async exportToFile(raw: unknown, destination: string): Promise<{ bytes: number; createdAt: string }> {
    const selection = parseSelection(raw), { value } = await this.content();
    if ((selection.scenes.length || selection.recordings.length || selection.clips.length) && !this.production) error('Studio data transfer is unavailable on this station.', 409);
    const studio = selection.scenes.length ? await this.production!.exportScenes(selection.scenes) : null;
    const studioDependencies = studio ? portableStudioDependencies(studio) : { channelIds: [], mediaIds: [] };
    const clipExport = selection.clips.length ? await this.production!.exportClips(selection.clips) : null;
    const recordingSources = await this.production?.exportRecordings([...new Set([...selection.recordings, ...(clipExport?.recordingIds ?? [])])]) ?? [];
    const recordings = recordingSources.map(({ path: _path, ...recording }) => recording);
    const allSetlists = this.setlists(value);
    const setlists = select(allSetlists, [...new Set([...selection.setlists, ...studioDependencies.channelIds.filter(id => allSetlists.some(s => s.id === id))])], s => s.id, 'setlist');
    const playlistIds = new Set(selection.presentations);
    for (const id of [...setlists.map(s => s.id), ...studioDependencies.channelIds]) {
      const required = value.channels.find(c => c.id === id); if (!required) error(`A Studio scene references a missing channel: ${id}`); playlistIds.add(required.playlistId);
    }
    const presentations = select(value.playlists, [...playlistIds], p => p.id, 'presentation').map(p => ({ playlist: p, channels: value.channels.filter(c => c.playlistId === p.id) }));
    const songIds = [...new Set([...selection.songs, ...setlists.flatMap(s => s.songIds)])];
    const versions = this.library.versions().filter(v => v.installed);
    const bibleIds = [...new Set([...selection.bibles, ...setlists.filter(s => versions.some(v => v.id === s.versionId)).map(s => s.versionId)])];
    const bibles = select(versions, bibleIds, v => v.id, 'Bible').map(v => ({
      version: { id: v.id, name: v.name, language: v.language, attribution: v.attribution },
      verses: (this.library.db.prepare('SELECT book,chapter,verse,endVerse,text FROM verses WHERE versionId=? ORDER BY book,chapter,verse').all(v.id) as { book: number; chapter: number; verse: number; endVerse: number | null; text: string }[]).map(({ endVerse, ...verse }) => ({ ...verse, ...(endVerse !== null ? { endVerse } : {}) })),
    }));
    const sources: ArchiveSource[] = [];
    for (const id of new Set([...selection.media, ...dependencies(presentations), ...studioDependencies.mediaIds])) {
      if (!isMediaId(id)) error('Unsupported media path.');
      sources.push({ id, path: await this.safePath(id, true) });
    }
    sources.push(...recordingSources.map(recording => ({ id: `recordings/${recording.id}/recording.webm`, path: recording.path })), ...(clipExport?.files ?? []).map(file => ({ id: file.id, path: file.path })));
    // Adapter paths must obey the same root and symlink restrictions as public
    // media, including all recording and Clips parent directories.
    for (const source of sources) source.path = await this.safePath(path.relative(this.root, source.path).split(path.sep).join('/'), true);
    const metadata = { bibles, songs: select(this.allSongs(), songIds, s => s.id, 'song'), presentations, settings: selection.settings ? value.settings : null, setlists, studio, recordings, clips: clipExport?.bundle ?? null };
    const result = await writeArchiveFile(destination, (assets: ArchiveAsset[]) => {
      const data = validatePayload({ ...metadata, media: assets.filter(asset => isMediaId(asset.id)) }, false);
      this.validateAssets(data, assets); return data;
    }, sources);
    return { bytes: result.bytes, createdAt: result.createdAt };
  }
  private validateAssets(data: Payload, descriptors: ArchiveAsset[]) {
    const assets = new Map(descriptors.map(asset => [asset.id, asset]));
    const expected = [...data.media.map(m => ({ id: m.id, bytes: m.bytes })), ...data.recordings.map(r => ({ id: `recordings/${r.id}/recording.webm`, bytes: r.bytes })), ...(data.clips ? portableClipFiles(data.clips) : [])];
    unique(expected.map(file => file.id), 'binary file');
    if (expected.length !== assets.size) error('The archive contains unexpected or missing assets.');
    for (const file of expected) if (assets.get(file.id)?.bytes !== file.bytes) error('Archive file metadata does not match its binary asset.');
    for (const media of data.media) if (media.data !== undefined || assets.get(media.id)?.sha256 !== media.sha256) error('Archive media metadata does not match its binary asset.');
  }
  async previewFile(source: string, stagingDir: string): Promise<{ archive: ValidatedArchive; createdAt: string; catalog: TransferCatalog; warnings: string[] }> {
    if (!(await isV2Archive(source))) {
      const stat = await fs.lstat(source);
      if (stat.size > MAX_TRANSFER_COMPRESSED_BYTES) error('The legacy .lumen file exceeds 128 MiB.', 413);
      return this.preview(await fs.readFile(source));
    }
    let data!: Payload;
    const result = await readArchiveFile(source, stagingDir, manifest => {
      data = validatePayload(manifest.payload, false);
      this.validateAssets(data, manifest.assets);
    });
    try { return await this.registerPreview(data, result.manifest.createdAt, { files: result.files, assets: new Map(result.manifest.assets.map(asset => [asset.id, asset])), stagingDir }); }
    catch (cause) { await fs.rm(stagingDir, { recursive: true, force: true }); throw cause; }
  }
  async export(raw: unknown): Promise<Buffer> {
    const selection = parseSelection(raw);
    if (selection.scenes.length || selection.recordings.length || selection.setlists.length || selection.clips.length) {
      const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'lumen-buffer-export-'));
      try {
        const filename = path.join(directory, 'export.lumen'); const result = await this.exportToFile(selection, filename);
        if (result.bytes > MAX_TRANSFER_COMPRESSED_BYTES) error('Use a file export for archives larger than 128 MiB.', 413);
        return await fs.readFile(filename);
      } finally { await fs.rm(directory, { recursive: true, force: true }); }
    }
    const { value } = await this.content();
    const versions = this.library.versions().filter(v => v.installed);
    const bibles = select(versions, selection.bibles, v => v.id, 'Bible').map(v => ({
      version: { id: v.id, name: v.name, language: v.language, attribution: v.attribution },
      verses: (this.library.db.prepare('SELECT book,chapter,verse,endVerse,text FROM verses WHERE versionId=? ORDER BY book,chapter,verse').all(v.id) as { book: number; chapter: number; verse: number; endVerse: number | null; text: string }[]).map(({ endVerse, ...verse }) => ({ ...verse, ...(endVerse !== null ? { endVerse } : {}) })),
    }));
    const presentations = select(value.playlists, selection.presentations, p => p.id, 'presentation').map(p => ({ playlist: p, channels: value.channels.filter(c => c.playlistId === p.id) }));
    const mediaIds = [...new Set([...selection.media, ...dependencies(presentations)])];
    const media: Asset[] = [];
    let binaryBytes = 0;
    for (const id of mediaIds) {
      if (!isMediaId(id)) error('Unsupported media path.');
      let target: string;
      try { target = await this.safePath(id, true); } catch (e) {
        if ((e as NodeJS.ErrnoException).code === 'ENOENT') error(`Selected media is no longer available: ${id}`, 409);
        throw e;
      }
      const handle = await fs.open(target, sync.constants.O_RDONLY | sync.constants.O_NOFOLLOW);
      try {
        const stat = await handle.stat();
        if (!stat.isFile() || stat.size > MAX_ASSET_BYTES) error(`Media is too large to transfer: ${id}`, 413);
        binaryBytes += stat.size; if (binaryBytes > MAX_TRANSFER_DECOMPRESSED_BYTES * .7) error('Selected media exceeds the transfer limit.', 413);
        const bytes = await handle.readFile(); if (bytes.length !== stat.size) error('A selected media file changed during export.');
        media.push({ id, bytes: bytes.length, sha256: digest(bytes), data: bytes.toString('base64') });
      } finally { await handle.close(); }
    }
    const payload = validatePayload({ bibles, songs: select(this.allSongs(), selection.songs, s => s.id, 'song'), presentations, media, settings: selection.settings ? value.settings : null });
    const { studio: _studio, recordings: _recordings, setlists: _setlists, clips: _clips, ...legacyPayload } = payload;
    const bytes = Buffer.from(JSON.stringify({ format: 'lumen', version: 1, createdAt: new Date().toISOString(), payload: legacyPayload }));
    if (bytes.length > MAX_TRANSFER_DECOMPRESSED_BYTES) error('Selected content exceeds the transfer limit.', 413);
    const compressed = gzipSync(bytes);
    if (compressed.length > MAX_TRANSFER_COMPRESSED_BYTES) error('Selected content exceeds the transfer limit.', 413);
    return compressed;
  }
  async preview(buffer: Buffer): Promise<{ archive: ValidatedArchive; createdAt: string; catalog: TransferCatalog; warnings: string[] }> {
    if (!Buffer.isBuffer(buffer) || !buffer.length) error('Choose a .lumen file.');
    if (buffer.length > MAX_TRANSFER_COMPRESSED_BYTES) error('The .lumen file exceeds 128 MiB.', 413);
    if (buffer.subarray(0, 8).equals(Buffer.from('LUMEN2\r\n'))) {
      const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'lumen-buffer-preview-'));
      try {
        const filename = path.join(directory, 'archive.lumen'); await fs.writeFile(filename, buffer);
        const result = await this.previewFile(filename, path.join(directory, 'assets'));
        await fs.unlink(filename); const stored = this.previews.get(result.archive)!; stored.stagingDir = directory; return result;
      } catch (cause) { await fs.rm(directory, { recursive: true, force: true }); throw cause; }
    }
    let envelope: z.infer<typeof EnvelopeSchema>;
    try {
      const plain = gunzipSync(buffer, { maxOutputLength: MAX_TRANSFER_DECOMPRESSED_BYTES });
      envelope = EnvelopeSchema.parse(JSON.parse(plain.toString('utf8')));
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code === 'ERR_BUFFER_TOO_LARGE') error('The expanded .lumen file exceeds 256 MiB.', 413);
      error('This is not a valid supported .lumen file, or the file is incomplete.');
    }
    return this.registerPreview(validatePayload(envelope.payload), envelope.createdAt);
  }
  private async registerPreview(data: Payload, createdAt: string, stored: Partial<PreviewData> = {}): Promise<{ archive: ValidatedArchive; createdAt: string; catalog: TransferCatalog; warnings: string[] }> {
    const existing = await this.catalog();
    const bibleIds = new Set(existing.bibles.map(v => v.id)), songIds = new Set(existing.songs.map(v => v.id));
    const archive = Object.freeze({}) as ValidatedArchive; this.previews.set(archive, { payload: data, files: new Map(), assets: new Map(), ...stored });
    return { archive, createdAt, warnings: warningsFor(data), catalog: {
      bibles: data.bibles.map(v => ({ id: v.version.id, name: v.version.name, detail: `${v.verses.length.toLocaleString()} passages`, exists: bibleIds.has(v.version.id) })),
      songs: data.songs.map(v => ({ id: v.id, name: v.title, exists: songIds.has(v.id) })),
      presentations: data.presentations.map(v => ({ id: v.playlist.id, name: v.playlist.name, detail: `${v.playlist.items.length} slides` })),
      media: data.media.map(v => ({ id: v.id, name: path.basename(v.id), bytes: v.bytes })), settings: data.settings !== null, scenes: data.studio?.scenes.map(scene => ({ id: scene.id, name: scene.name, detail: `${scene.layers.length} layers` })) ?? [], recordings: data.recordings.map(recording => ({ id: recording.id, name: recording.name, bytes: recording.bytes })), clips: data.clips?.drafts.map(draft => ({ id: draft.id, name: draft.name })) ?? [],
      setlists: data.setlists.map(s => ({ id: s.id, name: data.presentations.flatMap(p => p.channels).find(c => c.id === s.id)!.name, detail: `${s.songIds.length} songs` })),
    } };
  }
  async import(archive: ValidatedArchive, raw: unknown, context?: { owner: { id: string; name: string } }): Promise<TransferResult> {
    const stored = this.previews.get(archive); if (!stored) error('This import preview expired or has already been used.', 409);
    const data = stored.payload;
    const selection = parseSelection(raw);
    if ((selection.scenes.length || selection.recordings.length || selection.clips.length) && !this.production) error('Studio data transfer is unavailable on this station.', 409);
    if (selection.clips.length && !context?.owner) error('Sign in before importing Clips projects.', 401);
    select(data.studio?.scenes ?? [], selection.scenes, scene => scene.id, 'Studio scene');
    select(data.clips?.drafts ?? [], selection.clips, draft => draft.id, 'Clips project');
    const studio = data.studio && selection.scenes.length ? selectPortableStudio(data.studio, selection.scenes) : null;
    const clips = data.clips && selection.clips.length ? selectPortableClips(data.clips, selection.clips) : null;
    const studioDependencies = studio ? portableStudioDependencies(studio) : { channelIds: [], mediaIds: [] };
    const recordings = select(data.recordings, [...new Set([...selection.recordings, ...(clips ? portableClipsDependencies(clips).recordingIds : [])])], r => r.id, 'recording');
    const setlists = select(data.setlists, [...new Set([...selection.setlists, ...studioDependencies.channelIds.filter(id => data.setlists.some(s => s.id === id))])], s => s.id, 'setlist');
    const bibles = select(data.bibles, [...new Set([...selection.bibles, ...setlists.filter(s => data.bibles.some(b => b.version.id === s.versionId)).map(s => s.versionId)])], b => b.version.id, 'Bible');
    const songs = select(data.songs, [...new Set([...selection.songs, ...setlists.flatMap(s => s.songIds)])], s => s.id, 'song');
    const presentations = select(data.presentations, [...new Set([...selection.presentations, ...[...setlists.map(s => s.id), ...studioDependencies.channelIds].map(id => data.presentations.find(p => p.channels.some(c => c.id === id))!.playlist.id)])], p => p.playlist.id, 'presentation');
    const media = select(data.media, [...new Set([...selection.media, ...dependencies(presentations), ...studioDependencies.mediaIds])], m => m.id, 'media');
    if (selection.settings && !data.settings) error('This archive has no display settings.');
    const portableFiles = [...recordings.map(recording => `recordings/${recording.id}/recording.webm`), ...(clips ? portableClipFiles(clips).map(file => file.id) : [])];
    for (const id of portableFiles) {
      const filename = stored.files.get(id), expected = stored.assets.get(id);
      if (!filename || !expected) error('A required archive file is unavailable. Choose the archive again.');
      await verifyAssetFile(filename, expected);
    }
    return withContentLock(async () => {
      // Recheck after waiting: two callers cannot consume one preview twice.
      if (!this.previews.has(archive)) error('This import preview has already been used.', 409);
      const { raw: oldRaw, value: current } = await this.content();
      const imported = counts(), skipped = counts(), warnings = warningsFor(data);
      const disk = await fs.statfs(this.root), libraryBytes = (await fs.stat(path.join(this.root, 'worship.db'))).size;
      const importBytes = media.reduce((sum, asset) => sum + asset.bytes, 0) + portableFiles.reduce((sum, id) => sum + stored.assets.get(id)!.bytes, 0);
      if (importBytes + libraryBytes + 16 * 1024 * 1024 > disk.bavail * disk.bsize) error('There is not enough free disk space to import the selected content.', 507);
      const backupRelative = `backups/data-transfer/${new Date().toISOString().replace(/[:.]/g, '-')}-${randomUUID()}`;
      const backupPath = await this.safePath(backupRelative);
      await fs.mkdir(backupPath, { recursive: true });
      // Await the online SQLite backup before any station mutation. The final
      // synchronous transaction checks current IDs again after this await.
      await this.library.db.backup(path.join(backupPath, 'worship.db'));
      await fs.writeFile(path.join(backupPath, 'content.json'), oldRaw ?? Buffer.from(JSON.stringify(current)), { flag: 'wx', mode: 0o600 });
      await fs.writeFile(path.join(backupPath, 'manifest.json'), JSON.stringify({ format: 'lumen-data-transfer-backup', createdAt: new Date().toISOString(), contentExisted: oldRaw !== null, selection }, null, 2), { flag: 'wx', mode: 0o600 });
      const apply = async (tx?: ProductionTransferTransaction) => {
      const staged: { temporary: string; target: string; id: string }[] = [], added: string[] = [], rewrite = new Map<string, string>();
      let contentTemporary: string | null = null, contentChanged = false;
      const contentTarget = path.join(this.root, 'content.json');
      try {
        for (const m of media) {
          const parts = m.id.split('/'), dirRelative = parts.slice(0, 2).join('/');
          const directory = await this.safePath(dirRelative); await fs.mkdir(directory, { recursive: true });
          let id = m.id;
          for (;;) {
            let exists = false; try { await fs.lstat(path.join(this.root, id)); exists = true; } catch (e) { if ((e as NodeJS.ErrnoException).code !== 'ENOENT') throw e; }
            if (!exists) break;
            const ext = path.extname(parts[2]), stem = parts[2].slice(0, -ext.length).slice(0, 120);
            id = `${dirRelative}/${stem}-import-${randomUUID()}${ext}`;
          }
          const target = await this.safePath(id);
          const temporary = path.join(directory, `.lumen-import-${randomUUID()}.tmp`);
          staged.push({ temporary, target, id });
          const source = stored.files.get(m.id);
          if (source) await copyAssetFile(source, temporary, stored.assets.get(m.id)!);
          else {
            const handle = await fs.open(temporary, 'wx', 0o600);
            try { await handle.writeFile(decodeAsset(m)); await handle.sync(); } finally { await handle.close(); }
          }
          rewrite.set(m.id, id);
        }
        const next: Content = structuredClone(current), channelRewrite = new Map<string, string>();
        for (const p of presentations) {
          const playlistId = `pl_${randomUUID()}`;
          const copy = structuredClone(p.playlist); copy.id = playlistId;
          for (const i of copy.items) {
            i.id = `item_${randomUUID()}`;
            for (const s of i.stanzas ?? []) s.id = `stanza_${randomUUID()}`;
            if (i.background?.src) i.background.src = rewrite.get(localReference(i.background.src)) ?? i.background.src;
          }
          next.playlists.push(copy);
          for (const c of p.channels) {
            const id = `chnl_${randomUUID()}`; channelRewrite.set(c.id, id); next.channels.push({ ...c, id, playlistId, defaultMode: 'manual' });
            next.sources.push({ id: `src_${randomUUID()}`, kind: 'channel', ref: id, label: c.name });
          }
          imported.presentations++;
        }
        if (selection.settings) { next.settings = data.settings!; imported.settings = 1; }
        const shouldWriteContent = presentations.length > 0 || selection.settings;
        if (shouldWriteContent) {
          next.updatedAt = new Date().toISOString(); ContentSchema.parse(next);
          contentTemporary = path.join(this.root, `.lumen-content-${randomUUID()}.tmp`);
          const handle = await fs.open(contentTemporary, 'wx', 0o600);
          try { await handle.writeFile(JSON.stringify(next, null, 2)); await handle.sync(); } finally { await handle.close(); }
        }
        if (tx) {
          if (studio) imported.scenes = await tx.importScenes(studio, { media: Object.fromEntries(rewrite), channels: Object.fromEntries(channelRewrite) });
          const recordingMap = await tx.importRecordings(recordings.map(recording => ({ recording, path: stored.files.get(`recordings/${recording.id}/recording.webm`)! })));
          imported.recordings = Object.keys(recordingMap).length;
          if (clips) imported.clips = await tx.importClips(clips, { recordings: recordingMap, files: Object.fromEntries(stored.files), owner: context!.owner });
          await tx.prepare();
        }
        this.library.db.transaction(() => {
          for (const b of bibles) {
            if (this.library.db.prepare('SELECT 1 FROM bible_versions WHERE id=?').get(b.version.id)) { skipped.bibles++; continue; }
            this.library.importBible(b); imported.bibles++;
          }
          for (const s of songs) {
            if (this.library.db.prepare('SELECT 1 FROM songs WHERE id=?').get(s.id)) { skipped.songs++; continue; }
            this.library.saveSong(s); imported.songs++;
          }
          for (const setlist of setlists) {
            const channelId = channelRewrite.get(setlist.id); if (!channelId) error('Missing imported setlist channel.');
            const state = { ...this.library.workspace(channelId), versionId: setlist.versionId, setlist: setlist.songIds, theme: setlist.theme };
            this.library.db.prepare('INSERT INTO worship_workspaces(channelId,state) VALUES(?,?)').run(channelId, JSON.stringify(state)); imported.setlists++;
          }
          for (const s of staged) {
            // link is an atomic no-clobber publish; unlike rename, it cannot
            // overwrite a file uploaded after collision checks above.
            sync.linkSync(s.temporary, s.target); added.push(s.target); sync.unlinkSync(s.temporary); imported.media++;
          }
          if (contentTemporary) { sync.renameSync(contentTemporary, contentTarget); contentChanged = true; }
          tx?.commitSync();
        })();
        try { tx?.publish(); } catch { /* Persisted state must not fail on notification. */ }
        await this.release(archive).catch(() => {});
        if (skipped.bibles || skipped.songs) warnings.push('Existing Bible editions and songs with matching IDs were kept.');
        return { imported, skipped, backupPath, warnings };
      } catch (e) {
        // Database.transaction rolls back all library/search writes. Restore
        // the other resources before releasing the shared content lock.
        invalidateLyricsSearch(this.library.db);
        if (contentChanged) {
          if (oldRaw) {
            const rollback = path.join(this.root, `.lumen-rollback-${randomUUID()}.tmp`);
            sync.writeFileSync(rollback, oldRaw, { flag: 'wx', mode: 0o600 }); sync.renameSync(rollback, contentTarget);
          } else { try { sync.unlinkSync(contentTarget); } catch {} }
        }
        for (const target of added) { try { sync.unlinkSync(target); } catch {} }
        throw e;
      } finally {
        for (const s of staged) { try { await fs.unlink(s.temporary); } catch {} }
        if (contentTemporary) { try { await fs.unlink(contentTemporary); } catch {} }
      }
      };
      return this.production && (studio || recordings.length || clips) ? this.production.transaction(backupPath, apply) : apply();
    });
  }
}
