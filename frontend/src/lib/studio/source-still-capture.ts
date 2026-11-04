const sampleTimeoutMs = 1000;

interface FrameCapture { grabFrame(): Promise<ImageBitmap> }
type FrameCaptureConstructor = new (track: MediaStreamTrack) => FrameCapture;

export function stillSize(width: number, height: number): { width: number; height: number } | null {
  if (!Number.isFinite(width) || !Number.isFinite(height) || width <= 0 || height <= 0) return null;
  const scale = Math.min(1, 192 / width, 108 / height);
  return { width: Math.max(1, Math.round(width * scale)), height: Math.max(1, Math.round(height * scale)) };
}

function live(track: MediaStreamTrack) {
  return track.kind === 'video' && track.readyState === 'live' && track.enabled && !track.muted;
}

/** Reads borrowed video tracks only. Device ownership stays with the publisher. */
export class SourceStillCapture {
  private canvas: HTMLCanvasElement | null = null;
  private video: HTMLVideoElement | null = null;
  private active: AbortController | null = null;
  private generation = 0;
  private nativePending = false;
  private nativeUnavailable = new WeakSet<MediaStreamTrack>();

  async capture(track: MediaStreamTrack, signal: AbortSignal): Promise<Blob | null> {
    if (signal.aborted || !live(track)) return null;
    this.active?.abort();
    const active = new AbortController(), generation = ++this.generation;
    this.active = active;
    const abort = () => active.abort();
    signal.addEventListener('abort', abort, { once: true });
    const current = () => !active.signal.aborted && this.generation === generation && live(track);
    try {
      const bitmap = await this.grabFrame(track, active.signal);
      if (bitmap) {
        try { return current() ? await this.encode(bitmap, bitmap.width, bitmap.height, active.signal, current) : null; }
        finally { bitmap.close(); }
      }
      if (!current()) return null;
      return await this.fromVideo(track, active.signal, current);
    } catch {
      // A thumbnail failure never interrupts or changes the publishing input.
      return null;
    } finally {
      signal.removeEventListener('abort', abort);
      if (this.active === active) this.active = null;
    }
  }

  private grabFrame(track: MediaStreamTrack, signal: AbortSignal): Promise<ImageBitmap | null> {
    const Capture = (globalThis as unknown as { ImageCapture?: FrameCaptureConstructor }).ImageCapture;
    if (!Capture || this.nativePending || this.nativeUnavailable.has(track) || signal.aborted || !live(track)) return Promise.resolve(null);
    let request: Promise<ImageBitmap>;
    try { request = new Capture(track).grabFrame(); }
    catch { this.nativeUnavailable.add(track); return Promise.resolve(null); }
    this.nativePending = true;
    return new Promise(resolve => {
      let finished = false;
      const finish = (bitmap: ImageBitmap | null, failed = false) => {
        if (finished) { bitmap?.close(); return; }
        finished = true;
        clearTimeout(timeout);
        signal.removeEventListener('abort', abort);
        if (failed) this.nativeUnavailable.add(track);
        resolve(bitmap);
      };
      const abort = () => finish(null);
      const timeout = setTimeout(() => finish(null, true), sampleTimeoutMs);
      signal.addEventListener('abort', abort, { once: true });
      if (signal.aborted) abort();
      // grabFrame has no cancellation API. Keep the native slot reserved until
      // it really settles; a timeout must not create overlapping native grabs.
      Promise.resolve(request).then(bitmap => {
        this.nativePending = false;
        if (signal.aborted || !live(track)) { bitmap.close(); finish(null); }
        else finish(bitmap);
      }, () => {
        this.nativePending = false;
        finish(null, true);
      });
    });
  }

  private async fromVideo(track: MediaStreamTrack, signal: AbortSignal, current: () => boolean): Promise<Blob | null> {
    if (!current()) return null;
    const video = this.video ??= document.createElement('video');
    // A fresh stream wrapper contains only the existing video track. Never
    // clone it, attach the microphone, or modify the track's constraints.
    const stream = new MediaStream([track]);
    video.muted = true; video.volume = 0; video.playsInline = true;
    video.srcObject = stream;
    try {
      const decoded = await new Promise<boolean>(resolve => {
        let finished = false, frame: number | undefined;
        const hasFrameCallback = typeof video.requestVideoFrameCallback === 'function';
        const ready = () => current() && video.srcObject === stream && video.readyState >= 2 && video.videoWidth > 0 && video.videoHeight > 0;
        const finish = (value: boolean) => {
          if (finished) return;
          finished = true; clearTimeout(timeout);
          if (frame !== undefined) video.cancelVideoFrameCallback(frame);
          for (const event of ['loadeddata', 'canplay', 'resize']) video.removeEventListener(event, check);
          video.removeEventListener('error', stop);
          signal.removeEventListener('abort', stop);
          track.removeEventListener('ended', stop); track.removeEventListener('mute', stop);
          resolve(value);
        };
        const check = () => { if (!hasFrameCallback && ready()) finish(true); };
        const stop = () => finish(false);
        const timeout = setTimeout(stop, sampleTimeoutMs);
        for (const event of ['loadeddata', 'canplay', 'resize']) video.addEventListener(event, check);
        video.addEventListener('error', stop, { once: true });
        signal.addEventListener('abort', stop, { once: true });
        track.addEventListener('ended', stop, { once: true }); track.addEventListener('mute', stop, { once: true });
        if (!current()) { stop(); return; }
        try {
          if (hasFrameCallback) frame = video.requestVideoFrameCallback(() => finish(ready()));
          void video.play().then(check, stop);
        } catch { stop(); }
      });
      if (!decoded || !current()) return null;
      // Drawing copies the small still synchronously. The finally block can
      // detach the video while JPEG serialization finishes asynchronously.
      return this.encode(video, video.videoWidth, video.videoHeight, signal, current);
    } finally {
      if (video.srcObject === stream) this.detach(video);
    }
  }

  private encode(image: CanvasImageSource, width: number, height: number, signal: AbortSignal, current: () => boolean): Promise<Blob | null> {
    const size = stillSize(width, height);
    if (!size || !current()) return Promise.resolve(null);
    const canvas = this.canvas ??= document.createElement('canvas');
    if (canvas.width !== size.width) canvas.width = size.width;
    if (canvas.height !== size.height) canvas.height = size.height;
    const context = canvas.getContext('2d', { alpha: false });
    if (!context) return Promise.resolve(null);
    context.drawImage(image, 0, 0, size.width, size.height);
    return new Promise(resolve => {
      let finished = false;
      const finish = (blob: Blob | null) => {
        if (finished) return;
        finished = true; clearTimeout(timeout); signal.removeEventListener('abort', abort);
        resolve(current() ? blob : null);
      };
      const abort = () => finish(null);
      const timeout = setTimeout(abort, sampleTimeoutMs);
      signal.addEventListener('abort', abort, { once: true });
      if (signal.aborted) { abort(); return; }
      try { canvas.toBlob(finish, 'image/jpeg', .65); } catch { finish(null); }
    });
  }

  private detach(video: HTMLVideoElement) {
    video.pause(); video.srcObject = null; video.removeAttribute('src'); video.load();
  }

  dispose() {
    ++this.generation;
    this.active?.abort(); this.active = null;
    if (this.video) this.detach(this.video);
    this.video = null;
    if (this.canvas) this.canvas.width = this.canvas.height = 0;
    this.canvas = null;
    // A later visible consumer can reuse this adapter. An outstanding native
    // request retains its slot and closes its bitmap when it eventually ends.
  }
}
