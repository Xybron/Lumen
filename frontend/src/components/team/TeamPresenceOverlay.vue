<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, ref, watch } from 'vue';
import { useRoute } from 'vue-router';
import { MousePointer2, ScanEye } from 'lucide-vue-next';
import { useTeamStore } from '@/stores/team';
import { useEnginesStore } from '@/stores/engines';

const route = useRoute(), team = useTeamStore(), engines = useEnginesStore();
// Outputs, engine renderers and recording previews never mount team cursors.
const operatorSurface = computed(() => ['dashboard', 'studio', 'team'].includes(String(route.name)));
const surface = computed(() => route.name === 'studio' ? 'studio' : route.name === 'team' ? `team:${String(route.query.resource ?? 'library')}` : `channel:${engines.focusedChannelId ?? 'none'}`);
const visible = computed(() => team.enabled && !!team.user && !!team.teamId && operatorSurface.value);
const clock = ref(Date.now());
const activePeers = computed(() => team.peers.filter(peer => clock.value - peer.updatedAt < 10000));
const cursors = computed(() => team.focusMode ? [] : activePeers.value.filter(peer => peer.surface === surface.value && Number.isFinite(peer.x) && Number.isFinite(peer.y) && peer.x >= 0 && peer.x <= 1 && peer.y >= 0 && peer.y <= 1));
let timer: ReturnType<typeof setInterval> | undefined, lastSent = 0;
function pointer(event: PointerEvent) {
  if (!visible.value || team.focusMode || document.hidden || Date.now() - lastSent < 100) return;
  // Do not disclose interaction positions inside password/account dialogs.
  const target = event.target;
  if (target instanceof Element && target.closest('[role="dialog"], [data-team-private]')) return;
  lastSent = Date.now();
  team.updatePresence(surface.value, Math.max(0, Math.min(1, event.clientX / Math.max(1, window.innerWidth))), Math.max(0, Math.min(1, event.clientY / Math.max(1, window.innerHeight))));
}
// Keyboard navigation changes the operator surface without a pointer event.
// Keep the last public coordinates; never sample a dialog/private input here.
watch([surface, visible], ([nextSurface, isVisible]) => {
  lastSent = 0;
  if (isVisible) team.updatePresence(nextSurface);
}, { immediate: true });
onMounted(() => { window.addEventListener('pointermove', pointer, { passive: true }); timer = setInterval(() => { clock.value = Date.now(); }, 1000); });
onBeforeUnmount(() => { window.removeEventListener('pointermove', pointer); if (timer) clearInterval(timer); });
function initials(name: string) { return name.trim().split(/\s+/).slice(0, 2).map(part => part[0]).join('').toUpperCase() || '?'; }
function location(value: string) { return value === 'studio' ? 'Studio' : value.startsWith('channel:') ? 'a channel' : 'Team workspace'; }
</script>

<template>
  <div v-if="visible" class="team-presence-layer" aria-hidden="true">
    <div v-for="peer in cursors" :key="peer.sessionId" class="team-remote-cursor" :style="{ left: `${peer.x * 100}%`, top: `${peer.y * 100}%`, '--peer-color': peer.color }">
      <MousePointer2 :size="19" :stroke-width="1.5" fill="currentColor" />
      <span>{{ peer.name }}</span>
    </div>
  </div>
  <aside v-if="visible" class="team-presence-bar" aria-label="Team activity">
    <div v-if="!team.focusMode && activePeers.length" class="team-presence-people">
      <span v-for="peer in activePeers.slice(0, 4)" :key="peer.sessionId" class="team-presence-avatar" :style="{ '--peer-color': peer.color }" :title="`${peer.name} · ${location(peer.surface)}`" role="img" :aria-label="`${peer.name} in ${location(peer.surface)}`">{{ initials(peer.name) }}</span>
      <span v-if="activePeers.length > 4" class="team-presence-more">+{{ activePeers.length - 4 }}</span>
    </div>
    <button type="button" :aria-pressed="team.focusMode" :title="team.focusMode ? 'Show team activity' : 'Focus mode: hide team activity and stop sharing your cursor'" @click="team.setFocusMode(!team.focusMode)"><ScanEye :size="14" /><span>{{ team.focusMode ? 'Focus mode' : 'Team activity' }}</span></button>
  </aside>
</template>

<style scoped>
.team-presence-layer{position:fixed;inset:0;z-index:35;pointer-events:none;overflow:hidden}
.team-remote-cursor{position:absolute;color:var(--peer-color,#7dd3fc);display:flex;flex-direction:column;align-items:flex-start;gap:1px;transition:left .1s linear,top .1s linear;filter:drop-shadow(0 1px 1px #0008)}
.team-remote-cursor>span{max-width:140px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;transform:translate(14px,-1px);background:var(--peer-color,#7dd3fc);color:#101113;border-radius:3px;padding:3px 5px;font-size:9px;font-weight:600;line-height:1.3}
.team-presence-bar{position:fixed;top:76px;right:20px;z-index:34;display:flex;gap:9px;align-items:center;background:var(--surface-1);border:1px solid var(--border-hair);border-radius:7px;padding:4px 5px;box-shadow:0 3px 12px #0002;color:var(--text-muted)}
.team-presence-bar>button{display:flex;align-items:center;gap:6px;padding:4px 5px;border-radius:4px;font-size:9px;cursor:pointer}
.team-presence-bar>button:hover{color:var(--text-primary);background:var(--bg-hover)}
.team-presence-bar>button:focus-visible{outline:2px solid var(--accent);outline-offset:2px}
.team-presence-people{display:flex;padding-left:2px;align-items:center}
.team-presence-avatar{display:grid;place-items:center;width:23px;height:23px;margin-left:-2px;border:2px solid var(--surface-1);background:var(--peer-color,#7dd3fc);color:#101113;border-radius:50%;font-size:8px;font-weight:600}
.team-presence-more{font-size:9px;padding-left:3px}
@media(max-width:760px){.team-presence-bar{top:auto;bottom:104px;right:12px}.team-presence-bar>button>span{display:none}}
@media(prefers-reduced-motion:reduce){.team-remote-cursor{transition:none}}
</style>
