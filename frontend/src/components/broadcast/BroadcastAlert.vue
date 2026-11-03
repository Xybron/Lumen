<script setup lang="ts">
import { ref, shallowRef } from 'vue';
import { useEventListener } from '@vueuse/core';
import { CircleAlert, Radio, X } from 'lucide-vue-next';
import { useBroadcastStore } from '@/stores/broadcast';

const broadcast = useBroadcastStore();
// A fullscreen element sits above the rest of the document, including app notifications.
function noticeTarget() {
  const full = document.fullscreenElement;
  return full && full !== document.documentElement ? full : document.body;
}
const target = shallowRef(noticeTarget());
const exitHint = ref('');
useEventListener(document, 'fullscreenchange', () => { target.value = noticeTarget(); exitHint.value = ''; });
async function controls() {
  if (noticeTarget() !== document.body) {
    try { await document.exitFullscreen(); }
    catch { if (noticeTarget() !== document.body) { exitHint.value = 'Exit fullscreen to open stream controls.'; return; } }
  }
  broadcast.open = true;
}
</script>

<template>
  <Teleport :to="target">
    <aside v-if="broadcast.visibleNotice && !broadcast.open" class="stream-alert" :data-tone="broadcast.visibleNotice.tone"
      :role="broadcast.visibleNotice.tone === 'info' ? 'status' : 'alert'" aria-atomic="true">
      <Radio v-if="broadcast.visibleNotice.tone === 'info'" :size="18" /><CircleAlert v-else :size="18" />
      <div><strong>{{ broadcast.visibleNotice.label }}</strong><p>{{ broadcast.visibleNotice.message }}</p><p v-if="exitHint">{{ exitHint }}</p></div>
      <button type="button" class="stream-alert-controls" @click="controls">Stream controls</button>
      <button type="button" class="broadcast-icon" aria-label="Dismiss stream notice" @click="broadcast.dismissNotice"><X :size="15" /></button>
    </aside>
  </Teleport>
</template>
