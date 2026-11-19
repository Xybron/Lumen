import test from 'node:test';
import assert from 'node:assert/strict';
import { presentationItem, samePresentationItem } from '../../frontend/src/lib/presentation-state.ts';
import type { Item, ProjectionState } from '../../frontend/src/types.ts';
const a: Item = { id: 'a', type: 'prayer', durationMs: 30000 };
const b: Item = { id: 'b', type: 'prayer', durationMs: 30000 };
const state = (index: number, itemId?: string): ProjectionState => ({ channelId: 'channel', playlistId: 'deck', index, itemId, mode: 'manual', playing: true, blanked: false, durationMs: 30000, startedAt: null });

test('presentation mirrors remain on the same cue in either state/content delivery order', () => {
  const original = [a, b], reordered = [b, a], before = state(0, 'a'), after = state(1, 'a');
  assert.equal(presentationItem(original, before), a);
  assert.equal(presentationItem(original, after), a, 'New index with old manifest cannot select the neighbour');
  assert.equal(presentationItem(reordered, before), a, 'New manifest with old index cannot select the neighbour');
  assert.equal(presentationItem(reordered, after), a);
  assert.equal(samePresentationItem(before, after), true, 'A reorder preserves the running clock');
  assert.equal(samePresentationItem(before, state(0, 'b')), false, 'An actual new slide resets time even at the same index');
  assert.equal(presentationItem([b], after), undefined, 'Missing ID never resolves to another slide');
  assert.equal(presentationItem(original, state(1)), b, 'Old senders still use the numeric index');
  assert.equal(samePresentationItem(state(0), state(0)), true);
});
