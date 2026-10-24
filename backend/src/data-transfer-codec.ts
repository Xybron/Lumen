import fs from 'node:fs/promises';
import sync from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { gzipSync, gunzipSync } from 'node:zlib';
import { z } from 'zod';
import { ProductionError } from './production-store.js';

// v2 stores a bounded compressed manifest followed by raw length-framed files.
// Recordings are already compressed: streaming their bytes avoids both base64
// expansion and loading hours of video into the JavaScript heap.
const MAGIC = Buffer.from('LUMEN2\r\n');
const END = Buffer.from('LUMENEND');
export const MAX_ARCHIVE_BYTES = 1024 ** 4;
export const MAX_MANIFEST_BYTES = 256 * 1024 * 1024;
const MAX_COMPRESSED_MANIFEST_BYTES = 128 * 1024 * 1024;
const CHUNK_BYTES = 1024 * 1024;
const descriptorSchema = z.object({ id: z.string().min(1).max(1024), bytes: z.number().int().nonnegative().max(MAX_ARCHIVE_BYTES), sha256: z.string().regex(/^[a-f0-9]{64}$/) }).strict();
const manifestSchema = z.object({ format: z.literal('lumen'), version: z.literal(2), createdAt: z.string().datetime(), payload: z.unknown(), assets: z.array(descriptorSchema).max(20_000) }).strict();
export type ArchiveAsset = z.infer<typeof descriptorSchema>;
export type ArchiveManifest = z.infer<typeof manifestSchema>;
export interface ArchiveSource { id: string; path: string }

function invalid(message: string, status = 422): never { throw new ProductionError(status, message); }
async function openRegular(filename: string) {
  const stat = await fs.lstat(filename);
  if (!stat.isFile() || stat.isSymbolicLink()) invalid('Archive files must be regular files.');
  return fs.open(filename, sync.constants.O_RDONLY | sync.constants.O_NOFOLLOW);
}
async function writeAll(handle: fs.FileHandle, bytes: Buffer) {
  let offset = 0;
  while (offset < bytes.length) {
    const written = await handle.write(bytes, offset, bytes.length - offset);
    if (!written.bytesWritten) invalid('Archive storage stopped accepting data.', 500);
    offset += written.bytesWritten;
  }
}
async function readExact(handle: fs.FileHandle, size: number) {
  const bytes = Buffer.allocUnsafe(size);
  let offset = 0;
  while (offset < size) {
    const read = await handle.read(bytes, offset, size - offset);
    if (!read.bytesRead) invalid('The .lumen archive is incomplete.');
    offset += read.bytesRead;
  }
  return bytes;
}
async function describe(source: ArchiveSource): Promise<ArchiveAsset> {
  const handle = await openRegular(source.path);
  try {
    const before = await handle.stat();
    if (before.size > MAX_ARCHIVE_BYTES) invalid('A selected file exceeds the 1 TiB archive limit.', 413);
    const hash = createHash('sha256'), bytes = Buffer.allocUnsafe(CHUNK_BYTES);
    let count = 0;
    for (;;) {
      const read = await handle.read(bytes, 0, bytes.length);
      if (!read.bytesRead) break;
      count += read.bytesRead; hash.update(bytes.subarray(0, read.bytesRead));
      if (count > before.size) invalid('A selected file changed during export.', 409);
    }
    const after = await handle.stat();
    if (count !== before.size || after.size !== before.size || after.mtimeMs !== before.mtimeMs) invalid('A selected file changed during export.', 409);
    return descriptorSchema.parse({ id: source.id, bytes: count, sha256: hash.digest('hex') });
  } finally { await handle.close(); }
}

export async function writeArchiveFile(destination: string, payload: unknown | ((assets: ArchiveAsset[]) => unknown), sources: ArchiveSource[], createdAt = new Date().toISOString()) {
  if (new Set(sources.map(source => source.id)).size !== sources.length) invalid('Duplicate archive asset identifiers.');
  const assets: ArchiveAsset[] = [];
  for (const source of sources) assets.push(await describe(source));
  const manifest = manifestSchema.parse({ format: 'lumen', version: 2, createdAt, payload: typeof payload === 'function' ? payload(assets) : payload, assets });
  const json = Buffer.from(JSON.stringify(manifest));
  if (json.length > MAX_MANIFEST_BYTES) invalid('The archive manifest exceeds 256 MiB. Export smaller groups of library content.', 413);
  const compressed = gzipSync(json);
  if (compressed.length > MAX_COMPRESSED_MANIFEST_BYTES) invalid('The archive manifest exceeds its compressed limit.', 413);
  const total = 16 + compressed.length + END.length + assets.reduce((sum, value) => sum + 8 + value.bytes, 0);
  if (total > MAX_ARCHIVE_BYTES) invalid('The selected content exceeds the 1 TiB archive limit.', 413);
  const available = await fs.statfs(path.dirname(destination));
  if (total + 16 * 1024 * 1024 > available.bavail * available.bsize) invalid('There is not enough free disk space to export this archive.', 507);
  const target = await fs.open(destination, 'wx', 0o600);
  try {
    const header = Buffer.alloc(16); MAGIC.copy(header); header.writeUInt32LE(compressed.length, 8); header.writeUInt32LE(assets.length, 12);
    await writeAll(target, header); await writeAll(target, compressed);
    for (let index = 0; index < assets.length; index++) {
      const asset = assets[index], input = await openRegular(sources[index].path);
      try {
        const length = Buffer.alloc(8); length.writeBigUInt64LE(BigInt(asset.bytes)); await writeAll(target, length);
        const bytes = Buffer.allocUnsafe(CHUNK_BYTES), hash = createHash('sha256');
        let remaining = asset.bytes;
        while (remaining) {
          const read = await input.read(bytes, 0, Math.min(bytes.length, remaining));
          if (!read.bytesRead) invalid('A selected file changed during export.', 409);
          const chunk = bytes.subarray(0, read.bytesRead); hash.update(chunk); await writeAll(target, chunk); remaining -= read.bytesRead;
        }
        const extra = await input.read(bytes, 0, 1);
        if (extra.bytesRead || hash.digest('hex') !== asset.sha256) invalid('A selected file changed during export.', 409);
      } finally { await input.close(); }
    }
    await writeAll(target, END); await target.sync();
    return { bytes: total, createdAt, manifest };
  } catch (error) { await target.close(); await fs.rm(destination, { force: true }); throw error; }
  finally { await target.close().catch(() => {}); }
}

export async function isV2Archive(filename: string) {
  const handle = await openRegular(filename);
  try { const header = Buffer.alloc(8), read = await handle.read(header, 0, 8, 0); return read.bytesRead === 8 && header.equals(MAGIC); }
  finally { await handle.close(); }
}

/** A caller validates payload references before any asset is extracted. */
export async function readArchiveFile(source: string, stagingDir: string, validate: (manifest: ArchiveManifest) => void | Promise<void>) {
  const input = await openRegular(source);
  let created = false;
  try {
    const stat = await input.stat();
    if (stat.size > MAX_ARCHIVE_BYTES) invalid('The .lumen file exceeds the 1 TiB archive limit.', 413);
    const header = await readExact(input, 16);
    if (!header.subarray(0, 8).equals(MAGIC)) invalid('This is not a supported .lumen archive.');
    const compressedLength = header.readUInt32LE(8), count = header.readUInt32LE(12);
    if (compressedLength > MAX_COMPRESSED_MANIFEST_BYTES || compressedLength > stat.size - 24 || count > 20_000) invalid('Invalid .lumen archive manifest length.');
    let manifest: ArchiveManifest;
    try { manifest = manifestSchema.parse(JSON.parse(gunzipSync(await readExact(input, compressedLength), { maxOutputLength: MAX_MANIFEST_BYTES }).toString('utf8'))); }
    catch { invalid('The .lumen archive manifest is invalid or incomplete.'); }
    if (manifest.assets.length !== count || new Set(manifest.assets.map(asset => asset.id)).size !== count) invalid('Duplicate or inconsistent archive assets.');
    const expected = 16 + compressedLength + 8 + manifest.assets.reduce((sum, asset) => sum + 8 + asset.bytes, 0);
    if (!Number.isSafeInteger(expected) || expected !== stat.size) invalid('The .lumen archive has missing or unexpected bytes.');
    await validate(manifest);
    // Never remove or reuse an existing caller directory. Generated filenames
    // are independent of untrusted archive IDs, so traversal is impossible.
    await fs.mkdir(stagingDir, { mode: 0o700 }); created = true;
    const available = await fs.statfs(stagingDir);
    const binaryBytes = manifest.assets.reduce((sum, asset) => sum + asset.bytes, 0);
    if (binaryBytes + 16 * 1024 * 1024 > available.bavail * available.bsize) invalid('There is not enough free disk space to preview this archive.', 507);
    const files = new Map<string, string>();
    for (let index = 0; index < manifest.assets.length; index++) {
      const asset = manifest.assets[index], length = await readExact(input, 8);
      if (length.readBigUInt64LE() !== BigInt(asset.bytes)) invalid('An archive asset has an invalid length.');
      const filename = path.join(stagingDir, `${index}.asset`), output = await fs.open(filename, 'wx', 0o600), hash = createHash('sha256');
      try {
        let remaining = asset.bytes;
        while (remaining) {
          const bytes = await readExact(input, Math.min(CHUNK_BYTES, remaining));
          hash.update(bytes); await writeAll(output, bytes); remaining -= bytes.length;
        }
        await output.sync();
      } finally { await output.close(); }
      if (hash.digest('hex') !== asset.sha256) invalid('An archive asset failed its integrity check.');
      files.set(asset.id, filename);
    }
    if (!(await readExact(input, 8)).equals(END)) invalid('The .lumen archive is incomplete.');
    const trailing = Buffer.alloc(1);
    if ((await input.read(trailing, 0, 1)).bytesRead || (await input.stat()).size !== stat.size) invalid('The .lumen archive changed while it was being read.');
    return { manifest, files };
  } catch (error) { if (created) await fs.rm(stagingDir, { recursive: true, force: true }); throw error; }
  finally { await input.close(); }
}

export async function copyAssetFile(source: string, destination: string, expected: ArchiveAsset) {
  const input = await openRegular(source);
  let output: fs.FileHandle | undefined;
  try {
    output = await fs.open(destination, 'wx', 0o600);
    const bytes = Buffer.allocUnsafe(CHUNK_BYTES), hash = createHash('sha256'); let count = 0;
    for (;;) {
      const read = await input.read(bytes, 0, bytes.length); if (!read.bytesRead) break;
      count += read.bytesRead; if (count > expected.bytes) invalid('A staged archive asset changed before import.');
      const chunk = bytes.subarray(0, read.bytesRead); hash.update(chunk); await writeAll(output, chunk);
    }
    if (count !== expected.bytes || hash.digest('hex') !== expected.sha256) invalid('A staged archive asset changed before import.');
    await output.sync();
  } finally { await input.close(); await output?.close(); }
}

export async function verifyAssetFile(source: string, expected: ArchiveAsset) {
  const actual = await describe({ id: expected.id, path: source });
  if (actual.bytes !== expected.bytes || actual.sha256 !== expected.sha256) invalid('A staged archive asset changed before import.');
}
