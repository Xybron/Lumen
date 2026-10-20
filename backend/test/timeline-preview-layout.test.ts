import test from 'node:test';
import assert from 'node:assert/strict';
import { frameTiles, waveformTiles, visibleMediaWindow, timelinePreviewKey, MAX_FRAME_TILES } from '../../frontend/src/lib/timeline-previews.js';

test('visible timeline media windows exclude offscreen clips and bound long-recording DOM geometry', () => {
  const item = { startMs: 20_000, durationMs: 7_200_000 };
  assert.equal(visibleMediaWindow(item, .1, 0, 900), null);
  assert.equal(visibleMediaWindow(item, .1, 800_000, 900), null);
  assert.equal(visibleMediaWindow(item, 0, 3000, 900), null);
  assert.equal(visibleMediaWindow(item, NaN, 3000, 900), null);
  assert.equal(visibleMediaWindow(item, .1, 3000, 0), null);
  const window = visibleMediaWindow(item, .1, 3000, 900)!;
  assert.equal(window.leftPx, 872);
  assert.equal(window.widthPx, 1156);
  assert.equal(window.localStartMs, 8720);
  assert.equal(window.localEndMs, 20280);
  const huge = visibleMediaWindow(item, .96, 300_000, 1_000_000)!;
  assert.ok(huge.widthPx <= 4096 + 256, 'Never allocate a whole long timeline or unconstrained viewport.');
});

test('filmstrip tiles use source time, stay inside trimmed clips and are bounded at wide/high zoom', () => {
  for (const [inMs, durationMs] of [[3333, 100], [45_123, 1200], [14_400_007, 7_200_000]]) {
    for (const scale of [.006, .2, .96]) {
      const item = { startMs: 0, inMs, durationMs }, before = structuredClone(item);
      const window = visibleMediaWindow(item, scale, 0, 4096)!;
      const frames = frameTiles(item, scale, window);
      assert.ok(frames.length > 0 && frames.length <= MAX_FRAME_TILES);
      for (const frame of frames) {
        assert.equal(frame.atMs % 100, 0);
        assert.ok(frame.atMs >= inMs, `Frame ${frame.atMs} must not precede trimmed in-point ${inMs}.`);
        assert.ok(frame.atMs < inMs + durationMs);
        assert.ok(frame.widthPx > 0 && frame.leftPx >= 0);
      }
      assert.deepEqual(item, before, 'Drawing the timeline cannot change a source trim.');
    }
  }
});

test('splitting and rearranging retain absolute source timing independently of timeline position', () => {
  const first = { startMs: 5000, inMs: 10_000, durationMs: 2000 };
  const second = { startMs: 7000, inMs: 12_000, durationMs: 2000 };
  const window1 = visibleMediaWindow(first, .2, 0, 2000)!;
  const window2 = visibleMediaWindow(second, .2, 0, 2000)!;
  const left = frameTiles(first, .2, window1), right = frameTiles(second, .2, window2);
  assert.ok(left.every(tile => tile.atMs >= 10_000 && tile.atMs < 12_000));
  assert.ok(right.every(tile => tile.atMs >= 12_000 && tile.atMs < 14_000));
  const moved = { ...second, startMs: 0 };
  assert.deepEqual(frameTiles(moved, .2, visibleMediaWindow(moved, .2, 0, 2000)!), right);
});

test('waveform chunks map exact source offsets through non-zero trims, zoom and horizontal scroll', () => {
  const item = { startMs: 0, inMs: 45_123, durationMs: 60_000 };
  const scale = .2, window = visibleMediaWindow(item, scale, 1000, 1600)!;
  const { tiles, limited } = waveformTiles(item, scale, window);
  assert.equal(limited, false);
  assert.equal(tiles[0].atMs, 30_000);
  assert.equal(tiles[0].widthPx, 6000);
  assert.ok(Math.abs(tiles[0].leftPx + 3024.6) < .00001);
  const sourceToneMs = 55_000;
  const imageFraction = (sourceToneMs - tiles[0].atMs) / 30_000;
  const waveformPosition = tiles[0].leftPx + imageFraction * tiles[0].widthPx;
  assert.ok(Math.abs(waveformPosition - (sourceToneMs - item.inMs) * scale) < .00001);
  assert.ok(waveformPosition >= window.leftPx && waveformPosition < window.leftPx + window.widthPx);
});

test('waveform requests cross 30-second boundaries without gaps and cap extreme layouts', () => {
  const item = { inMs: 29_500 };
  const normal = waveformTiles(item, .1, { leftPx: 0, widthPx: 200, localStartMs: 0, localEndMs: 2000 });
  assert.deepEqual(normal.tiles.map(tile => tile.atMs), [0, 30_000]);
  assert.equal(normal.tiles[0].leftPx + normal.tiles[0].widthPx, normal.tiles[1].leftPx);
  const huge = waveformTiles({ inMs: 0 }, .00001, { leftPx: 0, widthPx: 1000, localStartMs: 0, localEndMs: 86_400_000 });
  assert.equal(huge.tiles.length, 64);
  assert.equal(huge.limited, true);
});

test('cache keys deduplicate quantized source previews but never mix source identities or media kinds', () => {
  const recording = { kind: 'recording' as const, id: 'rec_test' };
  assert.equal(timelinePreviewKey(recording, 'frame', 1234), timelinePreviewKey(recording, 'frame', 1299));
  assert.notEqual(timelinePreviewKey(recording, 'frame', 1234), timelinePreviewKey(recording, 'frame', 1300));
  assert.equal(timelinePreviewKey(recording, 'waveform', 29_999), timelinePreviewKey(recording, 'waveform', 0));
  assert.notEqual(timelinePreviewKey(recording, 'waveform', 30_000), timelinePreviewKey(recording, 'waveform', 0));
  assert.notEqual(timelinePreviewKey(recording, 'frame', 0), timelinePreviewKey({ kind: 'asset', id: 'rec_test' }, 'frame', 0));
  assert.notEqual(timelinePreviewKey(recording, 'frame', 0), timelinePreviewKey(recording, 'waveform', 0));
});
