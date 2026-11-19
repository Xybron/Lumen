<script setup lang="ts">
import { computed, ref } from 'vue';
import { ArrowUpRight, Check, LoaderCircle } from 'lucide-vue-next';
import { toast } from 'vue-sonner';
import { useStudioStore } from '@/stores/studio';
import { useContentStore } from '@/stores/content';
import { useEnginesStore } from '@/stores/engines';
import { useIdentityStore } from '@/stores/identity';
import { preparePresentationScene } from '@/lib/studio/presentation-scene';
import { shortId } from '@/lib/ids';
import { studioApi } from '@/lib/studio/api';
const props = defineProps<{ channelId?: string }>();
const studio = useStudioStore(), content = useContentStore(), engines = useEnginesStore(), identity = useIdentityStore();
const busy = ref(false);
const canOperate = computed(() => identity.isAuthenticated && identity.can('*', 'author'));
const channel = computed(() => content.channels.find(item => item.id === (props.channelId ?? engines.focusedChannelId)));
const onProgram = computed(() => !!channel.value && studio.state?.program?.layers.some(layer => layer.visible && layer.opacity > 0 &&
  studio.state?.sources.some(source => source.id === layer.sourceId && source.kind === 'channel' && source.channelId === channel.value?.id)));
const directProgram = computed(() => onProgram.value && studio.state?.program?.id.startsWith('presentation_') && !studio.state?.channelInsert);
async function present() {
  const selected = channel.value;
  if (!selected || busy.value || !canOperate.value || directProgram.value) return;
  busy.value = true;
  try {
    if (!studio.state) await studio.load();
    if (!studio.state || !canOperate.value) throw new Error('Program is unavailable. Please reconnect and try again.');
    let sceneId = '';
    await studio.edit(draft => { sceneId = preparePresentationScene(draft, selected, shortId).id; });
    await studio.command({ type: 'take', sceneId, transition: 'cut', swapPreview: false });
    if (studio.status.state !== 'running') studio.status = await studioApi.start();
    toast.success(`${selected.name} is on Program.`);
  } catch (error) { toast.error(error instanceof Error ? error.message : 'Could not send this channel to Program.'); }
  finally { busy.value = false; }
}
</script>
<template>
  <button v-if="channel && canOperate" type="button" class="send-to-program" :class="{ selected: onProgram }" :disabled="busy || studio.saving > 0 || directProgram" :title="directProgram ? 'This channel is already on Program' : onProgram ? 'Show this channel full screen instead of the current composition' : 'Show this channel on Program'" @click="present"><LoaderCircle v-if="busy" :size="14" class="animate-spin" /><Check v-else-if="directProgram" :size="14" /><ArrowUpRight v-else :size="14" />{{ directProgram ? 'On Program' : onProgram ? 'Present fullscreen' : 'Send to Program' }}</button>
</template>
<style scoped>
.send-to-program{display:inline-flex;align-items:center;justify-content:center;gap:6px;min-height:32px;white-space:nowrap;padding:6px 9px;border:1px solid var(--border-hair);border-radius:7px;color:var(--text-primary);background:var(--surface-2);font-size:11px;line-height:1.4}.send-to-program:hover:not(:disabled){background:var(--bg-hover)}.send-to-program.selected{color:var(--accent);border-color:#7dd3fc30;background:#7dd3fc08}.send-to-program:disabled{opacity:.55;cursor:default}.send-to-program:focus-visible{outline:2px solid var(--accent);outline-offset:3px}@media(pointer:coarse){.send-to-program{min-height:40px}}
</style>
