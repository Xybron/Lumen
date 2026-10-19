// A dedicated, bounded Program transport. It never owns/stops the compositor's
// tracks or the independent recording encoder.
import type { BroadcastProfile } from '../../../../shared/broadcast';

export function broadcastCaptureSettings(profile: BroadcastProfile) {
  return { profile, width: profile === '720p' ? 1280 : 1920, height: profile === '720p' ? 720 : 1080,
    frameRate: 30, videoBitsPerSecond: profile === '720p' ? 3_000_000 : 6_000_000, audioBitsPerSecond: 192_000 };
}
export function broadcastRecorderOptions(profile: BroadcastProfile, supports = (mime: string) => MediaRecorder.isTypeSupported(mime)): MediaRecorderOptions {
  // The managed transport is WebM. Never fall back to a costly VP9 encoder.
  const mimeType = ['video/webm;codecs=vp8,opus', 'video/webm;codecs=vp8'].find(supports);
  if (!mimeType) throw new Error('This renderer cannot encode the Program stream with VP8.');
  const { videoBitsPerSecond, audioBitsPerSecond } = broadcastCaptureSettings(profile);
  return { mimeType, videoBitsPerSecond, audioBitsPerSecond };
}

/** One small broadcast-only surface, painted by the compositor's existing tick. */
export class BroadcastVideoSource {
  readonly stream: MediaStream;
  readonly settings: ReturnType<typeof broadcastCaptureSettings>;
  private canvas: HTMLCanvasElement | null = null;
  private context: CanvasRenderingContext2D | null = null;
  private closed = false;
  constructor(private source: HTMLCanvasElement, program: MediaStream, profile: BroadcastProfile,
    createCanvas: () => HTMLCanvasElement = () => document.createElement('canvas')) {
    this.settings = broadcastCaptureSettings(profile);
    if (profile === '1080p') { this.stream = program; return; }
    const canvas = createCanvas();
    canvas.width = this.settings.width; canvas.height = this.settings.height;
    const context = canvas.getContext('2d', { alpha: false });
    if (!context) throw new Error('The streaming canvas is unavailable.');
    this.canvas = canvas; this.context = context;
    this.stream = canvas.captureStream(this.settings.frameRate);
    // The existing Program mix is shared, not cloned, reconfigured or owned.
    try {
      for (const track of program.getAudioTracks()) this.stream.addTrack(track);
      this.draw();
    } catch (error) { this.close(); throw error; }
  }
  draw() {
    if (this.closed || !this.canvas || !this.context) return;
    this.context.drawImage(this.source, 0, 0, this.settings.width, this.settings.height);
  }
  close() {
    if (this.closed) return;
    this.closed = true;
    if (this.canvas) {
      // Do not stop shared audio (or 1080p Program) when streaming ends.
      for (const track of this.stream.getVideoTracks()) track.stop();
      this.canvas.width = this.canvas.height = 0;
      this.canvas = null; this.context = null;
    }
  }
}

export interface BroadcastCaptureRecorder {
  readonly state: string;
  ondataavailable: ((event: { data: Blob }) => void) | null;
  onerror: (() => void) | null;
  start(timeslice: number): void;
  stop(): void;
}
export interface BroadcastCaptureOptions {
  createRecorder?: (stream: MediaStream, profile: BroadcastProfile) => BroadcastCaptureRecorder;
  upload: (id: string, sequence: number, data: Blob, signal: AbortSignal) => Promise<unknown>;
  onFailure: (id: string, message: string) => Promise<unknown> | void;
  maxQueuedBytes?: number;
  maxChunkBytes?: number;
  requestTimeoutMs?: number;
  retryDelayMs?: number;
}
function recorderFor(stream: MediaStream, profile: BroadcastProfile): BroadcastCaptureRecorder {
  return new MediaRecorder(stream, broadcastRecorderOptions(profile)) as unknown as BroadcastCaptureRecorder;
}
export interface BroadcastCaptureSource { stream: MediaStream; release?: () => void; }
interface Capture {
  id: string; recorder: BroadcastCaptureRecorder; controller: AbortController;
  queued: number; sequence: number; chain: Promise<void>; stopped: boolean; release: () => void;
  settings: ReturnType<typeof broadcastCaptureSettings>;
}
export class ProgramBroadcastCapture {
  private current: Capture | null = null;
  constructor(private options: BroadcastCaptureOptions) {}
  get activeId() { return this.current?.id ?? null; }
  get queuedBytes() { return this.current?.queued ?? 0; }
  get settings() { return this.current?.settings ?? null; }
  start(id: string, source: MediaStream | (() => BroadcastCaptureSource), profile: BroadcastProfile = '1080p') {
    if (this.current?.id === id) return;
    this.stop();
    let capture: Capture | undefined;
    let release: () => void = () => {};
    try {
      const input = typeof source === 'function' ? source() : { stream: source };
      let released = false;
      release = () => { if (!released) { released = true; try { input.release?.(); } catch { /* Teardown must not affect production. */ } } };
      const recorder = (this.options.createRecorder ?? recorderFor)(input.stream, profile);
      capture = { id, recorder, controller: new AbortController(), queued: 0, sequence: 0, chain: Promise.resolve(), stopped: false, release, settings: broadcastCaptureSettings(profile) };
      this.current = capture;
      const active = capture;
      recorder.ondataavailable = event => this.queue(active, event.data);
      recorder.onerror = () => this.fail(active, 'The streaming encoder stopped. Local recording is independent.');
      recorder.start(500);
    } catch {
      if (capture) this.fail(capture, 'The Program feed could not start streaming. Local recording is independent.');
      else { release(); void Promise.resolve().then(() => this.options.onFailure(id, 'The Program feed could not start streaming. Local recording is independent.')).catch(() => {}); }
    }
  }
  stop(id?: string) {
    const active = this.current;
    if (!active || id && active.id !== id) return;
    this.current = null; active.stopped = true; active.controller.abort();
    active.recorder.ondataavailable = null; active.recorder.onerror = null;
    try { if (active.recorder.state !== 'inactive') active.recorder.stop(); } catch { /* Encoder already stopped. */ }
    active.release();
  }
  private fail(active: Capture, message: string) {
    if (active.stopped || this.current !== active) return;
    this.stop(active.id);
    void Promise.resolve().then(() => this.options.onFailure(active.id, message)).catch(() => {});
  }
  private queue(active: Capture, data: Blob) {
    if (active.stopped || this.current !== active || !data.size) return;
    if (data.size > (this.options.maxChunkBytes ?? 8 * 1024 * 1024) || active.queued + data.size > (this.options.maxQueuedBytes ?? 16 * 1024 * 1024)) {
      this.fail(active, 'The streaming connection is too slow. Streaming stopped to protect Program and local recording.'); return;
    }
    active.queued += data.size;
    const sequence = active.sequence++;
    active.chain = active.chain.then(async () => {
      if (active.stopped) return;
      for (let attempt = 0; attempt < 2; attempt++) {
        if (active.stopped) return;
        const request = new AbortController(), abort = () => request.abort();
        const timeout = setTimeout(abort, this.options.requestTimeoutMs ?? 8000);
        active.controller.signal.addEventListener('abort', abort, { once: true });
        try {
          await this.withAbort(this.options.upload(active.id, sequence, data, request.signal), request.signal);
          active.queued -= data.size; return;
        } catch {
          if (active.stopped) return;
          if (attempt) throw new Error('The station could not accept the Program stream. Streaming stopped; local recording is independent.');
        } finally { clearTimeout(timeout); active.controller.signal.removeEventListener('abort', abort); }
        await this.delay(this.options.retryDelayMs ?? 250, active.controller.signal);
      }
    }).catch(error => this.fail(active, (error as Error).message));
  }
  private withAbort<T>(operation: Promise<T>, signal: AbortSignal): Promise<T> {
    return new Promise((resolve, reject) => {
      const abort = () => reject(new Error('The streaming connection was interrupted.'));
      if (signal.aborted) { operation.catch(() => {}); abort(); return; }
      signal.addEventListener('abort', abort, { once: true });
      operation.then(value => { signal.removeEventListener('abort', abort); resolve(value); }, error => { signal.removeEventListener('abort', abort); reject(error); });
    });
  }
  private delay(ms: number, signal: AbortSignal): Promise<void> {
    return new Promise(resolve => {
      if (signal.aborted) { resolve(); return; }
      const done = () => { clearTimeout(timer); signal.removeEventListener('abort', done); resolve(); };
      const timer = setTimeout(done, ms); signal.addEventListener('abort', done, { once: true });
    });
  }
}
