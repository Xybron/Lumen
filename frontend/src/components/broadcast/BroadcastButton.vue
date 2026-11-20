<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, ref } from 'vue';
import { CircleAlert, Radio } from 'lucide-vue-next';
import { useBroadcastStore } from '@/stores/broadcast';
import { broadcastControlState } from '@/lib/broadcast-notice';
import '@/styles/broadcast.css';
const props = defineProps<{ compact?: boolean }>();
const broadcast = useBroadcastStore(), now = ref(Date.now());
let timer: ReturnType<typeof setInterval> | undefined, detach: (() => void) | undefined;
onMounted(() => { detach = broadcast.attach(); if (!props.compact) timer = setInterval(() => { now.value = Date.now(); }, 1000); });
onBeforeUnmount(() => { detach?.(); clearInterval(timer); });
const elapsed = computed(() => { const started = broadcast.snapshot?.session?.startedAt; if (!started) return ''; const seconds = Math.max(0, Math.floor((now.value - Date.parse(started)) / 1000)); return `${String(Math.floor(seconds / 3600)).padStart(2, '0')}:${String(Math.floor(seconds / 60) % 60).padStart(2, '0')}:${String(seconds % 60).padStart(2, '0')}`; });
const warning = computed(() => broadcast.notice && broadcast.notice.tone !== 'info' ? broadcast.notice : null);
const control = computed(() => broadcastControlState(broadcast.snapshot?.session ?? null, broadcast.busy, broadcast.notice));
</script>

<template><button v-if="broadcast.canOperate" type="button" class="broadcast-trigger" :class="{ 'is-active': control.onAir, 'has-warning': !!warning, 'is-compact': compact }" :data-tone="control.tone" aria-label="Open Go Live controls" :title="warning?.message" :aria-expanded="broadcast.open" aria-haspopup="dialog" @click="broadcast.open = true"><CircleAlert v-if="warning" :size="15" /><span v-else-if="control.onAir" class="broadcast-live-dot" aria-hidden="true" /><Radio v-else :size="15" :stroke-width="1.7" /><span aria-live="polite">{{ control.label }}</span><time v-if="!compact && control.onAir && elapsed">{{ elapsed }}</time></button></template>
