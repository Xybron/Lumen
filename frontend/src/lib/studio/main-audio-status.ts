import type { StudioSource, StudioStatus } from '../../../../shared/production';

export type MainAudioState = 'ready' | 'muted' | 'disconnected' | 'error' | 'offline' | 'loading' | 'paused' | 'no-audio';

/** Input health only: silence between sentences and final-output mute are not
 * input failures, and an offline renderer cannot establish disconnection. */
export function describeMainAudioStatus(source: Pick<StudioSource, 'audio' | 'playback'>,
  engine: StudioStatus['state'], status?: StudioStatus['sources'][string], error?: string, textOnly = false) {
  let state: MainAudioState;
  if (textOnly) state = 'no-audio';
  else if (engine === 'running' && status === 'error') state = 'error';
  else if (engine === 'running' && status === 'missing') state = 'disconnected';
  else if (source.audio.muted || source.audio.volume <= 0) state = 'muted';
  else if (source.playback?.paused) state = 'paused';
  else if (engine === 'starting') state = 'loading';
  else if (engine !== 'running') state = 'offline';
  else if (!status || status === 'loading') state = 'loading';
  else state = 'ready';
  const descriptions: Record<MainAudioState, [string, string]> = {
    ready: ['Main', 'Main input is available.'],
    muted: ['Main · Muted', source.audio.muted ? 'Main input is muted.' : 'Main input volume is zero.'],
    disconnected: ['Main · Disconnected', 'Main input is disconnected. Reconnect it in Sources.'],
    error: ['Main · Error', 'Main input needs attention. Check its source status.'],
    offline: ['Main · Offline', 'The engine is offline; live input availability is not being checked.'],
    loading: ['Main · Connecting', 'Waiting for the engine or main input to become ready.'],
    paused: ['Main · Paused', 'Main media playback is paused.'],
    'no-audio': ['Main · No audio', 'This channel is text-only. Choose an audio input as Main in Audio mixer.'],
  };
  const [label, explanation] = descriptions[state];
  const alsoMuted = source.audio.muted && state !== 'muted' ? ' Input is also muted.' : '';
  return { state, label, title: `${error || explanation}${alsoMuted} Main selection persists across every scene.` };
}
