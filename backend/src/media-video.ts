import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import fs from 'node:fs/promises';
import { setPriority, constants as osConstants } from 'node:os';
import ffmpeg from 'ffmpeg-static';

/** MOV clips often use HEVC, which is not dependable across browser/PC setups.
 * Prepare a bounded H.264/AAC MP4 for presentation and Studio playback. */
export async function preparePresentationVideo(source: string, originalName: string): Promise<string> {
  if (!/\.mov$/i.test(originalName)) return source;
  if (!ffmpeg) {
    await fs.unlink(source).catch(() => undefined);
    throw new Error('The video converter is unavailable.');
  }
  const ffmpegPath: string = ffmpeg;
  const target = source.replace(/\.mov$/i, '.mp4');
  const pending = `${target}.${randomUUID()}.partial`;
  const args = [
    '-hide_banner', '-loglevel', 'error', '-nostdin', '-y', '-threads', '2', '-i', source,
    '-map', '0:v:0', '-map', '0:a:0?',
    '-vf', "scale=w='min(1920,iw)':h='min(1080,ih)':force_original_aspect_ratio=decrease:force_divisible_by=2,format=yuv420p",
    '-r', '30', '-c:v', 'libx264', '-preset', 'veryfast', '-crf', '23', '-threads', '2',
    '-c:a', 'aac', '-b:a', '160k', '-movflags', '+faststart', '-map_metadata', '-1',
    '-f', 'mp4', pending,
  ];
  try {
    await new Promise<void>((resolve, reject) => {
      const child = spawn(ffmpegPath, args, { stdio: ['ignore', 'ignore', 'pipe'] });
      if (child.pid) try { setPriority(child.pid, osConstants.priority.PRIORITY_BELOW_NORMAL); } catch { /* Best effort on this OS. */ }
      let diagnostics = '';
      child.stderr.on('data', chunk => { if (diagnostics.length < 4096) diagnostics += String(chunk).slice(0, 4096 - diagnostics.length); });
      child.once('error', reject);
      child.once('close', code => code === 0 ? resolve() : reject(new Error(diagnostics || `Video converter exited with ${code}.`)));
    });
    await fs.rename(pending, target);
    await fs.unlink(source);
    return target;
  } catch (error) {
    await Promise.allSettled([fs.unlink(pending), fs.unlink(source)]);
    throw error;
  }
}
