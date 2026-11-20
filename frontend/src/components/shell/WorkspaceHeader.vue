<script setup lang="ts">
import FacetMark from '@/components/shell/FacetMark.vue';
import { useRoute } from 'vue-router';
import { computed, onActivated, onDeactivated, ref } from 'vue';
import ProgramControls from './ProgramControls.vue';
import SharedListeningBar from './SharedListeningBar.vue';
import { useIdentityStore } from '@/stores/identity';
import { useContentStore } from '@/stores/content';
import { useEnginesStore } from '@/stores/engines';
import { Maximize2, Minimize2 } from 'lucide-vue-next';
import { toast } from 'vue-sonner';
import TeamButton from '@/components/team/TeamButton.vue';
import AccountMenu from './AccountMenu.vue';
import { useAppFullscreen } from '@/composables/useAppFullscreen';
const route = useRoute(), identity = useIdentityStore(), content = useContentStore();
const active = ref(true);
onActivated(() => { active.value = true; });
onDeactivated(() => { active.value = false; });
const productionWorkspace = computed(() => ['dashboard', 'studio', 'media'].includes(String(route.name)));
const programControls = computed(() => active.value && identity.isAuthenticated && identity.can('*', 'author') && productionWorkspace.value);
const workspace = computed(() => {
  if (route.name === 'dashboard') {
    const channel = content.channels.find(item => item.id === useEnginesStore().focusedChannelId);
    return channel?.kind === 'scripture' ? 'Scripture' : channel?.kind === 'lyrics' ? 'Lyrics' : channel?.kind === 'notes' ? 'Notes' : 'Presentation';
  }
  return ({ studio: 'Studio', media: 'Media', recordings: 'Recordings', team: 'Team', 'clip-editor': 'Editor', switch: 'Switcher' } as Record<string, string>)[String(route.name)] || '';
});
const { isFullscreen, isSupported, toggle } = useAppFullscreen();
async function toggleFullscreen() {
  try { await toggle(); } catch { toast.error('Fullscreen is unavailable in this window.'); }
}
</script>

<template>
  <header class="lumen-header" :class="{ 'has-program-controls': programControls }">
    <div class="lumen-header-identity"><RouterLink to="/" class="lumen-brand" aria-label="Lumen home"><FacetMark />lumen</RouterLink><span v-if="workspace" class="lumen-workspace-label">{{ workspace }}</span></div>
    <SharedListeningBar v-if="active && identity.ready && identity.isAuthenticated" />
    <div class="lumen-header-detail"><slot /></div>
    <ProgramControls v-if="programControls" />
    <template v-if="!productionWorkspace">
      <button v-if="isSupported && ['recordings', 'team'].includes(String(route.name))" class="lumen-fullscreen-toggle" type="button" :aria-label="isFullscreen ? 'Exit fullscreen' : 'Enter fullscreen'" :aria-pressed="isFullscreen" title="Fullscreen · F" aria-keyshortcuts="F" @click="toggleFullscreen"><Minimize2 v-if="isFullscreen" :size="16" /><Maximize2 v-else :size="16" /></button>
      <TeamButton /><AccountMenu placement="header" />
    </template>
  </header>
</template>

<style scoped>
.lumen-brand :deep(.facet-mark){color:var(--accent)}
.lumen-header.lumen-header{min-height:68px;height:auto;min-width:0;flex-shrink:0;grid-column:1/-1;display:flex;align-items:center;gap:24px;padding:14px 22px;flex-wrap:wrap;border-bottom:1px solid var(--border-hair);background:var(--surface-1);color:var(--text-primary);backdrop-filter:none}
.lumen-header-identity{display:flex;align-items:center;gap:20px;flex-shrink:0;min-width:0}.lumen-brand{display:inline-flex;align-items:center;gap:10px;color:var(--text-primary);text-decoration:none;font-size:25px;line-height:1;font-weight:600;letter-spacing:-1.25px;white-space:nowrap}.lumen-workspace-label{border-left:1px solid var(--border-hair);padding-left:20px;font-size:12px;color:var(--text-muted);white-space:nowrap;line-height:20px}
.lumen-header .lumen-header-detail{display:flex;align-items:center;gap:12px;flex:0 1 auto;min-width:0;font-size:12px;color:var(--text-muted)}.lumen-header .lumen-header-detail:empty{display:none}.lumen-header :deep(.program-controls){margin-left:auto}
.lumen-fullscreen-toggle{display:grid;place-items:center;width:30px;height:30px;margin-left:auto;border:1px solid transparent;border-radius:7px;color:var(--text-muted);background:transparent}.lumen-fullscreen-toggle:hover{color:var(--text-primary);background:var(--bg-hover)}
@media(max-width:900px){.lumen-header.lumen-header{gap:12px 18px;padding:12px 16px}.lumen-header-identity{gap:14px}.lumen-workspace-label{padding-left:14px}}
@media(max-width:600px){.lumen-header.lumen-header{padding:14px 12px;gap:16px 12px}.lumen-header.has-program-controls :deep(.program-controls){flex-basis:100%;justify-content:flex-end;margin-left:0}.lumen-header.has-program-controls :deep(.outputs-button){margin-right:auto}.lumen-header .lumen-header-detail{margin-left:auto}.lumen-brand{font-size:23px}.lumen-workspace-label{font-size:12px}}
</style>
