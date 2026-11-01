<script setup lang="ts">
import { useRoute } from 'vue-router';
import { Aperture, Maximize2, Minimize2 } from 'lucide-vue-next';
import { toast } from 'vue-sonner';
import TeamButton from '@/components/team/TeamButton.vue';
import AccountMenu from './AccountMenu.vue';
import { useAppFullscreen } from '@/composables/useAppFullscreen';
const route = useRoute();
const { isFullscreen, isSupported, toggle } = useAppFullscreen();
async function toggleFullscreen() {
  try { await toggle(); }
  catch { toast.error('Fullscreen is unavailable in this window.'); }
}
</script>

<template>
  <header class="lumen-header">
    <RouterLink to="/" class="lumen-brand" aria-label="Lumen home"><span><Aperture :size="22" :stroke-width="1.5" /></span>lumen</RouterLink>
    <div class="lumen-header-detail"><slot /></div>
    <button v-if="isSupported && ['dashboard', 'recordings', 'team'].includes(String(route.name))" class="lumen-fullscreen-toggle" type="button" :aria-label="isFullscreen ? 'Exit fullscreen' : 'Enter fullscreen'" :aria-pressed="isFullscreen" title="Fullscreen · F" aria-keyshortcuts="F" @click="toggleFullscreen"><Minimize2 v-if="isFullscreen" :size="16" /><Maximize2 v-else :size="16" /></button>
    <TeamButton />
    <AccountMenu v-if="route.name !== 'dashboard' && route.name !== 'studio'" placement="header" />
  </header>
</template>

<style scoped>
.lumen-header {
  height: 64px;
  min-width: 0;
  flex-shrink: 0;
  grid-column: 1 / -1;
  display: flex;
  align-items: center;
  gap: 24px;
  padding: 0 20px;
  border-bottom: 1px solid var(--border-hair);
  background: var(--surface-1);
  color: var(--text-primary);
  backdrop-filter: none;
}
.lumen-brand {
  display: flex;
  align-items: center;
  gap: 9px;
  color: var(--text-primary);
  text-decoration: none;
  font-size: 23px;
  letter-spacing: -1.1px;
  font-weight: 550;
  flex-shrink: 0;
}
.lumen-brand > span {
  display: grid;
  place-items: center;
  width: 30px;
  height: 30px;
  border-radius: 8px;
  border: 1px solid #7dd3fc22;
  color: var(--accent);
  background: #7dd3fc08;
}
.lumen-header-detail { display: flex; gap: 20px; align-items: center; flex: 1; min-width: 0; font-size: 12px; color: var(--text-muted); }
.lumen-fullscreen-toggle { display: grid; place-items: center; flex: 0 0 30px; width: 30px; height: 30px; border: 1px solid transparent; border-radius: 7px; background: transparent; color: #949aa3; cursor: pointer; }
.lumen-fullscreen-toggle:hover, .lumen-fullscreen-toggle:focus-visible { color: #e7edf3; background: #ffffff0b; border-color: #ffffff15; }
.lumen-header-detail :deep(.lumen-channel-actions) { gap: 16px; }
@media (max-width: 1100px) {
  .lumen-header { gap: 18px; padding: 0 16px; }
  .lumen-header-detail { gap: 12px; }
}
@media (max-width: 760px) {
  .lumen-header, .lumen-header.lumen-header-channel { height: auto; min-height: 60px; flex-wrap: wrap; gap: 10px 14px; padding: 10px 14px; }
  .lumen-header-detail { flex: 1 1 210px; justify-content: flex-end; flex-wrap: wrap; gap: 8px; }
  .lumen-header-detail:empty { display: none; }
  .lumen-header-detail :deep(.lumen-channel-actions) { justify-content: flex-end; gap: 12px; }
  .lumen-brand { font-size: 21px; }
}
</style>
