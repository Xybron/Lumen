import test from 'node:test';
import assert from 'node:assert/strict';
import { formatSongLyrics, splitSongLyrics } from '../../frontend/src/lib/worship/song-paste.js';

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

test('existing songs roundtrip with names, literal headings, internal blanks and stable IDs', () => {
  const original = [
    { id: 'verse', label: 'Verse 1', text: 'First line\nChorus\n[Sing together]\n\n  An indented line  \n\\A literal slash' },
    { id: 'response', label: 'Response [all] \\ repeated\nsoftly', text: 'Sing together\nSing again' },
    { id: 'repeat', label: 'Response [all] \\ repeated\nsoftly', text: 'Sing together\nSing again' },
    { id: 'unnamed', label: '', text: 'A quiet ending' },
  ];
  const formatted = formatSongLyrics(original);
  assert.deepEqual(splitSongLyrics(formatted, 'blank', original), original);
  const edited = splitSongLyrics(formatted.replace('A quiet ending', 'A new ending'), 'blank', original);
  assert.deepEqual(edited.slice(0, 3), original.slice(0, 3), 'Editing another section preserves literal lyrics');
  assert.deepEqual(edited[3], { ...original[3], text: 'A new ending' });
  const lines = splitSongLyrics(formatted, 'line', original);
  assert.ok(lines.every(section => section.text.trim()), 'Internal blank lines cannot create empty sections');
  assert.deepEqual(lines.slice(0, 5).map(section => section.text), [
    'First line', 'Chorus', '[Sing together]', '  An indented line  ', '\\A literal slash',
  ]);
  assert.deepEqual(splitSongLyrics(formatted, 'blank', original), original, 'Returning to Blank line restores the saved boundaries');
});

test('ordinary songs format as readable pasted lyrics and retain 80-character custom headings', () => {
  const original = [
    { id: 'one', label: 'Verse 1', text: 'First line\nSecond line' },
    { id: 'two', label: '', text: 'Final line' },
    { id: 'three', label: ']'.repeat(80), text: 'Together' },
  ];
  assert.ok(formatSongLyrics(original).startsWith('[Verse 1]\nFirst line\nSecond line\n\nFinal line\n\n'));
  assert.deepEqual(splitSongLyrics(formatSongLyrics(original), 'blank', original), original);
});
