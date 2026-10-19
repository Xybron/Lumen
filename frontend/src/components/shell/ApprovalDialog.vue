<script setup lang="ts">
import { watch } from 'vue';
import { Check, X, Inbox, FileVideo, Music } from 'lucide-vue-next';
import { toast } from 'vue-sonner';
import { Dialog, DialogContent, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { useStagingStore } from '@/stores/staging';

const props = defineProps<{ open: boolean }>();
const emit = defineEmits<{ (e: 'update:open', v: boolean): void }>();

const staging = useStagingStore();

watch(
  () => props.open,
  (open) => {
    if (open) void staging.refresh();
  },
);

function isImage(mime: string | null) {
  return !!mime && mime.startsWith('image');
}
function isVideo(mime: string | null) {
  return !!mime && mime.startsWith('video');
}

async function approve(id: string) {
  try {
    await staging.approve(id);
    toast.success('Added to the media library');
  } catch (e) {
    toast.error(`Approve failed: ${(e as Error).message}`);
  }
}
async function reject(id: string) {
  try {
    await staging.reject(id);
  } catch (e) {
    toast.error(`Reject failed: ${(e as Error).message}`);
  }
}
</script>

<template>
  <Dialog :open="open" @update:open="emit('update:open', $event)">
    <DialogContent class="sm:max-w-lg">
      <DialogHeader>
        <DialogTitle class="flex items-center gap-2">
          <Inbox :size="16" class="text-accent" /> Pending media
          <span v-if="staging.count" class="text-xs text-white/45">({{ staging.count }})</span>
        </DialogTitle>
      </DialogHeader>

      <div v-if="staging.pending.length === 0" class="text-sm text-white/45 py-8 text-center">
        Nothing waiting. Uploads from <span class="text-accent">/contribute</span> appear here.
      </div>

      <ul v-else class="flex flex-col gap-2 max-h-[60vh] overflow-y-auto -mx-1 px-1">
        <li v-for="p in staging.pending" :key="p.id" class="panel-soft p-2.5 flex items-center gap-3">
          <div class="h-14 w-20 rounded-lg overflow-hidden bg-black/40 border border-hair flex items-center justify-center shrink-0">
            <img v-if="isImage(p.mime)" :src="p.rawUrl" class="h-full w-full object-cover" />
            <FileVideo v-else-if="isVideo(p.mime)" :size="20" class="text-white/45" />
            <Music v-else :size="20" class="text-white/45" />
          </div>
          <div class="flex-1 min-w-0">
            <div class="text-sm font-medium text-white truncate">{{ p.origName }}</div>
            <div class="text-xs text-white/45">
              {{ p.targetKind }}<span v-if="p.contributor"> · from {{ p.contributor }}</span>
            </div>
          </div>
          <div class="flex items-center gap-1.5 shrink-0">
            <button
              class="h-8 w-8 rounded-lg flex items-center justify-center text-emerald-300 bg-emerald-500/10 hover:bg-emerald-500/20 transition-colors"
              title="Approve"
              @click="approve(p.id)"
            >
              <Check :size="15" />
            </button>
            <button
              class="h-8 w-8 rounded-lg flex items-center justify-center text-red-300 bg-red-500/10 hover:bg-red-500/20 transition-colors"
              title="Reject"
              @click="reject(p.id)"
            >
              <X :size="15" />
            </button>
          </div>
        </li>
      </ul>
    </DialogContent>
  </Dialog>
</template>
