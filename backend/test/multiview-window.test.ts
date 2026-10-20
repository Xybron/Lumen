import test from 'node:test';
import assert from 'node:assert/strict';
import { fitMultiviewWindow } from '../../frontend/src/lib/studio/multiview-window.js';

test('Multiview window preferences stay fully reachable after moves, resize and small screens', () => {
  for (const [width, height] of [[1512, 982], [390, 844], [320, 568], [800, 280]]) {
    for (const box of [null, { x: -500, y: -100, width: 2000, height: 3000 }, { x: 5000, y: 9000, width: 100, height: 200 }, { x: NaN, y: Infinity, width: -1, height: NaN }]) {
      const fitted = fitMultiviewWindow(box, width, height);
      assert.ok(fitted.x >= 12 && fitted.y >= 12);
      assert.ok(fitted.x + fitted.width <= width - 12);
      assert.ok(fitted.y + fitted.height <= height - 12);
    }
  }
  const moved = { x: 30, y: 40, width: 500, height: 450 };
  assert.deepEqual(fitMultiviewWindow(moved, 1512, 982), moved, 'Valid operator positions are not reset');
});
