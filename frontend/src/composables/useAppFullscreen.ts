import { inject, type InjectionKey } from 'vue';
import { useFullscreen } from '@vueuse/core';

export type AppFullscreen = ReturnType<typeof useFullscreen>;
export const appFullscreenKey: InjectionKey<AppFullscreen> = Symbol('app-fullscreen');

export function useAppFullscreen(): AppFullscreen {
  const fullscreen = inject(appFullscreenKey);
  if (!fullscreen) throw new Error('App fullscreen is unavailable outside Lumen.');
  return fullscreen;
}
