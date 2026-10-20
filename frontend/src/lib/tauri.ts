// Feature-detect the Tauri desktop shell so the same frontend runs unchanged in
// the browser AND as the packaged station. When packaged, `window.__TAURI__` is
// present and projection outputs open as native borderless windows (placed on a
// chosen monitor); in the browser they fall back to `window.open` tabs.

interface TauriGlobal {
  core?: { invoke(cmd: string, args?: Record<string, unknown>): Promise<unknown> };
}

function tauri(): TauriGlobal | null {
  return (window as unknown as { __TAURI__?: TauriGlobal }).__TAURI__ ?? null;
}

export function isTauri(): boolean {
  return tauri() !== null;
}

// Open a channel's projection output: native window under Tauri, browser tab otherwise.
export function openProjection(channelId: string): void {
  const t = tauri();
  if (t?.core) {
    void t.core.invoke('open_projection_window', { channelId });
    return;
  }
  window.open(`/live/${channelId}`, `lumen-live-${channelId}`, 'noopener');
}

// Studio's live view always follows the committed Program bus, regardless of
// which destination outputs are pinned, blanked, or renamed.
export function openStudioProjection(): void {
  const t = tauri();
  if (t?.core) {
    void t.core.invoke('open_studio_projection_window');
    return;
  }
  window.open('/studio/output/program', 'lumen-studio-program', 'noopener');
}
