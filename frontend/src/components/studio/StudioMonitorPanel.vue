<script setup lang="ts">
import { computed, ref } from 'vue';
import { useEventListener } from '@vueuse/core';
import { Maximize, Minimize } from 'lucide-vue-next';
import { toast } from 'vue-sonner';

const props = defineProps<{ label: 'Preview' | 'Program' }>();
const panel = ref<HTMLElement | null>(null), toggle = ref<HTMLButtonElement | null>(null);
const fullscreen = ref(false), supported = document.fullscreenEnabled;
const action = computed(() => fullscreen.value ? `Exit ${props.label} fullscreen` : `Fullscreen ${props.label}`);
useEventListener(document, 'fullscreenchange', () => {
  const expanded = !!panel.value && document.fullscreenElement === panel.value;
  if (fullscreen.value === expanded) return;
  fullscreen.value = expanded;
  toggle.value?.focus({ preventScroll: true });
});
async function toggleFullscreen() {
  try {
    if (document.fullscreenElement === panel.value) await document.exitFullscreen();
    else await panel.value?.requestFullscreen();
  } catch { toast.error(`Fullscreen is unavailable for ${props.label} in this window.`); }
}
function monitorKeys(event: KeyboardEvent) {
  if (!fullscreen.value) return;
  if (event.key === 'Escape') {
    event.preventDefault(); event.stopPropagation(); void toggleFullscreen();
  } else if (event.key === 'Tab' && panel.value) {
    // The exit button and actions on any stream alert remain reachable.
    const buttons = [...panel.value.querySelectorAll<HTMLButtonElement>('button:not(:disabled)')]
      .filter(button => !button.closest('[inert]') && button.getClientRects().length);
    if (!buttons.length) return;
    const index = buttons.indexOf(document.activeElement as HTMLButtonElement);
    event.preventDefault();
    buttons[(index + (event.shiftKey ? -1 : 1) + buttons.length) % buttons.length].focus();
  }
}
</script>

<template>
  <section ref="panel" class="monitor-panel" :role="fullscreen ? 'dialog' : undefined"
    :aria-modal="fullscreen || undefined" :aria-label="'Studio ' + label" @keydown="monitorKeys">
    <div class="monitor-title"><span><span class="tiny-dot" />{{ label.toUpperCase() }}</span><small><slot name="scene" /></small></div>
    <div class="monitor-picture">
      <slot :fullscreen="fullscreen" />
      <button v-if="supported" ref="toggle" type="button" class="monitor-expand" :aria-pressed="fullscreen"
        :aria-label="action" :title="action" @click="toggleFullscreen">
        <Minimize v-if="fullscreen" :size="16" /><Maximize v-else :size="16" />
      </button>
    </div>
    <div class="monitor-bottom"><slot name="footer" /></div>
  </section>
</template>
