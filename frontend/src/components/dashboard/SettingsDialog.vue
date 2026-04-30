<script setup lang="ts">
import { reactive, watch } from 'vue';
import {
  Dialog,
  DialogContent,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { Button } from '@/components/ui/button';
import { useContentStore } from '@/stores/content';
import type { Settings } from '@/types';

const props = defineProps<{ open: boolean }>();
const emit = defineEmits<{ (e: 'update:open', v: boolean): void }>();

const content = useContentStore();

// Edit a draft so the operator can cancel without persisting partial values.
const draft = reactive<Settings>({ ...content.content.settings });

watch(
  () => [props.open, content.content.settings] as const,
  ([open, s]) => {
    if (open) Object.assign(draft, s);
  },
  { deep: true, immediate: true },
);

const FONT_FAMILIES = ['Inter', 'system-ui', 'Georgia', 'JetBrains Mono'];

function asSeconds(ms: number) {
  return Math.round(ms / 100) / 10;
}

function fromSeconds(value: string) {
  const n = Number(value);
  if (!Number.isFinite(n) || n < 0) return 0;
  return Math.round(n * 1000);
}

async function save() {
  await content.updateSettings({ ...draft });
  emit('update:open', false);
}
</script>

<template>
  <Dialog :open="open" @update:open="emit('update:open', $event)">
    <DialogContent class="sm:max-w-xl">
      <DialogHeader>
        <DialogTitle>Settings</DialogTitle>
      </DialogHeader>

      <div class="grid gap-4">
        <div class="grid grid-cols-2 gap-3">
          <label class="grid gap-1.5">
            <span class="text-xs font-medium text-white/55 uppercase tracking-[0.1em]">
              Default duration (s)
            </span>
            <input
              type="number"
              min="1"
              step="1"
              :value="asSeconds(draft.defaultDurationMs)"
              class="rounded-xl bg-white/[0.04] border border-hair focus:border-accent/60 outline-none px-3 py-2 text-sm text-white tnum"
              @input="draft.defaultDurationMs = fromSeconds(($event.target as HTMLInputElement).value)"
            />
          </label>

          <label class="grid gap-1.5">
            <span class="text-xs font-medium text-white/55 uppercase tracking-[0.1em]">
              Transition (ms)
            </span>
            <input
              type="number"
              min="0"
              step="50"
              v-model.number="draft.transitionMs"
              class="rounded-xl bg-white/[0.04] border border-hair focus:border-accent/60 outline-none px-3 py-2 text-sm text-white tnum"
            />
          </label>

          <label class="grid gap-1.5">
            <span class="text-xs font-medium text-white/55 uppercase tracking-[0.1em]">
              Warning at (s)
            </span>
            <input
              type="number"
              min="0"
              step="1"
              :value="asSeconds(draft.warningAtMs)"
              class="rounded-xl bg-white/[0.04] border border-hair focus:border-accent/60 outline-none px-3 py-2 text-sm text-white tnum"
              @input="draft.warningAtMs = fromSeconds(($event.target as HTMLInputElement).value)"
            />
          </label>

          <label class="grid gap-1.5">
            <span class="text-xs font-medium text-white/55 uppercase tracking-[0.1em]">
              Countdown at (s)
            </span>
            <input
              type="number"
              min="0"
              step="1"
              :value="asSeconds(draft.countdownAtMs)"
              class="rounded-xl bg-white/[0.04] border border-hair focus:border-accent/60 outline-none px-3 py-2 text-sm text-white tnum"
              @input="draft.countdownAtMs = fromSeconds(($event.target as HTMLInputElement).value)"
            />
          </label>
        </div>

        <label class="grid gap-1.5">
          <span class="text-xs font-medium text-white/55 uppercase tracking-[0.1em]">
            Font family
          </span>
          <div class="flex gap-1.5 flex-wrap">
            <button
              v-for="f in FONT_FAMILIES"
              :key="f"
              class="px-3 h-8 rounded-lg text-xs font-medium border transition-colors"
              :class="
                draft.fontFamily === f
                  ? 'bg-accent/15 text-accent border-accent/40'
                  : 'bg-white/[0.04] text-white/65 border-hair hover:bg-white/[0.08]'
              "
              :style="{ fontFamily: f }"
              @click="draft.fontFamily = f"
            >
              {{ f }}
            </button>
          </div>
        </label>

        <label class="grid gap-2">
          <div class="flex items-center justify-between">
            <span class="text-xs font-medium text-white/55 uppercase tracking-[0.1em]">
              Font scale
            </span>
            <span class="text-xs text-white/55 tnum">
              {{ draft.globalFontScale.toFixed(2) }}×
            </span>
          </div>
          <input
            type="range"
            min="0.6"
            max="1.6"
            step="0.05"
            v-model.number="draft.globalFontScale"
            class="w-full accent-[var(--accent)]"
          />
        </label>
      </div>

      <DialogFooter>
        <Button variant="ghost" @click="emit('update:open', false)">Cancel</Button>
        <Button variant="accent" @click="save">Save</Button>
      </DialogFooter>
    </DialogContent>
  </Dialog>
</template>
