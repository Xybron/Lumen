<script setup lang="ts">
import { computed, onMounted, ref } from 'vue';
import { useRouter, useRoute } from 'vue-router';
import { Plus, LogOut, Shield, ChevronUp, Inbox, Clapperboard, Cpu, GripVertical, ChevronsLeft, ChevronsRight, RotateCcw, Presentation, BookOpen, Music2, Grid2X2, Scissors } from 'lucide-vue-next';
import {
  DropdownMenu,
  DropdownMenuTrigger,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
} from '@/components/ui/dropdown-menu';
import { useContentStore } from '@/stores/content';
import { useEnginesStore } from '@/stores/engines';
import { useIdentityStore } from '@/stores/identity';
import { usePresenceStore } from '@/stores/presence';
import { useStagingStore } from '@/stores/staging';
import { useWorshipStore } from '@/stores/worship';
import ChannelChip from './ChannelChip.vue';
import UsersDialog from './UsersDialog.vue';
import ApprovalDialog from './ApprovalDialog.vue';
import AgentManagerDialog from './AgentManagerDialog.vue';
import { openProjection } from '@/lib/tauri';
import type { ChannelKind } from '@/types';
import { useFloatingDock } from '@/composables/useFloatingDock';
import { useMultiview } from '@/composables/useMultiview';
import { useConfirmation } from '@/composables/useConfirmation';
import { sceneShortcutProblem } from '@/lib/studio/scene-shortcuts';

const props = defineProps<{ studio?: boolean }>();
const { element: dock, style: dockStyle, collapsed, dragging, begin, move, finish, cancel, reset, keyboard } = useFloatingDock({
  legacyStorageKeys: props.studio ? ['lumen.studio.toolbar.v1', 'lumen.present.toolbar.v1'] : ['lumen.present.toolbar.v1', 'lumen.studio.toolbar.v1'],
  bottomInset: () => window.innerWidth < 768 ? 20 : 44,
});

const KINDS: { kind: ChannelKind; label: string }[] = [
  { kind: 'presentation', label: 'Presentation' },
  { kind: 'scripture', label: 'Scripture' },
  { kind: 'lyrics', label: 'Lyrics' },
];

// The floating operator nav, bottom-center. It IS the "now on air" view: every
// channel shows its live slide counter + play/blank state, who controls it, and
// a context menu (rename/delete). Plus add-channel and an account menu.
const router = useRouter();
const route = useRoute();
const multiview = useMultiview();
const { confirmAction } = useConfirmation();
function focus(id: string) { engines.focusChannel(id); if(route.path !== '/') void router.push('/'); }
const content = useContentStore();
const engines = useEnginesStore();
const identity = useIdentityStore();
const presence = usePresenceStore();
const staging = useStagingStore();
const worship = useWorshipStore();
const focusedChannel = computed(() => content.channels.find(ch => ch.id === engines.focusedChannelId));
const dockLabel = computed(() => props.studio ? 'Studio' : focusedChannel.value?.name ?? 'Present');
const dockIcon = computed(() => props.studio ? Clapperboard : focusedChannel.value?.kind === 'scripture' ? BookOpen : focusedChannel.value?.kind === 'lyrics' ? Music2 : Presentation);
function toolbarKeys(event: KeyboardEvent) {
  // Keep search available without letting toolbar keys advance slides or Take.
  if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === 'k') return;
  if (sceneShortcutProblem(event) === null) return;
  if (event.key === 'Escape' && dragging.value) { cancel(); event.preventDefault(); }
  event.stopPropagation();
}

const approvalOpen = ref(false);
onMounted(() => void staging.refresh());

const channels = computed(() => {
  const byId = new Map(engines.allEngines.map((e) => [e.channelId, e]));
  return content.channels.map((ch) => {
    const e = byId.get(ch.id);
    const byOther = presence.controlledByOther(ch.id);
    return {
      id: ch.id,
      name: ch.name,
      kind: ch.kind,
      listening: worship.listening[ch.id]?.session?.mode ?? null,
      focused: route.path === '/' && ch.id === engines.focusedChannelId,
      index: e?.index.value ?? 0,
      total: e?.items.value.length ?? 0,
      playing: e?.playing.value ?? false,
      blanked: e?.blanked.value ?? false,
      byOther,
      controllerName: byOther ? presence.userName(presence.controllerOf(ch.id)) : null,
    };
  });
});

const adding = ref(false);
async function addChannel(kind: ChannelKind) {
  if (adding.value) return;
  adding.value = true;
  try {
    const name = KINDS.find((k) => k.kind === kind)?.label ?? 'Channel';
    const { channelId } = await content.addChannel(name, kind);
    focus(channelId);
  } finally {
    adding.value = false;
  }
}

function openLive(id: string) {
  openProjection(id);
}

async function takeover(id: string, name: string | null) {
  const channel = content.channels.find(item => item.id === id);
  if (!channel || !identity.can(id, 'author')) return;
  const channelName = channel.name;
  const controllerId = presence.controllerOf(id);
  if (!await confirmAction({
    title: 'Take control?',
    description: `You will control “${channelName}”${name ? ` instead of ${name}` : ''}.`,
    confirmLabel: 'Take control',
  })) return;
  // A different operator may have taken over while the dialog was open.
  if (!identity.can(id, 'author') || !content.channels.some(item => item.id === id) || presence.controllerOf(id) !== controllerId) return;
  presence.takeover(id);
  engines.focusChannel(id);
}

async function deleteChannel(id: string, name: string) {
  if (!identity.can(id, 'author') || presence.controlledByOther(id)) return;
  if (!await confirmAction({
    title: 'Delete channel?',
    description: `“${name}” and its playlist and slides will be removed.`,
    confirmLabel: 'Delete channel',
    tone: 'danger',
  })) return;
  if (identity.can(id, 'author') && !presence.controlledByOther(id) && content.channels.some(item => item.id === id)) await content.removeChannel(id);
}

const usersOpen = ref(false);
const agentsOpen = ref(false);
async function signOut() {
  const userId = identity.me?.id;
  if (!userId || !await confirmAction({
    title: 'Sign out?',
    description: 'You will need to sign in again to control this station.',
    confirmLabel: 'Sign out',
  })) return;
  if (identity.me?.id === userId) await identity.logout();
}
</script>

<template>
  <div
    ref="dock"
    :style="dockStyle"
    :class="{ 'dock-collapsed': collapsed, 'dock-dragging': dragging }"
    role="navigation"
    aria-label="Channel toolbar"
    @keydown="toolbarKeys"
    class="channel-nav floating-dock"
  >
    <button class="dock-grip dock-control" aria-label="Move toolbar" title="Drag to move · Arrow keys to nudge · Home to reset"
      aria-describedby="dock-move-help" @pointerdown="begin" @pointermove="move" @pointerup="finish" @pointercancel="cancel" @lostpointercapture="finish" @keydown="keyboard" @dblclick="reset">
      <GripVertical :size="16" />
    </button>
    <span id="dock-move-help" class="sr-only">Drag to reposition, or use arrow keys. Hold Shift for larger steps. Home resets position. Escape cancels a drag.</span>
    <div v-if="collapsed" class="dock-summary">
      <component :is="dockIcon" :size="15" /><span :title="dockLabel">{{ dockLabel }}</span>
      <span v-if="channels.some(ch => ch.listening)" class="dock-listening" title="AI listening active" aria-label="AI listening active" />
    </div>
    <div v-show="!collapsed" id="channel-toolbar-items" class="dock-items no-scrollbar">
    <ChannelChip
      v-for="ch in channels"
      :key="ch.id"
      :ch="ch"
      @focus="focus(ch.id)"
      @takeover="takeover(ch.id, ch.controllerName)"
      @open-live="openLive(ch.id)"
      @rename="(name) => content.renameChannel(ch.id, name)"
      @delete="deleteChannel(ch.id, ch.name)"
    />

    <DropdownMenu>
      <DropdownMenuTrigger as-child>
        <button
          class="dock-tool"
          :disabled="adding"
          title="Add channel"
          aria-label="Add channel"
        >
          <Plus :size="16" />
        </button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="center" :side-offset="8" class="w-40">
        <div class="px-2 py-1 text-[10px] uppercase tracking-[0.12em] text-white/35">New channel</div>
        <DropdownMenuItem v-for="k in KINDS" :key="k.kind" @select="addChannel(k.kind)">
          {{ k.label }}
        </DropdownMenuItem>
      </DropdownMenuContent>
    </DropdownMenu>

    <!-- Studio lives alongside the channels, not in a second workspace switch. -->
    <button
      class="dock-tool"
      :class="{ 'dock-studio-current': route.path === '/studio' }"
      title="Production Studio — scenes, audio & recording"
      aria-label="Open Production Studio"
      :aria-current="route.path === '/studio' ? 'page' : undefined"
      @click="router.push('/studio')"
    >
      <Clapperboard :size="17" :stroke-width="1.7" />
    </button>
    <button v-if="identity.can('*', 'author')" class="dock-tool" :class="{ 'dock-studio-current': multiview.open.value }"
      aria-label="Open Multiview" title="Multiview — Preview, Program & scenes" data-multiview-trigger :aria-expanded="multiview.open.value"
      @click="multiview.toggle"><Grid2X2 :size="17" :stroke-width="1.7" /></button>

    <a href="/recordings" target="_blank" rel="noopener" class="dock-tool" aria-label="Open Recordings and Clips" title="Recordings & clips — opens in a new tab"><Scissors :size="17" :stroke-width="1.7" /></a>

    <!-- pending media inbox -->
    <button
      class="dock-tool"
      title="Pending media"
      aria-label="Pending media"
      @click="approvalOpen = true"
    >
      <Inbox :size="16" />
      <span
        v-if="staging.count"
        class="absolute -top-0.5 -right-0.5 min-w-[16px] h-4 px-1 rounded-full bg-accent text-black text-[10px] font-bold flex items-center justify-center"
      >
        {{ staging.count }}
      </span>
    </button>

    <!-- account / admin menu -->
    <div class="w-px h-6 bg-hair mx-0.5 shrink-0" />
    <DropdownMenu v-if="identity.me">
      <DropdownMenuTrigger as-child>
        <button
          class="dock-tool dock-account"
          :title="`Signed in as ${identity.me.displayName}`"
          :aria-label="`Account menu for ${identity.me.displayName}`"
        >
          <span class="h-6 w-6 rounded-full bg-accent/20 text-accent text-[11px] font-semibold flex items-center justify-center uppercase">
            {{ identity.me.displayName.charAt(0) }}
          </span>
          <ChevronUp :size="13" class="opacity-60" />
        </button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end" :side-offset="8" class="w-48">
        <div class="px-2 py-1.5 text-xs text-white/50 truncate">{{ identity.me.displayName }}</div>
        <DropdownMenuSeparator />
        <DropdownMenuItem v-if="identity.me.isAdmin" @select="usersOpen = true">
          <Shield :size="13" /> Team &amp; roles
        </DropdownMenuItem>
        <DropdownMenuItem v-if="identity.me.isAdmin" @select="agentsOpen = true">
          <Cpu :size="13" /> Capture agents
        </DropdownMenuItem>
        <DropdownMenuItem @select="signOut">
          <LogOut :size="13" /> Sign out
        </DropdownMenuItem>
      </DropdownMenuContent>
    </DropdownMenu>
    </div>
    <div class="dock-divider" />
    <button class="dock-control dock-reset" aria-label="Reset toolbar position" title="Reset toolbar position" @click="reset"><RotateCcw :size="13" /></button>
    <button class="dock-control" :aria-label="collapsed ? 'Expand toolbar' : 'Collapse toolbar'" :title="collapsed ? 'Expand toolbar' : 'Collapse toolbar'"
      :aria-expanded="!collapsed" aria-controls="channel-toolbar-items" @click="collapsed = !collapsed">
      <ChevronsRight v-if="collapsed" :size="16" /><ChevronsLeft v-else :size="16" />
    </button>
  </div>
  <UsersDialog v-model:open="usersOpen" />
  <ApprovalDialog v-model:open="approvalOpen" />
  <AgentManagerDialog v-model:open="agentsOpen" />
</template>

<style scoped>
.dock-items { display: flex; align-items: center; gap: 3px; min-width: 0; overflow-x: auto; overscroll-behavior-x: contain; }
.floating-dock { position: fixed; left: 50%; transform: translateX(-50%); z-index: 30; display: flex; align-items: center; gap: 4px; padding: 5px; border: 1px solid #ffffff1c; border-radius: 11px; bottom: calc(20px + env(safe-area-inset-bottom, 0px)); width: max-content; max-width: calc(100vw - 24px); background: #1c1d20f5; box-shadow: var(--shadow-floating), inset 0 1px 0 #ffffff05; backdrop-filter: blur(12px); }
@media (min-width: 768px) { .floating-dock { bottom: calc(44px + env(safe-area-inset-bottom, 0px)); } }
.dock-control { width: 28px; height: 38px; flex-shrink: 0; display: flex; align-items: center; justify-content: center; border-radius: 6px; color: var(--text-muted); transition: color 120ms, background-color 120ms; }
.dock-control:hover, .dock-tool:hover { color: var(--text-primary); background: #ffffff0a; }
.dock-control:focus-visible, .dock-tool:focus-visible { outline: 2px solid var(--accent); outline-offset: -2px; }
.dock-tool { position: relative; display: flex; align-items: center; justify-content: center; flex-shrink: 0; width: 36px; height: 38px; border-radius: 6px; color: var(--text-muted); transition: color 120ms, background-color 120ms; }
.dock-tool:disabled { opacity: .4; cursor: not-allowed; }
.dock-tool.dock-studio-current { color: var(--accent); background: var(--accent-soft); box-shadow: inset 0 0 0 1px #7dd3fc1f; }
.dock-account { width: auto; padding: 0 7px; gap: 6px; }
.floating-dock .dock-grip { width: 24px; cursor: grab; touch-action: none; user-select: none; }
.floating-dock.dock-dragging, .floating-dock.dock-dragging .dock-grip { cursor: grabbing; user-select: none; }
.dock-divider { height: 22px; width: 1px; background: var(--border-hair); flex-shrink: 0; }
.dock-summary { display: flex; align-items: center; gap: 8px; padding: 0 7px; color: var(--text-primary); font-size: 12px; }
.dock-summary > svg { color: var(--accent); }
.dock-summary > span:not(.dock-listening) { max-width: 140px; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
.dock-listening { width: 5px; height: 5px; border-radius: 50%; background: var(--accent); }
.dock-collapsed .dock-reset { display: none; }
.no-scrollbar::-webkit-scrollbar {
  display: none;
}
.no-scrollbar {
  -ms-overflow-style: none;
  scrollbar-width: none;
}
</style>
