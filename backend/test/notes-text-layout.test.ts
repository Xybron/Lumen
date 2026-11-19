import test from 'node:test';
import assert from 'node:assert/strict';
import { createCanvas } from '@napi-rs/canvas';
import { layoutPresentationText } from '../../frontend/src/lib/presentation-slide.ts';
import type { Item } from '../../frontend/src/types.ts';

test('Notes text-size controls affect key points and keep long notes inside the slide', () => {
  const ctx = createCanvas(1920, 1080).getContext('2d') as unknown as CanvasRenderingContext2D;
  const base: Item = { id: 'notes-layout', type: 'notes', title: 'Keep growing', body: 'A clear point.', layout: 'key-points', durationMs: 30000 };
  const bodySize = (size?: NonNullable<Item['typography']>['size']) => layoutPresentationText(ctx, { ...base, typography: { size } }).find(block => block.role === 'body')!.fontSize;
  assert.equal(bodySize(), 38, 'The existing default size stays unchanged');
  assert(bodySize('sm') < bodySize('lg'));
  assert(bodySize('2xl') > bodySize('lg'), 'Text-size changes must resize the actual points, not only the title');
  const long = layoutPresentationText(ctx, { ...base, body: Array.from({ length: 24 }, (_, index) => `Point ${index + 1}: keep caring for the people around you.`).join('\n'), typography: { size: '2xl' } });
  assert(long.every(block => block.y >= 0 && block.y + block.lines.length * block.lineHeight <= 1080), 'Auto-fit keeps large multi-point notes visible in preview and Program');
});
