import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { ProductionStore } from '../src/production-store.js';
import { LayerSchema, initialProduction } from '../src/production-schema.js';
import type { SceneLayer } from '../../shared/production.js';

const style = {
  fontFamily: 'georgia', italic: true, underline: true, lineHeight: 1.5, letterSpacing: 3,
  verticalAlign: 'bottom', textTransform: 'uppercase',
  textStroke: { color: '#14263b', width: 2 },
  textShadow: { color: '#000000a0', blur: 8, offsetX: -2, offsetY: 4 },
} satisfies Partial<SceneLayer>;
const fields = Object.keys(style) as (keyof typeof style)[];
function typography(layer: SceneLayer) { return Object.fromEntries(fields.map(key => [key, layer[key]])); }

test('rich typography is optional for existing scenes and rejects invalid or unsupported styles', () => {
  const legacy = initialProduction().scenes[0].layers[0];
  assert.deepEqual(LayerSchema.parse(legacy), legacy, 'Reading a legacy layer must not inject style defaults');
  assert.deepEqual(typography(LayerSchema.parse({ ...legacy, ...style })), style);
  for (const fontFamily of ['system', 'arial', 'verdana', 'trebuchet', 'georgia', 'times', 'courier']) {
    assert.equal(LayerSchema.safeParse({ ...legacy, fontFamily }).success, true);
  }
  for (const patch of [
    { fontFamily: 'url(https://example.invalid/font.woff2)' }, { fontFamily: 'unregistered-font' },
    { italic: 'yes' }, { underline: 1 }, { lineHeight: .79 }, { lineHeight: 2.51 }, { lineHeight: NaN },
    { letterSpacing: -5.01 }, { letterSpacing: 20.01 }, { letterSpacing: Infinity },
    { verticalAlign: 'baseline' }, { textTransform: 'capitalize' },
    { textStroke: { color: 'red', width: 1 } }, { textStroke: { color: '#000000', width: 10.1 } },
    { textStroke: { color: '#000000', width: -1 } }, { textStroke: { color: '#000000', width: 1, extra: true } },
    { textShadow: { ...style.textShadow, blur: 30.1 } }, { textShadow: { ...style.textShadow, offsetX: -30.1 } },
    { textShadow: { ...style.textShadow, offsetY: 30.1 } }, { textShadow: { ...style.textShadow, color: 'transparent' } },
    { textShadow: { ...style.textShadow, extra: true } },
  ]) assert.equal(LayerSchema.safeParse({ ...legacy, ...patch }).success, false, JSON.stringify(patch));
});

test('typography changes remain in Preview, survive restart, and preserve independent Program/output snapshots', async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'lumen-typography-'));
  try {
    const store = new ProductionStore(dir); await store.init();
    let state = store.get();
    Object.assign(state.scenes[0].layers[0], structuredClone(style));
    state = await store.save(state);
    const sceneId = state.scenes[0].id;
    state = await store.command(state.revision, { type: 'take', sceneId });
    state = await store.command(state.revision, { type: 'route', outputId: 'screen_main', sceneId });
    state.scenes[0].layers[0].fontFamily = 'courier';
    state.scenes[0].layers[0].textShadow!.blur = 0;
    state.scenes[0].layers[0].textStroke!.width = 0;
    state = await store.save(state);
    assert.equal(state.scenes[0].layers[0].fontFamily, 'courier');
    assert.deepEqual(typography(state.program!.layers[0]), style);
    assert.deepEqual(typography(state.outputs[0].scene!.layers[0]), style);
    const reopened = new ProductionStore(dir); await reopened.init();
    assert.deepEqual(reopened.get(), state, 'All styles and committed copies persist on disk');
    state = await reopened.command(state.revision, { type: 'take', sceneId });
    assert.equal(state.program!.layers[0].fontFamily, 'courier');
    assert.equal(state.program!.layers[0].textStroke!.width, 0);
    assert.equal(state.program!.layers[0].textShadow!.blur, 0);
    assert.deepEqual(typography(state.outputs[0].scene!.layers[0]), style, 'A pinned output keeps its own style');
    // Clear optional effects as the editor does in a full document save.
    state.scenes[0].layers[0].textShadow = undefined;
    state.scenes[0].layers[0].textStroke = undefined;
    state = await reopened.save(JSON.parse(JSON.stringify(state)));
    assert.equal(state.scenes[0].layers[0].textShadow, undefined);
    assert.equal(state.scenes[0].layers[0].textStroke, undefined);
    assert.notEqual(state.program!.layers[0].textShadow, undefined);
  } finally { await fs.rm(dir, { recursive: true, force: true }); }
});
