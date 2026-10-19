import { useShortcuts } from '@/lib/keyboard';
import { usePlaybackStore } from '@/stores/playback';

// Operator keyboard shortcuts for the focused channel, scoped through the
// playback shim (which targets the focused engine and enforces read-only).
export function useChannelKeyboard(opts: { onToggleShortcuts: () => void }) {
  const playback = usePlaybackStore();
  useShortcuts({
    Space: () => playback.toggle(),
    ArrowRight: () => playback.goNext(),
    Enter: () => playback.goNext(),
    ArrowLeft: () => playback.goPrev(),
    M: () => playback.toggleMode(),
    B: () => playback.toggleBlank(),
    L: () => playback.toggleBlank(),
    '?': () => opts.onToggleShortcuts(),
    ...Object.fromEntries(
      Array.from({ length: 9 }, (_, i) => [String(i + 1), () => playback.jumpTo(i)]),
    ),
  });
}
