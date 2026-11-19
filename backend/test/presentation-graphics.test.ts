import test from 'node:test';
import assert from 'node:assert/strict';
import { ChannelSchema } from '../src/schema.js';
import { drawPresentationGraphics, presentationElapsed, presentationGraphics, presentationTime } from '../../frontend/src/lib/presentation-graphics.ts';

function context() {
  const marks: Array<{ kind: string; args: unknown[]; color: unknown }> = [];
  const ctx: Record<string, unknown> = { fillStyle: '', save() {}, restore() {}, scale() {}, beginPath() {},
    roundRect() {}, arc() {}, measureText: (text: string) => ({ width: text.length * 14 }),
    createLinearGradient: () => ({ addColorStop() {} }) };
  for (const kind of ['fillRect', 'fillText', 'fill', 'stroke']) ctx[kind] = (...args: unknown[]) => marks.push({ kind, args, color: ctx.fillStyle });
  return { ctx: ctx as unknown as CanvasRenderingContext2D, marks };
}
const frame = { graphics: presentationGraphics(), durationMs: 120000, elapsedMs: 110000, countdownAtMs: 15000, warningAtMs: 30000, title: 'Prayer' };

test('presentation clock extrapolates running manual timers, freezes paused snapshots and clamps at cue end', () => {
  const clock = { elapsedMs: 110000, receivedAt: 1000 };
  assert.equal(presentationElapsed(clock, 120000, true, 6000), 115000);
  assert.equal(presentationElapsed(clock, 120000, false, 6000), 110000);
  assert.equal(presentationElapsed(clock, 120000, true, 999999), 120000);
  assert.equal(presentationElapsed(undefined, 120000, true, 6000), 0);
  assert.equal(presentationTime(3661000), '1:01:01');
});

test('all audience graphics can be hidden without changing timing data', () => {
  const { ctx, marks } = context();
  drawPresentationGraphics(ctx, { ...frame, graphics: { ...frame.graphics, progress: false, timer: false, countdown: false, warning: false } }, 1920, 1080);
  assert.deepEqual(marks, []);
  assert.equal(frame.elapsedMs, 110000);
});

test('countdown and elapsed timer render independently of progress visibility', () => {
  const { ctx, marks } = context();
  drawPresentationGraphics(ctx, { ...frame, graphics: { ...frame.graphics, template: 'minimal', timerMode: 'elapsed', progress: false } }, 1920, 1080);
  assert(marks.some(mark => mark.kind === 'fillText' && mark.args[0] === '01:50 elapsed'));
  assert(marks.some(mark => mark.kind === 'fillText' && mark.args[0] === '10'));
  assert(!marks.some(mark => mark.kind === 'fillRect'));
  const end = context(); drawPresentationGraphics(end.ctx, { ...frame, elapsedMs: 120000, graphics: { ...frame.graphics, progress: false, timer: false } }, 1920, 1080);
  assert.deepEqual(end.marks, [], 'finished countdown never leaves a stale zero on the picture');
});

test('graphics and named presets survive validation per channel, invalid colours and oversized preset collections fail', () => {
  const first = ChannelSchema.parse({ id: 'a', name: 'A', playlistId: 'p', presentationGraphics: frame.graphics,
    presentationGraphicPresets: [{ name: 'Prayer night', graphics: { ...frame.graphics, template: 'ember' } }] });
  assert.equal(first.presentationGraphicPresets?.[0]?.graphics.template, 'ember');
  assert.equal(ChannelSchema.parse({ id: 'b', name: 'B', playlistId: 'q' }).presentationGraphicPresets, undefined);
  assert.equal(ChannelSchema.safeParse({ ...first, presentationGraphics: { ...frame.graphics, color: 'url(invalid)' } }).success, false);
  assert.equal(ChannelSchema.safeParse({ ...first, presentationGraphicPresets: Array(21).fill(first.presentationGraphicPresets![0]) }).success, false);
});

 test('flame omits the persistent footer timer while retaining caption and final countdown', () => {
  const { ctx, marks } = context();
  drawPresentationGraphics(ctx, { ...frame, graphics: { ...frame.graphics, timer: true, caption: true, progress: false } }, 1920, 1080);
  const labels = marks.filter(mark => mark.kind === 'fillText').map(mark => mark.args[0]);
  assert.deepEqual(labels, ['Prayer', '10']);
 });
