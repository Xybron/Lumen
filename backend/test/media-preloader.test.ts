import test from 'node:test';
import assert from 'node:assert/strict';
import { createMediaPreloader } from '../../frontend/src/lib/media-preloader';

test('next-slide warming shares assets, releases obsolete buffers and can revisit released media', t => {
  const created: Media[] = [];
  class Media {
    src = ''; preload = ''; muted = false; paused = false; loads = 0;
    constructor() { created.push(this); }
    pause() { this.paused = true; }
    removeAttribute(name: string) { if (name === 'src') this.src = ''; }
    load() { this.loads++; }
  }
  for (const [key, value] of Object.entries({ Image: Media, document: { createElement: () => new Media() } })) {
    const original = Object.getOwnPropertyDescriptor(globalThis, key);
    Object.defineProperty(globalThis, key, { configurable: true, value });
    t.after(() => { if (original) Object.defineProperty(globalThis, key, original); else Reflect.deleteProperty(globalThis, key); });
  }
  const pool = createMediaPreloader(), video = { kind: 'video' as const, url: '/motion.mp4' };
  pool.prepare('main', video); pool.prepare('main', video); pool.prepare('other', video);
  assert.equal(created.length, 1); assert.equal(created[0].muted, true); assert.equal(created[0].preload, 'auto');
  pool.prepare('main', { kind: 'image', url: '/picture.png' });
  assert.equal(created[0].src, video.url, 'Another channel still needs the original preload');
  pool.release('other');
  assert.equal(created[0].src, ''); assert.equal(created[0].paused, true); assert.equal(created[0].loads, 1);
  pool.prepare('main', video);
  assert.equal(created[1].src, '', 'Obsolete artwork is released');
  assert.equal(created.length, 3, 'Returning to an evicted asset prepares it again');
  for (let i = 0; i < 100; i++) pool.prepare('main', { kind: 'video', url: `/slide-${i}.mp4` });
  assert.equal(created.filter(element => !!element.src).length, 1, 'A long deck retains only the next asset');
  pool.prepare('main'); pool.release('main');
  assert.equal(created.filter(element => !!element.src).length, 0, 'End of deck / channel disposal frees every preload');
});
