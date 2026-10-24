<script setup lang="ts">
import type { MobileScene } from '../../../../shared/mobile-controller';
defineProps<{ scene: MobileScene | null; empty?: string }>();
</script>
<template>
  <div class="mobile-scene-poster" :style="{ background: scene?.background || '#111619' }" aria-hidden="true">
    <template v-if="scene"><div v-for="layer in scene.layers" :key="layer.id" class="mobile-scene-layer" :style="{ left: `${layer.x}%`, top: `${layer.y}%`, width: `${layer.width}%`, height: `${layer.height}%`, color: layer.color, background: layer.background, opacity: layer.opacity, fontSize: `${layer.fontSize / 19.2}cqw`, textAlign: layer.align }">{{ layer.text }}</div></template>
    <span v-else class="mobile-scene-empty">{{ empty || 'Nothing selected' }}</span>
  </div>
</template>
