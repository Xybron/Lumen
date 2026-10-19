import test from 'node:test';
import assert from 'node:assert/strict';
import { multiviewAtlasCells, multiviewDisplaySize } from '../../frontend/src/lib/studio/multiview-atlas.js';

test('fullscreen Multiview reflows paired slots into four smaller columns', () => {
  assert.deepEqual(multiviewDisplaySize(3, 4), { columns: 4, rows: 1, slotCount: 4, width: 1280, height: 180 });
  assert.deepEqual(multiviewDisplaySize(5, 4), { columns: 4, rows: 2, slotCount: 6, width: 1280, height: 360 });
  assert.deepEqual(multiviewDisplaySize(5, 2), { columns: 2, rows: 3, slotCount: 6, width: 640, height: 540 });
  assert.deepEqual(multiviewDisplaySize(0, 4), { columns: 4, rows: 1, slotCount: 2, width: 1280, height: 180 });
  assert.equal(multiviewDisplaySize(Number.NaN, 4).slotCount, 2);
  assert.equal(multiviewDisplaySize(-2, 2).slotCount, 2);
  assert.equal(multiviewDisplaySize(3.9, 2).slotCount, 4);
  assert.equal(multiviewDisplaySize(5, 3).columns, 2);
});

test('fullscreen crop coordinates preserve all source cells in row-major order', () => {
  const cells = multiviewAtlasCells(5, 4);
  assert.equal(cells.length, 6, 'Five scenes retain one paired empty slot, not three new ones');
  assert.deepEqual(cells.map(cell => [cell.sourceX, cell.sourceY]), [
    [0, 0], [320, 0], [0, 180], [320, 180], [0, 360], [320, 360],
  ]);
  assert.deepEqual(cells.map(cell => [cell.targetX, cell.targetY]), [
    [0, 0], [320, 0], [640, 0], [960, 0], [0, 180], [320, 180],
  ]);
  assert.ok(cells.every(cell => cell.width === 320 && cell.height === 180));
});

test('floating Multiview retains its original two-column cell layout', () => {
  const cells = multiviewAtlasCells(3, 2);
  assert.equal(cells.length, 4);
  assert.ok(cells.every(cell => cell.sourceX === cell.targetX && cell.sourceY === cell.targetY));
});
