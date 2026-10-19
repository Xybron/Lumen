interface PlaybackElement {
  play(): Promise<void>;
  pause(): void;
}

// A play promise may settle after its element was paused, replaced or removed.
// Only the latest request on the current element may report a playback failure.
// Do not blanket-ignore AbortError: an unexpected failure on the active input
// still needs to be visible to the operator.
export class MediaPlayback {
  private element: PlaybackElement | null = null;
  private request = 0;

  bind(element: PlaybackElement | null) {
    if (this.element === element) return;
    this.request++;
    this.element = element;
  }

  isCurrent(element: PlaybackElement) { return this.element === element; }

  pause() {
    this.request++;
    this.element?.pause();
  }

  play(failed: (error: unknown) => void) {
    const element = this.element;
    if (!element) return;
    const request = ++this.request;
    const report = (error: unknown) => {
      if (this.element === element && this.request === request) failed(error);
    };
    try { void element.play().catch(report); }
    catch (error) { report(error); }
  }
}

export function playbackError(error: unknown, live: boolean): string {
  const name = typeof error === 'object' && error !== null && 'name' in error ? error.name : '';
  if (name === 'NotAllowedError') return live
    ? 'Input playback was blocked. Reconnect this input or restart the engine.'
    : 'Media playback was blocked. Resume this source or restart the engine.';
  if (name === 'NotSupportedError') return live
    ? 'This input could not be played. Reconnect it and try again.'
    : 'This media could not be decoded. Try an MP4/H.264 video or MP3/WAV audio file.';
  if (name === 'AbortError') return live
    ? 'Input playback was interrupted. Reconnect this input.'
    : 'Media playback was interrupted. Resume or restart this source.';
  return live
    ? 'This input could not start playing. Reconnect it and try again.'
    : 'This media could not start playing. Resume it or choose another file.';
}
