export interface InputSelection {
  videoDeviceId?: string;
  audioDeviceId?: string;
  includeAudio?: boolean;
  width?: number;
  height?: number;
  frameRate?: number;
}

/** Auto lets fixed-mode HDMI adapters negotiate. Explicit choices must succeed
 * as requested so the preview never silently uses a different format. */
export function cameraVideoConstraints(selection: InputSelection = {}): MediaTrackConstraints {
  return {
    width: selection.width === undefined ? { ideal: 1920 } : { exact: selection.width },
    height: selection.height === undefined ? { ideal: 1080 } : { exact: selection.height },
    frameRate: selection.frameRate === undefined ? { ideal: 30 } : { exact: selection.frameRate },
    ...(selection.videoDeviceId ? { deviceId: { exact: selection.videoDeviceId } } : {}),
  };
}

/** Capture cards exposed by the OS use the same device API as webcams. */
export function deviceConstraints(kind: 'camera' | 'microphone', selection: InputSelection = {}): MediaStreamConstraints {
  return {
    video: kind === 'camera' ? cameraVideoConstraints(selection) : false,
    audio: kind === 'microphone' || selection.includeAudio ? {
      echoCancellation: false, noiseSuppression: false, autoGainControl: false,
      ...(selection.audioDeviceId ? { deviceId: { exact: selection.audioDeviceId } } : {}),
    } : false,
  };
}

export function inputCaptureError(cause: unknown): string {
  const { name, constraint } = (cause as { name?: string; constraint?: string } | null) ?? {};
  if (name === 'NotAllowedError' || name === 'SecurityError') return 'Allow camera/microphone access in browser and system privacy settings, then reconnect.';
  if (name === 'OverconstrainedError' && ['width', 'height', 'frameRate'].includes(constraint ?? '')) {
    const setting = constraint === 'frameRate' ? 'frame rate' : 'resolution';
    return `The selected ${setting} is not supported with this camera format. Choose another resolution or frame rate, or use Auto.`;
  }
  if (name === 'NotFoundError' || name === 'OverconstrainedError') return 'The selected input is unavailable. Check the capture card connection and driver, or add a source with another device. No default input was substituted.';
  if (name === 'NotReadableError' || name === 'AbortError') return 'The input could not start. Close other apps using the capture card or camera, check its HDMI signal, then reconnect.';
  return 'Device access failed. Check the input connection, driver and browser permissions, then reconnect.';
}

export async function openDeviceCapture(kind: 'camera' | 'microphone', selection: InputSelection = {}): Promise<MediaStream> {
  if (!navigator.mediaDevices?.getUserMedia) throw new Error('Device access requires localhost or HTTPS and a browser with camera support.');
  let stream: MediaStream;
  try { stream = await navigator.mediaDevices.getUserMedia(deviceConstraints(kind, selection)); }
  catch (cause) { throw new Error(inputCaptureError(cause)); }
  const live = (tracks: MediaStreamTrack[]) => tracks.some(track => track.readyState === 'live');
  const videoLive = live(stream.getVideoTracks()), audioLive = live(stream.getAudioTracks());
  if (!(kind === 'camera' ? videoLive : audioLive) || (kind === 'camera' && selection.includeAudio && !audioLive)) {
    stream.getTracks().forEach(track => track.stop());
    throw new Error(kind === 'camera' && !videoLive
      ? 'The input returned no live video track. Check the camera, HDMI cable and capture card.'
      : 'The input returned no live audio track. Select an available audio device or add the camera without audio.');
  }
  return stream;
}

/** A live audio track alone does not mean a camera picture has arrived. */
export function liveInputStatus(kind: 'camera' | 'screen' | 'microphone', stream: MediaStream | null,
  picture?: { readyState: number; videoWidth: number; videoHeight: number } | null): 'ready' | 'loading' | 'missing' {
  const tracks = kind === 'microphone' ? stream?.getAudioTracks() : stream?.getVideoTracks();
  const track = tracks?.find(track => track.readyState === 'live');
  if (!track) return 'missing';
  if (track.muted) return 'loading';
  if (kind !== 'microphone' && (!picture || picture.readyState < 2 || !picture.videoWidth || !picture.videoHeight)) return 'loading';
  return 'ready';
}
