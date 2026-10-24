import { cameraVideoConstraints, inputCaptureError, openDeviceCapture, type InputSelection } from './device-capture';

const stop = (stream: MediaStream | null) => stream?.getTracks().forEach(track => track.stop());
const liveTrack = (tracks: MediaStreamTrack[], id?: string) => tracks.find(track =>
  track.readyState === 'live' && (!id || track.getSettings().deviceId === id));

/** Setup owns cloned/new tracks, never the tracks currently feeding Studio. */
export class CameraPreviewCapture {
  private stream: MediaStream | null = null;
  private selection: InputSelection = {};
  private generation = 0;

  async start(selection: InputSelection, connected: MediaStream[] = []): Promise<MediaStream | null> {
    const previous = this.stream, previousSelection = this.selection;
    const candidates = [previous, ...connected].filter((stream): stream is MediaStream => !!stream);
    const reusable = candidates.find(stream => {
      // Default means the browser's default, not an arbitrary connected input.
      if (!selection.videoDeviceId && (stream !== previous || previousSelection.videoDeviceId)) return false;
      return !!liveTrack(stream.getVideoTracks(), selection.videoDeviceId);
    });
    const video = reusable && liveTrack(reusable.getVideoTracks(), selection.videoDeviceId)?.clone();
    const audio = selection.includeAudio && reusable && (selection.audioDeviceId || (reusable === previous && !previousSelection.audioDeviceId))
      ? liveTrack(reusable.getAudioTracks(), selection.audioDeviceId)?.clone() : undefined;
    // Clone before releasing our previous handle to keep the same camera open.
    this.stop();
    const generation = this.generation;
    this.selection = { ...selection };
    let stream: MediaStream | null = video ? new MediaStream([video, ...(audio ? [audio] : [])]) : null;
    this.stream = stream;
    try {
      if (!stream) stream = await openDeviceCapture('camera', selection);
      else {
        // Clones inherit constraints. Replace them even for Auto to release any
        // previous exact format, without changing the published track's constraints.
        // The browser may still reconfigure their shared underlying camera.
        try { await video!.applyConstraints(cameraVideoConstraints(selection)); }
        catch (cause) { throw new Error(inputCaptureError(cause)); }
        if (generation !== this.generation) { stop(stream); return null; }
        if (selection.includeAudio && !audio) {
          const sound = await openDeviceCapture('microphone', { audioDeviceId: selection.audioDeviceId });
          for (const track of sound.getTracks()) stream.addTrack(track);
        }
      }
      if (generation !== this.generation) { stop(stream); return null; }
      this.stream = stream;
      return stream;
    } catch (cause) {
      stop(stream);
      if (generation !== this.generation) return null;
      this.stream = null;
      throw cause;
    }
  }

  /** A separate owned handle can outlive setup after Add succeeds. */
  copy(): MediaStream | null { return this.stream ? new MediaStream(this.stream.getTracks().map(track => track.clone())) : null; }
  stop() { this.generation++; stop(this.stream); this.stream = null; }
}
