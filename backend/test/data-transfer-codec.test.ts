import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { writeArchiveFile, readArchiveFile, copyAssetFile, isV2Archive } from '../src/data-transfer-codec.js';

test('v2 streams recordings beyond the legacy 128 MiB limit and rejects damaged frames without leftover files', { timeout: 30_000 }, async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'lumen-framed-archive-'));
  try {
    const input = path.join(dir, 'recording.webm'), output = path.join(dir, 'service.lumen');
    const file = await fs.open(input, 'wx');
    await file.truncate(129 * 1024 * 1024 + 17); await file.write(Buffer.from('Synthetic recording tail'), 0, 24, 129 * 1024 * 1024 - 24); await file.close();
    const id = 'recordings/rec_fixture/recording.webm';
    const exported = await writeArchiveFile(output, { test: 'Only synthetic fixtures' }, [{ id, path: input }]);
    assert.ok(exported.bytes > 128 * 1024 * 1024); assert.equal(await isV2Archive(output), true);
    const decoded = await readArchiveFile(output, path.join(dir, 'decoded'), manifest => {
      assert.equal(manifest.version, 2); assert.deepEqual(manifest.payload, { test: 'Only synthetic fixtures' });
    });
    const asset = decoded.manifest.assets[0];
    assert.equal(asset.bytes, (await fs.stat(input)).size);
    await copyAssetFile(decoded.files.get(id)!, path.join(dir, 'copied.webm'), asset);
    assert.equal((await fs.stat(path.join(dir, 'copied.webm'))).size, asset.bytes);

    const handle = await fs.open(output, 'r+');
    const header = Buffer.alloc(16); await handle.read(header, 0, 16, 0);
    const position = 16 + header.readUInt32LE(8) + 8 + 100;
    await handle.write(Buffer.from([42]), 0, 1, position); await handle.close();
    await assert.rejects(() => readArchiveFile(output, path.join(dir, 'corrupt'), () => {}), /integrity/);
    await assert.rejects(() => fs.access(path.join(dir, 'corrupt')));
    await fs.truncate(output, exported.bytes - 1);
    await assert.rejects(() => readArchiveFile(output, path.join(dir, 'truncated'), () => {}), /missing|incomplete/);
    await assert.rejects(() => fs.access(path.join(dir, 'truncated')));
  } finally { await fs.rm(dir, { recursive: true, force: true }); }
});

test('v2 validates before extraction, refuses duplicate IDs, and never reuses an existing extraction directory', async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'lumen-framed-validation-'));
  try {
    const input = path.join(dir, 'asset.png'), output = path.join(dir, 'small.lumen'); await fs.writeFile(input, 'synthetic');
    await assert.rejects(() => writeArchiveFile(output, {}, [{ id: 'same', path: input }, { id: 'same', path: input }]), /Duplicate/);
    await writeArchiveFile(output, {}, [{ id: '../../escape', path: input }]);
    await assert.rejects(() => readArchiveFile(output, path.join(dir, 'rejected'), () => { throw new Error('Invalid application payload'); }), /Invalid application/);
    await assert.rejects(() => fs.access(path.join(dir, 'rejected')));
    const staged = path.join(dir, 'staged'); await fs.mkdir(staged); await fs.writeFile(path.join(staged, 'retained'), 'Keep');
    await assert.rejects(() => readArchiveFile(output, staged, () => {}), /EEXIST/);
    assert.equal(await fs.readFile(path.join(staged, 'retained'), 'utf8'), 'Keep');
    const decoded = await readArchiveFile(output, path.join(dir, 'generated'), () => {});
    assert.equal(decoded.files.get('../../escape'), path.join(dir, 'generated', '0.asset'));
    const extracted = decoded.files.get('../../escape')!; await fs.writeFile(extracted, 'tampered');
    await assert.rejects(() => copyAssetFile(extracted, path.join(dir, 'invalid-copy'), decoded.manifest.assets[0]), /changed/);
  } finally { await fs.rm(dir, { recursive: true, force: true }); }
});

test('v2 rejects impossible manifest sizes and archives modified during preview', async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'lumen-framed-bounds-'));
  try {
    const filename = path.join(dir, 'empty.lumen'); await writeArchiveFile(filename, {}, []);
    await assert.rejects(() => readArchiveFile(filename, path.join(dir, 'changed'), async () => { await fs.appendFile(filename, 'unexpected'); }), /changed/);
    await assert.rejects(() => fs.access(path.join(dir, 'changed')));
    const oversized = path.join(dir, 'oversized.lumen'), bytes = Buffer.alloc(24);
    Buffer.from('LUMEN2\r\n').copy(bytes); bytes.writeUInt32LE(0xffffffff, 8);
    await fs.writeFile(oversized, bytes);
    await assert.rejects(() => readArchiveFile(oversized, path.join(dir, 'oversized'), () => {}), /manifest length/);
    await assert.rejects(() => fs.access(path.join(dir, 'oversized')));
  } finally { await fs.rm(dir, { recursive: true, force: true }); }
});
