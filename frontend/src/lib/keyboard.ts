import { useEventListener } from '@vueuse/core';

export type ShortcutHandler = (e: KeyboardEvent) => void;

// Centralized keyboard dispatcher. Skips events fired into editable surfaces so
// typing in the Edit dialog doesn't toggle playback under the operator's hands.
export function useShortcuts(map: Record<string, ShortcutHandler>) {
  useEventListener(document, 'keydown', (e: KeyboardEvent) => {
    const target = e.target as HTMLElement | null;
    if (
      target &&
      (target.tagName === 'INPUT' ||
        target.tagName === 'TEXTAREA' ||
        target.isContentEditable)
    ) {
      return;
    }
    const key = normalizeKey(e);
    const handler = map[key];
    if (handler) {
      e.preventDefault();
      handler(e);
    }
  });
}

function normalizeKey(e: KeyboardEvent): string {
  const k = e.key;
  if (k === ' ') return 'Space';
  if (/^[a-zA-Z]$/.test(k)) return k.toUpperCase();
  if (/^[1-9]$/.test(k)) return k;
  return k;
}
