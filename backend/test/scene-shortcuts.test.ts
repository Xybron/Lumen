import assert from 'node:assert/strict';
import test from 'node:test';
import { normalizeSceneShortcuts, sceneHasPendingChannelPublication, sceneShortcutLabel, sceneShortcutMatches, sceneShortcutProblem, sceneShortcutSurfaceBlocked, type SceneShortcutKey } from '../../frontend/src/lib/studio/scene-shortcuts';
import { initialProduction } from '../src/production-schema.js';

const key = (patch: Partial<SceneShortcutKey> = {}): SceneShortcutKey => ({ code: 'Digit1', ctrlKey: true, metaKey: false, shiftKey: true, altKey: false, ...patch });
const binding = { sceneId: 'scripture', code: 'Digit1', alt: false, transition: 'cut' as const, durationMs: 300 };

test('scene shortcuts require an explicit modified chord, never existing channel or typing shortcuts', () => {
  assert.equal(sceneShortcutProblem(key()), null);
  for (const event of [key({ ctrlKey: false }), key({ shiftKey: false }), key({ code: 'Enter' }), key({ code: 'Space' }), key({ code: 'KeyK', shiftKey: false }), key({ ctrlKey: true, metaKey: true })]) assert.ok(sceneShortcutProblem(event));
  assert.equal(sceneShortcutProblem(key({ ctrlKey: false, metaKey: true })), null);
});
test('scene shortcuts reject browser, system and input method combinations', () => {
  for (const code of ['KeyQ', 'KeyW', 'KeyR', 'KeyT', 'KeyI', 'KeyP', 'Digit3', 'Digit4', 'Digit5', 'Digit6']) {
    assert.ok(sceneShortcutProblem(key({ code })));
    assert.ok(sceneShortcutProblem(key({ code, altKey: true })));
  }
  assert.ok(sceneShortcutProblem(key({ isComposing: true })));
  assert.ok(sceneShortcutProblem(key({ altKey: true, getModifierState: name => name === 'AltGraph' })));
  assert.equal(sceneShortcutProblem(key({ code: 'KeyL', altKey: true })), null);
});
test('matching is precise and physical-key based on either platform modifier', () => {
  assert.equal(sceneShortcutMatches(binding, key()), true);
  assert.equal(sceneShortcutMatches(binding, key({ ctrlKey: false, metaKey: true })), true);
  assert.equal(sceneShortcutMatches(binding, key({ code: 'Digit2' })), false);
  assert.equal(sceneShortcutMatches(binding, key({ altKey: true })), false);
  assert.equal(sceneShortcutMatches(binding, key({ shiftKey: false })), false);
  assert.equal(sceneShortcutLabel(binding), 'Ctrl + Shift + 1');
  assert.equal(sceneShortcutLabel({ code: 'KeyL', alt: true }, true), '⌘ ⇧ ⌥ L');
});
test('stored shortcuts are validated, deduplicated, bounded and safe on reload', () => {
  assert.deepEqual(normalizeSceneShortcuts(null), []);
  assert.deepEqual(normalizeSceneShortcuts({}), []);
  const result = normalizeSceneShortcuts([binding, { ...binding, sceneId: 'duplicate' }, { ...binding, code: 'Digit2' },
    { ...binding, sceneId: 'lyrics', code: 'Digit2', transition: 'fade', durationMs: 6000 },
    { ...binding, sceneId: 'reserved', code: 'KeyR' }, { ...binding, sceneId: '', code: 'Digit7' },
    { ...binding, sceneId: 'bad', code: 'Digit8', transition: 'explode' },
    { ...binding, sceneId: 'fallback', code: 'Digit9', durationMs: 'unsafe' }]);
  assert.deepEqual(result, [binding, { ...binding, sceneId: 'lyrics', code: 'Digit2', transition: 'fade', durationMs: 3000 }, { ...binding, sceneId: 'fallback', code: 'Digit9' }]);
  assert.deepEqual(normalizeSceneShortcuts(JSON.parse(JSON.stringify(result))), result);
});
test('scene binding identity survives rename and reorder and never binds an index', () => {
  const saved = normalizeSceneShortcuts([binding]);
  const scenes = [{ id: 'camera', name: 'Camera' }, { id: 'scripture', name: 'Renamed scripture' }].reverse();
  assert.equal(scenes.find(scene => scene.id === saved[0].sceneId)?.name, 'Renamed scripture');
  assert.equal(scenes.filter(scene => scene.id !== 'scripture').some(scene => scene.id === saved[0].sceneId), false);
});
test('editable surfaces, open dialogs/menus and animation rehearsals block global takes', () => {
  const none = { querySelector: () => null } as unknown as Pick<Document, 'querySelector'>;
  const openDialog = { querySelector: () => ({}) } as unknown as Pick<Document, 'querySelector'>;
  const editable = { closest: () => ({}) } as unknown as Element;
  const canvas = { closest: () => null } as unknown as Element;
  assert.equal(sceneShortcutSurfaceBlocked(null, none, false), false);
  assert.equal(sceneShortcutSurfaceBlocked(canvas, none, false), false);
  assert.equal(sceneShortcutSurfaceBlocked(editable, none, false), true);
  assert.equal(sceneShortcutSurfaceBlocked(canvas, openDialog, false), true);
  assert.equal(sceneShortcutSurfaceBlocked(canvas, none, true), true);
});

test('persistent Scripture and Lyrics results are not treated as globally open popups', () => {
  const excludesInline=(selector:string)=>selector.includes('[role="listbox"]:not([data-channel-search-results])');
  const inlineResults={querySelector:(selector:string)=>excludesInline(selector)?null:{}} as unknown as Pick<Document,'querySelector'>;
  const verseButton={closest:(selector:string)=>excludesInline(selector)?null:{}} as unknown as Element;
  assert.equal(sceneShortcutSurfaceBlocked(verseButton,inlineResults,false),false);
  const input={closest:()=>({})} as unknown as Element;
  assert.equal(sceneShortcutSurfaceBlocked(input,inlineResults,false),true,'Typing still blocks scene shortcuts');
  const popup={querySelector:()=>({})} as unknown as Pick<Document,'querySelector'>;
  assert.equal(sceneShortcutSurfaceBlocked(verseButton,popup,false),true,'Unrelated popup lists still block');
});

test('a Take waits for target scene channel publication, but unrelated publishing or private preparation cannot block it', () => {
  const state = initialProduction(), scene = state.scenes[0];
  scene.layers = [{ ...scene.layers[0], kind: 'source', sourceId: 'scripture_source' }];
  const sources = [{ id: 'scripture_source', kind: 'channel' as const, channelId: 'scripture' }, { id: 'lyrics_source', kind: 'channel' as const, channelId: 'lyrics' }];
  assert.equal(sceneHasPendingChannelPublication(scene, sources, { scripture: true }), true);
  assert.equal(sceneHasPendingChannelPublication(scene, sources, { lyrics: true }), false);
  assert.equal(sceneHasPendingChannelPublication(scene, sources, { scripture: false }), false);
  assert.equal(sceneHasPendingChannelPublication(scene, sources, {}), false);
  assert.equal(sceneHasPendingChannelPublication(null, sources, { scripture: true }), false);
  scene.layers[0].sourceId = 'lyrics_source';
  assert.equal(sceneHasPendingChannelPublication(scene, sources, { lyrics: true }), true);
});
