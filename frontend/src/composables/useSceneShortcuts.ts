import { onBeforeUnmount, onMounted, ref } from 'vue';
import { toast } from 'vue-sonner';
import { useStudioStore } from '@/stores/studio';
import { useIdentityStore } from '@/stores/identity';
import { useWorshipStore } from '@/stores/worship';
import { useAnimationPreview } from '@/composables/useAnimationPreview';
import { normalizeSceneShortcuts, SCENE_SHORTCUT_STORAGE, sceneHasPendingChannelPublication, sceneShortcutMatches, sceneShortcutSurfaceBlocked, type SceneShortcut } from '@/lib/studio/scene-shortcuts';

function readBindings(): SceneShortcut[] {
  try { return normalizeSceneShortcuts(JSON.parse(localStorage.getItem(SCENE_SHORTCUT_STORAGE) ?? '[]')); }
  catch { return []; }
}
const bindings = ref<SceneShortcut[]>(readBindings());
export function useSceneShortcutPreferences() {
  function save(next: SceneShortcut[]) {
    const valid = normalizeSceneShortcuts(next);
    try { localStorage.setItem(SCENE_SHORTCUT_STORAGE, JSON.stringify(valid)); }
    catch { throw new Error('This browser could not save shortcuts. Allow local storage and try again.'); }
    bindings.value = valid;
  }
  return { bindings, save };
}
/** Mounted once, only on operator routes—not projection/engine pages. */
export function useSceneShortcutListener() {
  const studio = useStudioStore(), identity = useIdentityStore(), worship = useWorshipStore(), motion = useAnimationPreview();
  let pending = false;
  const storage = (event: StorageEvent) => {
    if (event.key === SCENE_SHORTCUT_STORAGE || event.key === null) bindings.value = readBindings();
  };
  function keydown(event: KeyboardEvent) {
    if (event.defaultPrevented || event.repeat || event.isComposing || pending || !identity.ready || !identity.isAuthenticated ||
      !identity.can('*', 'author') || !studio.state || studio.status.state !== 'running' || studio.saving || studio.engineBusy || studio.recordingBusy) return;
    const target = event.target instanceof Element ? event.target : null;
    if (sceneShortcutSurfaceBlocked(target, document, motion.elapsedMs.value !== null)) return;
    const binding = bindings.value.find(item => sceneShortcutMatches(item, event));
    const scene = studio.state.scenes.find(scene => scene.id === binding?.sceneId);
    if (!binding || !scene) return;
    event.preventDefault();
    if (sceneHasPendingChannelPublication(scene, studio.state.sources, worship.saving)) {
      toast.info('Wait for Send live to finish, then try the scene shortcut again.');
      return;
    }
    pending = true;
    motion.stop(); motion.setOverride(null);
    // Target the bound scene directly, then return the former Program to
    // Preview atomically, just like the Studio and Multiview Cut/Fade buttons.
    // This never publishes a prepared channel cue or saves over draft scenes.
    void studio.command({ type: 'take', sceneId: binding.sceneId, transition: binding.transition,
      swapPreview: true,
      ...(binding.transition === 'fade' ? { durationMs: binding.durationMs } : {}) })
      .then(() => toast.success(`On Program: ${studio.state?.program?.name ?? 'Scene'}`))
      .catch(() => {}) // The store reports permission/revision/connection errors.
      .finally(() => { pending = false; });
  }
  onMounted(() => {
    bindings.value = readBindings();
    // A new authenticated operator session must not retain a pre-login socket.
    studio.reconnect();
    window.addEventListener('keydown', keydown);
    window.addEventListener('storage', storage);
  });
  onBeforeUnmount(() => {
    window.removeEventListener('keydown', keydown);
    window.removeEventListener('storage', storage);
  });
}
