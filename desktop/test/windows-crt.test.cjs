'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const os = require('node:os');

test('Windows CRT discovery selects the newest x64 release and honors case-insensitive developer environment keys', async () => {
  const { findWindowsCrt } = await import('../scripts/prepare-windows-crt.mjs');
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'lumen-crt-test-'));
  try {
    const redists = path.join(root, 'VC', 'Redist', 'MSVC');
    for (const version of ['14.39.1', '14.44.1']) await fs.mkdir(path.join(redists, version, 'x64', 'Microsoft.VC143.CRT'), { recursive: true });
    await fs.mkdir(path.join(redists, '14.99.1', 'x86', 'Microsoft.VC143.CRT'), { recursive: true });
    await fs.mkdir(path.join(redists, 'debug_nonredist', 'x64', 'Microsoft.VC143.DebugCRT'), { recursive: true });
    const newest = await findWindowsCrt({ env: { vsinstalldir: root } });
    assert.equal(path.basename(newest.redist), '14.44.1');
    const explicit = await findWindowsCrt({ env: { vctoolsredistdir: path.join(redists, '14.39.1') } });
    assert.equal(path.basename(explicit.redist), '14.39.1');
    await assert.rejects(findWindowsCrt({ env: {} }), /build machine needs/);
  } finally { await fs.rm(root, { recursive: true, force: true }); }
});

test('Windows CRT copying validates architecture before copying unmodified DLLs and preserves supplied notices', async () => {
  const { copyWindowsCrt } = await import('../scripts/prepare-windows-crt.mjs');
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'lumen-crt-copy-'));
  try {
    const redist = path.join(root, '14.44.1'), directory = path.join(redist, 'x64', 'Microsoft.VC143.CRT');
    const resources = path.join(root, 'resources');
    await fs.mkdir(directory, { recursive: true });
    const pe = Buffer.alloc(128); pe.write('MZ'); pe.writeUInt32LE(64, 0x3c); pe.writeUInt32LE(0x4550, 64); pe.writeUInt16LE(0x8664, 68); pe.writeUInt16LE(0x20b, 88);
    const files = ['vcruntime140.dll', 'vcruntime140_1.dll', 'msvcp140.dll'];
    for (const file of files) await fs.writeFile(path.join(directory, file), pe);
    await fs.writeFile(path.join(redist, 'License.txt'), 'Synthetic supplied notice');
    const inventory = await copyWindowsCrt({ directory, redist }, resources);
    assert.equal(inventory.length, 3);
    for (const file of files) assert.deepEqual(await fs.readFile(path.join(resources, 'runtime', file)), pe);
    assert.equal(await fs.readFile(path.join(resources, 'runtime', 'licenses', 'microsoft-vc', 'Redist-License.txt'), 'utf8'), 'Synthetic supplied notice');
    pe.writeUInt16LE(0x14c, 68);
    await fs.writeFile(path.join(directory, files[0]), pe);
    const invalidOutput = path.join(root, 'invalid-output');
    await assert.rejects(copyWindowsCrt({ directory, redist }, invalidOutput), /Expected an x64/);
    await assert.rejects(fs.access(invalidOutput), { code: 'ENOENT' });
  } finally { await fs.rm(root, { recursive: true, force: true }); }
});
