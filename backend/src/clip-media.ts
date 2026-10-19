import { spawn, type ChildProcess } from 'node:child_process';
import { setPriority } from 'node:os';
import ffmpeg from 'ffmpeg-static';
import { z } from 'zod';
import type { ClipExportOptions, ClipFormat, ClipSettings } from '../../shared/clips.js';

export const MAX_CLIP_MS = 2 * 60 * 60 * 1000;
export const MAX_EXPORT_BYTES = 2 * 1024 * 1024 * 1024;
export const CLIP_SIZES = {
  '16:9': [1920, 1080], '9:16': [1080, 1920], '1:1': [1080, 1080],
} as const;
export const clipExportOptionsSchema = z.object({
  container: z.enum(['mp4', 'webm', 'mov', 'mp3', 'wav']), resolution: z.enum(['1080p', '720p']),
}).strict();
export function normalizeClipExportOptions(options?: ClipExportOptions): ClipExportOptions {
  return options === undefined ? { container: 'mp4', resolution: '1080p' } : clipExportOptionsSchema.parse(options);
}
export function clipExportProfile(options?: ClipExportOptions) {
  const { container } = normalizeClipExportOptions(options);
  const profiles = {
    mp4: { extension: 'mp4', mime: 'video/mp4', video: true, videoCodec: 'h264', audioCodec: 'aac' },
    webm: { extension: 'webm', mime: 'video/webm', video: true, videoCodec: 'vp9', audioCodec: 'opus' },
    mov: { extension: 'mov', mime: 'video/quicktime', video: true, videoCodec: 'h264', audioCodec: 'aac' },
    mp3: { extension: 'mp3', mime: 'audio/mpeg', video: false, videoCodec: '', audioCodec: 'mp3' },
    wav: { extension: 'wav', mime: 'audio/wav', video: false, videoCodec: '', audioCodec: 'pcm_s16le' },
  } as const;
  return { container, ...profiles[container] };
}
export function clipExportDimensions(format: ClipFormat, options?: ClipExportOptions): readonly [number, number] {
  if (normalizeClipExportOptions(options).resolution === '1080p') return CLIP_SIZES[format];
  return format === '16:9' ? [1280, 720] : format === '9:16' ? [720, 1280] : [720, 720];
}
/** Codec/muxer tail only; the caller chooses its verified stream maps and duration. */
export function clipOutputArguments(output: string, options?: ClipExportOptions): string[] {
  const profile = clipExportProfile(options);
  const args: string[] = [];
  if (profile.video) {
    if (profile.container === 'webm') args.push('-c:v', 'libvpx-vp9', '-deadline', 'realtime', '-cpu-used', '6', '-b:v', '0', '-crf', '32');
    else args.push('-c:v', 'libx264', '-preset', 'veryfast', '-crf', '23');
    args.push('-pix_fmt', 'yuv420p', '-r', '30');
  } else args.push('-vn');
  args.push('-threads', '1');
  if (profile.container === 'webm') args.push('-c:a', 'libopus', '-b:a', '160k');
  else if (profile.container === 'mp3') args.push('-c:a', 'libmp3lame', '-b:a', '192k');
  else if (profile.container === 'wav') args.push('-c:a', 'pcm_s16le');
  else args.push('-c:a', 'aac', '-b:a', '160k');
  args.push('-ac', '2', '-ar', '48000');
  if (profile.container === 'mp4' || profile.container === 'mov') args.push('-movflags', '+faststart');
  return [...args, '-map_metadata', '-1', '-max_muxing_queue_size', '1024', '-fs', String(MAX_EXPORT_BYTES), '-progress', 'pipe:1', '-nostats', '-f', profile.container, output];
}

// The player uses CSS object-fit/object-position with these same normalised
// positions. Crop the *remaining* width/height, not the source coordinates.
export function clipVideoFilter(settings: ClipSettings, options?: ClipExportOptions) {
  const [width, height] = clipExportDimensions(settings.format, options);
  if (settings.fit === 'contain') {
    return `scale=${width}:${height}:force_original_aspect_ratio=decrease:force_divisible_by=2,pad=${width}:${height}:(ow-iw)/2:(oh-ih)/2:color=black,setsar=1`;
  }
  return `scale=${width}:${height}:force_original_aspect_ratio=increase:force_divisible_by=2,crop=${width}:${height}:(iw-ow)*${settings.positionX}:(ih-oh)*${settings.positionY},setsar=1`;
}

export function exportArguments(input: string, output: string, settings: ClipSettings, options?: ClipExportOptions, hasAudio = true) {
  const profile = clipExportProfile(options);
  const args = [
    '-hide_banner', '-nostdin', '-y', '-threads', '1',
    '-ss', (settings.inMs / 1000).toFixed(3), '-i', input,
  ];
  if (!profile.video && !hasAudio) args.push('-f', 'lavfi', '-i', 'anullsrc=r=48000:cl=stereo');
  args.push('-t', ((settings.outMs - settings.inMs) / 1000).toFixed(3));
  if (profile.video) args.push('-map', '0:v:0', '-map', '0:a:0?', '-vf', clipVideoFilter(settings, options));
  else args.push('-map', hasAudio ? '0:a:0' : '1:a:0');
  return [...args, '-sn', '-dn', '-filter_threads', '1', '-filter_complex_threads', '1', ...clipOutputArguments(output, options)];
}

export function clipExportMatches(stderr: string, format: ClipFormat, options: ClipExportOptions | undefined, expectedDurationMs: number): boolean {
  const profile = clipExportProfile(options);
  const duration = stderr.match(/Duration:\s*(\d+):(\d{2}):(\d{2}(?:\.\d+)?)/);
  if (!duration) return false;
  const actual = (Number(duration[1]) * 3600 + Number(duration[2]) * 60 + Number(duration[3])) * 1000;
  if (Math.abs(actual - expectedDurationMs) > 150) return false;
  const audioLine = stderr.split(/\r?\n/).find(line => /Stream.*Audio:/.test(line));
  const audioMatches = !!audioLine && new RegExp(`Audio:\\s*${profile.audioCodec}\\b`).test(audioLine) && /(?:stereo|2 channels)/.test(audioLine);
  if (!profile.video) return audioMatches && !/Stream.*Video:/.test(stderr);
  const info = parseMediaInfo(stderr, 0), [width, height] = clipExportDimensions(format, options);
  // Legacy recordings without an audio track remain exportable as silent video.
  return !!info && info.width === width && info.height === height && new RegExp(`Video:\\s*${profile.videoCodec}\\b`).test(stderr) && (!audioLine || audioMatches);
}

export interface MediaInfo { durationMs: number; width: number; height: number }
export function parseMediaInfo(stderr: string, fallbackDurationMs: number): MediaInfo | null {
  const dimensions = stderr.split(/\r?\n/).find(line => /Stream.*Video:/.test(line))?.match(/(?:^|[\s,])([1-9]\d{0,4})x([1-9]\d{0,4})(?=$|[\s,])/);
  if (!dimensions) return null;
  const duration = stderr.match(/Duration:\s*(\d+):(\d{2}):(\d{2}(?:\.\d+)?)/);
  const durationMs = duration
    ? Math.round((Number(duration[1]) * 3600 + Number(duration[2]) * 60 + Number(duration[3])) * 1000)
    : fallbackDurationMs;
  const width = Number(dimensions[1]), height = Number(dimensions[2]);
  if (![durationMs, width, height].every(Number.isFinite) || durationMs <= 0 || width < 2 || height < 2 || width > 16384 || height > 16384) return null;
  return { durationMs, width, height };
}

export interface MediaProcess {
  process: ChildProcess;
  result: Promise<string>;
  stop(reason: string): void;
}

// One caller-owned worker serialises these processes. No shell interpolation,
// arbitrary commands, unbounded output capture or detached child processes.
export function runClipMedia(args: string[], timeoutMs: number, onProgress?: (microseconds: number) => void): MediaProcess {
  if (!ffmpeg) throw new Error('FFmpeg is unavailable on this station.');
  const process = spawn(ffmpeg, args, { stdio: ['ignore', 'pipe', 'pipe'] });
  if (process.pid) {
    try { setPriority(process.pid, 15); } catch { /* Best effort on platforms without process priorities. */ }
  }
  let stderr = '', progressBuffer = '', failure: string | null = null;
  let killTimer: ReturnType<typeof setTimeout> | undefined;
  const stop = (reason: string) => {
    if (process.exitCode !== null || process.signalCode !== null) return;
    failure ??= reason;
    process.kill('SIGTERM');
    killTimer ??= setTimeout(() => { process.kill('SIGKILL'); }, 1500);
    killTimer.unref();
  };
  const timer = setTimeout(() => stop('The media job exceeded its time limit.'), timeoutMs);
  timer.unref();
  process.stderr?.on('data', (data: Buffer) => { stderr = (stderr + data.toString()).slice(-24_000); });
  process.stdout?.on('data', (data: Buffer) => {
    progressBuffer = (progressBuffer + data.toString()).slice(-8000);
    const lines = progressBuffer.split(/\r?\n/);
    progressBuffer = lines.pop() ?? '';
    for (const line of lines) {
      const match = /^out_time_us=(\d+)$/.exec(line);
      if (match) onProgress?.(Number(match[1]));
    }
  });
  const result = new Promise<string>((resolve, reject) => {
    process.once('error', error => {
      clearTimeout(timer); if (killTimer) clearTimeout(killTimer);
      reject(error);
    });
    process.once('close', code => {
      clearTimeout(timer); if (killTimer) clearTimeout(killTimer);
      if (failure || code !== 0) reject(new Error(failure ?? `Media processing failed (${code}). ${stderr.slice(-1200)}`));
      else resolve(stderr);
    });
  });
  return { process, result, stop };
}
