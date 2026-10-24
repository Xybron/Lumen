<script setup lang="ts">
import { useRoute } from 'vue-router';
import { Aperture } from 'lucide-vue-next';
import TeamButton from '@/components/team/TeamButton.vue';
import AccountMenu from './AccountMenu.vue';
const route = useRoute();
</script>

<template>
  <header class="lumen-header">
    <RouterLink to="/" class="lumen-brand" aria-label="Lumen home"><span><Aperture :size="22" :stroke-width="1.5" /></span>lumen</RouterLink>
    <div class="lumen-header-detail"><slot /></div>
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
