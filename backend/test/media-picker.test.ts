import assert from 'node:assert/strict';
import test from 'node:test';
import {
  MAX_MEDIA_BYTES, mediaAccept, mediaAssetUrl, mediaDisplayName,
  mediaExtensions, mediaFilesForKind, mediaFileSize, mediaFormatHint, mediaSourceName,
} from '../../frontend/src/lib/studio/media-library';

const file = (name: string, modifiedAt?: string) => ({ name, path: `media/backgrounds/${name}`, modifiedAt });

test('media picker filters images, videos and audio without mixing asset kinds', () => {
  const files = ['logo.PNG', 'photo.JPEG', 'backdrop.jpg', 'still.webp', 'motion.gif', 'service.mp4', 'clip.WEBM', 'film.MOV', 'intro.m4v',
    'song.mp3', 'track.M4A', 'speech.wav', 'music.aac', 'sound.ogg', 'master.flac', 'notes.txt', 'image.png.backup', 'movie.mp4.exe'].map(name => file(name));
  assert.deepEqual(mediaFilesForKind(files, 'image').map(asset => asset.name).sort(), ['backdrop.jpg', 'logo.PNG', 'motion.gif', 'photo.JPEG', 'still.webp'].sort());
  assert.deepEqual(mediaFilesForKind(files, 'video').map(asset => asset.name).sort(), ['service.mp4', 'clip.WEBM', 'film.MOV', 'intro.m4v'].sort());
  assert.deepEqual(mediaFilesForKind(files, 'audio').map(asset => asset.name).sort(), ['song.mp3', 'track.M4A', 'speech.wav', 'music.aac', 'sound.ogg', 'master.flac'].sort());
});

test('media picker accepted extensions, filtering and format hints agree', () => {
  for (const kind of ['image', 'video', 'audio'] as const) {
    assert.ok(mediaFormatHint[kind].length > 0);
    for (const extension of mediaAccept[kind].split(',')) {
      assert.ok(mediaExtensions[kind].test(`asset${extension}`), `${kind}: ${extension}`);
      assert.ok(mediaExtensions[kind].test(`ASSET${extension.toUpperCase()}`), `${kind}: uppercase ${extension}`);
    }
    assert.equal(mediaExtensions[kind].test('filename'), false);
  }
  assert.equal(MAX_MEDIA_BYTES, 200 * 1024 * 1024);
});

test('library search is case-insensitive, trimmed and searches the human filename', () => {
  const files = [file('1792300000000-Sunday Welcome.png'), file('1792300000001-Sunday worship.mp4'), file('1792300000002-Youth Evening.PNG')];
  assert.deepEqual(mediaFilesForKind(files, 'image', '  sUnDaY  ').map(asset => asset.name), ['1792300000000-Sunday Welcome.png']);
  assert.deepEqual(mediaFilesForKind(files, 'image', 'youth even').map(asset => asset.name), ['1792300000002-Youth Evening.PNG']);
  assert.deepEqual(mediaFilesForKind(files, 'image', '1792300000000'), [], 'internal upload timestamps are not exposed as searchable names');
  assert.deepEqual(mediaFilesForKind(files, 'image', '   '), mediaFilesForKind(files, 'image'));
  assert.deepEqual(mediaFilesForKind(files, 'image', 'missing'), []);
});

test('newest library files are first with deterministic alphabetical ties and no input mutation', () => {
  const files = [
    file('Zed.png', '2026-10-17T10:00:00.000Z'),
    file('Unknown.png'),
    file('Alpha.png', '2026-10-17T10:00:00.000Z'),
    file('Newest.png', '2026-10-18T10:00:00.000Z'),
    file('Invalid.png', 'not-a-date'),
  ];
  const original = structuredClone(files);
  assert.deepEqual(mediaFilesForKind(files, 'image').map(asset => asset.name), ['Newest.png', 'Alpha.png', 'Zed.png', 'Invalid.png', 'Unknown.png']);
  assert.deepEqual(files, original);
  assert.deepEqual(mediaFilesForKind([], 'audio'), []);
});

test('display names hide only station upload prefixes and preserve meaningful filenames', () => {
  assert.equal(mediaDisplayName('1792300000000-Sunday Welcome.png'), 'Sunday Welcome.png');
  assert.equal(mediaDisplayName('2026-Sunday Welcome.png'), '2026-Sunday Welcome.png');
  assert.equal(mediaDisplayName('12345678901234-logo.png'), '12345678901234-logo.png');
  assert.equal(mediaDisplayName('1792300000000logo.png'), '1792300000000logo.png');
  assert.equal(mediaDisplayName('Church #1 · 50%.PNG'), 'Church #1 · 50%.PNG');
});

test('source names drop the upload prefix and final extension and respect the Studio limit', () => {
  assert.equal(mediaSourceName('1792300000000-Message.final.MP4'), 'Message.final');
  assert.equal(mediaSourceName('Church logo.png'), 'Church logo');
  assert.equal(mediaSourceName('No extension'), 'No extension');
  assert.equal(mediaSourceName(`${'a'.repeat(130)}.png`), 'a'.repeat(100));
});

test('media sizes are concise and invalid or unknown sizes stay absent', () => {
  for (const input of [undefined, Number.NaN, Infinity, -1]) assert.equal(mediaFileSize(input), '');
  assert.equal(mediaFileSize(0), '0 B');
  assert.equal(mediaFileSize(1), '1 B');
  assert.equal(mediaFileSize(1023), '1023 B');
  assert.equal(mediaFileSize(1024), '1 KB');
  assert.equal(mediaFileSize(1536), '2 KB');
  assert.equal(mediaFileSize(1024 * 1024), '1.0 MB');
  assert.equal(mediaFileSize(2.5 * 1024 * 1024), '2.5 MB');
  assert.equal(mediaFileSize(MAX_MEDIA_BYTES), '200.0 MB');
});

test('library URLs encode reserved filename characters without interpreting them as URL syntax', () => {
  assert.equal(mediaAssetUrl('media/backgrounds/Church #1? 50%.png'), '/media/backgrounds/Church%20%231%3F%2050%25.png');
  assert.equal(mediaAssetUrl('/media/backgrounds/Church + choir.png'), '/media/backgrounds/Church%20%2B%20choir.png');
  assert.equal(mediaAssetUrl('///media/music/Abide & sing.m4a'), '/media/music/Abide%20%26%20sing.m4a');
  assert.equal(mediaAssetUrl('media/backgrounds/already%20named.png'), '/media/backgrounds/already%2520named.png', 'a literal percent sequence in a filename is not decoded');
  assert.equal(mediaAssetUrl('media/backgrounds/Église.jpg'), '/media/backgrounds/%C3%89glise.jpg');
  assert.equal(new URL(mediaAssetUrl('//other.example/path.png'), 'https://station.test').origin, 'https://station.test', 'library paths cannot become scheme-relative remote media');
  assert.equal(new URL(mediaAssetUrl('https://other.example/file.png'), 'https://station.test').origin, 'https://station.test', 'scheme-like names remain local paths');
});
