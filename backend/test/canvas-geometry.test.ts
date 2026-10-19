import test from 'node:test';
import assert from 'node:assert/strict';
import { canvasSnapTargets, moveRect, resizeRect, nudgeRect, type CanvasRect, type ResizeHandle } from '../../frontend/src/lib/studio/canvas-geometry.js';

const initial: CanvasRect = { x: 10, y: 20, width: 30, height: 20 };
const near = (a: number, b: number, epsilon = 1e-9) => assert.ok(Math.abs(a - b) <= epsilon, `${a} should equal ${b}`);

test('canvas movement snaps edges and centers, with an explicit bypass', () => {
  const targets = canvasSnapTargets([{ ...initial, id: 'other', visible: true }, { x: 70, y: 80, width: 10, height: 10, id: 'hidden', visible: false }], 'moving');
  assert.ok(targets.some(g => g.axis === 'x' && g.value === 25));
  assert.equal(targets.some(g => g.value === 80), false);
  const snapped = moveRect({ ...initial, x: 19.7 }, 0, 0, { targets, tolerance: { x: .5, y: .5 } });
  near(snapped.rect.x, 20); // right edge aligns with the canvas center
  assert.ok(snapped.guides.some(g => g.axis === 'x' && g.value === 50));
  const free = moveRect({ ...initial, x: 19.7 }, 0, 0, { snap: false });
  assert.notEqual(free.rect.x, 20);
  assert.deepEqual(free.guides, []);
});

test('drag rounds on the production pixel grid and constrains schema origins', () => {
  const result = moveRect(initial, 1.12345, 2.23456, { snap: false }).rect;
  near(result.x * 19.2, Math.round(result.x * 19.2));
  near(result.y * 10.8, Math.round(result.y * 10.8));
  assert.equal(moveRect(initial, 900, -900, { snap: false }).rect.x, 100);
  assert.equal(moveRect(initial, 900, -900, { snap: false }).rect.y, -100);
  assert.deepEqual({ width: result.width, height: result.height }, { width: initial.width, height: initial.height });
});

test('Shift locks movement to the visually dominant pixel axis', () => {
  const horizontal = moveRect(initial, 2, 3, { shift: true, snap: false }).rect;
  near(horizontal.y, initial.y);
  const vertical = moveRect(initial, 1, 3, { shift: true, snap: false }).rect;
  near(vertical.x, initial.x);
});

test('all eight resize handles respect the opposite edge and schema dimensions', () => {
  for (const handle of ['n', 'ne', 'e', 'se', 's', 'sw', 'w', 'nw'] as ResizeHandle[]) {
    const r = resizeRect(initial, 4, 5, handle, { snap: false }).rect;
    assert.ok(r.width >= 1 && r.width <= 200);
    assert.ok(r.height >= 1 && r.height <= 200);
    if (handle.includes('w')) near(r.x + r.width, initial.x + initial.width, .06);
    if (handle.includes('n')) near(r.y + r.height, initial.y + initial.height, .1);
    if (handle.includes('e')) near(r.x, initial.x);
    if (handle.includes('s')) near(r.y, initial.y);
  }
});

test('resize cannot invert a rectangle or exceed the document limits', () => {
  for (const handle of ['n', 'ne', 'e', 'se', 's', 'sw', 'w', 'nw'] as ResizeHandle[]) for (const delta of [-1000, 1000]) {
    const r = resizeRect(initial, delta, delta, handle, { snap: false }).rect;
    assert.ok(r.width >= 1 && r.width <= 200 && r.height >= 1 && r.height <= 200);
    assert.ok(r.x >= -100 && r.x <= 100 && r.y >= -100 && r.y <= 100);
  }
});

test('single-edge resizing leaves the orthogonal position and size unchanged', () => {
  const fractional = { x: 10.123, y: 20.456, width: 30.789, height: 20.456 };
  const east = resizeRect(fractional, 10, 0, 'e', { snap: false }).rect;
  assert.equal(east.x, fractional.x); assert.equal(east.y, fractional.y); assert.equal(east.height, fractional.height);
  const north = resizeRect(fractional, 0, -5, 'n', { snap: false }).rect;
  assert.equal(north.x, fractional.x); assert.equal(north.width, fractional.width);
  near(north.y + north.height, fractional.y + fractional.height);
});

test('Shift resize preserves aspect ratio at every handle, including boundary constraints', () => {
  for (const handle of ['n', 'ne', 'e', 'se', 's', 'sw', 'w', 'nw'] as ResizeHandle[]) for (const delta of [-1000, 12, 1000]) {
    const r = resizeRect(initial, delta, delta, handle, { snap: false, shift: true }).rect;
    near(r.width / r.height, initial.width / initial.height);
    assert.ok(r.width >= 1 && r.width <= 200 && r.height >= 1 && r.height <= 200);
    assert.ok(r.x >= -100 && r.x <= 100 && r.y >= -100 && r.y <= 100);
  }
});

test('resize snaps only its active edges and reports the applied guides', () => {
  const result = resizeRect(initial, 9.8, 0, 'e', { targets: [{ axis: 'x', value: 50 }], tolerance: { x: .5, y: .5 } });
  near(result.rect.x + result.rect.width, 50);
  assert.deepEqual(result.guides, [{ axis: 'x', value: 50 }]);
  assert.deepEqual(resizeRect(initial, 9.8, 0, 'e', { snap: false }).guides, []);
});

test('aspect resizing clamps floating point boundary overshoots before persistence', () => {
  const irregular = { x: 16.391414373824233, y: -36.85434587579284, width: 154.95991857951975, height: 41.497233214980184 };
  const maximum = resizeRect(irregular, 1000, 0, 'e', { shift: true, snap: false }).rect;
  assert.equal(maximum.width, 200);
  const minimum = resizeRect({ x: 39.98975491625828, y: 78.15521950165714, width: 28.442346989866746, height: 38.019428254397674 }, 1000, -1000, 'sw', { shift: true, snap: false }).rect;
  assert.equal(minimum.width, 1);
  near(minimum.width / minimum.height, 28.442346989866746 / 38.019428254397674);
});

test('keyboard nudges use exact one-pixel and ten-pixel steps without changing size', () => {
  const r = nudgeRect(initial, 1, -10);
  near((r.x - initial.x) * 19.2, 1);
  near((r.y - initial.y) * 10.8, -10);
  assert.equal(r.width, initial.width); assert.equal(r.height, initial.height);
  assert.equal(nudgeRect({ ...initial, x: 100, y: -100 }, 10, -10).x, 100);
  assert.equal(nudgeRect({ ...initial, x: 100, y: -100 }, 10, -10).y, -100);
});
