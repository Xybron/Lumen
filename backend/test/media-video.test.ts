import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';
import test from 'node:test';
import ffmpeg from 'ffmpeg-static';
import { preparePresentationVideo } from '../src/media-video';

const run = promisify(execFile);

test('MOV presentation video becomes a browser-ready MP4 and removes the original', async () => {
  assert.ok(ffmpeg, 'The bundled converter is required');
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'lumen-media-video-'));
  const source = path.join(dir, 'sample.mov');
  try {
    await run(ffmpeg, ['-hide_banner', '-loglevel', 'error', '-f', 'lavfi', '-i', 'testsrc2=size=320x180:rate=30',
      '-t', '1', '-c:v', 'libx265', '-preset', 'ultrafast', '-tag:v', 'hvc1', '-an', source], { timeout: 30_000 });
    const target = await preparePresentationVideo(source, 'sample.mov');
    assert.equal(target, path.join(dir, 'sample.mp4'));
    await assert.rejects(fs.stat(source), { code: 'ENOENT' });
    assert.ok((await fs.stat(target)).size > 0);
    const { stderr } = await run(ffmpeg, ['-hide_banner', '-i', target, '-f', 'null', '-'], { timeout: 30_000 });
    assert.match(stderr, /Video: h264/);
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
});

test('already suitable media is left in place', async () => {
  assert.equal(await preparePresentationVideo('/tmp/clip.mp4', 'clip.mp4'), '/tmp/clip.mp4');
});
