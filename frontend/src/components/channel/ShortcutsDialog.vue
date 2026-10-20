<script setup lang="ts">
import { FileText } from 'lucide-vue-next';
import { Dialog, DialogContent, DialogHeader, DialogTitle } from '@/components/ui/dialog';

defineProps<{ open: boolean }>();
defineEmits<{ (e: 'update:open', v: boolean): void }>();
</script>

<template>
  <Dialog :open="open" @update:open="$emit('update:open', $event)">
    <DialogContent class="sm:max-w-lg">
      <DialogHeader>
        <DialogTitle>Keyboard shortcuts</DialogTitle>
      </DialogHeader>
      <div class="grid grid-cols-1 sm:grid-cols-2 gap-x-8 gap-y-2.5 text-xs">
        <div class="flex justify-between"><span class="text-white/65">Play / pause</span><kbd class="kbd">Space</kbd></div>
        <div class="flex justify-between"><span class="text-white/65">Next slide</span><kbd class="kbd">→</kbd></div>
        <div class="flex justify-between"><span class="text-white/65">Previous slide</span><kbd class="kbd">←</kbd></div>
        <div class="flex justify-between"><span class="text-white/65">Show / update Program</span><kbd class="kbd">⌘ / Ctrl ↵</kbd></div>
        <div class="flex justify-between"><span class="text-white/65">Toggle Auto/Manual</span><kbd class="kbd">M</kbd></div>
        <div class="flex justify-between"><span class="text-white/65">Blank screen</span><kbd class="kbd">B</kbd></div>
        <div class="flex justify-between"><span class="text-white/65">Logo / hold</span><kbd class="kbd">L</kbd></div>
        <div class="flex justify-between"><span class="text-white/65">Jump to slide N</span><kbd class="kbd">1–9</kbd></div>
        <div class="flex justify-between"><span class="text-white/65">Fullscreen (Live)</span><kbd class="kbd">F</kbd></div>
        <div class="flex justify-between"><span class="text-white/65">Exit fullscreen</span><kbd class="kbd">Esc</kbd></div>
        <div class="flex justify-between"><span class="text-white/65">Show this overlay</span><kbd class="kbd">?</kbd></div>
      </div>
      <p class="text-xs text-white/45 mt-4 leading-relaxed">
        Open final Program in a second tab with <FileText :size="11" class="inline -translate-y-px" />
        <span class="text-accent">Open Live View</span>, drag it onto your projector display, then press
        <kbd class="kbd">F</kbd> to go fullscreen. Use “Open channel output” in the channel menu for an independent projection.
      </p>
    </DialogContent>
  </Dialog>
</template>

<style scoped>
.kbd {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  height: 22px;
  min-width: 22px;
  padding: 0 6px;
  border-radius: 6px;
  background: rgba(255, 255, 255, 0.06);
  border: 1px solid rgba(255, 255, 255, 0.08);
  font-family: ui-monospace, SFMono-Regular, Menlo, monospace;
  font-size: 11px;
  color: rgba(244, 244, 245, 0.85);
}
</style>
