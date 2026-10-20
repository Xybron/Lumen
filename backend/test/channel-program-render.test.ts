import assert from 'node:assert/strict';
import test from 'node:test';
import { channelText, layoutChannelOverlay } from '../../frontend/src/lib/studio/channel-overlay';
import { AnimationRunTracker } from '../../frontend/src/lib/studio/animation';
import { sceneSourceWeights } from '../../frontend/src/lib/studio/transition';
import { blendProgramPictures, programPictureSources, withProgramInsert, type ProgramPicture } from '../../frontend/src/lib/studio/program-picture';
import type { Item } from '../../frontend/src/types';
import { initialProduction } from '../src/production-schema.js';

const scripture: Item = {
  id: 'cue_john', type: 'scripture', durationMs: 0,
  body: 'For God so loved the world that he gave his only begotten Son, that whosoever believeth in him should not perish, but have everlasting life.',
  reference: 'John 3:16 · KJV', subtitle: 'King James Version',
};
const measure = (text: string, fontSize: number) => text.length * fontSize * .55;

test('channel overlay lays out readable text, reference and attribution inside actual lower-third bounds', () => {
  const copy = structuredClone(scripture);
  const layout = layoutChannelOverlay(scripture, 1728, 280, 54, 500, measure);
  assert.equal(layout.blocks.length, 3);
  assert.equal(layout.blocks[1].lines.join(' '), scripture.reference);
  assert.equal(layout.blocks[2].lines.join(' '), scripture.subtitle);
  assert.ok(layout.blocks[0].fontSize >= 40, 'a lower third does not squeeze a full 16:9 slide into tiny type');
  for (const block of layout.blocks) {
    assert.ok(block.top >= layout.padding);
    assert.ok(block.top + block.lines.length * block.lineHeight <= 280 - layout.padding + .001);
    for (const line of block.lines) assert.ok(measure(line, block.fontSize) <= layout.contentWidth + .001, line);
  }
  assert.deepEqual(scripture, copy, 'rendering never changes the channel content or theme');
});

test('overlay fitting retains scripture metadata and long words in narrow or shallow frames', () => {
  const item = { ...scripture, body: 'Supercalifragilisticexpialidocious'.repeat(5) };
  for (const [width, height] of [[200, 100], [1200, 80], [50, 30]]) {
    const layout = layoutChannelOverlay(item, width, height, 60, 600, measure);
    assert.equal(layout.blocks.length, 3);
    assert.equal(layout.blocks[0].lines.join(''), item.body);
    for (const block of layout.blocks) {
      assert.ok(block.top >= 0);
      assert.ok(block.top + block.lines.length * block.lineHeight <= height + .001);
      assert.ok(block.lines.every(line => measure(line, block.fontSize) <= layout.contentWidth + .001));
    }
  }
});

test('lyrics overlay preserves stanza breaks and only shows attribution for generated cues', () => {
  const item: Item = { id: 'cue_lyrics', type: 'lyrics', durationMs: 0, body: 'unused',
    stanzas: [{ id: 'verse', lines: 'Amazing grace\nHow sweet the sound' }, { id: 'chorus', lines: 'I once was lost' }],
    subtitle: 'Public domain', reference: 'Amazing Grace · Verse 1',
  };
  assert.equal(channelText(item), 'Amazing grace\nHow sweet the sound\n\nI once was lost');
  const layout = layoutChannelOverlay(item, 1500, 400, 54, 500, measure);
  assert.deepEqual(layout.blocks[0].lines, ['Amazing grace', 'How sweet the sound', '', 'I once was lost']);
  assert.equal(layout.blocks.length, 3);
  assert.equal(layoutChannelOverlay({ ...item, id: 'announcement' }, 1500, 400, 54, 500, measure).blocks.length, 2);
});

test('channel inserts and return cannot restart the base scene entrance or replace its follow-audio weights', () => {
  const state = initialProduction();
  state.program = structuredClone(state.scenes[0]);
  state.program.layers[0] = { ...state.program.layers[0], kind: 'source', sourceId: 'preacher_microphone' };
  state.programTransition = { id: 'base_take', kind: 'cut', durationMs: 0 };
  const tracker = new AnimationRunTracker(state);
  state.programTransition.id = 'fresh_take';
  tracker.update(state, 100);
  const before = sceneSourceWeights([{ scene: state.program, weight: 1 }]);
  state.channelInsert = {
    id: 'insert_1', channelId: 'scripture', sourceId: 'scripture_source', mode: 'overlay',
    layer: { ...state.program.layers[0], id: 'scripture_insert', sourceId: 'scripture_source', channelStyle: 'overlay' },
  };
  assert.equal(tracker.update(state, 200), false);
  assert.equal(tracker.program?.startedAt, 100);
  assert.deepEqual(sceneSourceWeights([{ scene: state.program, weight: 1 }]), before);
  state.channelInsert.mode = 'fullscreen';
  assert.equal(tracker.update(state, 300), false);
  assert.deepEqual(sceneSourceWeights([{ scene: state.program, weight: 1 }]), before);
  delete state.channelInsert;
  assert.equal(tracker.update(state, 400), false);
  assert.equal(tracker.program?.startedAt, 100);
  assert.deepEqual(sceneSourceWeights([{ scene: state.program, weight: 1 }]), before);
});

test('Studio Fade retains the actual outgoing channel picture independently of base audio weights', () => {
  const state = initialProduction(), base = state.scenes[0], next = state.scenes[1];
  const insert = { id: 'scripture_insert', channelId: 'scripture', sourceId: 'scripture_source', mode: 'fullscreen' as const,
    layer: { ...base.layers[0], id: 'scripture_layer', kind: 'source' as const, sourceId: 'scripture_source' } };
  const original: ProgramPicture[] = withProgramInsert([{ scene: base, weight: 1, animationStartedAt: 100, runId: 'base', inserts: [] }], insert);
  const copy = structuredClone(original);
  const start = blendProgramPictures(original, next, 0, { id: 'next', startedAt: 500 });
  assert.equal(start.length, 1);
  assert.equal(start[0].inserts[0].id, insert.id, 'the first Fade frame still contains the full-screen channel');
  const middle = blendProgramPictures(original, next, .5, { id: 'next', startedAt: 500 });
  assert.deepEqual(middle.map(entry => entry.weight), [.5, .5]);
  assert.equal(middle[0].animationStartedAt, 100, 'outgoing camera/element run remains live');
  assert.equal(middle[0].inserts[0].id, insert.id);
  assert.deepEqual(middle[1].inserts, []);
  const final = blendProgramPictures(original, next, 1, { id: 'next', startedAt: 500 });
  assert.equal(final.length, 1);
  assert.deepEqual(final[0].inserts, [], 'the outgoing channel vanishes only when Fade completes');
  assert.deepEqual(original, copy, 'sampling a Fade cannot alter the old composition');
  assert.equal(sceneSourceWeights([{ scene: base, weight: 1 }]).has(insert.sourceId), false,
    'insert sources do not become scene follow-audio routes');
});

test('interrupted visual fades preserve old insert pictures and let current inserts/Return act without replay', () => {
  const state = initialProduction(), [base, next, last] = state.scenes;
  const firstInsert = { id: 'first', channelId: 'scripture', sourceId: 'scripture_source', mode: 'overlay' as const, layer: base.layers[0] };
  const secondInsert = { ...firstInsert, id: 'second', channelId: 'lyrics', sourceId: 'lyrics_source', mode: 'fullscreen' as const };
  const from = withProgramInsert([{ scene: base, weight: 1, animationStartedAt: 100, inserts: [] }], firstInsert);
  const interrupted = blendProgramPictures(from, next, .4, { id: 'next', startedAt: 200 });
  const shown = withProgramInsert(interrupted, secondInsert);
  assert.deepEqual(shown.map(entry => entry.inserts.map(insert => insert.id)), [['first', 'second'], ['second']]);
  assert.deepEqual(withProgramInsert(shown, secondInsert), shown, 'an unrelated cue update cannot duplicate the same insert');
  const fade = blendProgramPictures(shown, last, .5, { id: 'last', startedAt: 300 });
  assert.deepEqual(fade.map(entry => entry.weight), [.3, .2, .5]);
  assert.deepEqual(fade.map(entry => entry.animationStartedAt), [100, 200, 300]);
  assert.deepEqual([...programPictureSources(fade)].filter(id => id.endsWith('_source')).sort(), ['lyrics_source', 'scripture_source'],
    'outgoing visual source decoders remain available until the Fade completes');
  assert.equal(withProgramInsert(interrupted, undefined), interrupted, 'Return removes only the active insert, without inventing a new animation/transition');
  assert.deepEqual([...programPictureSources(blendProgramPictures(shown, last, 1))].filter(id => id.endsWith('_source')), []);
});
