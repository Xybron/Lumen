<script setup lang="ts">
import { nextTick, ref, useTemplateRef } from 'vue';
import { ExternalLink, Hand, MoreVertical, Pencil, Trash2, BookOpen, Music2, Presentation } from 'lucide-vue-next';
import {
  DropdownMenu,
  DropdownMenuTrigger,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
} from '@/components/ui/dropdown-menu';

// One channel in the floating nav: status dot + name/counter, who controls it
// (presence), takeover, the live-output link, and a context menu for rename /
// delete. Rename is inline (mirrors PlaylistRail's pattern).
interface ChannelVM {
  id: string;
  name: string;
  kind: string;
  listening: 'assisted' | 'automatic' | null;
  focused: boolean;
  index: number;
  total: number;
  playing: boolean;
  blanked: boolean;
  byOther: boolean;
  controllerName: string | null;
}

const props = defineProps<{ ch: ChannelVM }>();
const emit = defineEmits<{
  (e: 'focus'): void;
  (e: 'takeover'): void;
  (e: 'open-live'): void;
  (e: 'rename', name: string): void;
  (e: 'delete'): void;
}>();

const menuOpen = ref(false);
const renaming = ref(false);
const draft = ref('');
const renameInput = useTemplateRef<HTMLInputElement>('renameInput');

async function startRename() {
  draft.value = props.ch.name;
  renaming.value = true;
  await nextTick();
  renameInput.value?.focus();
  renameInput.value?.select();
}
function commitRename() {
  const next = draft.value.trim();
  if (next && next !== props.ch.name) emit('rename', next);
  renaming.value = false;
}
</script>

<template>
  <div
    class="channel-chip group relative flex items-center gap-2 h-10 pl-2.5 pr-1.5 shrink-0 transition-colors"
    :class="{ 'channel-chip-active': ch.focused }"
    @contextmenu.prevent="menuOpen = true"
  >
    <button
      class="flex items-center gap-2 min-w-0"
      :title="`${ch.name} — ${ch.kind}`"
      :aria-label="`${ch.name} — ${ch.kind}`"
      :aria-pressed="ch.focused"
      @click="!renaming && emit('focus')"
    >
      <component :is="ch.kind === 'scripture' ? BookOpen : ch.kind === 'lyrics' ? Music2 : Presentation" :size="16" :class="ch.focused ? 'text-accent' : 'text-white/40'" />
      <div class="flex flex-col items-start leading-tight min-w-0">
        <input
          v-if="renaming"
          ref="renameInput"
          v-model="draft"
          class="bg-white/[0.08] border border-hairglow rounded px-1 text-[13px] text-white outline-none w-[130px]"
          @click.stop
          @keydown.enter.prevent="commitRename"
          @keydown.escape.prevent="renaming = false"
          @blur="commitRename"
        />
        <span v-else class="text-[12px] font-medium tracking-display truncate max-w-[140px]">{{ ch.name }}</span>
        <span v-if="!renaming" class="text-[10px] tnum text-white/40 flex items-center gap-1">
          <span v-if="ch.listening" :class="ch.listening === 'automatic' ? 'text-amber-300' : 'text-accent'">AI {{ch.listening === 'automatic' ? 'auto' : 'listening'}} ·</span>
          <span v-if="ch.blanked" class="text-white/50">blanked</span>
          <span v-else>{{ ch.kind === 'scripture' ? 'Scripture' : ch.kind === 'lyrics' ? 'Lyrics' : `Slides · ${ch.total === 0 ? 'Ready' : `${ch.index + 1} / ${ch.total}`}` }}</span>
          <span v-if="ch.byOther" class="text-amber-300/80 normal-nums">· {{ ch.controllerName }}</span>
        </span>
      </div>
    </button>

    <!-- takeover when another operator controls this channel -->
    <button
      v-if="ch.byOther"
      class="h-7 px-1.5 rounded-lg flex items-center gap-1 text-amber-300/90 bg-amber-400/10 hover:bg-amber-400/20 transition-colors text-[10px] font-medium cursor-pointer"
      :title="`Take control from ${ch.controllerName}`"
      :aria-label="`Take control of ${ch.name} from ${ch.controllerName}`"
      @click.stop="emit('takeover')"
    >
      <Hand :size="11" /> Take
    </button>

    <!-- context menu -->
    <DropdownMenu v-model:open="menuOpen">
      <DropdownMenuTrigger as-child>
        <button
          class="channel-chip-options h-7 w-6 rounded flex items-center justify-center text-white/35 hover:text-white hover:bg-white/[0.08] transition-colors"
          title="Channel options"
          :aria-label="`Options for ${ch.name}`"
          @click.stop
        >
          <MoreVertical :size="14" />
        </button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end" :side-offset="6" class="w-44">
        <DropdownMenuItem :disabled="ch.byOther" @select="startRename">
          <Pencil :size="13" /> Rename
        </DropdownMenuItem>
        <DropdownMenuItem @select="emit('open-live')">
          <ExternalLink :size="13" /> Open channel output
        </DropdownMenuItem>
        <DropdownMenuSeparator />
        <DropdownMenuItem
          :disabled="ch.byOther"
          class="text-red-300 data-[highlighted]:text-red-200 data-[highlighted]:bg-red-500/15"
          @select="emit('delete')"
        >
          <Trash2 :size="13" /> Delete channel
        </DropdownMenuItem>
      </DropdownMenuContent>
    </DropdownMenu>
  </div>
</template>

<style scoped>
.channel-chip { height: 38px; border: 1px solid transparent; border-radius: 7px; color: var(--text-muted); }
.channel-chip:hover { background: #ffffff06; color: var(--text-primary); }
.channel-chip-active { background: #ffffff09; border-color: #ffffff12; color: var(--text-primary); }
.channel-chip-active:hover { background: #ffffff0d; }
.channel-chip > button:first-child { min-height: 30px; border-radius: 4px; }
.channel-chip-options { opacity: .65; }
.channel-chip:hover .channel-chip-options, .channel-chip-options:focus-visible, .channel-chip-options[data-state="open"] { opacity: 1; }
.channel-chip button:focus-visible { outline: 2px solid var(--accent); outline-offset: 1px; }
@media (pointer: coarse) { .channel-chip { min-height: 40px; } .channel-chip-options { min-width: 30px; min-height: 34px; opacity: 1; } }
</style>
