import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';
import { setPriority, constants as osConstants } from 'node:os';
import ffmpeg from 'ffmpeg-static';
import { makeVideoThumb } from './thumbs.js';

const activePreparations = new Set<string>(), deletingSources = new Set<string>();
export class MediaVideoBusyError extends Error {}

/** The synchronous reservation prevents preparation/status requests from
 * starting a new writer between a deletion check and its filesystem changes. */
export async function withSourceVideoDeletion<T>(sources: string[], operation: () => Promise<T>): Promise<T> {
  const paths = sources.map(source => path.resolve(source));
  if (paths.some(source => activePreparations.has(source) || sourceJobs.get(source) === 'processing' || deletingSources.has(source))) {
    throw new MediaVideoBusyError('This video is still being prepared. Wait for preparation to finish before deleting it.');
  }
  paths.forEach(source => deletingSources.add(source));
  try { return await operation(); }
  finally { paths.forEach(source => deletingSources.delete(source)); }
}

/** MOV clips often use HEVC, which is not dependable across browser/PC setups.
 * Prepare a bounded H.264/AAC MP4 for presentation and Studio playback. */
export async function preparePresentationVideo(source: string, originalName: string, keepOriginal = false): Promise<string> {
  if (!/\.mov$/i.test(originalName)) return source;
  source = path.resolve(source);
  if (deletingSources.has(source) || activePreparations.has(source)) throw new MediaVideoBusyError('This video is busy. Please try again shortly.');
  activePreparations.add(source);
  try { return await convertPresentationVideo(source, keepOriginal); }
  finally { activePreparations.delete(source); }
}

async function convertPresentationVideo(source: string, keepOriginal: boolean): Promise<string> {
  if (!ffmpeg) {
    if (!keepOriginal) await fs.unlink(source).catch(() => undefined);
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
    if (!keepOriginal) await fs.unlink(source);
    return target;
  } catch (error) {
    await Promise.allSettled(keepOriginal ? [fs.unlink(pending)] : [fs.unlink(pending), fs.unlink(source)]);
    throw error;
  }
}

// Source uploads finish as soon as the file is stored. MOV preparation runs
// separately so a large 4K clip never holds the upload request open.
const sourceJobs = new Map<string, 'processing' | 'failed'>();
let sourceQueue: Promise<unknown> = Promise.resolve();

export function queueSourceVideo(source: string): void {
  source = path.resolve(source);
  if (!/\.mov$/i.test(source) || sourceJobs.has(source) || deletingSources.has(source) || activePreparations.has(source)) return;
  sourceJobs.set(source, 'processing');
  sourceQueue = sourceQueue.catch(() => undefined).then(async () => {
    try {
      const target = await preparePresentationVideo(source, source, true);
      await fs.stat(target);
      try { await fs.stat(source); } catch {
        // The operator removed this upload while conversion was in progress.
        await fs.unlink(target).catch(() => undefined);
        sourceJobs.delete(source);
        return;
      }
      const folder = path.dirname(source);
      await makeVideoThumb(target, path.basename(source), path.basename(folder) === 'backgrounds' ? path.dirname(folder) : folder);
      sourceJobs.delete(source);
    } catch (error) {
      sourceJobs.set(source, 'failed');
      console.warn('[media] Source video preparation failed:', (error as Error).message);
    }
  });
}

export async function sourceVideoStatus(source: string, options: { resume?: boolean } = {}): Promise<{ status: 'processing' | 'ready' | 'failed' | 'missing'; path?: string }> {
  source = path.resolve(source);
  if (!/\.mov$/i.test(source)) return { status: 'missing' };
  const target = source.replace(/\.mov$/i, '.mp4');
  try { await fs.stat(source); } catch { return { status: 'missing' }; }
  try {
    const stat = await fs.lstat(target);
    if (stat.isFile() && stat.size > 0) return { status: 'ready', path: target };
  } catch { /* Conversion has not finished. */ }
  if (!sourceJobs.has(source) && options.resume !== false) queueSourceVideo(source); // Resume after a station restart.
  return { status: sourceJobs.get(source) ?? (activePreparations.has(source) ? 'processing' : 'missing') };
}
