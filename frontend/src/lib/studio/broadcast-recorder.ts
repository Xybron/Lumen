import type { BroadcastProfile } from '../../../../shared/broadcast';
import { broadcastRecorderOptions, streamVideoBitrate, type BroadcastCaptureRecorder } from './broadcast-capture';

interface TrackProcessor {
  new <T>(options: { track: MediaStreamTrack; maxBufferSize: number }): { readable: ReadableStream<T> };
}

// Prefer one hardware video encode in the worker. Commit the container format
// only after it supplies media. An unsupported station can still go live.
export class StudioBroadcastRecorder implements BroadcastCaptureRecorder {
  state = 'inactive';
  videoEncoder = 'starting';
  ondataavailable: BroadcastCaptureRecorder['ondataavailable'] = null;
  onerror: BroadcastCaptureRecorder['onerror'] = null;
  private worker: Worker | null = null;
  private fallback: MediaRecorder | null = null;
  private tracks: MediaStreamTrack[] = [];
  private startup?: number;
  private sentMedia = false;
  constructor(private stream: MediaStream, private profile: BroadcastProfile) {}

  start(timeslice: number) {
    this.state = 'recording';
    const Processor = (window as Window & { MediaStreamTrackProcessor?: TrackProcessor }).MediaStreamTrackProcessor;
    if (!Processor || typeof Worker === 'undefined') { this.useCompatibilityRecorder(timeslice); return; }
    // The managed Mac Chromium stalled at hardware AVC initialization and
    // interrupted simultaneous Program audio. Its software worker passed the
    // same live A/V check. On Windows try the GPU on actual Program frames.
    this.startWorker(Processor, !/Mac/i.test(navigator.platform), timeslice);
  }

  private startWorker(Processor: TrackProcessor, hardware: boolean, timeslice: number) {
    const failed = () => {
      this.releaseWorker();
      if (this.state === 'inactive') return;
      if (this.sentMedia) { this.onerror?.(); return; }
      if (hardware) this.startWorker(Processor, false, timeslice);
      else this.useCompatibilityRecorder(timeslice);
    };
    try {
      const worker = new Worker(new URL('./broadcast-encoder.worker.ts', import.meta.url), { type: 'module' });
      this.worker = worker;
      const clone = (track: MediaStreamTrack) => {
        const owned = track.clone();
        this.tracks.push(owned);
        return owned;
      };
      worker.onmessage = ({ data }: MessageEvent<'error' | 'ready' | Blob>) => {
        if (this.worker !== worker) return;
        if (data === 'error') { failed(); return; }
        if (data === 'ready') {
          try {
            const video = new Processor<VideoFrame>({ track: clone(this.stream.getVideoTracks()[0]), maxBufferSize: 1 }).readable;
            const audio = new Processor<AudioData>({ track: clone(this.stream.getAudioTracks()[0]), maxBufferSize: 8 }).readable;
            worker.postMessage({ video, audio }, [video, audio]);
          } catch { failed(); }
          return;
        }
        clearTimeout(this.startup);
        this.sentMedia = true;
        this.videoEncoder = hardware ? 'worker-hardware' : 'worker-software';
        this.ondataavailable?.({ data });
        if (this.worker === worker) worker.postMessage('ack');
      };
      const workerError = () => { if (this.worker === worker) failed(); };
      worker.onerror = workerError;
      worker.onmessageerror = workerError;
      this.startup = window.setTimeout(workerError, 3500);
      worker.postMessage({ hardware, bitrate: streamVideoBitrate(this.profile) });
    } catch { failed(); }
  }

  private useCompatibilityRecorder(timeslice: number) {
    try {
      this.videoEncoder = 'compatibility';
      const recorder = new MediaRecorder(this.stream, broadcastRecorderOptions(this.profile));
      recorder.ondataavailable = event => this.ondataavailable?.(event);
      recorder.onerror = () => this.onerror?.();
      this.fallback = recorder;
      recorder.start(timeslice);
    } catch { this.onerror?.(); }
  }

  private releaseWorker() {
    clearTimeout(this.startup);
    this.worker?.terminate(); this.worker = null;
    for (const track of this.tracks) track.stop();
    this.tracks = [];
  }

  stop() {
    this.state = 'inactive';
    this.releaseWorker();
    if (this.fallback) {
      this.fallback.ondataavailable = null; this.fallback.onerror = null;
      if (this.fallback.state !== 'inactive') this.fallback.stop();
      this.fallback = null;
    }
  }
}
