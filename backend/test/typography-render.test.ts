import test from 'node:test';
import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';
import { createChannelPosterLayoutCache } from '../../frontend/src/lib/studio/channel-poster-layout.js';
import { drawPreparedText, fontFamily, prepareTextLine, textCss, textFont, transformText, type TextOptions } from '../../frontend/src/lib/studio/text-style.js';
import { initialProduction } from '../src/production-schema.js';
import type { Item } from '../../frontend/src/types.js';

const cue: Item = { id: 'cue_style', type: 'lyrics', body: 'Together in this place\nLet every voice sing with joy', durationMs: 0 };
test('typography layout follows family, spacing, leading, case and vertical alignment without remeasuring stable text', () => {
  let measurements = 0;
  const layout = createChannelPosterLayoutCache((text, size, _weight, style = {}) => {
    measurements++;
    return text.length * size * (style.fontFamily === 'courier' ? .65 : .45) + Math.max(0, text.length - 1) * (style.letterSpacing ?? 0);
  });
  const base = layout(cue, 1920, 1080, 72, 600), before = measurements;
  assert.strictEqual(layout(cue, 1920, 1080, 72, 600), base); assert.equal(measurements, before);
  const top = layout(cue, 1920, 1080, 72, 600, { verticalAlign: 'top' });
  const bottom = layout(cue, 1920, 1080, 72, 600, { verticalAlign: 'bottom' });
  assert.ok(top.blocks[0].top < base.blocks[0].top && base.blocks[0].top < bottom.blocks[0].top);
  assert.equal(top.blocks[0].top, top.padding);
  const wide = layout(cue, 400, 1080, 72, 600, { fontFamily: 'courier', letterSpacing: 12 });
  const narrow = layout(cue, 400, 1080, 72, 600, { fontFamily: 'arial' });
  assert.ok(wide.blocks[0].lines.length > narrow.blocks[0].lines.length);
  const leading = layout(cue, 1920, 1080, 72, 600, { lineHeight: 1.8, italic: true, textTransform: 'uppercase' });
  assert.equal(leading.blocks[0].lineHeight, 72 * 1.8);
  assert.equal(leading.blocks[0].lines.join('\n'), cue.body!.toUpperCase());
  assert.notStrictEqual(layout(cue, 1920, 1080, 72, 600, { fontFamily: 'georgia' }), base);
  assert.equal(cue.body, 'Together in this place\nLet every voice sing with joy', 'Styling never rewrites saved lyrics');
});

test('font and effects CSS use the same safe family and design-unit scaling as rendered text', () => {
  const style: TextOptions = { fontFamily: 'georgia', italic: true, underline: true, letterSpacing: 3,
    textStroke: { color: '#112233', width: 2 }, textShadow: { color: '#000000aa', blur: 10, offsetX: -3, offsetY: 5 } };
  assert.equal(textFont(style, 72, 600), 'italic 600 72px Georgia, "Times New Roman", serif');
  const css = textCss(style);
  assert.equal(css.fontFamily, fontFamily(style)); assert.equal(css.fontStyle, 'italic');
  assert.equal(css.letterSpacing, `${3 / 19.2}cqw`); assert.equal(css.textDecorationLine, 'underline');
  assert.equal(css.WebkitTextStroke, `${4 / 19.2}cqw #112233`);
  assert.equal(css.textShadow, `${-3 / 19.2}cqw ${5 / 19.2}cqw ${10 / 19.2}cqw #000000aa`);
  assert.equal(fontFamily({ fontFamily: 'url(http://untrusted)' as never }), fontFamily());
  assert.equal(transformText('Amazing Grace', { textTransform: 'lowercase' }), 'amazing grace');
});

test('letter-spacing fallback prepares grapheme positions once and preserves combined characters while painting', () => {
  let measured = 0;
  const painted: { text: string; x: number }[] = [];
  const ctx = { font: '', textBaseline: 'top', textAlign: 'center',
    measureText(text: string) { measured++; return { width: Array.from(text).length * 10 }; },
    save() {}, restore() {}, fillText(text: string, x: number) { painted.push({ text, x }); }, fillRect() {}, strokeText() {},
  } as unknown as CanvasRenderingContext2D;
  const style: TextOptions = { letterSpacing: 4, underline: true };
  const line = prepareTextLine(ctx, 'e\u0301🙂', style, 20, 500), initial = measured;
  assert.equal(line.glyphs?.length, 2);
  drawPreparedText(ctx, line, 100, 0, 20, 500, style, 'center');
  assert.deepEqual(painted.map(glyph => glyph.text), ['e\u0301', '🙂']);
  assert.equal(painted[0].x, 100 - line.width / 2); assert.ok(painted[1].x > painted[0].x);
  assert.equal(measured, initial, 'Frames reuse prepared glyph advances instead of measuring every character again');
});

async function loadRenderer() {
  const { default: esbuild } = await import('../../frontend/node_modules/esbuild/lib/main.js');
  const frontend = fileURLToPath(new URL('../../frontend/', import.meta.url));
  const bundle = await esbuild.build({ absWorkingDir: frontend,
    stdin: { contents: 'export { paintScene } from "./src/lib/studio/compositor.ts";', resolveDir: frontend },
    tsconfig: 'tsconfig.json', bundle: true, write: false, format: 'esm', platform: 'browser', define: { 'process.env.NODE_ENV': '"production"' } });
  return import(`data:text/javascript;base64,${Buffer.from(bundle.outputFiles[0].text).toString('base64')}`);
}

test('effects rasterise once per independent Preview/Program style and cleared cues stop painting', async t => {
  const { paintScene } = await loadRenderer();
  let measures = 0, fills = 0, strokes = 0, allocations = 0, copies = 0;
  const fonts: string[] = [];
  class Context {
    font = ''; globalAlpha = 1; fillStyle = ''; textBaseline = 'top'; textAlign = 'center';
    save() {} restore() {} setTransform() {} translate() {} rotate() {} scale() {} fillRect() {} clip() {} beginPath() {} roundRect() {}
    measureText(value: string) { measures++; return { width: value.length * Number(/([\d.]+)px/.exec(this.font)?.[1]) * .5 }; }
    fillText(value: string) { fills++; fonts.push(this.font); assert.equal(value, value.toUpperCase()); }
    strokeText() { strokes++; }
    drawImage() { copies++; }
  }
  const canvases: { width: number; height: number; getContext: () => Context }[] = [];
  const oldDocument = Object.getOwnPropertyDescriptor(globalThis, 'document');
  Object.defineProperty(globalThis, 'document', { configurable: true, value: { createElement(name: string) {
    assert.equal(name, 'canvas'); allocations++; const ctx = new Context();
    const canvas = { width: 0, height: 0, getContext: () => ctx }; canvases.push(canvas); return canvas;
  } } });
  t.after(() => { if (oldDocument) Object.defineProperty(globalThis, 'document', oldDocument); else Reflect.deleteProperty(globalThis, 'document'); });
  const main = new Context(), canvas = { width: 1920, height: 1080, getContext: () => main };
  const scene = initialProduction().scenes[0], base = scene.layers[0];
  scene.layers = [{ ...base, kind: 'source', sourceId: 'lyrics', x: 0, y: 0, width: 100, height: 100, opacity: 1,
    fontFamily: 'georgia', italic: true, underline: true, textTransform: 'uppercase',
    textStroke: { color: '#000000', width: 2 }, textShadow: { color: '#000000aa', blur: 12, offsetX: 3, offsetY: 4 } }];
  const draft = structuredClone(scene); draft.layers[0].color = '#ffee00';
  let item: Item | undefined = structuredClone(cue);
  const bank = { inputs: new Map([['lyrics', { source: { kind: 'channel' }, element: null }]]), channelItem: () => item, isTextChannel: () => true };
  paintScene(canvas, scene, bank); paintScene(canvas, draft, bank);
  assert.equal(allocations, 2, 'Each distinct visual style has its own surface');
  assert.ok(canvases.every(surface => surface.height < 1080), 'Only text bounds, not entire HD frames, are stored');
  const first = { measures, fills, strokes };
  for (let frame = 0; frame < 30; frame++) { paintScene(canvas, scene, bank); paintScene(canvas, draft, bank); }
  assert.deepEqual({ measures, fills, strokes }, first, 'Steady frames only copy cached text over moving backgrounds');
  assert.equal(allocations, 2); assert.equal(copies, 62);
  assert.ok(fonts.every(font => font.includes('Georgia') && font.startsWith('italic ')));
  item = { ...cue, body: 'New words' }; paintScene(canvas, scene, bank);
  assert.ok(fills > first.fills);
  const last = { allocations, fills, copies }; item = undefined; paintScene(canvas, scene, bank);
  assert.deepEqual({ allocations, fills, copies }, last, 'A cleared cue neither paints text nor allocates effect surfaces');
});
