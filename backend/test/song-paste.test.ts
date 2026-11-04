import test from 'node:test';
import assert from 'node:assert/strict';
import { splitSongLyrics } from '../../frontend/src/lib/worship/song-paste.js';

test('pasted headings, Windows newlines and whitespace-only separators produce lyric sections', () => {
  const text = '  [Verse 1]\r\n\r\nFirst line\r\nSecond line\r\n \t\r\nChorus:\r\nWe sing a chorus\r\n\r\n\r\nFinal line [together]';
  const blank = splitSongLyrics(text, 'blank');
  assert.deepEqual(blank.map(s => [s.label, s.text]), [
    ['Verse 1', 'First line\nSecond line'], ['Chorus', 'We sing a chorus'], ['', 'Final line [together]'],
  ]);
  const lines = splitSongLyrics(text, 'line');
  assert.deepEqual(lines.map(s => s.label), ['Verse 1', 'Verse 1', 'Chorus', '']);
  assert.equal(new Set(lines.map(s => s.id)).size, 4);
  assert.deepEqual(splitSongLyrics('[Bridge]\r\n  \n', 'blank'), []);
});

test('section identity follows reordered headings, repeated choruses and edits in place', () => {
  const original = splitSongLyrics('[Refrain]\nSing\n\n[Tag]\nSing\n\nRepeat\n\nRepeat','blank');
  const reordered = splitSongLyrics('[Tag]\nSing\n\n[Refrain]\nSing\n\nRepeat\n\nRepeat','blank',original);
  assert.deepEqual(reordered.map(s => s.id), [original[1].id, original[0].id, original[2].id, original[3].id]);
  const edited = splitSongLyrics('[New name]\nSing\n\n[Refrain]\nSing louder\n\nRepeat\n\nRepeat','blank',reordered);
  assert.deepEqual(edited.map(s => s.id), reordered.map(s => s.id));
  const inserted = splitSongLyrics('Intro music\n\n[New name]\nSing\n\n[Refrain]\nSing louder\n\nRepeat\n\nRepeat','blank',edited);
  assert.deepEqual(inserted.slice(1).map(s => s.id), edited.map(s => s.id));
  assert.ok(!edited.some(s => s.id === inserted[0].id));
});
