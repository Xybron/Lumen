import { ref, shallowRef } from 'vue';
import type { LayerAnimation } from '../../../shared/production';

// A local rehearsal clock shared by the inspector, editor and Preview canvas.
// Nothing here writes production state or sends messages to the live renderer.
const elapsedMs = ref<number | null>(null), playing = ref(false);
const sceneId = ref<string | null>(null), layerId = ref<string | null>(null), durationMs = ref(0);
const override = shallowRef<{ sceneId: string; layerId: string; animation: LayerAnimation } | null>(null);
let frame: number | undefined;
function pause() {
  if (frame !== undefined) cancelAnimationFrame(frame);
  frame = undefined;
  playing.value = false;
}
function seek(scene: string, layer: string | null, time: number, duration: number) {
  pause();
  sceneId.value = scene; layerId.value = layer;
  durationMs.value = Number.isFinite(duration) ? Math.min(20_000, Math.max(0, duration)) : 0;
  elapsedMs.value = Math.min(durationMs.value, Math.max(0, Number.isFinite(time) ? time : 0));
}
function play(scene: string, layer: string | null, duration: number) {
  const resume = sceneId.value === scene && layerId.value === layer && elapsedMs.value !== null && elapsedMs.value < duration;
  seek(scene, layer, resume ? elapsedMs.value! : 0, duration);
  const startedAt = performance.now() - elapsedMs.value!;
  playing.value = true;
  const tick = (now: number) => {
    elapsedMs.value = Math.min(durationMs.value, Math.max(0, now - startedAt));
    if (elapsedMs.value >= durationMs.value) { pause(); return; }
    frame = requestAnimationFrame(tick);
  };
  frame = requestAnimationFrame(tick);
}
function stop() {
  pause(); elapsedMs.value = null; sceneId.value = null; layerId.value = null; durationMs.value = 0;
}
function setOverride(value: typeof override.value) { override.value = value; }

export function useAnimationPreview() {
  return { elapsedMs, playing, sceneId, layerId, durationMs, override, play, pause, seek, stop, setOverride };
}
