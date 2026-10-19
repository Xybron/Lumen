<script setup lang="ts">
// A readable content proof, not a miniature scene or a source of display styles.
defineProps<{text:string;reference?:string;attribution?:string}>();
</script>

<template>
  <div class="channel-cue-proof">
    <p class="channel-cue-proof-text">{{text}}</p>
    <p v-if="reference" class="channel-cue-proof-reference">{{reference}}</p>
    <p v-if="attribution" class="channel-cue-proof-attribution">{{attribution}}</p>
  </div>
</template>

<style scoped>
.channel-cue-proof{display:flex;flex-direction:column;gap:12px;padding:14px;color:var(--text-primary,#f1f2f3)}
.channel-cue-proof-text{font-size:13px;line-height:1.7;white-space:pre-wrap;overflow-wrap:anywhere}
.channel-cue-proof-reference{font-size:10px;line-height:1.5;font-weight:550;color:var(--text-muted,#9fa2a9);overflow-wrap:anywhere}
.channel-cue-proof-attribution{font-size:9px;line-height:1.5;color:var(--text-muted,#9fa2a9);opacity:.8;white-space:pre-wrap;overflow-wrap:anywhere}
</style>
