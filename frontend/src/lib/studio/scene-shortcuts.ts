import type { StudioScene, StudioSource } from '../../../../shared/production';

/** Controller-local explicit Studio commands. These never publish channel cues. */
export interface SceneShortcut {
  sceneId: string;
  code: string;
  alt: boolean;
  transition: 'cut' | 'fade';
  durationMs: number;
}
export interface SceneShortcutKey {
  code: string;
  ctrlKey: boolean;
  metaKey: boolean;
  shiftKey: boolean;
  altKey: boolean;
  isComposing?: boolean;
  getModifierState?: (key: string) => boolean;
}
export const SCENE_SHORTCUT_STORAGE = 'lumen.studio.scene-shortcuts.v1';
const letterOrNumber = /^(Key[A-Z]|Digit[1-9])$/;
// Conservatively reserve navigation, developer tools, clipboard, screenshots,
// and common platform/window commands on both platforms.
const reserved = new Set(['KeyA', 'KeyB', 'KeyC', 'KeyD', 'KeyE', 'KeyF', 'KeyG', 'KeyH', 'KeyI', 'KeyJ', 'KeyK', 'KeyL', 'KeyM', 'KeyN', 'KeyO', 'KeyP', 'KeyQ', 'KeyR', 'KeyS', 'KeyT', 'KeyU', 'KeyV', 'KeyW', 'KeyY', 'KeyZ', 'Digit3', 'Digit4', 'Digit5', 'Digit6']);
const reservedWithAlt = new Set(['KeyC', 'KeyI', 'KeyJ', 'KeyN', 'KeyP', 'KeyQ', 'KeyR', 'KeyT', 'KeyV', 'KeyW', 'Digit3', 'Digit4', 'Digit5', 'Digit6']);
export function sceneShortcutProblem(key: SceneShortcutKey): string | null {
  if (key.isComposing || key.getModifierState?.('AltGraph')) return 'Finish typing before recording a shortcut.';
  if (!(key.ctrlKey || key.metaKey) || !key.shiftKey || (key.ctrlKey && key.metaKey) || !letterOrNumber.test(key.code)) {
    return 'Use Ctrl/⌘ + Shift with a letter or number. Add Alt/⌥ if needed.';
  }
  if ((key.altKey ? reservedWithAlt : reserved).has(key.code)) return 'That combination is reserved by the browser or system. Try Ctrl/⌘ + Shift + 1, 2, 7, 8 or 9.';
  return null;
}
export function sceneShortcutMatches(binding: SceneShortcut, key: SceneShortcutKey): boolean {
  return !sceneShortcutProblem(key) && binding.code === key.code && binding.alt === key.altKey;
}
export function sceneShortcutLabel(binding: Pick<SceneShortcut, 'code' | 'alt'>, mac = false): string {
  const key = binding.code.replace(/^(Key|Digit)/, '');
  return mac ? `⌘ ⇧ ${binding.alt ? '⌥ ' : ''}${key}` : `Ctrl + Shift + ${binding.alt ? 'Alt + ' : ''}${key}`;
}
export function normalizeSceneShortcuts(raw: unknown): SceneShortcut[] {
  if (!Array.isArray(raw)) return [];
  const result: SceneShortcut[] = [];
  for (const value of raw.slice(0, 100)) {
    if (!value || typeof value !== 'object' || typeof value.sceneId !== 'string' || !value.sceneId || value.sceneId.length > 100 ||
      typeof value.code !== 'string' || typeof value.alt !== 'boolean' || !['cut', 'fade'].includes(value.transition) ||
      sceneShortcutProblem({ code: value.code, altKey: value.alt, ctrlKey: true, metaKey: false, shiftKey: true })) continue;
    if (result.some(item => item.sceneId === value.sceneId || item.code === value.code && item.alt === value.alt)) continue;
    const durationMs = Number.isInteger(value.durationMs) ? Math.max(100, Math.min(3000, value.durationMs)) : 300;
    result.push({ sceneId: value.sceneId, code: value.code, alt: value.alt, transition: value.transition, durationMs });
  }
  return result;
}
/** Typing, open menus/modals and local animation rehearsal must stay local.
 * Persistent Scripture/Lyrics result lists are content, not open popups: they must
 * not disable Studio/Multiview controls elsewhere in the same workspace. */
export function sceneShortcutSurfaceBlocked(target: Element | null, root: Pick<Document, 'querySelector'>, rehearsing: boolean): boolean {
  return rehearsing || !!target?.closest('input, textarea, select, summary, [contenteditable]:not([contenteditable="false"]), [role="dialog"], [role="menu"], [role="listbox"]:not([data-channel-search-results]), [role="menuitem"]') ||
    !!root.querySelector('[role="dialog"], [role="menu"], [role="listbox"]:not([data-channel-search-results]), [data-studio-layer-menu], [data-animation-editor]');
}

/** A rapid Send live → Take must not get ahead of the cue's server commit.
 * Private preparation is intentionally unrelated and never blocks a Take. */
export function sceneHasPendingChannelPublication(scene: Pick<StudioScene, 'layers'> | null | undefined,
  sources: readonly Pick<StudioSource, 'id' | 'kind' | 'channelId'>[], publishing: Readonly<Record<string, boolean>>): boolean {
  if (!scene) return false;
  const used = new Set(scene.layers.filter(layer => layer.kind === 'source').map(layer => layer.sourceId));
  return sources.some(source => used.has(source.id) && source.kind === 'channel' && !!source.channelId && !!publishing[source.channelId]);
}
