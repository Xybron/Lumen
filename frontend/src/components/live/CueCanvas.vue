<script setup lang="ts">
import { ref, watch, onMounted, onBeforeUnmount } from 'vue';
import type { WorshipTheme } from '../../../../shared/worship';

const props = defineProps<{ text: string; reference?: string; attribution?: string; theme: WorshipTheme }>();
const root = ref<HTMLElement>(), body = ref<HTMLElement>(), fontSize = ref(32), unit = ref(1);
let observer: ResizeObserver | undefined;

function fit() {
  const canvas = root.value, text = body.value;
  if (!canvas || !text) return;
  const width = canvas.clientWidth, height = canvas.clientHeight;
  if (!width || !height) return;
  unit.value = width / 1920;
  const maximum = width * ({ sm: .026, md: .031, lg: .038, xl: .046, '2xl': .054 }[props.theme.size]);
  const fits = (size: number) => {
    text.style.fontSize = size + 'px';
    return text.scrollHeight <= height * .65 && text.scrollWidth <= text.clientWidth + 1;
  };

  // Most cues already fit at the chosen size. Only squeeze a long cue, and
  // stop measuring once the remaining difference is under a quarter pixel.
  let size = maximum;
  if (!fits(maximum)) {
    let low = Math.min(1, maximum), high = maximum;
    while (high - low > .25) {
      const mid = (low + high) / 2;
      if (fits(mid)) low = mid;
      else high = mid;
    }
    size = low;
    text.style.fontSize = size + 'px';
  }
  fontSize.value = size;
}
watch([() => props.text, () => props.theme.size], fit, { flush: 'post' });
onMounted(() => {
  // The observer supplies the initial size as well as subsequent resizes.
  observer = new ResizeObserver(fit);
  if (root.value) observer.observe(root.value);
});
onBeforeUnmount(() => observer?.disconnect());
</script>
<template>
  <div ref="root" class="cue-canvas" :style="{background:theme.background,color:theme.color,textAlign:theme.align}">
    <div class="cue-body-wrap"><div ref="body" class="cue-body" :style="{fontSize:fontSize+'px'}">{{ text }}</div></div>
    <div class="cue-reference" :style="{fontSize:Math.max(1,32*unit)+'px'}">{{ reference }}</div>
    <div class="cue-attribution" :style="{fontSize:Math.max(1,18*unit)+'px'}">{{ attribution }}</div>
  </div>
</template>
<style scoped>
.cue-canvas{position:absolute;inset:0;overflow:hidden}.cue-body-wrap{position:absolute;inset:9% 8% 26%;display:flex;align-items:center}.cue-body{width:100%;white-space:pre-wrap;overflow-wrap:anywhere;line-height:1.25;font-weight:500;letter-spacing:-.025em}.cue-reference{position:absolute;left:8%;right:8%;bottom:14%;font-weight:500;opacity:.85}.cue-attribution{position:absolute;left:8%;right:8%;bottom:4%;max-height:8%;overflow:hidden;line-height:1.2;opacity:.6}
</style>
