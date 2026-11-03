<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, ref } from 'vue';
import { CircleAlert, Radio } from 'lucide-vue-next';
import { useBroadcastStore } from '@/stores/broadcast';
import '@/styles/broadcast.css';
const broadcast = useBroadcastStore(), now = ref(Date.now());
let timer: ReturnType<typeof setInterval> | undefined, detach: (() => void) | undefined;
onMounted(() => { detach = broadcast.attach(); timer = setInterval(() => { now.value = Date.now(); }, 1000); });
onBeforeUnmount(() => { detach?.(); clearInterval(timer); });
const elapsed = computed(() => { const started = broadcast.snapshot?.session?.startedAt; if (!started) return ''; const seconds = Math.max(0, Math.floor((now.value - Date.parse(started)) / 1000)); return `${String(Math.floor(seconds / 3600)).padStart(2, '0')}:${String(Math.floor(seconds / 60) % 60).padStart(2, '0')}:${String(seconds % 60).padStart(2, '0')}`; });
const warning = computed(() => broadcast.notice && broadcast.notice.tone !== 'info' ? broadcast.notice : null);
const label = computed(() => {
  if (broadcast.busy === 'start') return 'Connecting';
  if (broadcast.notice && (warning.value || broadcast.active)) return broadcast.notice.label;
  const state = broadcast.snapshot?.session?.state;
  return state === 'starting' ? 'Connecting' : state === 'stopping' ? 'Ending' : broadcast.active ? 'Live controls' : 'Go Live';
});
</script>

<template><button v-if="broadcast.canOperate" type="button" class="broadcast-trigger" :class="{ 'is-active': broadcast.active, 'has-warning': !!warning }" aria-label="Open Go Live controls" :title="warning?.message" :aria-expanded="broadcast.open" aria-haspopup="dialog" @click="broadcast.open = true"><CircleAlert v-if="warning" :size="15" /><Radio v-else :size="15" :stroke-width="1.7" /><span>{{ label }}</span><time v-if="broadcast.active && elapsed">{{ elapsed }}</time></button></template>
