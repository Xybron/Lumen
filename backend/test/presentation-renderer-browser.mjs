// Uses an isolated page and in-memory source bundle: no station, user data,
// distribution build, microphone, network output or production engine.
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright-core';
import sharp from 'sharp';
import { build } from '../../frontend/node_modules/esbuild/lib/main.js';
import { parse, compileScript } from '../../frontend/node_modules/@vue/compiler-sfc/dist/compiler-sfc.esm-browser.js';
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const compiled = await build({ absWorkingDir: path.join(root, 'frontend'), stdin: { contents: `
  export { createApp, h, nextTick } from 'vue';
  export { default as ContentLayer } from './src/components/live/ContentLayer.vue';
  export { drawPresentationItem, paintScene } from './src/lib/studio/compositor';
  export { SourceBank } from './src/lib/studio/sources';
  export { layoutPresentationText, hasStructuredPresentation, drawPresentationGradient } from './src/lib/presentation-slide';
  export { drawPresentationGraphics, presentationGraphics, presentationElapsed, originalFlameStops } from './src/lib/presentation-graphics';
`, resolveDir: path.join(root, 'frontend') }, tsconfig: 'tsconfig.json', bundle: true, write: false, format: 'iife', globalName: 'PresentationTest', platform: 'browser',
  define: { 'process.env.NODE_ENV': '"production"', __VUE_OPTIONS_API__: 'true', __VUE_PROD_DEVTOOLS__: 'false', __VUE_PROD_HYDRATION_MISMATCH_DETAILS__: 'false' },
  plugins: [{ name: 'vue-source', setup(builder) {
    builder.onLoad({ filter: /\.vue$/ }, async ({ path: filename }) => {
      const source = await fs.readFile(filename, 'utf8'), { descriptor } = parse(source, { filename });
      const component = compileScript(descriptor, { id: path.basename(filename), inlineTemplate: true });
      return { contents: component.content, loader: 'ts', resolveDir: path.dirname(filename) };
    });
  } }],
});
let browser;
try {
  browser = await chromium.launch({ executablePath: process.env.LUMEN_CHROME_PATH ?? '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome', headless: true });
  const page = await browser.newPage({ viewport: { width: 1440, height: 1000 } });
  const errors = []; page.on('pageerror', error => errors.push(error.message));
  await page.setContent('<div id="preview"></div>');
  await page.addScriptTag({ content: compiled.outputFiles[0].text });
  const result = await page.evaluate(async () => {
    const { createApp, h, nextTick, ContentLayer, SourceBank, paintScene, drawPresentationItem, layoutPresentationText,
      drawPresentationGraphics, presentationGraphics, presentationElapsed, originalFlameStops, hasStructuredPresentation } = window.PresentationTest;
    const canvas = () => { const c = document.createElement('canvas'); c.width = 1920; c.height = 1080; return c; };
    const pixels = c => c.getContext('2d').getImageData(0, 0, c.width, c.height).data;
    const same = (a, b) => { const left = pixels(a), right = pixels(b); return left.every((v, i) => v === right[i]); };
    const item = { id: 'prayer', type: 'prayer', title: 'Saviour of World!', body: 'For God so loved the world that he gave his only begotten Son.', reference: 'John 3:16', durationMs: 120000,
      background: { kind: 'color', color: '#15202d', overlayOpacity: 0 }, typography: { size: 'lg', align: 'center', weight: 500 } };
    const input = { source: { id: 'prayer-source', kind: 'channel', channelId: 'prayer-channel' }, element: null };
    const bank = Object.create(SourceBank.prototype);
    bank.content = { channels: [{ id: 'prayer-channel', kind: 'prayer', playlistId: 'deck' }], playlists: [{ id: 'deck', items: [item] }], settings: { countdownAtMs: 10000, warningAtMs: 300000 } };
    bank.inputs = new Map([['prayer-source', input]]); bank.channelStates = new Map([['prayer-channel', { playlistId: 'deck', index: 0, playing: false, blanked: false }]]);
    bank.channelClocks = new Map(); bank.channelItem = input => SourceBank.prototype.channelItem.call(bank, input, false);
    bank.channelGraphics = () => undefined;
    const context = bank.channelPresentationContext(input);
    const app = createApp({ render: () => h(ContentLayer, { item, prayerLabel: context.prayerLabel }) });
    app.mount('#preview'); await nextTick(); await document.fonts.ready; await nextTick();
    const source = document.querySelector('#preview canvas');
    const expected = canvas(); expected.getContext('2d').fillStyle = item.background.color; expected.getContext('2d').fillRect(0, 0, 1920, 1080); expected.getContext('2d').drawImage(source, 0, 0);
    const program = canvas();
    const layer = { id: 'layer', kind: 'source', sourceId: 'prayer-source', visible: true, x: 0, y: 0, width: 100, height: 100, opacity: 1, radius: 0, background: '#000000', channelStyle: 'slide' };
    paintScene(program, { id: 'scene', background: '#000000', layers: [layer] }, bank);
    const leftPixels=pixels(expected),rightPixels=pixels(program);let pixelDifferences=0,maxDifference=0;for(let i=0;i<leftPixels.length;i++){if(leftPixels[i]!==rightPixels[i])pixelDifferences++;maxDifference=Math.max(maxDifference,Math.abs(leftPixels[i]-rightPixels[i]));} const parity = same(expected, program), blocks = layoutPresentationText(program.getContext('2d'), item, context);
    const printed = blocks.map(b => [b.role, b.lines.join(' ')]), hierarchy = blocks.map(b => [b.role, b.fontSize, b.y]);
    const textPixels = pixels(source).filter((_, i) => i % 4 === 3).some(a => a > 0);
    app.unmount();
    // Section boundaries and old prayer-sub items retain the established numbering.
    bank.content.playlists[0].items = [{ ...item, id: 'first' }, { ...item, id: 'sub', type: 'prayer-sub' }, { ...item, id: 'section', type: 'section' }, item];
    const numbering = [];
    for (const index of [0, 1, 3]) { bank.channelStates.get('prayer-channel').index = index; numbering.push(bank.channelPresentationContext(input).prayerLabel); }
    // A reordered state reaches Program before its content-updated fetch. Its
    // new numeric position still points at a different slide in the old deck.
    bank.channelStates.set('prayer-channel', { playlistId: 'deck', index: 3, itemId: 'first', playing: false, blanked: false });
    const beforeManifest = { id: bank.channelItem(input)?.id, label: bank.channelPresentationContext(input).prayerLabel };
    const previousItems = bank.content.playlists[0].items;
    bank.content.playlists[0].items = [previousItems[1], previousItems[2], previousItems[3], previousItems[0]];
    const afterManifest = { id: bank.channelItem(input)?.id, label: bank.channelPresentationContext(input).prayerLabel };
    bank.channelStates.get('prayer-channel').itemId = 'not-in-this-manifest';
    const missingIdentity = bank.channelItem(input) === undefined;
    const variants = {};
    for (const layout of ['general', 'statement', 'quote', 'key-points']) {
      const changed = { ...item, layout };
      variants[layout] = layoutPresentationText(program.getContext('2d'), changed, context).map(b => ({ role: b.role, lines: b.lines, size: b.fontSize }));
    }
    const statementSizing = ['notes', 'text', 'prayer'].map(type => {
      const withBody = layoutPresentationText(program.getContext('2d'), { ...item, type, layout: 'statement' }, context);
      const titleOnly = layoutPresentationText(program.getContext('2d'), { ...item, type, layout: 'statement', body: undefined }, context);
      return { type, heading: withBody.find(b => b.role === 'title').fontSize, body: withBody.find(b => b.role === 'body').fontSize,
        titleOnly: titleOnly.find(b => b.role === 'title').fontSize };
    });
    const notes = { ...item, id: 'notes', type: 'notes', title: 'Remember', body: '- Listen\n* Be patient\n3. Give thanks', layout: 'key-points' };
    const noteBlocks = layoutPresentationText(program.getContext('2d'), notes);
    const long = { ...item, body: ('A long supporting prayer must fit and remain separate from its title and reference. ').repeat(180) };
    const longBlocks = layoutPresentationText(program.getContext('2d'), long, context);
    const longBounds = longBlocks.map(b => [b.y, b.y + b.lines.length * b.lineHeight]);
    // Changing a mutable cue must invalidate layout; previews sometimes edit in place.
    const mutable = { ...item }, before = layoutPresentationText(program.getContext('2d'), mutable, context);
    mutable.title = 'An updated prayer';
    const after = layoutPresentationText(program.getContext('2d'), mutable, context);
    const unchangedOverlay = !hasStructuredPresentation({ ...item, id: 'cue_scripture', type: 'scripture' });
    const original = presentationGraphics(), legacyInput = { template: 'minimal', progress: true, timer: true, countdown: false, warning: false, timerMode: 'elapsed', position: 'bottom', size: 'small', color: '#1188ff' };
    const legacy = presentationGraphics(legacyInput), resolved = presentationGraphics({ ...legacyInput, caption: false, thickness: 19, tip: 'icon', tipIcon: 'star', colorMode: 'gradient', gradientColors: ['#123456', '#abcdef'] });
    const frame = graphics => ({ graphics, elapsedMs: 60000, durationMs: 120000, countdownAtMs: 10000, warningAtMs: 300000, title: item.title });
    const graphics = canvas(), gctx = graphics.getContext('2d');
    const draw = options => { gctx.clearRect(0, 0, 1920, 1080); drawPresentationGraphics(gctx, frame(presentationGraphics(options)), 1920, 1080); };
    draw({ ...original, timer: false, countdown: false });
    const at = (x, y) => Array.from(gctx.getImageData(x, y, 1, 1).data);
    const flame = { ember: at(15, 2), orange: at(570, 2), hot: at(960, 2), empty: at(1500, 2), glow: at(960, 8) };
    // Plain bottom bar: exact requested geometry, no glow and no unwanted timer/caption.
    draw({ ...original, timer: false, countdown: false, caption: false, position: 'bottom', thickness: 12, colorMode: 'solid', color: '#22cc66', tip: 'none' });
    const plain = { inside: at(400, 1070), above: at(400, 1067), after: at(1200, 1070), top: at(400, 2) };
    draw({ ...original, progress: false, timer: false, countdown: false, warning: false, caption: false });
    const allHidden = !pixels(graphics).some((v, i) => i % 4 === 3 && v > 0);
    draw({ ...original, progress: false, timer: false, countdown: false, warning: false, caption: true });
    const caption = pixels(graphics).some((v, i) => i % 4 === 3 && v > 0);
    gctx.clearRect(0, 0, 1920, 1080); drawPresentationGraphics(gctx, { ...frame({ ...original, progress: false, timer: false, caption: true }), durationMs: 0 }, 1920, 1080);
    const untimedCaption = pixels(graphics).some((v, i) => i % 4 === 3 && v > 0);
    const icons = [];
    for (const icon of ['flame', 'star', 'cross', 'diamond', 'heart']) {
      draw({ ...original, colorMode: 'solid', timer: false, countdown: false, tip: 'icon', tipIcon: icon }); icons.push(graphics.toDataURL());
    }
    draw({ ...original, timer: false, countdown: false, tip: 'none', colorMode: 'gradient', gradientColors: ['#0000ff', '#ff0000'] });
    const customGradient = { start: at(10, 2), end: at(950, 2) };
    return { parity, pixelDifferences,maxDifference, printed, hierarchy, textPixels, numbering, beforeManifest, afterManifest, missingIdentity, variants, statementSizing, noteLines: noteBlocks.find(b => b.role === 'body').lines,
      longBounds, invalidates: before !== after && after.find(b => b.role === 'title').lines.join(' ') === mutable.title, unchangedOverlay,
      original, originalFlameStops, legacy, legacyInput, resolved, flame, plain, allHidden, caption, untimedCaption, iconCount: new Set(icons).size, customGradient,
      paused: presentationElapsed({ elapsedMs: 60000, receivedAt: 10 }, 120000, false, 50000), running: presentationElapsed({ elapsedMs: 60000, receivedAt: 10 }, 120000, true, 1010) };
  });
  // The preview's CSS gradients and the Program canvas must agree on angle,
  // non-uniform stops, named/rgb colours and translucent stops as well.
  for (const css of ['linear-gradient(135deg, #142536 0%, #653412 35%, #dca533 100%)', 'linear-gradient(to top right, rgb(12, 40, 80) 10%, #fe9854 80%)', 'linear-gradient(90deg, rgba(40,120,200,.5), #304050)']) {
    await page.evaluate(css => {
      document.body.style.margin = '0'; document.body.innerHTML = '<div id="css-gradient" style="width:320px;height:180px;background-color:#102030"></div><canvas id="canvas-gradient" width="320" height="180" style="display:block"></canvas>';
      document.querySelector('#css-gradient').style.backgroundImage = css;
      const ctx = document.querySelector('#canvas-gradient').getContext('2d'); ctx.fillStyle = '#102030'; ctx.fillRect(0, 0, 320, 180);
      window.PresentationTest.drawPresentationGradient(ctx, css, 320, 180);
    }, css);
    const expected = await sharp(await page.locator('#css-gradient').screenshot()).raw().toBuffer();
    const actual = await sharp(await page.locator('#canvas-gradient').screenshot()).raw().toBuffer();
    let maximum = 0; for (let i = 0; i < expected.length; i++) maximum = Math.max(maximum, Math.abs(expected[i] - actual[i]));
    assert(maximum <= 2, `CSS/Program gradient parity: ${css}, maximum channel difference ${maximum}`);
  }
  assert.equal(result.parity, true, 'Actual Preview ContentLayer pixels equal the Program source renderer');
  assert.equal(result.textPixels, true);
  assert.deepEqual(result.printed.map(([role]) => role), ['label', 'title', 'body', 'reference']);
  assert.equal(result.printed[0][1], 'PRAYER 1.'); assert.equal(result.printed[1][1], 'Saviour of World!');
  assert(result.hierarchy[1][1] > result.hierarchy[2][1], 'Title remains the hero; supporting scripture stays smaller');
  assert.deepEqual(result.numbering, ['1.', '1a.', '1.']);
  assert.deepEqual(result.beforeManifest, { id: 'first', label: '1.' }, 'State before content keeps the same Program prayer');
  assert.deepEqual(result.afterManifest, { id: 'first', label: '2.' }, 'New numbering follows the selected item after content arrives');
  assert.equal(result.missingIdentity, true, 'An unavailable stable identity must never fall through to a neighbour');
  for (const [layout, blocks] of Object.entries(result.variants)) assert.deepEqual(blocks.map(b => b.role), ['label', 'title', 'body', 'reference'], `${layout} retains all authored content`);
  for (const statement of result.statementSizing) {
    assert(statement.body > statement.heading, `${statement.type} statement emphasizes the actual thought over its heading`);
    assert.equal(statement.titleOnly, statement.body, `${statement.type} title-only statement remains large`);
  }
  assert(result.variants.quote[2].lines.join(' ').startsWith('“'));
  assert.deepEqual(result.noteLines, ['• Listen', '• Be patient', '• Give thanks']);
  assert(result.longBounds.every(([top, bottom]) => top >= 120 && bottom <= 960.1), 'Long prayers fit inside the shared safe area');
  for (let i = 1; i < result.longBounds.length; i++) assert(result.longBounds[i][0] > result.longBounds[i - 1][1]);
  assert.equal(result.invalidates, true); assert.equal(result.unchangedOverlay, true);
  assert.equal(result.original.template, 'flame'); assert.equal(result.original.position, 'top'); assert.equal(result.original.thickness, 5); assert.equal(result.original.tip, 'glow');
  assert.equal(result.originalFlameStops.length, 7);
  for (const [key, value] of Object.entries(result.legacyInput)) assert.deepEqual(result.legacy[key], value, `Existing ${key} retained`);
  assert.equal(result.legacy.tip, 'none'); assert.equal(result.legacy.caption, true);
  assert.equal(result.resolved.thickness, 19); assert.equal(result.resolved.tipIcon, 'star'); assert.equal(result.resolved.caption, false); assert.deepEqual(result.resolved.gradientColors, ['#123456', '#abcdef']);
  assert(result.flame.ember[0] > result.flame.ember[1]); assert(result.flame.orange[0] > 220); assert(result.flame.hot[0] > 230 && result.flame.hot[1] > 220);
  assert.equal(result.flame.empty[3], 0); assert(result.flame.glow[3] > 0, 'Leading glow extends below the 5px top bar');
  assert.deepEqual(result.plain.inside, [34, 204, 102, 255]); assert.equal(result.plain.above[3], 0); assert.equal(result.plain.after[3], 0); assert.equal(result.plain.top[3], 0);
  assert.equal(result.allHidden, true); assert.equal(result.caption, true); assert.equal(result.untimedCaption, true); assert.equal(result.iconCount, 5);
  assert(result.customGradient.start[2] > 240 && result.customGradient.end[0] > 240);
  assert.equal(result.paused, 60000); assert.equal(result.running, 61000); assert.deepEqual(errors, []);
  console.log('PASS: real Preview/Program pixel parity, prayer/sub-prayer hierarchy, layouts/notes, safe fitting, exact flame geometry/palette, legacy customization, icons, captions and manual clocks');
} finally { await browser?.close(); }
