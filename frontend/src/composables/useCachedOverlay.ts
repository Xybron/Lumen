import { onActivated, onDeactivated, ref } from 'vue';

// KeepAlive detaches the workspace, but Teleports remain in document.body.
// Release overlay focus traps and dismiss their state when the owner leaves.
export function useCachedOverlay(close: () => void) {
  const active = ref(true);
  onActivated(() => { active.value = true; });
  onDeactivated(() => { active.value = false; close(); });
  return active;
}
