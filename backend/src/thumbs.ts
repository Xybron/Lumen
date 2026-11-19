import path from 'node:path';
import fs from 'node:fs/promises';
import sharp from 'sharp';
import ffmpeg from 'fluent-ffmpeg';
import ffmpegStatic from 'ffmpeg-static';
import { MEDIA_DIR } from './paths.js';

const THUMB_DIR = path.join(MEDIA_DIR, 'thumbnails');

// fluent-ffmpeg picks ffmpeg off PATH by default. Point it at the bundled
// static binary so deployments without ffmpeg installed still produce thumbs.
if (ffmpegStatic) ffmpeg.setFfmpegPath(ffmpegStatic as unknown as string);

function thumbOutPath(basename: string) {
  return path.join(THUMB_DIR, basename.replace(/\.[^.]+$/, '') + '.jpg');
}

function relFromMedia(absPath: string) {
  return path.relative(path.join(MEDIA_DIR, '..'), absPath);
}

export async function makeImageThumb(srcAbs: string, basename: string): Promise<string | null> {
  try {
    await fs.mkdir(THUMB_DIR, { recursive: true });
    const out = thumbOutPath(basename);
    await sharp(srcAbs).resize({ width: 320 }).jpeg({ quality: 78 }).toFile(out);
    return relFromMedia(out);
  } catch {
    return null;
  }
}

// Pull a single frame ~1s into the video, downscale to 320px wide. Resolves to
// null on failure (missing codec, corrupt file, ffmpeg not available) rather
// than throwing — thumbnails are best-effort.
export async function makeVideoThumb(srcAbs: string, basename: string, mediaDir = MEDIA_DIR): Promise<string | null> {
  try {
    const directory = path.join(mediaDir, 'thumbnails');
    await fs.mkdir(directory, { recursive: true });
    const out = path.join(directory, basename.replace(/\.[^.]+$/, '') + '.jpg');
    await new Promise<void>((resolve, reject) => {
      ffmpeg(srcAbs)
        .on('end', () => resolve())
        .on('error', reject)
        .screenshots({
          timestamps: ['1'],
          filename: path.basename(out),
          folder: path.dirname(out),
          size: '320x?',
        });
    });
    return path.relative(path.dirname(mediaDir), out);
  } catch {
    return null;
  }
}
