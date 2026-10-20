import type { StudioSource } from '../../../../shared/production';

// One source, one route: main audio is independent of visual composition, not
// an extra copy summed on top of a source that is already in the scene.
export function sourceAudioWeight(source: StudioSource, mainAudioSourceId: string | null | undefined,
  current: boolean, followsProgram: boolean, outgoingWeight: number, sceneWeight: number) {
  if (source.id === mainAudioSourceId && current) return 1;
  if (source.audio.mode === 'always') return current ? 1 : followsProgram ? outgoingWeight : 0;
  return sceneWeight;
}

export function outputAudioEnabled(outputId: string, enabled?: boolean) {
  return outputId !== 'preview' && (outputId === 'program' || enabled === true);
}
