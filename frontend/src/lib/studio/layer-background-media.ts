import type { SceneLayer } from '../../../../shared/production';
import { MediaPlayback } from './media-playback';
import { mediaAssetUrl } from './media-library';

type BackgroundLayer = Pick<SceneLayer, 'id' | 'mediaBackground'>;
type VideoStatus = { status: 'processing' | 'ready' | 'failed' | 'missing'; path?: string };
interface BackgroundVideo {
  element: HTMLVideoElement;
  playback: MediaPlayback;
  preparationTimer?: ReturnType<typeof setInterval>;
  checking: boolean;
  preparing: boolean;
  error: string;
}

// A draft and its committed Program layer can share an id but use different
// media. Fit/dim changes are draw-only; lyric cue changes never enter this key.
function videoKey(layer: BackgroundLayer) {
  const background = layer.mediaBackground;
  return background?.kind === 'video' ? JSON.stringify([layer.id, background.url, background.loop]) : null;
}

/** Silent visual players, entirely separate from source/audio ownership. */
export class LayerBackgroundMedia {
  private videos = new Map<string, BackgroundVideo>();

  constructor(private readonly videoStatus: (url: string) => Promise<VideoStatus>) {}

  sync(layers: readonly BackgroundLayer[]) {
    const retained = new Set<string>();
    for (const layer of layers) {
      const key = videoKey(layer), background = layer.mediaBackground;
      if (!key || !background) continue;
      retained.add(key);
      if (this.videos.has(key)) continue;
      const element = document.createElement('video'), playback = new MediaPlayback();
      // Never attach these players to Web Audio: even a background with an
      // audio track must stay silent in monitoring, recordings and streams.
      element.muted = element.defaultMuted = true; element.volume = 0;
      element.playsInline = true; element.loop = background.loop; element.preload = 'auto';
      element.src = mediaAssetUrl(background.url);
      const entry: BackgroundVideo = { element, playback, checking: false, preparing: /\.mov$/i.test(background.url), error: '' };
      this.videos.set(key, entry);
      element.onerror = () => { if (this.videos.get(key) === entry && !entry.preparing) entry.error = 'Background video cannot be played. Choose an MP4 (H.264) video.'; };
      element.onplaying = () => { if (this.videos.get(key) === entry) entry.error = ''; };
      playback.bind(element); this.play(entry);
      if (entry.preparing) {
        const check = () => { void this.checkPreparedVideo(key, entry, background.url); };
        entry.preparationTimer = setInterval(check, 2000);
        check();
      }
    }
    for (const key of this.videos.keys()) if (!retained.has(key)) this.release(key);
  }

  video(layer: BackgroundLayer): HTMLVideoElement | undefined {
    const key = videoKey(layer);
    return key ? this.videos.get(key)?.element : undefined;
  }

  error(layer: BackgroundLayer): string | undefined {
    const key = videoKey(layer);
    return key ? this.videos.get(key)?.error || undefined : undefined;
  }

  private play(entry: BackgroundVideo) {
    entry.playback.play(error => {
      if (entry.preparing) return;
      const name = error && typeof error === 'object' && 'name' in error ? error.name : '';
      entry.error = name === 'NotSupportedError' ? 'Background video cannot be played. Choose an MP4 (H.264) video.'
        : name === 'NotAllowedError' ? 'Background video was blocked. Choose another video.'
          : 'Background video could not start. Choose another video.';
    });
  }

  private async checkPreparedVideo(key: string, entry: BackgroundVideo, url: string) {
    if (entry.checking) return;
    entry.checking = true;
    try {
      const result = await this.videoStatus(url);
      if (this.videos.get(key) !== entry || result.status === 'processing') return;
      clearInterval(entry.preparationTimer); entry.preparationTimer = undefined;
      entry.preparing = false;
      // Retain playback on browsers that already decode the original MOV.
      if (entry.element.readyState >= 2) { entry.error = ''; return; }
      if (result.status === 'ready' && result.path) {
        entry.element.src = mediaAssetUrl(result.path); entry.element.load();
        this.play(entry);
      } else entry.error = result.status === 'missing' ? 'Background video is missing from this station. Choose another video.'
        : 'Background video could not be prepared. Choose an MP4 (H.264) video.';
    } catch { /* Retry when the local station is reachable again. */ }
    finally { entry.checking = false; }
  }

  private release(key: string) {
    const entry = this.videos.get(key);
    if (!entry) return;
    this.videos.delete(key); clearInterval(entry.preparationTimer);
    entry.playback.bind(null);
    entry.element.onerror = entry.element.onplaying = null;
    entry.element.pause(); entry.element.removeAttribute('src'); entry.element.load();
  }

  close() { for (const key of this.videos.keys()) this.release(key); }
}
