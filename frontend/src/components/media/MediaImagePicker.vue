<script setup lang="ts">
import { computed } from 'vue';
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import MediaImageBrowser from './MediaImageBrowser.vue';
import type { MediaLibraryAsset, MediaLibraryKind } from '@/lib/media-library';

const props = withDefaults(defineProps<{ open: boolean; selectedPath?: string; acceptedKinds?: MediaLibraryKind[]; title?: string }>(), { acceptedKinds: () => ['image'], title: '' });
const pickerTitle = computed(() => props.title || (props.acceptedKinds.length === 1 ? props.acceptedKinds[0] === 'image' ? 'Choose an image' : props.acceptedKinds[0] === 'video' ? 'Choose a video' : 'Choose an audio file' : 'Choose media'));
const emit = defineEmits<{ 'update:open': [value: boolean]; select: [asset: MediaLibraryAsset] }>();
function select(asset: MediaLibraryAsset) { emit('select', asset); emit('update:open', false); }
</script>

<template>
  <Dialog :open="open" @update:open="emit('update:open', $event)">
    <DialogContent class="media-image-picker" @keydown.stop>
      <DialogHeader><DialogTitle>{{ pickerTitle }}</DialogTitle><DialogDescription>Media library</DialogDescription></DialogHeader>
      <MediaImageBrowser v-if="open" picker :selected-path="selectedPath" :accepted-kinds="acceptedKinds" @select="select" @cancel="emit('update:open', false)" />
    </DialogContent>
  </Dialog>
</template>
