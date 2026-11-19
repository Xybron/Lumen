<script setup lang="ts">
import { LoadingSkeleton, Skeleton } from '@/components/ui/skeleton';

defineProps<{ inspectorOpen: boolean }>();
</script>

<template>
  <LoadingSkeleton class="nle-workspace nle-loading" label="Opening clip editor">
    <div class="nle-top" :class="{ 'inspector-closed': !inspectorOpen }" aria-hidden="true">
      <div class="nle-rail nle-loading-rail">
        <div v-for="item in 5" :key="item"><Skeleton :width="22" :height="22" :radius="6" /><Skeleton :width="28" :height="6" /></div>
      </div>
      <div class="nle-bin">
        <div class="nle-heading"><Skeleton width="56%" :height="11" /></div>
        <div class="nle-loading-bin">
          <Skeleton :height="29" :radius="5" />
          <Skeleton width="74%" :height="9" />
          <div class="nle-media-grid"><div v-for="item in 4" :key="item" class="nle-loading-media"><Skeleton height="auto" class="nle-loading-thumb" :radius="5" /><Skeleton :width="item % 2 ? '78%' : '61%'" :height="9" /></div></div>
        </div>
      </div>
      <div class="nle-loading-preview">
        <div class="nle-loading-preview-toolbar"><Skeleton :width="72" :height="10" /><Skeleton :width="48" :height="10" /></div>
        <div class="nle-loading-stage"><Skeleton class="nle-loading-canvas" height="auto" :radius="4" /></div>
        <div class="nle-loading-transport"><Skeleton :width="82" :height="10" /><Skeleton :width="104" :height="24" :radius="5" /><Skeleton :width="52" :height="10" /></div>
      </div>
      <div v-if="inspectorOpen" class="nle-inspector">
        <div class="nle-heading"><Skeleton width="55%" :height="11" /></div>
        <div class="nle-loading-fields"><div v-for="item in 5" :key="item"><Skeleton :width="item % 2 ? '41%' : '57%'" :height="9" /><Skeleton :height="32" :radius="5" /></div></div>
      </div>
    </div>
    <div class="nle-loading-timeline" aria-hidden="true">
      <div class="nle-loading-timeline-toolbar"><Skeleton :width="156" :height="18" :radius="4" /><Skeleton :width="90" :height="9" /></div>
      <div v-for="item in 3" :key="item" class="nle-loading-track"><Skeleton :width="item === 2 ? 65 : 81" :height="10" /><div><Skeleton :width="item === 1 ? '76%' : item === 2 ? '58%' : '86%'" :height="37" :radius="5" /></div></div>
    </div>
    <div class="nle-loading-status" aria-hidden="true"><Skeleton :width="230" :height="7" /></div>
  </LoadingSkeleton>
</template>

<style scoped>
.nle-loading-rail { align-items: center; gap: 24px; padding-top: 20px; }
.nle-loading-rail > div { display: grid; justify-items: center; gap: 9px; }
.nle-loading-bin { padding: 13px; display: grid; gap: 20px; overflow: hidden; }
.nle-loading-media { display: grid; gap: 9px; min-width: 0; }
.nle-loading-thumb { aspect-ratio: 16 / 10; }
.nle-loading-preview { display: flex; flex-direction: column; min-width: 0; min-height: 0; }
.nle-loading-preview-toolbar { display: flex; justify-content: space-between; align-items: center; min-height: 44px; padding: 0 18px; border-bottom: 1px solid var(--nle-line); }
.nle-loading-stage { display: grid; align-content: center; flex: 1; min-height: 0; overflow: hidden; padding: 24px; }
.nle-loading-canvas { aspect-ratio: 16 / 9; max-height: 100%; }
.nle-loading-transport { display: flex; align-items: center; justify-content: space-between; gap: 12px; min-height: 52px; padding: 12px 18px; border-top: 1px solid var(--nle-line); }
.nle-loading-fields { display: grid; gap: 24px; padding: 18px 14px; overflow: hidden; }
.nle-loading-fields > div { display: grid; gap: 11px; }
.nle-loading-timeline { flex-shrink: 0; padding-bottom: 16px; border-top: 1px solid var(--nle-line); background: var(--nle-panel); }
.nle-loading-timeline-toolbar { display: flex; align-items: center; justify-content: space-between; min-height: 43px; padding: 0 16px; border-bottom: 1px solid var(--nle-line); margin-bottom: 10px; }
.nle-loading-track { display: grid; grid-template-columns: 124px minmax(0, 1fr); align-items: center; gap: 16px; padding: 5px 16px; }
.nle-loading-track > div { min-width: 0; }
.nle-loading-track:nth-child(3) > div { padding-left: 8%; }
.nle-loading-status { display: flex; align-items: center; min-height: 26px; padding: 0 16px; border-top: 1px solid var(--nle-line); }
@media (max-width: 720px) {
  .nle-loading .nle-inspector { display: none; }
  .nle-loading-stage { padding: 12px; }
  .nle-loading-transport { gap: 10px; padding-inline: 10px; }
  .nle-loading-track { grid-template-columns: 64px minmax(0, 1fr); gap: 12px; padding-inline: 12px; }
  .nle-loading-track > :first-child { max-width: 100%; }
}
</style>
