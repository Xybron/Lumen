/** Canvas geometry stays in document percentages; pointer deltas are rounded on
 * the 1920 × 1080 production grid rather than the operator monitor's pixels. */
export interface CanvasRect { x: number; y: number; width: number; height: number }
export type ResizeHandle = 'n' | 'ne' | 'e' | 'se' | 's' | 'sw' | 'w' | 'nw';
export interface SnapGuide { axis: 'x' | 'y'; value: number }
export interface GeometryResult { rect: CanvasRect; guides: SnapGuide[] }
export interface GeometryOptions {
  shift?: boolean;
  snap?: boolean;
  targets?: SnapGuide[];
  tolerance?: { x: number; y: number };
}
const PX = 19.2, PY = 10.8;
const clamp = (value: number, min: number, max: number) => Math.max(min, Math.min(max, value));
const pixel = (value: number, scale: number) => Math.round(value * scale) / scale;

export function canvasSnapTargets(layers: (CanvasRect & { id: string; visible: boolean })[], exceptId: string): SnapGuide[] {
  const targets: SnapGuide[] = [0, 50, 100].flatMap(value => [{ axis: 'x' as const, value }, { axis: 'y' as const, value }]);
  for (const layer of layers) if (layer.id !== exceptId && layer.visible) {
    for (const value of [layer.x, layer.x + layer.width / 2, layer.x + layer.width]) targets.push({ axis: 'x', value });
    for (const value of [layer.y, layer.y + layer.height / 2, layer.y + layer.height]) targets.push({ axis: 'y', value });
  }
  return targets;
}

function nearest(values: number[], targets: SnapGuide[], axis: 'x' | 'y', tolerance: number) {
  let match: { delta: number; guide: SnapGuide } | undefined;
  for (const guide of targets) if (guide.axis === axis) for (const value of values) {
    const delta = guide.value - value;
    if (Math.abs(delta) <= tolerance && (!match || Math.abs(delta) < Math.abs(match.delta))) match = { delta, guide };
  }
  return match;
}

export function moveRect(initial: CanvasRect, dx: number, dy: number, options: GeometryOptions = {}): GeometryResult {
  if (options.shift) {
    if (Math.abs(dx * PX) >= Math.abs(dy * PY)) dy = 0; else dx = 0;
  }
  let x = clamp(initial.x + dx, -100, 100), y = clamp(initial.y + dy, -100, 100);
  const guides: SnapGuide[] = [], tolerance = options.tolerance ?? { x: .5, y: .8 };
  if (options.snap !== false) {
    const targets = options.targets ?? canvasSnapTargets([], '');
    const sx = (!options.shift || dy === 0) ? nearest([x, x + initial.width / 2, x + initial.width], targets, 'x', tolerance.x) : undefined;
    const sy = (!options.shift || dx === 0) ? nearest([y, y + initial.height / 2, y + initial.height], targets, 'y', tolerance.y) : undefined;
    if (sx && x + sx.delta >= -100 && x + sx.delta <= 100) { x += sx.delta; guides.push(sx.guide); }
    if (sy && y + sy.delta >= -100 && y + sy.delta <= 100) { y += sy.delta; guides.push(sy.guide); }
  }
  return { rect: { ...initial, x: clamp(pixel(x, PX), -100, 100), y: clamp(pixel(y, PY), -100, 100) }, guides };
}

function resizeUnsnapped(initial: CanvasRect, dx: number, dy: number, handle: ResizeHandle, aspect: boolean): CanvasRect {
  const left = handle.includes('w'), right = handle.includes('e'), top = handle.includes('n'), bottom = handle.includes('s');
  const farX = initial.x + initial.width, farY = initial.y + initial.height;
  if (!aspect) {
    let { x, y, width, height } = initial;
    if (left) { x = clamp(pixel(initial.x + dx, PX), Math.max(-100, farX - 200), Math.min(100, farX - 1)); width = clamp(farX - x, 1, 200); }
    if (right) width = clamp(pixel(initial.width + dx, PX), 1, 200);
    if (top) { y = clamp(pixel(initial.y + dy, PY), Math.max(-100, farY - 200), Math.min(100, farY - 1)); height = clamp(farY - y, 1, 200); }
    if (bottom) height = clamp(pixel(initial.height + dy, PY), 1, 200);
    return { x, y, width, height };
  }
  const sx = (initial.width + (left ? -dx : dx)) / initial.width;
  const sy = (initial.height + (top ? -dy : dy)) / initial.height;
  let scale = left || right ? top || bottom ? Math.abs(sx - 1) >= Math.abs(sy - 1) ? sx : sy : sx : sy;
  // Width/height and origin constraints are solved together, preserving aspect
  // ratio even when an opposite-edge anchor is near the schema boundary.
  let minScale = Math.max(1 / initial.width, 1 / initial.height);
  let maxScale = Math.min(200 / initial.width, 200 / initial.height);
  const constrainOrigin = (origin: number, size: number, near: boolean, far: boolean) => {
    if (far) return;
    const anchor = near ? origin + size : origin + size / 2;
    const factor = near ? size : size / 2;
    minScale = Math.max(minScale, (anchor - 100) / factor);
    maxScale = Math.min(maxScale, (anchor + 100) / factor);
  };
  constrainOrigin(initial.x, initial.width, left, right);
  constrainOrigin(initial.y, initial.height, top, bottom);
  scale = clamp(scale, minScale, maxScale);
  const width = initial.width * scale, height = initial.height * scale;
  // Round the driving size only. Rounding both axes independently changes the
  // ratio; the derived axis intentionally retains subpixel precision.
  const driveX = left || right;
  const roundedScale = clamp(driveX ? pixel(width, PX) / initial.width : pixel(height, PY) / initial.height, minScale, maxScale);
  const w = initial.width * roundedScale, h = initial.height * roundedScale;
  // A division followed by multiplication can overshoot a strict document
  // boundary by one floating-point ULP (200.00000000000003, for example).
  return { x: clamp(right ? initial.x : left ? farX - w : initial.x + (initial.width - w) / 2, -100, 100),
    y: clamp(bottom ? initial.y : top ? farY - h : initial.y + (initial.height - h) / 2, -100, 100),
    width: clamp(w, 1, 200), height: clamp(h, 1, 200) };
}

export function resizeRect(initial: CanvasRect, dx: number, dy: number, handle: ResizeHandle, options: GeometryOptions = {}): GeometryResult {
  let rect = resizeUnsnapped(initial, dx, dy, handle, !!options.shift);
  const guides: SnapGuide[] = [], targets = options.targets ?? canvasSnapTargets([], ''), tolerance = options.tolerance ?? { x: .5, y: .8 };
  if (options.snap === false) return { rect, guides };
  const horizontal = handle.includes('w') ? 'w' : handle.includes('e') ? 'e' : null;
  const vertical = handle.includes('n') ? 'n' : handle.includes('s') ? 's' : null;
  const sx = horizontal ? nearest([horizontal === 'w' ? rect.x : rect.x + rect.width], targets, 'x', tolerance.x) : undefined;
  const sy = vertical ? nearest([vertical === 'n' ? rect.y : rect.y + rect.height], targets, 'y', tolerance.y) : undefined;
  // With aspect lock, use one snap as the driver rather than deforming the box.
  if (options.shift) {
    if (sx && (!sy || Math.abs(sx.delta / tolerance.x) <= Math.abs(sy.delta / tolerance.y))) {
      rect = resizeUnsnapped(initial, dx + sx.delta, dy, handle, true);
      if (Math.abs((horizontal === 'w' ? rect.x : rect.x + rect.width) - sx.guide.value) <= 1 / PX) guides.push(sx.guide);
    } else if (sy) {
      rect = resizeUnsnapped(initial, dx, dy + sy.delta, handle, true);
      if (Math.abs((vertical === 'n' ? rect.y : rect.y + rect.height) - sy.guide.value) <= 1 / PY) guides.push(sy.guide);
    }
  } else {
    rect = resizeUnsnapped(initial, dx + (sx?.delta ?? 0), dy + (sy?.delta ?? 0), handle, false);
    if (sx && Math.abs((horizontal === 'w' ? rect.x : rect.x + rect.width) - sx.guide.value) <= 1 / PX) guides.push(sx.guide);
    if (sy && Math.abs((vertical === 'n' ? rect.y : rect.y + rect.height) - sy.guide.value) <= 1 / PY) guides.push(sy.guide);
  }
  return { rect, guides };
}

/** Keyboard deltas are exact production pixels, including legacy documents
 * whose existing percentage positions are not on a whole-pixel boundary. */
export function nudgeRect(rect: CanvasRect, dxPixels: number, dyPixels: number): CanvasRect {
  return { ...rect, x: clamp(rect.x + dxPixels / PX, -100, 100), y: clamp(rect.y + dyPixels / PY, -100, 100) };
}
