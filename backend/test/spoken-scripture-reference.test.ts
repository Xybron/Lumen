import test from 'node:test';
import assert from 'node:assert/strict';
import { analyzeSpokenReferences, BOOK_NAMES, normalizeReference, parseReference, parseReferences } from '../src/scripture-reference.js';

const reference = (book: number, chapter?: number, verse?: number, endVerse?: number, complete = chapter !== undefined && verse !== undefined) => ({ book, chapter, verse, endVerse, complete });

test('spoken citations accept normal punctuation without crossing into another book', () => {
  for (const input of [
    'John 3:16', 'Jn3:16', 'John three sixteen', 'John, chapter three, verse sixteen',
    'Let us read John chapter three verse sixteen today.', 'John. 3:16',
  ]) assert.deepEqual(parseReferences(input), [reference(43, 3, 16)], input);
  assert.deepEqual(parseReferences('John chapter three. John chapter three verse sixteen'), [
    reference(43, 3), reference(43, 3, 16),
  ]);
  assert.deepEqual(parseReferences('John chapter three John chapter three verse sixteen'), [
    reference(43, 3), reference(43, 3, 16),
  ]);
  for (const input of ['Romans chapter eight and verse twenty eight', 'Romans eight verse twenty eight', 'Romans chapter eight, and verse twenty eight']) {
    assert.deepEqual(parseReferences(input), [reference(45, 8, 28)], input);
  }
  // Arbitrary intervening commentary is not evidence that these numbers form
  // one reference. Keep the chapter partial until a clear citation arrives.
  assert.deepEqual(parseReferences('John chapter three reading from verse sixteen'), [reference(43, 3)]);
});

test('book-name lists never borrow the next numbered book ordinal as a chapter', () => {
  for (const input of [
    'Romans, 1 Corinthians, Romans, 1 Peter',
    'Thessalonians, Romans, Romans, 1 Corinthians, Romans, Romans, 1 Peter, Romans',
    'John, 3 John, 2 John, 1 Peter',
    'Romans. 1 Corinthians. Romans. 1 Peter.',
  ]) assert.deepEqual(parseReferences(input), [], input);
  assert.deepEqual(parseReferences('Romans, 1 Corinthians chapter thirteen verse four'), [reference(46, 13, 4)]);
  assert.deepEqual(parseReferences('John 3:16, 1 Corinthians 13:4, Romans 8:28'), [
    reference(43, 3, 16), reference(46, 13, 4), reference(45, 8, 28),
  ]);
});

test('all numbered canonical books and exact compact aliases retain their identities', () => {
  for (let index = 0; index < BOOK_NAMES.length; index++) {
    assert.deepEqual(parseReferences(`${BOOK_NAMES[index]} 1:1`), [reference(index + 1, 1, 1)], BOOK_NAMES[index]);
  }
  for (const [input, book] of [
    ['First John chapter two verse four', 62], ['1Jn2:4', 62],
    ['Second Corinthians chapter two verse four', 47], ['2Cor2:4', 47],
    ['Third John chapter one verse four', 64], ['3Jn1:4', 64],
  ] as const) assert.deepEqual(parseReferences(input), [reference(book, book === 64 ? 1 : 2, 4)], input);
});

test('repeated references remain repeated so the caller can canonicalize them explicitly', () => {
  for (const input of [
    'John 3:16. John 3:16.',
    'John chapter three verse sixteen, John three sixteen',
    'John three sixteen and John three sixteen',
  ]) assert.deepEqual(parseReferences(input), [reference(43, 3, 16), reference(43, 3, 16)], input);
  assert.deepEqual(parseReferences('First John two four. First John two four.'), [reference(62, 2, 4), reference(62, 2, 4)]);
});

test('incomplete spoken citations cannot become complete through dangling separators', () => {
  assert.deepEqual(parseReference('John'), reference(43));
  assert.deepEqual(parseReference('John chapter three'), reference(43, 3));
  assert.deepEqual(parseReference('John 3:'), reference(43, 3));
  assert.deepEqual(parseReference('John 3 verse'), reference(43, 3));
  assert.deepEqual(parseReference('John 3:16-'), reference(43, 3, 16, undefined, false));
  assert.deepEqual(parseReference('John 3:16 through'), reference(43, 3, 16, undefined, false));
  assert.equal(parseReference('John 3:16:17')?.complete, false);
  assert.equal(parseReference('John verse sixteen'), null);
  assert.deepEqual(parseReference('Jude verse five'), reference(65, 1, 5));
  assert.deepEqual(parseReference('Jude chapter one'), reference(65, 1));
});

test('numeric limits and verse ranges reject malformed or out-of-bounds citations', () => {
  for (const input of [
    'John 0:16', 'John 3:0', 'John 151:1', 'John 3:201',
    'John 3:16-15', 'John 3:16-201', 'John 3:16-999',
    'John 3:1600', 'John 3:16garbage', 'John 316', 'Jude chapter two verse one',
  ]) assert.equal(parseReference(input), null, input);
  for (const input of ['John 3:16-18', 'John three sixteen through eighteen', 'John 3 verses 16 to 18']) {
    assert.deepEqual(parseReference(input), reference(43, 3, 16, 18), input);
  }
  assert.deepEqual(parseReference('Jude five through seven'), reference(65, 1, 5, 7));
});

test('manual reference normalization stays stable and ASR does not use fuzzy shortcuts', () => {
  assert.equal(normalizeReference('Psalm one hundred and thirty nine verse twenty three'), 'psalm 139 verse 23');
  assert.equal(normalizeReference('Jer.20.11'), 'jer 20 11');
  for (const input of ['jeremia 20 11', 'jeremaih20 11', 'jo3 16', 'jonn3 16', 'jn316', 'I am the way']) {
    assert.equal(parseReference(input), null, input);
  }
});

test('additional numeric tails never silently publish a truncated first verse', () => {
  for (const input of [
    'John3:16,17', 'John3:16/17', 'John3:16.17', 'John3:16 and17',
    'John3:16 and 17', 'John3:16;17', 'John3:16, and verse 17',
    'John3:16 to18 and20', 'John3:16-18,20', 'John3:16 to18:20',
  ]) {
    const analysis = analyzeSpokenReferences(input);
    assert.equal(analysis.invalid, true, input);
    assert.ok(analysis.references.every(reference => !reference.complete), input);
  }
  for (const input of ['John3:16. The preacher continued.', 'John3:16. Romans8:28', 'John3:16, and Romans8:28']) {
    const analysis = analyzeSpokenReferences(input);
    assert.equal(analysis.invalid, false, input);
    assert.ok(analysis.references.every(reference => reference.complete), input);
  }
});

test('invalid citation evidence survives parsing so quotations cannot bypass uncertainty', () => {
  const quote = 'The faithful shepherd guides the gathered people beside the peaceful river and restores their weary souls.';
  for (const citation of ['John0:16', 'John3:0', 'John151:1', 'John3:201', 'John3:16-15', 'John-3:16', 'John3:1600', 'John3:16garbage', 'John zero verse sixteen', 'John three verse zero']) {
    const analysis = analyzeSpokenReferences(`${citation} ${quote}`);
    assert.equal(analysis.invalid, true, citation);
    assert.deepEqual(analysis.references, [], citation);
  }
  for (const text of [quote, 'Romans, 1 Corinthians, Romans, 1 Peter', 'I am the way and the truth', 'The preacher mentioned John in a story.']) {
    assert.equal(analyzeSpokenReferences(text).invalid, false, text);
  }
  assert.equal(analyzeSpokenReferences('John chapter three').invalid, false, 'A valid incomplete citation is not malformed');
  assert.equal(normalizeReference('John zero verse sixteen'), 'john zero verse 16', 'Spoken-zero evidence does not change public/manual number normalization');
});

test('explicit correction markers before exact citations are separate from verse-text negation', () => {
  for (const input of [
    'not John3:16', 'not 1John3:16', 'Not First John chapter three verse sixteen',
    'instead of Jn3:16', 'rather than Romans chapter eight verse twenty eight',
    'not: John 3:16', 'not “John 3:16”', 'John3:16 and not Romans8:28',
  ]) {
    const analysis = analyzeSpokenReferences(input);
    assert.equal(analysis.negated, true, input);
    assert.ok(analysis.references.some(reference => reference.complete), input);
  }
  for (const input of [
    'John3:16 that whosoever believeth in him should not perish',
    'For God so loved the world that whosoever believeth should not perish',
    'John 3:16. The speaker said not to worry.', 'I am not the shepherd',
  ]) assert.equal(analyzeSpokenReferences(input).negated, false, input);
});
