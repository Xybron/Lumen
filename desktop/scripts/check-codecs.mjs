// Verify the packaged encoder with the application's real export arguments.
// Only synthetic video/audio and temporary files are used.
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { spawn } from 'node:child_process';
const desktop = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const resources = path.resolve(process.argv[2] || path.join(desktop, 'build/resources'));
const manifest = JSON.parse(await fs.readFile(path.join(resources, 'runtime-manifest.json'), 'utf8'));
const ffmpeg = path.join(resources, manifest.ffmpegRelativePath);
const { exportArguments, clipExportMatches } = await import(pathToFileURL(path.join(resources, 'lumen/backend/dist/clip-media.js')).href);
const temp = await fs.mkdtemp(path.join(os.tmpdir(), 'lumen-desktop-codecs-'));
async function run(args, allowedCode = 0) {
  return new Promise((resolve, reject) => {
    const child = spawn(ffmpeg, args, { windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
    let output = ''; child.stdout.on('data', value => { output += value; }); child.stderr.on('data', value => { output += value; });
    child.once('error', reject);
    child.once('exit', code => code === allowedCode ? resolve(output) : reject(new Error(`FFmpeg exited ${code}\n${output}`)));
  });
}
try {
  const input = path.join(temp, 'synthetic.webm');
  await run(['-hide_banner', '-loglevel', 'error', '-f', 'lavfi', '-i', 'testsrc2=size=320x180:rate=30', '-f', 'lavfi', '-i', 'sine=frequency=440:sample_rate=48000', '-t', '1', '-c:v', 'libvpx-vp9', '-deadline', 'realtime', '-cpu-used', '6', '-threads', '1', '-c:a', 'libopus', '-ac', '2', '-y', input]);
  const checks = [];
  for (const container of ['mp4', 'mov', 'webm', 'mp3', 'wav']) {
    const output = path.join(temp, `export.${container}`), options = { container, resolution: '720p' };
    await run(exportArguments(input, output, { inMs: 0, outMs: 1000, format: '16:9', fit: 'contain', positionX: .5, positionY: .5 }, options, true));
    const details = await run(['-hide_banner', '-i', output], 1);
    assert.ok(clipExportMatches(details, '16:9', options, 1000), `${container} metadata matches the application export contract`);
    assert.ok((await fs.stat(output)).size > 0);
    checks.push(container);
  }
  await run(['-hide_banner', '-loglevel', 'error', '-i', input, '-frames:v', '1', '-y', path.join(temp, 'thumbnail.png')]);
  assert.ok((await fs.stat(path.join(temp, 'thumbnail.png'))).size > 0);
  console.log(JSON.stringify({ result: 'PASS', checks: [...checks, 'PNG thumbnail'], ffmpeg }));
} finally { await fs.rm(temp, { recursive: true, force: true }); }
