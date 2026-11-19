// Verify the actual received packets and end-of-run audio after a rehearsal.
// Does not open devices or network connections, or modify recorded media.
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { spawn } from 'node:child_process';
import ffmpeg from 'ffmpeg-static';

const filename = process.argv[2]; assert.ok(filename, 'Pass the stress-test report.json path.');
const report = JSON.parse(await fs.readFile(filename, 'utf8')); assert.equal(report.ok, true);
async function run(args) {
  return new Promise((resolve, reject) => {
    const child = spawn(ffmpeg, args, { stdio: ['ignore', 'pipe', 'pipe'] }); let output = '', error = '';
    child.stdout.on('data', c => { output += c; }); child.stderr.on('data', c => { error += c; });
    child.once('error', reject); child.once('close', code => code === 0 ? resolve({ output, error }) : reject(new Error(error)));
  });
}
const checks = [];
const recordingId = report.samples.findLast(s => s.status?.recording?.id)?.status.recording.id;
assert.ok(recordingId, 'The rehearsal includes a local recording');
const recordingDirectory = path.join(report.directory, 'recordings', recordingId);
const recording = JSON.parse(await fs.readFile(path.join(recordingDirectory, 'recording.json'), 'utf8'));
assert.equal(recording.status, 'complete');
const media = [...report.media, { name: 'local-recording', filename: path.join(recordingDirectory, 'recording.webm'), bytes: recording.bytes }];
for (const stream of media) {
  const local = stream.name === 'local-recording';
  const packets = await run(['-hide_banner', '-nostats', '-progress', 'pipe:1', '-i', stream.filename, '-map', '0:v:0', '-an', '-c:v', 'copy', '-f', 'null', '-']);
  const value = key => Number([...packets.output.matchAll(new RegExp(`^${key}=(\\d+)$`, 'gm'))].at(-1)?.[1]);
  const frames = value('frame'), durationSeconds = value('out_time_us') / 1000000, averageFps = frames / durationSeconds;
  assert.match(packets.error, local ? /Video: vp[89][^\n]*1920x1080/ : /Video: h264[^\n]*1280x720/);
  assert.ok(durationSeconds >= report.seconds, `${stream.name}: full stress duration is present`);
  assert.ok(averageFps >= 28.5 && averageFps <= 31, `${stream.name}: actual average frame rate ${averageFps}`);
  const audio = await run(['-hide_banner', '-ss', String(Math.max(0, durationSeconds - 3)), '-i', stream.filename, '-vn', '-af', 'volumedetect', '-f', 'null', '-']);
  const meanDb = Number(audio.error.match(/mean_volume: ([-\d.]+) dB/)?.[1]);
  assert.match(audio.error, local ? /Audio: opus[^\n]*stereo/ : /Audio: aac[^\n]*stereo/); assert.ok(Number.isFinite(meanDb) && meanDb > -45, `${stream.name}: audible stereo audio remains at the end`);
  const motion = [];
  for (const offset of [5, Math.floor(durationSeconds / 2), Math.max(0, Math.floor(durationSeconds) - 5)]) {
    const decoded = await run(['-hide_banner', '-loglevel', 'error', '-ss', String(offset), '-i', stream.filename, '-t', '2', '-an', '-vf', 'fps=10,scale=160:90', '-f', 'framemd5', '-']);
    const hashes = decoded.output.split('\n').filter(line => /^0,/.test(line)).map(line => line.split(',').at(-1).trim());
    const uniqueFrames = new Set(hashes).size;
    assert.ok(hashes.length >= 18 && uniqueFrames >= 15, `${stream.name}: moving video at ${offset}s (${uniqueFrames}/${hashes.length} distinct frames)`);
    motion.push({ offset, frames: hashes.length, uniqueFrames });
  }
  checks.push({ name: stream.name, frames, durationSeconds, averageFps, endAudioMeanDb: meanDb, bytes: stream.bytes, motion });
}
const result = { ok: true, report: filename, checks };
await fs.writeFile(path.join(path.dirname(filename), 'media-verification.json'), JSON.stringify(result, null, 2));
console.log(JSON.stringify(result, null, 2));
