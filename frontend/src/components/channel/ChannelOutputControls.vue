<script setup lang="ts">
import { computed, ref } from 'vue';
import { MoreHorizontal, ExternalLink, Monitor, MonitorOff } from 'lucide-vue-next';
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover';
import { useIdentityStore } from '@/stores/identity';
import { usePresenceStore } from '@/stores/presence';
import { useEnginesStore } from '@/stores/engines';
import { usePlaybackStore } from '@/stores/playback';
import { openProjection } from '@/lib/tauri';

const identity = useIdentityStore(), presence = usePresenceStore(), engines = useEnginesStore(), playback = usePlaybackStore();
const menuOpen = ref(false);
const channelId = computed(() => engines.focusedChannelId);
const canOperate = computed(() => !!channelId.value && identity.can(channelId.value, 'author') && presence.isMine(channelId.value));
</script>

<template>
  <Popover v-if="channelId" v-model:open="menuOpen">
    <PopoverTrigger as-child><button class="channel-output-more" aria-label="More channel controls" title="More channel controls"><MoreHorizontal :size="16" /></button></PopoverTrigger>
    <PopoverContent align="end" :side-offset="8" class="!p-2 w-60">
      <div class="channel-output-menu">
        <button @click="openProjection(channelId!);menuOpen=false"><ExternalLink :size="14" />Open channel output</button>
        <button class="channel-mobile-blank" :disabled="!canOperate || !playback.current" @click="playback.toggleBlank();menuOpen=false"><Monitor v-if="playback.blanked" :size="14" /><MonitorOff v-else :size="14" />{{ playback.blanked ? 'Resume projection' : 'Blank screen' }}</button>
        <small>Channel content updates its Studio sources. Scene switching stays in Studio.</small>
      </div>
    </PopoverContent>
  </Popover>
</template>

<style scoped>
.channel-output-more{height:32px;width:28px;display:grid;place-items:center;flex-shrink:0;border-radius:var(--radius-control,7px);color:var(--text-muted)}
.channel-output-more:hover,.channel-output-menu button:hover:not(:disabled){background:var(--bg-hover)}
button:focus-visible{outline:2px solid var(--accent);outline-offset:2px}
.channel-output-menu{display:flex;flex-direction:column;gap:3px}
.channel-output-menu button{display:flex;align-items:center;gap:9px;text-align:left;padding:8px 7px;border-radius:4px;font-size:11px;color:var(--text-primary)}
.channel-output-menu button:disabled{opacity:.4;cursor:not-allowed}
.channel-output-menu small{font-size:10px;line-height:1.5;color:var(--text-muted);padding:8px 7px 4px;border-top:1px solid var(--border-hair);margin-top:5px}
@media(min-width:768px){.channel-mobile-blank{display:none!important}}
</style>
