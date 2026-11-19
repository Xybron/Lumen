import { defineStore } from 'pinia';
import { ref } from 'vue';

// UI state only: opening Outputs never changes routing or starts a destination.
export const useOutputsStore = defineStore('outputs', () => {
  const open = ref(false), outputId = ref<string | null>(null), revision = ref(0);
  function show(id?: string) { outputId.value = id ?? null; open.value = true; }
  function close() { open.value = false; outputId.value = null; revision.value++; }
  function changed() { revision.value++; }
  return { open, outputId, revision, show, close, changed };
});
