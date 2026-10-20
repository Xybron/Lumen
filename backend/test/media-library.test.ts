import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { listMediaLibrary } from '../src/media-library.js';
import type { MediaKind } from '../src/paths.js';

async function fixture(t: { after: (fn: () => Promise<void>) => void }) {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'lumen-media-library-'));
  t.after(() => fs.rm(dir, { recursive: true, force: true }));
  await fs.mkdir(path.join(dir, 'backgrounds'));
  await fs.mkdir(path.join(dir, 'music'));
  await fs.mkdir(path.join(dir, 'thumbnails'));
  return dir;
}

async function file(dir: string, relative: string, value = 'fixture', seconds = 1_700_000_000) {
  const absolute = path.join(dir, relative);
  await fs.writeFile(absolute, value);
  await fs.utimes(absolute, seconds, seconds);
  return absolute;
}

test('media listing retains existing paths and supplies available preview/file metadata without writes', async t => {
  const dir = await fixture(t);
  await file(dir, 'backgrounds/1700000000000-Church.jpg', 'original');
  await file(dir, 'backgrounds/1700000000001-Service.mp4', 'movie');
  await file(dir, 'thumbnails/1700000000000-Church.jpg', 'thumb', 1_700_000_001);
  await file(dir, 'thumbnails/1700000000001-Service.jpg', 'thumb', 1_700_000_001);
  const originalNames = await fs.readdir(path.join(dir, 'backgrounds'));
  const thumbnailNames = await fs.readdir(path.join(dir, 'thumbnails'));
  const items = await listMediaLibrary('backgrounds', dir);
  assert.deepEqual(items, [
    {
      name: '1700000000000-Church.jpg', path: 'media/backgrounds/1700000000000-Church.jpg',
      thumbnail: 'media/thumbnails/1700000000000-Church.jpg', bytes: 8, modifiedAt: '2023-11-14T22:13:20.000Z',
    },
    {
      name: '1700000000001-Service.mp4', path: 'media/backgrounds/1700000000001-Service.mp4',
      thumbnail: 'media/thumbnails/1700000000001-Service.jpg', bytes: 5, modifiedAt: '2023-11-14T22:13:20.000Z',
    },
  ]);
  assert.deepEqual(await fs.readdir(path.join(dir, 'backgrounds')), originalNames);
  assert.deepEqual(await fs.readdir(path.join(dir, 'thumbnails')), thumbnailNames);
});

test('legacy, missing, stale, empty, non-visual, and ambiguous thumbnails fall back to null', async t => {
  const dir = await fixture(t);
  await file(dir, 'backgrounds/legacy.png');
  await file(dir, 'backgrounds/stale.mov');
  await file(dir, 'thumbnails/stale.jpg', 'old preview', 1_699_999_999);
  await file(dir, 'backgrounds/empty.webp');
  await file(dir, 'thumbnails/empty.jpg', '', 1_700_000_001);
  await file(dir, 'backgrounds/duplicate.png');
  await file(dir, 'backgrounds/duplicate.mp4');
  await file(dir, 'thumbnails/duplicate.jpg', 'uncertain origin', 1_700_000_001);
  await file(dir, 'backgrounds/notes.txt');
  await file(dir, 'thumbnails/notes.jpg', 'unrelated', 1_700_000_001);
  await file(dir, 'thumbnails/orphan.jpg', 'no original', 1_700_000_001);
  const items = await listMediaLibrary('backgrounds', dir);
  assert.equal(items.length, 6);
  assert.equal(items.every(item => item.thumbnail === null), true);
  assert.equal(items.some(item => item.name === 'orphan.jpg'), false);
  assert.equal((await fs.readdir(path.join(dir, 'thumbnails'))).length, 5);
});

test('listing excludes hidden files, folders, source symlinks and symlink previews', async t => {
  const dir = await fixture(t);
  const outside = await file(dir, 'outside.jpg');
  await fs.mkdir(path.join(dir, 'backgrounds', 'nested'));
  await file(dir, 'backgrounds/.hidden.jpg');
  await fs.symlink(outside, path.join(dir, 'backgrounds', 'linked.jpg'));
  await file(dir, 'backgrounds/real.png');
  await fs.symlink(outside, path.join(dir, 'thumbnails', 'real.jpg'));
  const items = await listMediaLibrary('backgrounds', dir);
  assert.equal(items.length, 1);
  assert.equal(items[0].name, 'real.png');
  assert.equal(items[0].thumbnail, null);
});

test('music remains listed with original audio URL and no image thumbnail', async t => {
  const dir = await fixture(t);
  await file(dir, 'music/Worship.mp3', 'audio');
  await file(dir, 'thumbnails/Worship.jpg', 'unrelated', 1_700_000_001);
  assert.deepEqual(await listMediaLibrary('music', dir), [{
    name: 'Worship.mp3', path: 'media/music/Worship.mp3', thumbnail: null,
    bytes: 5, modifiedAt: '2023-11-14T22:13:20.000Z',
  }]);
});

test('missing library is empty, invalid kinds are rejected, other I/O errors are not hidden', async t => {
  const dir = await fixture(t);
  assert.deepEqual(await listMediaLibrary('backgrounds', path.join(dir, 'missing')), []);
  await assert.rejects(listMediaLibrary('../' as MediaKind, dir), /bad kind/);
  await fs.rm(path.join(dir, 'backgrounds'), { recursive: true });
  await file(dir, 'backgrounds', 'not a directory');
  await assert.rejects(listMediaLibrary('backgrounds', dir), { code: 'ENOTDIR' });
});
