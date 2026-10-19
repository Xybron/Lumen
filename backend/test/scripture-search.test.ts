import test from 'node:test';
import assert from 'node:assert/strict';
import { performance } from 'node:perf_hooks';
import { BOOK_NAMES, parseReference } from '../src/scripture-reference.js';
import { resolveScriptureSearch } from '../src/scripture-search.js';

test('manual Scripture search resolves brief, compact and punctuation-free references', () => {
  for (const input of ['jeremia 20 11', 'jer20:11', 'Jer.20.11', 'jeremiah20 11', 'Jeremiah chapter twenty verse eleven']) {
    const result = resolveScriptureSearch(input);
    assert.equal(result.kind, 'reference', input);
    assert.equal(result.label, 'Jeremiah 20:11', input);
    assert.deepEqual(result.reference, { book: 24, chapter: 20, verse: 11, endVerse: undefined, complete: true }, input);
  }
  for (const input of ['jn3:16', 'jhn3 16', 'John3v16', 'John 3 verse 16', 'Ｊｎ３：１６']) assert.equal(resolveScriptureSearch(input).label, 'John 3:16', input);
  assert.equal(resolveScriptureSearch('jeremia').label, 'Jeremiah');
  assert.equal(resolveScriptureSearch('jn3:').label, 'John 3');
});

test('numbered books, multiword books and verse ranges keep their identity', () => {
  for (const input of ['1cor13 4', '1 Cor. 13:4', 'First Corinthians 13:4', '1stcor13:4', 'I Corinthians 13 4']) assert.equal(resolveScriptureSearch(input).label, '1 Corinthians 13:4', input);
  for (const input of ['2Jn1:4', 'second John 1 4', 'II John 1:4']) assert.equal(resolveScriptureSearch(input).label, '2 John 1:4', input);
  for (const input of ['jn3 16-18', 'John3:16–18', 'John 3:16 through 18']) assert.equal(resolveScriptureSearch(input).label, 'John 3:16–18', input);
  assert.equal(resolveScriptureSearch('song of sol3 1').label, 'Song of Solomon 3:1');
  assert.equal(resolveScriptureSearch('song of songs 3:1').label, 'Song of Solomon 3:1');
  assert.equal(resolveScriptureSearch('sos3:1').label, 'Song of Solomon 3:1');
  assert.equal(resolveScriptureSearch('Jude5-7').label, 'Jude 1:5–7');
  assert.equal(resolveScriptureSearch('Jude chapter1').label, 'Jude 1');
  assert.equal(resolveScriptureSearch('Jude verse5').label, 'Jude 1:5');
});

test('all canonical book names and exact abbreviations take precedence over prefixes', () => {
  for (let index = 0; index < BOOK_NAMES.length; index++) {
    const result = resolveScriptureSearch(`${BOOK_NAMES[index]} 1:1`);
    assert.equal(result.kind, 'reference', BOOK_NAMES[index]);
    assert.equal(result.reference?.book, index + 1, BOOK_NAMES[index]);
    assert.equal(result.match, 'exact', BOOK_NAMES[index]);
  }
  assert.equal(resolveScriptureSearch('am1:1').reference?.book, 30);
  assert.equal(resolveScriptureSearch('jn3:16').match, 'exact');
  assert.equal(resolveScriptureSearch('1co13:4').reference?.book, 46);
  assert.equal(resolveScriptureSearch('1ch13:4').reference?.book, 13);
});

test('ambiguous short prefixes return book choices without silently resolving a verse', () => {
  const result = resolveScriptureSearch('jo3 16');
  assert.equal(result.kind, 'ambiguous');
  assert.equal(result.reference, null);
  assert.equal(result.match, 'ambiguous');
  assert.deepEqual(result.candidates.map(candidate => candidate.reference.book), [6, 18, 29, 32, 43, 62, 63, 64]);
  assert.ok(result.candidates.every(candidate => candidate.reference.chapter === 3 && candidate.reference.verse === 16));
  assert.equal(resolveScriptureSearch('ma1').kind, 'ambiguous');
  assert.deepEqual(resolveScriptureSearch('1c1').candidates.map(candidate => candidate.reference.book), [13, 46]);
  assert.equal(resolveScriptureSearch('jo').kind, 'ambiguous');
});

test('omitting a numbered-book ordinal offers its family instead of guessing', () => {
  for (const [input, expected] of [
    ['cor13 4', [46, 47]], ['corinthians13:4', [46, 47]],
    ['sam3 1', [9, 10]], ['tim2 1', [54, 55]], ['pet1 3', [60, 61]],
    ['co1:1', [46, 47, 51]], ['chro1:1', [13, 14]], ['samuell3 1', [9, 10]],
  ] as const) {
    const result = resolveScriptureSearch(input);
    assert.equal(result.kind, 'ambiguous', input);
    assert.equal(result.reference, null, input);
    assert.deepEqual(result.candidates.map(candidate => candidate.reference.book), [...expected], input);
  }
  for (const [input, book] of [['John3:16', 43], ['col1:1', 51], ['1co13:4', 46], ['1sam3:1', 9]] as const) {
    assert.equal(resolveScriptureSearch(input).kind, 'reference', input);
    assert.equal(resolveScriptureSearch(input).reference?.book, book, input);
    assert.equal(resolveScriptureSearch(input).match, 'exact', input);
  }
  assert.equal(resolveScriptureSearch('cor 13 says love is patient').kind, 'text');
  assert.equal(resolveScriptureSearch('jn316').kind, 'invalid');
});

test('bounded manual typo tolerance handles missing letters and adjacent transpositions', () => {
  for (const [input, label] of [
    ['jeremaih20 11', 'Jeremiah 20:11'], ['mathew5 3', 'Matthew 5:3'],
    ['pslams23 1', 'Psalms 23:1'], ['jonn3 16', 'John 3:16'],
    ['phillipians4 6', 'Philippians 4:6'], ['romn8 28', 'Romans 8:28'],
  ]) {
    const result = resolveScriptureSearch(input);
    assert.equal(result.label, label, input);
    assert.equal(result.match, 'corrected', input);
  }
  assert.equal(resolveScriptureSearch('xyz3:16').kind, 'text');
  assert.equal(resolveScriptureSearch('love').kind, 'text');
  assert.equal(resolveScriptureSearch('hope').kind, 'text');
});

test('only whole valid references resolve; compact digits are never guessed into a chapter and verse', () => {
  for (const input of ['job has heard the voice', 'John 3 says God loves the world', 'John 3:16 and Romans 8:28', 'John 3:16garbage', 'the Lord is my shepherd', 'For God so loved', '', 'x'.repeat(501)]) {
    assert.equal(resolveScriptureSearch(input).kind, 'text', input);
    assert.equal(resolveScriptureSearch(input).reference, null, input);
  }
  for (const input of ['jn316', 'John0:16', 'John3:0', 'John3:16-15', 'John3:16-201', 'John3-5', 'John verse16']) {
    assert.equal(resolveScriptureSearch(input).kind, 'invalid', input);
    assert.equal(resolveScriptureSearch(input).reference, null, input);
  }
  assert.equal(resolveScriptureSearch('jn31').label, 'John 31');
  assert.equal(resolveScriptureSearch('jn31').reference?.verse, undefined);
});

test('manual tolerance does not change the strict spoken-reference parser', () => {
  assert.equal(parseReference('jeremia 20 11'), null);
  assert.equal(parseReference('jeremaih20 11'), null);
  assert.equal(parseReference('jo3 16'), null);
  assert.equal(parseReference('John 3:16')?.book, 43);
});

test('cached finite book matching stays fast across common search keystrokes', () => {
  const inputs = ['j', 'jo', 'joh', 'john', 'john3', 'john3:', 'john3:1', 'john3:16', 'jeremia20 11', 'jeremaih20 11', 'mathew5 3', 'for God loved world'];
  const started = performance.now();
  for (let iteration = 0; iteration < 500; iteration++) for (const input of inputs) resolveScriptureSearch(input);
  const elapsed = performance.now() - started;
  console.log(`Manual Scripture resolver: ${(elapsed / (500 * inputs.length)).toFixed(3)} ms/query over ${500 * inputs.length} lookups.`);
  // Generous regression guard, not a device-specific frame-time promise.
  assert.ok(elapsed < 5000, `6000 finite book lookups took ${elapsed.toFixed(0)} ms`);
});
