<script setup lang="ts">
import { computed, nextTick, ref, watch } from 'vue';
import { useRoute } from 'vue-router';
import { toast } from 'vue-sonner';
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogDescription } from '@/components/ui/dialog';
import { useConfirmation } from '@/composables/useConfirmation';
import { useIdentityStore } from '@/stores/identity';
import { useOutputsStore } from '@/stores/outputs';
import { useStudioStore } from '@/stores/studio';
import { shortId } from '@/lib/ids';
import StudioOutputsPanel from './StudioOutputsPanel.vue';

const route = useRoute(), identity = useIdentityStore(), outputs = useOutputsStore(), studio = useStudioStore();
const { confirmAction } = useConfirmation();
const panel = ref<InstanceType<typeof StudioOutputsPanel> | null>(null);
const canOperate = computed(() => identity.isAuthenticated && identity.can('*', 'author'));
let generation = 0;
watch(() => route.fullPath, () => outputs.close());
watch([() => identity.me?.id, canOperate], () => { generation++; outputs.close(); });
watch(() => [outputs.open, outputs.outputId] as const, async ([open, id]) => {
  const current = ++generation;
  if (!open || !canOperate.value) return;
  if (!studio.state) await studio.load();
  await nextTick();
  if (current !== generation || !outputs.open || !canOperate.value || outputs.outputId !== id) return;
  panel.value?.reset();
  if (id) await panel.value?.focusOutput(id);
}, { immediate: true });
async function run(work: () => Promise<void>) {
  if (!canOperate.value) return;
  try { await work(); outputs.changed(); }
  catch (error) { toast.error(error instanceof Error ? error.message : 'Output changes could not be saved.'); }
}
function addOutput() {
  void run(() => studio.edit(draft => {
    if (draft.outputs.length >= 6) return;
    draft.outputs.push({ id: shortId('output'), name: `Output ${draft.outputs.length + 1}`, mode: 'program', scene: null, blanked: false, audioEnabled: false });
  }));
}
function renameOutput(id: string, name: string) {
  const next = name.trim().slice(0, 100);
  if (!next || next === studio.state?.outputs.find(item => item.id === id)?.name) return;
  void run(() => studio.edit(draft => { const output = draft.outputs.find(item => item.id === id); if (output) output.name = next; }));
}
async function removeOutput(id: string) {
  const operator = identity.me?.id;
  const output = studio.state?.outputs.find(item => item.id === id);
  if (!output || !canOperate.value || (studio.state?.outputs.length ?? 0) <= 1) return;
  if (!await confirmAction({ title: 'Remove output?', description: `“${output.name}” will be removed. Any screen following this output will disconnect.`, confirmLabel: 'Remove output', tone: 'danger' })) return;
  if (canOperate.value && operator === identity.me?.id) void run(() => studio.edit(draft => { if (draft.outputs.length > 1) draft.outputs = draft.outputs.filter(item => item.id !== id); }));
}
function audio(id: string) {
  void run(() => studio.edit(draft => { const output = draft.outputs.find(item => item.id === id); if (output) output.audioEnabled = !output.audioEnabled; }));
}
function refresh(id: string) {
  const sceneId = studio.state?.outputs.find(item => item.id === id)?.scene?.id;
  if (sceneId) void run(() => studio.command({ type: 'route', outputId: id, sceneId }));
}
</script>

<template>
  <Dialog :open="outputs.open && canOperate" @update:open="value => { if (!value) outputs.close(); }">
    <DialogContent class="shared-outputs-dialog sm:max-w-[850px]">
      <DialogHeader><DialogTitle>Outputs</DialogTitle><DialogDescription>Manage your screens, share Program, and configure Lumen’s camera and microphone.</DialogDescription></DialogHeader>
      <StudioOutputsPanel v-if="studio.state" ref="panel" :outputs="studio.state.outputs" :scenes="studio.state.scenes" :pending="!!studio.saving" :can-operate="canOperate" :program-name="studio.state.program?.name"
        @add="addOutput" @rename="renameOutput" @route="(id, sceneId) => run(() => studio.command({ type: 'route', outputId: id, sceneId }))"
        @blank="(id, blanked) => run(() => studio.command({ type: 'blank', outputId: id, blanked }))" @audio="audio" @refresh="refresh" @remove="removeOutput" />
      <p v-else class="outputs-loading" role="status">{{ studio.loading ? 'Loading outputs…' : 'Outputs are unavailable. Reconnect to the station and try again.' }}</p>
    </DialogContent>
  </Dialog>
</template>

<style scoped>
.shared-outputs-dialog{background:var(--surface-1);border-color:var(--border-hair);gap:20px;max-height:calc(100dvh - 32px)}
.outputs-loading{padding:28px 0;color:var(--text-muted);font-size:12px}
</style>
