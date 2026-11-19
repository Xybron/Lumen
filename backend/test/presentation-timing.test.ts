import assert from 'node:assert/strict';
import test from 'node:test';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { build } from 'esbuild';

// Exercise the real Vue engine and timer without a browser, networking or a
// station. Only its content provider and outward broadcast boundary are faked.
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const wait = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));
test('presentation starts manual and idle; its independent timer holds, resumes and advances only with Auto', async () => {
  const messages: any[] = [];
  const fixture = { playlistForChannel: () => ({ id: 'p', items: [
    { id: 'first', type: 'text', durationMs: 500 },
    { id: 'heading', type: 'section', durationMs: 0 },
    { id: 'second', type: 'text', durationMs: 1000 },
  ] }) };
  const globals = globalThis as any;
  const previous = { window: globals.window, content: globals.__timingContent, messages: globals.__timingMessages };
  globals.window = globalThis; globals.__timingContent = fixture; globals.__timingMessages = messages;
  const compiled = await build({
    stdin: { contents: "export { createPlaybackEngine } from './src/lib/engine'; export { nextTick, reactive } from 'vue';", resolveDir: path.join(root, 'frontend'), loader: 'ts' },
    bundle: true, platform: 'node', format: 'esm', write: false,
    plugins: [{ name: 'station-boundaries', setup(builder) {
      builder.onResolve({ filter: /^@\/stores\/content$/ }, () => ({ path: 'content', namespace: 'fixture' }));
      builder.onResolve({ filter: /^@\/lib\/(broadcast|preload)$/ }, args => ({ path: args.path.split('/').pop()!, namespace: 'fixture' }));
      builder.onResolve({ filter: /^@\// }, args => ({ path: path.join(root, 'frontend/src', args.path.slice(2) + '.ts') }));
      builder.onLoad({ filter: /.*/, namespace: 'fixture' }, args => ({ contents: args.path === 'content'
        ? 'export const useContentStore = () => globalThis.__timingContent;'
        : args.path === 'broadcast' ? 'export const broadcast = msg => globalThis.__timingMessages.push(msg);'
        : 'export const preload = () => {}; export const releasePreload = () => {};', loader: 'js' }));
    } }],
  });
  const { createPlaybackEngine, nextTick, reactive } = await import(`data:text/javascript;base64,${Buffer.from(compiled.outputFiles[0].text).toString('base64')}`);
  const playlist = reactive(fixture.playlistForChannel());
  fixture.playlistForChannel = () => playlist;
  const engine = createPlaybackEngine('presentation', { defaultMode: 'auto' });
  try {
    assert.equal(engine.mode.value, 'manual', 'legacy saved Auto is not session consent');
    assert.equal(engine.playing.value, false);
    assert.equal(engine.remainingMs.value, 500);
    await wait(550);
    assert.equal(engine.index.value, 0, 'startup never advances');
    engine.play(); await wait(80); engine.pause(); await nextTick();
    const frozen = engine.elapsedMs.value;
    assert.ok(frozen >= 40 && frozen < 300, 'pause samples the exact clock');
    assert.equal(engine.mode.value, 'manual');
    await wait(70); assert.equal(engine.elapsedMs.value, frozen, 'pause holds time');
    engine.play(); await wait(600); await nextTick();
    assert.equal(engine.index.value, 0, 'Manual completion holds the current prayer');
    assert.equal(engine.elapsedMs.value, 500);
    assert.equal(engine.playing.value, false);
    engine.sendState();
    const snapshot = messages.filter(message => message.t === 'state').at(-1);
    assert.equal(snapshot.payload.elapsedMs, 500, 'late viewers receive the frozen Manual time');
    assert.equal(snapshot.payload.itemId, 'first', 'projection state carries a stable cue identity');
    engine.setMode('auto'); await wait(650); await nextTick();
    assert.equal(engine.index.value, 2, 'explicit Auto advances and skips section headings');
    assert.equal(engine.playing.value, true);
    engine.setMode('manual');
    assert.equal(engine.playing.value, true, 'disabling Auto does not stop the clock');
    engine.pause();
    const retained = engine.elapsedMs.value;
    engine.setMode('auto');
    assert.equal(engine.elapsedMs.value, retained, 'enabling Auto resumes without resetting elapsed time');
    engine.pause(); engine.goPrev(); await nextTick();
    assert.equal(engine.index.value, 0);
    assert.equal(engine.playing.value, false, 'cue navigation does not restart a paused timer');
    assert.equal(engine.remainingMs.value, 500);
    engine.play(); await wait(60);
    const beforeMove = engine.elapsedMs.value;
    const [moved] = playlist.items.splice(0, 1); playlist.items.push(moved);
    await nextTick();
    assert.equal(engine.current.value.id, 'first', 'group/reorder edits retain the on-air cue');
    assert.equal(engine.index.value, 2);
    assert.equal(engine.projectionState.value.itemId, 'first', 'reordered projection retains its item ID');
    assert.equal(engine.playing.value, true, 'reordering never pauses the current timer');
    assert.ok(engine.elapsedMs.value >= beforeMove);
    playlist.items.splice(2, 1); await nextTick();
    assert.equal(engine.playing.value, false, 'deleting the current slide stops its clock');
  } finally {
    engine.dispose();
    globals.window = previous.window; globals.__timingContent = previous.content; globals.__timingMessages = previous.messages;
  }
});
