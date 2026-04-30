<script setup lang="ts">
import { onBeforeUnmount, watch } from 'vue';

const props = defineProps<{ open: boolean; title?: string }>();
const emit = defineEmits<{ (e: 'update:open', v: boolean): void }>();

function close() {
  emit('update:open', false);
}

function onKey(e: KeyboardEvent) {
  if (e.key === 'Escape' && props.open) close();
}

watch(
  () => props.open,
  (open) => {
    if (open) {
      document.addEventListener('keydown', onKey);
      document.body.style.overflow = 'hidden';
    } else {
      document.removeEventListener('keydown', onKey);
      document.body.style.overflow = '';
    }
  },
  { immediate: true },
);

onBeforeUnmount(() => {
  document.removeEventListener('keydown', onKey);
  document.body.style.overflow = '';
});
</script>

<template>
  <Teleport to="body">
    <Transition
      enter-active-class="transition-opacity duration-200 ease-out-cubic"
      enter-from-class="opacity-0"
      enter-to-class="opacity-100"
      leave-active-class="transition-opacity duration-200 ease-out-cubic"
      leave-from-class="opacity-100"
      leave-to-class="opacity-0"
    >
      <div
        v-if="open"
        class="fixed inset-0 z-[60] bg-black/55 backdrop-blur-sm"
        @click="close"
      />
    </Transition>

    <Transition
      enter-active-class="transition-transform duration-250 ease-out-quart"
      enter-from-class="translate-y-full"
      enter-to-class="translate-y-0"
      leave-active-class="transition-transform duration-200 ease-out-cubic"
      leave-from-class="translate-y-0"
      leave-to-class="translate-y-full"
    >
      <div
        v-if="open"
        role="dialog"
        aria-modal="true"
        class="fixed bottom-0 left-0 right-0 z-[61] panel rounded-b-none p-4 pb-[max(1rem,env(safe-area-inset-bottom))] max-h-[85dvh] overflow-y-auto overscroll-contain"
        @click.stop
      >
        <div class="mx-auto h-1 w-10 rounded-full bg-white/20 mb-4" aria-hidden="true" />
        <h3
          v-if="title"
          class="text-base font-semibold tracking-display text-textprimary mb-3"
        >
          {{ title }}
        </h3>
        <slot />
      </div>
    </Transition>
  </Teleport>
</template>
