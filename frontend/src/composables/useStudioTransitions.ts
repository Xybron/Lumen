import { computed, ref, watch } from 'vue';
import { toast } from 'vue-sonner';
import { useAnimationPreview } from '@/composables/useAnimationPreview';
import { sceneHasPendingChannelPublication } from '@/lib/studio/scene-shortcuts';
import { useIdentityStore } from '@/stores/identity';
import { useStudioStore } from '@/stores/studio';
import { useWorshipStore } from '@/stores/worship';

const durationStorageKey = 'lumen.studio.fade-duration';
// The Studio and floating/standalone Multiview share one operator preference.
const fadeDuration = ref((() => {
  try {
    const saved = Number(localStorage.getItem(durationStorageKey));
    if (Number.isInteger(saved) && saved >= 100 && saved <= 3000) return saved;
  } catch { /* Optional local preference. */ }
  return 300;
})());
watch(fadeDuration, duration => {
  try { localStorage.setItem(durationStorageKey, String(duration)); } catch { /* Optional local preference. */ }
});
const taking = ref(false);

/** Safe shared bus transitions. Callers own keyboard/focus/rehearsal handling. */
export function useStudioTransitions() {
  const studio = useStudioStore(), identity = useIdentityStore(), worship = useWorshipStore();
  const motion = useAnimationPreview();
  // Keep an editable draft: frequent engine status messages must not overwrite
  // an uncommitted numeric input before its native change/blur event.
  const fadeDurationInput = ref<string | number>(fadeDuration.value);
  watch(fadeDuration, duration => { fadeDurationInput.value = duration; });
  function setFadeDuration() {
    const value = Number(fadeDurationInput.value);
    if (fadeDurationInput.value !== '' && Number.isFinite(value)) {
      fadeDuration.value = Math.round(Math.min(3000, Math.max(100, value)));
    }
    fadeDurationInput.value = fadeDuration.value;
  }
  const ready = computed(() => identity.ready && identity.isAuthenticated && identity.can('*', 'author') &&
    !!studio.state && studio.status.state === 'running' && !studio.saving && !studio.engineBusy && !studio.recordingBusy && !taking.value);
  const canTake = computed(() => ready.value && !!studio.selectedScene);

  async function take(kind: 'cut' | 'fade', sceneId = studio.selectedScene?.id): Promise<void> {
    if (!ready.value || !sceneId) return;
    const scene = studio.state?.scenes.find(value => value.id === sceneId);
    if (!scene) return;
    if (sceneHasPendingChannelPublication(scene, studio.state?.sources ?? [], worship.saving)) {
      toast.info('Wait for Send live to finish, then take the scene again.');
      return;
    }
    taking.value = true;
    motion.stop(); motion.setOverride(null);
    try {
      await studio.command({ type: 'take', sceneId, transition: kind, swapPreview: true,
        ...(kind === 'fade' ? { durationMs: fadeDuration.value } : {}) });
    } catch { /* The store reports connection, permission and revision errors. */ }
    finally { taking.value = false; }
  }

  return { fadeDuration, fadeDurationInput, setFadeDuration, canTake, take };
}
