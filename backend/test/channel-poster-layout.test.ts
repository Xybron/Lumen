import test from 'node:test';
import assert from 'node:assert/strict';
import { createChannelPosterLayoutCache } from '../../frontend/src/lib/studio/channel-poster-layout.js';
import type { Item } from '../../frontend/src/types.js';

test('channel poster layouts reuse measurements but follow mutable lyrics and credits', () => {
  let measures = 0;
  const layout = createChannelPosterLayoutCache((text, size) => { measures++; return text.length * size * .5; });
  const item: Item = { id: 'cue_song', type: 'lyrics', body: 'A shared lyric', reference: 'Verse 1', subtitle: 'Original credit', durationMs: 0 };
  const first = layout(item, 1920, 300, 68, 500), initialMeasures = measures;
  assert.ok(initialMeasures > 0);
  assert.strictEqual(layout(item, 1920, 300, 68, 500), first);
  assert.equal(measures, initialMeasures, 'Equivalent scenes and unrelated Studio updates must not remeasure');
  item.body = 'An edited lyric';
  const edited = layout(item, 1920, 300, 68, 500);
  assert.notStrictEqual(edited, first);
  assert.equal(edited.blocks[0].lines.join('\n'), item.body);
  item.reference = 'Chorus'; item.subtitle = 'Updated credit';
  const credited = layout(item, 1920, 300, 68, 500);
  assert.equal(credited.blocks[1].lines.join('\n'), 'Chorus');
  assert.equal(credited.blocks[2].lines.join('\n'), 'Updated credit');
  assert.notStrictEqual(layout(item, 960, 300, 68, 500), credited, 'Different layer geometry needs its own fit');
});

test('poster cache is bounded and legacy stanza changes produce a new fit', () => {
  const layout = createChannelPosterLayoutCache((text, size) => text.length * size * .5, 2);
  const item: Item = { id: 'legacy', type: 'lyrics', stanzas: [{ id: 'verse', lines: 'First verse' }], durationMs: 0 };
  const first = layout(item, 1000, 300, 68, 500);
  layout(item, 1200, 300, 68, 500); layout(item, 1400, 300, 68, 500);
  assert.notStrictEqual(layout(item, 1000, 300, 68, 500), first, 'Old geometry variants are evicted');
  item.stanzas![0].lines = 'Revised verse';
  assert.equal(layout(item, 1000, 300, 68, 500).blocks[0].lines.join('\n'), 'Revised verse');
});
