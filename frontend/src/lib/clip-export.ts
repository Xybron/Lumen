import type { ClipExport, ClipExportOptions, ClipFormat } from '../../../shared/clips';

export const EXPORT_FORMATS = [
  { value: 'mp4', label: 'MP4', description: 'H.264 · AAC', use: 'Best compatibility for social media and screens' },
  { value: 'mov', label: 'MOV', description: 'H.264 · AAC', use: 'QuickTime video for editing and playback' },
  { value: 'webm', label: 'WebM', description: 'VP9 · Opus', use: 'Open web video · takes longer to encode' },
  { value: 'mp3', label: 'MP3', description: '192 kbps stereo', use: 'Audio only · sermons, podcasts and sharing' },
  { value: 'wav', label: 'WAV', description: 'PCM · 48 kHz stereo', use: 'Uncompressed audio · larger files for further editing' },
] as const;
export const defaultExportOptions = (): ClipExportOptions => ({ container: 'mp4', resolution: '1080p' });
export const audioExport = (container: ClipExportOptions['container']) => container === 'mp3' || container === 'wav';
export function exportOptions(job: Pick<ClipExport, 'options'>): ClipExportOptions { return job.options ?? defaultExportOptions(); }
export function exportLabel(job: Pick<ClipExport, 'options'>) { return exportOptions(job).container.toUpperCase(); }
export function exportDimensions(format: ClipFormat, options: ClipExportOptions) {
  const short = options.resolution === '720p' ? 720 : 1080, long = options.resolution === '720p' ? 1280 : 1920;
  return format === '9:16' ? `${short} × ${long}` : format === '1:1' ? `${short} × ${short}` : `${long} × ${short}`;
}
