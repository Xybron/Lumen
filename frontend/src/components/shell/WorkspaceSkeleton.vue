<script setup lang="ts">
import { LoadingSkeleton, Skeleton } from '@/components/ui/skeleton';
withDefaults(defineProps<{ studio?: boolean; label?: string }>(), { studio: false, label: 'Opening your workspace…' });
</script>

<template>
  <LoadingSkeleton class="workspace-skeleton" :class="{ 'is-studio': studio }" :label="label">
    <div class="workspace-skeleton-header" aria-hidden="true">
      <Skeleton :width="104" :height="23" />
      <div class="workspace-skeleton-actions"><Skeleton :width="100" :height="28" /><Skeleton :width="82" :height="28" /><Skeleton :width="28" :height="28" radius="50%" /></div>
    </div>
    <div class="workspace-skeleton-body" aria-hidden="true">
      <div class="workspace-skeleton-sidebar">
        <Skeleton width="55%" :height="10" /><Skeleton :height="30" />
        <div v-for="n in 4" :key="n" class="workspace-skeleton-scene"><Skeleton class="workspace-skeleton-thumb" height="auto" /><Skeleton :width="n % 2 ? '72%' : '54%'" :height="10" /><Skeleton width="34%" :height="7" /></div>
      </div>
      <div class="workspace-skeleton-main">
        <div class="workspace-skeleton-heading"><Skeleton width="28%" :height="16" /><Skeleton :width="48" :height="24" /></div>
        <div class="workspace-skeleton-monitors">
          <div v-for="n in 2" :key="n" class="workspace-skeleton-panel"><Skeleton :width="65" :height="9" /><Skeleton class="workspace-skeleton-monitor" height="auto" /><div class="workspace-skeleton-heading"><Skeleton width="32%" :height="8" /><Skeleton width="16%" :height="8" /></div></div>
        </div>
        <div class="workspace-skeleton-tools">
          <div v-for="n in 2" :key="n" class="workspace-skeleton-panel"><Skeleton :width="85" :height="10" /><div v-for="row in 4" :key="row" class="workspace-skeleton-row"><Skeleton :width="28" :height="28" /><div><Skeleton :width="row % 2 ? '65%' : '46%'" :height="10" /><Skeleton width="30%" :height="7" /></div></div></div>
        </div>
      </div>
      <div v-if="studio" class="workspace-skeleton-inspector"><Skeleton :width="88" :height="12" /><div v-for="n in 5" :key="n" class="workspace-skeleton-fields"><Skeleton width="40%" :height="9" /><Skeleton :height="32" /></div></div>
    </div>
    <div class="workspace-skeleton-footer" aria-hidden="true"><Skeleton v-for="n in 4" :key="n" :width="70" :height="11" /></div>
  </LoadingSkeleton>
</template>

<style scoped>
.workspace-skeleton { display: flex; flex-direction: column; width: 100%; height: 100dvh; min-height: 0; overflow: hidden; background: var(--bg-base); }
.workspace-skeleton-header { height: 64px; flex-shrink: 0; display: flex; align-items: center; justify-content: space-between; gap: 24px; padding: 0 20px; border-bottom: 1px solid var(--border-hair); background: var(--surface-1); }
.workspace-skeleton-actions, .workspace-skeleton-heading { display: flex; align-items: center; justify-content: space-between; gap: 12px; }
.workspace-skeleton-body { display: grid; grid-template-columns: 210px minmax(0, 1fr); flex: 1; min-height: 0; overflow: hidden; }
.is-studio .workspace-skeleton-body { grid-template-columns: 210px minmax(0, 1fr) 280px; }
.workspace-skeleton-sidebar, .workspace-skeleton-inspector { display: flex; flex-direction: column; gap: 20px; padding: 22px 16px; overflow: hidden; background: var(--surface-1); }
.workspace-skeleton-sidebar { border-right: 1px solid var(--border-hair); }
.workspace-skeleton-inspector { border-left: 1px solid var(--border-hair); padding: 24px 20px; gap: 30px; }
.workspace-skeleton-scene, .workspace-skeleton-fields { display: flex; flex-direction: column; gap: 10px; }
.workspace-skeleton-thumb, .workspace-skeleton-monitor { aspect-ratio: 16 / 9; border-radius: 6px; }
.workspace-skeleton-main { min-width: 0; display: flex; flex-direction: column; gap: 22px; padding: 24px; overflow: hidden; }
.workspace-skeleton-monitors, .workspace-skeleton-tools { display: grid; grid-template-columns: repeat(2, minmax(0, 1fr)); gap: 18px; }
.workspace-skeleton-panel { min-width: 0; display: flex; flex-direction: column; gap: 16px; border: 1px solid var(--border-hair); border-radius: 10px; padding: 16px; background: var(--surface-1); }
.workspace-skeleton-tools { flex: 1; align-content: start; }
.workspace-skeleton-row { display: flex; align-items: center; gap: 12px; }
.workspace-skeleton-row > div { flex: 1; display: flex; flex-direction: column; gap: 8px; }
.workspace-skeleton-footer { display: flex; flex-shrink: 0; height: 48px; align-items: center; justify-content: center; gap: 30px; border-top: 1px solid var(--border-hair); background: var(--surface-1); }
@media (max-width: 1100px) { .is-studio .workspace-skeleton-body { grid-template-columns: 180px minmax(0, 1fr); } .workspace-skeleton-inspector { display: none; } }
@media (max-width: 700px) { .workspace-skeleton-body, .is-studio .workspace-skeleton-body { grid-template-columns: minmax(0, 1fr); } .workspace-skeleton-sidebar { display: none; } .workspace-skeleton-main { padding: 16px; gap: 16px; } .workspace-skeleton-monitors, .workspace-skeleton-tools { gap: 12px; } .workspace-skeleton-panel { padding: 12px; } .workspace-skeleton-header { padding: 0 16px; } .workspace-skeleton-actions > :first-child { display: none; } .workspace-skeleton-footer { gap: 18px; } }
@media (max-width: 420px) { .workspace-skeleton-monitors { grid-template-columns: minmax(0, 1fr); } .workspace-skeleton-monitors > :last-child { display: none; } }
</style>
