<script setup lang="ts">
import { computed, ref, watch } from 'vue';
import { ListMusic, Music2, Trash2 } from 'lucide-vue-next';
import { toast } from 'vue-sonner';
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { Button } from '@/components/ui/button';
import { useContentStore } from '@/stores/content';
import { useIdentityStore } from '@/stores/identity';
import { useConfirmation } from '@/composables/useConfirmation';
import { mediaDisplayName } from '@/lib/studio/media-library';

const props = defineProps<{ open: boolean; track: string }>();
const emit = defineEmits<{ 'update:open': [value: boolean] }>();
const content = useContentStore(), identity = useIdentityStore();
const { confirmAction } = useConfirmation();
const removing = ref(false), selectedRow = ref<HTMLElement>();
const tracks = computed(() => [...new Set([content.content.music.current, ...content.content.music.queue].filter((value): value is string => !!value))]);
const name = (track: string) => mediaDisplayName(track.split('/').pop() || track);
watch(() => props.open, open => { if (open) requestAnimationFrame(() => selectedRow.value?.scrollIntoView({ block: 'nearest' })); });
async function remove(track: string) {
  if (removing.value || !identity.can('*', 'author')) return;
  const current = content.content.music.current === track;
  if (!await confirmAction({ title: 'Remove track from music?', description: `“${name(track)}” will be removed from the music queue${current ? ' and the current track selection' : ''}.`, note: 'If this track is playing, removing it stops that music. The file stays in Media.', confirmLabel: 'Remove track', tone: 'danger' })) return;
  if (!identity.can('*', 'author')) return;
  removing.value = true;
  try {
    const saved = await content.save(draft => {
      draft.music.queue = draft.music.queue.filter(value => value !== track);
      if (draft.music.current === track) delete draft.music.current;
    });
    if (saved) toast.success('Track removed from music.');
  } catch { toast.error('The music queue could not be updated. Try again.'); }
  finally { removing.value = false; }
}
</script>

<template>
  <Dialog :open="open" @update:open="emit('update:open', $event)">
    <DialogContent class="sm:max-w-lg" @keydown.stop>
      <DialogHeader><DialogTitle><span class="flex items-center gap-2"><ListMusic :size="18" />Music queue</span></DialogTitle><DialogDescription>Remove the track here to release its music references. Opening this queue does not start playback.</DialogDescription></DialogHeader>
      <p v-if="!tracks.includes(track)" class="text-sm text-white/60">This track is no longer in the music queue or current selection.</p>
      <div class="flex max-h-[55vh] flex-col gap-2 overflow-y-auto">
        <div v-for="value in tracks" :key="value" :ref="element => { if (value === track) selectedRow = element as HTMLElement; }" class="flex items-center gap-3 rounded-lg border p-3" :class="value === track ? 'border-accent/50 bg-accent/10' : 'border-hair'" :data-media-track="value">
          <Music2 :size="18" class="shrink-0 text-accent" /><div class="min-w-0 flex-1"><p class="truncate text-sm" :title="name(value)">{{ name(value) }}</p><p class="text-xs text-white/50">{{ content.content.music.current === value ? 'Current track' : 'Queued track' }}<span v-if="content.content.music.current === value && content.content.music.queue.includes(value)"> · In queue</span></p></div>
          <Button type="button" variant="ghost" :disabled="removing || !identity.can('*', 'author')" :aria-label="`Remove ${name(value)} from music`" @click="remove(value)"><Trash2 :size="15" /></Button>
        </div>
      </div>
      <div class="flex justify-end"><Button type="button" variant="outline" @click="emit('update:open', false)">Done</Button></div>
    </DialogContent>
  </Dialog>
</template>
