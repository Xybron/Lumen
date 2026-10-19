<script setup lang="ts">
import { computed, reactive, ref, shallowRef, watch } from 'vue';
import { Download, Film, FolderOpen, Headphones, LoaderCircle, ShieldCheck } from 'lucide-vue-next';
import { Dialog, DialogContent, DialogDescription, DialogTitle } from '@/components/ui/dialog';
import { audioExport, defaultExportOptions, EXPORT_FORMATS, exportDimensions } from '@/lib/clip-export';
import { formatClipTime } from '@/lib/clip-timeline';
import { chooseClipDestination, clipDeliveryFilename, destinationLabel, supportsClipSavePicker, type ClipDestination } from '@/lib/clip-delivery';
import type { ClipExportOptions, ClipFormat } from '../../../../shared/clips';

const props = defineProps<{ open: boolean; name: string; format: ClipFormat; duration: number; liveProtected: boolean; disabled: boolean; error?: string }>();
const emit = defineEmits<{ 'update:open': [open: boolean]; export: [options: ClipExportOptions, destination: ClipDestination] }>();
const options = reactive<ClipExportOptions>(defaultExportOptions());
const destination = shallowRef<ClipDestination | null>(null), picking = ref(false), destinationError = ref('');
const pickerSupported = supportsClipSavePicker();
const audioOnly = computed(() => audioExport(options.container));
const choice = computed(() => EXPORT_FORMATS.find(value => value.value === options.container)!);
watch(() => options.container, () => { destination.value = null; destinationError.value = ''; });
watch(() => props.open, open => { if (open) destinationError.value = ''; else destination.value = null; });
async function chooseLocation() {
  if (picking.value || props.disabled) return null;
  picking.value = true; destinationError.value = '';
  try { const value = await chooseClipDestination({ ...options }, props.name); if (value) destination.value = value; return value; }
  catch (error) { destinationError.value = (error as Error).message || 'Could not choose a save location. Try again.'; return null; }
  finally { picking.value = false; }
}
async function submit() { if (props.disabled || picking.value) return; const selected = destination.value ?? await chooseLocation(); if (selected) emit('export', { ...options }, selected); }
function useBrowserDownloads() { destination.value = { kind: 'download', name: clipDeliveryFilename(options, props.name), canRevealFolder: false }; destinationError.value = ''; }
</script>

<template>
  <Dialog :open="open" @update:open="value => { if (!disabled && !picking) emit('update:open', value); }">
    <DialogContent class="nle-export-dialog" @escape-key-down="event => { if (disabled || picking) event.preventDefault(); }" @interact-outside="event => { if (disabled || picking) event.preventDefault(); }">
      <header class="nle-export-heading"><span class="nle-export-icon"><Headphones v-if="audioOnly" :size="21" :stroke-width="1.5" /><Film v-else :size="21" :stroke-width="1.5" /></span><div><DialogTitle>Export your edit</DialogTitle><DialogDescription>Choose a file for your next destination.</DialogDescription></div></header>
      <div class="nle-export-project"><strong>{{ name }}</strong><span>{{ formatClipTime(duration) }} · {{ audioOnly ? 'Audio only' : format }}</span></div>
      <form @submit.prevent="submit">
        <label class="clip-field"><span>File format</span><select v-model="options.container" aria-label="Export file format" :disabled="disabled || picking"><option v-for="option in EXPORT_FORMATS" :key="option.value" :value="option.value">{{ option.label }} · {{ option.description }}</option></select></label>
        <p class="nle-export-use">{{ choice.use }}</p>
        <label class="clip-field"><span>Resolution<span v-if="audioOnly">Not used for audio</span></span><select v-model="options.resolution" aria-label="Export resolution" :disabled="disabled || picking || audioOnly"><option value="1080p">1080p · Full HD</option><option value="720p">720p · Smaller file</option></select></label>
        <div class="nle-export-destination"><div><span>Save to</span><strong data-testid="export-destination">{{ destination ? destinationLabel(destination) : pickerSupported ? 'Choose a location on this device' : 'Browser download' }}</strong><small>{{ destination?.kind === 'file' ? 'The completed file goes directly to your chosen location.' : destination?.kind !== 'download' && pickerSupported ? 'A system save dialog lets you choose the folder and filename.' : 'Your browser chooses the folder or asks where to save. Lumen cannot verify browser downloads.' }}</small></div><button v-if="pickerSupported" class="clip-button" type="button" :disabled="disabled || picking" aria-label="Choose export save location" @click="chooseLocation"><LoaderCircle v-if="picking" :size="14" class="clip-spin" /><FolderOpen v-else :size="14" />{{ destination ? 'Change' : 'Choose' }}</button></div>
        <dl class="nle-export-details"><div><dt>{{ audioOnly ? 'Audio' : 'Frame size' }}</dt><dd>{{ audioOnly ? choice.description : exportDimensions(format, options) }}</dd></div><div v-if="!audioOnly"><dt>Frame rate</dt><dd>30 fps</dd></div><div><dt>Includes</dt><dd>{{ audioOnly ? 'Mixed timeline audio and fades' : 'Picture, transitions and mixed audio' }}</dd></div></dl>
        <p class="nle-export-safety"><ShieldCheck :size="15" /><span>{{ liveProtected ? 'Live production is protected. Rendering waits until Studio is idle.' : 'Your original and live production stay untouched.' }} Temporary render files are removed after a confirmed save, or expire after 24 hours if not saved.</span></p>
        <p v-if="destinationError || error" class="nle-export-error" role="alert">{{ destinationError || error }}</p>
        <button v-if="destinationError && pickerSupported" class="clip-button" type="button" :disabled="disabled || picking" @click="useBrowserDownloads"><Download :size="14" />Use browser Downloads instead</button>
        <footer><button class="clip-button" type="button" :disabled="disabled || picking" @click="emit('update:open', false)">Keep editing</button><button class="clip-button clip-button-primary" type="submit" :disabled="disabled || picking"><LoaderCircle v-if="disabled || picking" :size="14" class="clip-spin" /><Download v-else :size="14" />Start export</button></footer>
      </form>
    </DialogContent>
  </Dialog>
</template>
