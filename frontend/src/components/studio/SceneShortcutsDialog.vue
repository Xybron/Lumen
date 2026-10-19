<script setup lang="ts">
import { computed, ref, watch } from 'vue';
import { Keyboard, Trash2, X } from 'lucide-vue-next';
import { toast } from 'vue-sonner';
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { useStudioStore } from '@/stores/studio';
import { useSceneShortcutPreferences } from '@/composables/useSceneShortcuts';
import { sceneShortcutLabel, sceneShortcutProblem, type SceneShortcut } from '@/lib/studio/scene-shortcuts';

const open = defineModel<boolean>('open', { default: false });
const studio = useStudioStore(), preferences = useSceneShortcutPreferences();
const recording = ref<string | null>(null), error = ref('');
const mac = /Mac|iPhone|iPad/.test(navigator.platform);
const scenes = computed(() => studio.state?.scenes ?? []);
const visibleBindings = computed(() => preferences.bindings.value.filter(binding => scenes.value.some(scene => scene.id === binding.sceneId)));
watch(open, () => { recording.value = null; error.value = ''; });
function binding(id: string) { return preferences.bindings.value.find(item => item.sceneId === id); }
function save(next: SceneShortcut[]) {
  try { preferences.save(next); error.value = ''; }
  catch (cause) { error.value = (cause as Error).message; }
}
function record(id: string) { recording.value = recording.value === id ? null : id; error.value = ''; }
function clear(id: string) { save(preferences.bindings.value.filter(item => item.sceneId !== id)); if (recording.value === id) recording.value = null; }
function update(id: string, patch: Partial<SceneShortcut>) { save(preferences.bindings.value.map(item => item.sceneId === id ? { ...item, ...patch } : item)); }
function fadeDuration(event: Event, id: string) {
  const input = event.target as HTMLInputElement, value = Number(input.value);
  const durationMs = Number.isFinite(value) && input.value ? Math.min(3000, Math.max(100, Math.round(value))) : 300;
  update(id, { durationMs }); input.value = String(durationMs);
}
function keydown(event: KeyboardEvent) {
  if (!recording.value) return;
  event.stopPropagation();
  if (event.key === 'Escape') { event.preventDefault(); recording.value = null; return; }
  if (['Control', 'Meta', 'Shift', 'Alt'].includes(event.key)) return;
  event.preventDefault();
  if (event.repeat) return;
  const problem = sceneShortcutProblem(event);
  if (problem) { error.value = problem; return; }
  const duplicate = preferences.bindings.value.find(item => item.sceneId !== recording.value && item.code === event.code && item.alt === event.altKey && scenes.value.some(scene => scene.id === item.sceneId));
  if (duplicate) { error.value = `Already assigned to “${scenes.value.find(scene => scene.id === duplicate.sceneId)?.name}”. Clear that shortcut first.`; return; }
  const previous = binding(recording.value);
  let duration = 300;
  try { duration = Number(localStorage.getItem('lumen.studio.fade-duration')); } catch { /* Optional preference. */ }
  save([...preferences.bindings.value.filter(item => item.sceneId !== recording.value && scenes.value.some(scene => scene.id === item.sceneId)), {
    sceneId: recording.value, code: event.code, alt: event.altKey, transition: previous?.transition ?? 'cut',
    durationMs: previous?.durationMs ?? (Number.isInteger(duration) && duration >= 100 && duration <= 3000 ? duration : 300),
  }]);
  if (!error.value) { recording.value = null; toast.success('Scene shortcut saved'); }
}
function clearAll() { save([]); recording.value = null; }
</script>

<template>
  <Dialog v-model:open="open">
    <DialogContent class="studio-dialog scene-shortcuts-dialog sm:max-w-[650px]" data-testid="scene-shortcuts-dialog" @keydown.capture="keydown">
      <DialogHeader><DialogTitle class="scene-shortcuts-title"><Keyboard :size="19" />Scene shortcuts</DialogTitle><DialogDescription>Take a scene directly to Program from Studio, Scripture, Lyrics or Presentation.</DialogDescription></DialogHeader>
      <p class="scene-shortcuts-safety">Nothing is assigned by default. Shortcuts take the scene’s latest saved design; they do not send prepared verses or lyrics live.</p>
      <div class="scene-shortcuts-list">
        <div v-for="scene in scenes" :key="scene.id" class="scene-shortcut-row" :data-scene-shortcut="scene.id">
          <div class="scene-shortcut-name"><b>{{ scene.name }}</b><span>Take scene</span></div>
          <button class="scene-shortcut-record" :class="{ recording: recording === scene.id, assigned: binding(scene.id) }" :aria-label="`Record shortcut for ${scene.name}`" :aria-pressed="recording === scene.id" @click="record(scene.id)"><Keyboard :size="14" /><kbd v-if="binding(scene.id) && recording !== scene.id">{{ sceneShortcutLabel(binding(scene.id)!, mac) }}</kbd><span v-else>{{ recording === scene.id ? 'Press shortcut…' : 'Set shortcut' }}</span><X v-if="recording === scene.id" :size="12" /></button>
          <select :aria-label="`Transition for ${scene.name}`" :disabled="!binding(scene.id)" :value="binding(scene.id)?.transition ?? 'cut'" @change="update(scene.id, { transition: ($event.target as HTMLSelectElement).value as 'cut' | 'fade' })"><option value="cut">Cut</option><option value="fade">Fade</option></select>
          <label v-if="binding(scene.id)?.transition === 'fade'" class="scene-shortcut-duration"><input type="number" min="100" max="3000" step="50" :aria-label="`Fade duration for ${scene.name}`" :value="binding(scene.id)?.durationMs" @change="fadeDuration($event, scene.id)" /><span>ms</span></label>
          <button class="s-icon scene-shortcut-remove" :aria-label="`Clear shortcut for ${scene.name}`" title="Clear shortcut" :disabled="!binding(scene.id)" @click="clear(scene.id)"><Trash2 :size="14" /></button>
        </div>
        <p v-if="!scenes.length" class="scene-shortcuts-empty">Create a Studio scene first, then assign its shortcut here.</p>
      </div>
      <p v-if="error" class="scene-shortcuts-error" role="alert">{{ error }}</p>
      <div class="scene-shortcuts-hint"><kbd>{{ mac ? '⌘ ⇧ 1' : 'Ctrl + Shift + 1' }}</kbd><span>Start with 1, 2, 7, 8 or 9. Add {{ mac ? '⌥' : 'Alt' }} for more combinations. Browser and system shortcuts are reserved. Escape cancels recording.</span></div>
      <p class="scene-shortcuts-footnote">Saved in this browser. Requires Studio access and a running engine. Paused while typing, using menus or dialogs, and rehearsing animations.</p>
      <div class="dialog-actions"><button class="s-button" :disabled="!visibleBindings.length" @click="clearAll">Clear all</button><button class="s-button primary" @click="open = false">Done</button></div>
    </DialogContent>
  </Dialog>
</template>

<style scoped>
.scene-shortcuts-title{display:flex;align-items:center;gap:9px}.scene-shortcuts-safety,.scene-shortcuts-footnote{color:var(--text-muted);font-size:11px;line-height:1.65;margin:0}.scene-shortcuts-list{display:grid;border-top:1px solid var(--border-hair);border-bottom:1px solid var(--border-hair);max-height:48dvh;overflow:auto}.scene-shortcut-row{display:flex;align-items:center;gap:8px;min-width:0;padding:13px 0;border-bottom:1px solid var(--border-hair)}.scene-shortcut-row:last-child{border:0}.scene-shortcut-name{display:flex;flex-direction:column;gap:4px;min-width:70px;flex:1}.scene-shortcut-name b{font-size:12px;font-weight:500;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}.scene-shortcut-name span{font-size:10px;color:var(--text-muted)}.scene-shortcut-record{display:flex;align-items:center;justify-content:center;gap:6px;min-width:138px;min-height:34px;padding:6px 9px;border-radius:6px;border:1px solid var(--border-hair);background:var(--surface-2);color:var(--text-muted);font-size:10px}.scene-shortcut-record.assigned{color:var(--text-primary)}.scene-shortcut-record.recording{border-color:var(--accent);color:var(--accent);background:#7dd3fc0c}.scene-shortcut-record kbd{font:inherit;white-space:nowrap}.scene-shortcut-row select{width:61px;min-height:34px;padding:5px;border:1px solid var(--border-hair);border-radius:6px;background:var(--surface-2);color:var(--text-primary);font-size:10px}.scene-shortcut-row select:disabled{opacity:.35}.scene-shortcut-duration{display:flex;align-items:center;gap:3px;font-size:9px;color:var(--text-muted)}.scene-shortcut-duration input{width:49px;min-height:34px;padding:5px;border:1px solid var(--border-hair);border-radius:6px;background:var(--surface-2);color:var(--text-primary);font-size:10px}.scene-shortcuts-error{font-size:11px;color:#f0b6a8;line-height:1.6;margin:0}.scene-shortcuts-hint{display:flex;gap:10px;align-items:flex-start;color:var(--text-muted);font-size:10px;line-height:1.7}.scene-shortcuts-hint kbd{flex-shrink:0;padding:3px 5px;background:var(--surface-2);border:1px solid var(--border-hair);border-radius:4px;font:inherit;color:var(--text-primary)}.scene-shortcuts-empty{padding:20px;color:var(--text-muted);text-align:center}.scene-shortcuts-dialog .dialog-actions{justify-content:space-between}.scene-shortcut-remove{flex-shrink:0}@media(max-width:550px){.scene-shortcut-row{flex-wrap:wrap}.scene-shortcut-name{flex-basis:calc(100% - 35px);order:0}.scene-shortcut-remove{order:1}.scene-shortcut-record,.scene-shortcut-row select,.scene-shortcut-duration{order:2}.scene-shortcut-record{flex:1}.scene-shortcuts-hint{flex-direction:column;gap:5px}}
</style>
