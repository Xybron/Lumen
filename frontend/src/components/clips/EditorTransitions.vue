<script setup lang="ts">
import { computed } from 'vue';
import { ArrowRightLeft, Play, RotateCcw } from 'lucide-vue-next';
import { findItem } from '@/lib/clip-timeline';
import { TRANSITION_PRESETS, transitionAtCut, transitionBulkSummary } from '@/lib/clip-transitions';
import type { ClipTimeline, ClipTimelineItem } from '../../../../shared/clips';

const props = defineProps<{ timeline: ClipTimeline; selectedId: string | null; disabled: boolean; previewing: boolean }>();
const emit = defineEmits<{ apply: [transition: NonNullable<ClipTimelineItem['transitionIn']> | null]; applyAll: [transition: NonNullable<ClipTimelineItem['transitionIn']>]; preview: []; select: [id: string] }>();
const selected = computed(() => findItem(props.timeline, props.selectedId));
const cut = computed(() => selected.value ? transitionAtCut(selected.value.track, selected.value.item.id) : null);
const choices = computed(() => props.timeline.tracks.flatMap(track => track.kind === 'video' ? [...track.items].sort((a, b) => a.startMs - b.startMs).slice(1).filter(item => transitionAtCut(track, item.id).eligible || item.transitionIn).map(item => ({ id: item.id, name: `${track.name} · ${item.name}`, locked: track.locked })) : []));
const current = computed(() => selected.value?.item.transitionIn);
const maxMs = computed(() => cut.value?.maxDurationMs ?? 2000);
const enabled = computed(() => !props.disabled && !!cut.value?.eligible && !selected.value?.track.locked);
const bulk = computed(() => current.value ? transitionBulkSummary(props.timeline, current.value) : null);
const bulkEnabled = computed(() => enabled.value && !!bulk.value?.changed && !bulk.value.reason);
function apply(kind: NonNullable<ClipTimelineItem['transitionIn']>['kind']) { if (enabled.value) emit('apply', { kind, durationMs: Math.min(current.value?.durationMs ?? 500, maxMs.value) }); }
function duration(event: Event) { const value = Number((event.target as HTMLInputElement).value); if (enabled.value && current.value && Number.isFinite(value)) emit('apply', { ...current.value, durationMs: Math.round(value * 1000) }); }
function applyAll() { if (bulkEnabled.value && current.value) emit('applyAll', { ...current.value }); }
</script>

<template>
  <section class="nle-transition-panel" aria-label="Transition settings">
    <div class="nle-transition-intro"><ArrowRightLeft :size="17" :stroke-width="1.5" /><h3>A smoother cut.</h3><p>Connect neighbouring clips with a subtle dissolve, wipe or slide.</p></div>
    <label v-if="choices.length" class="clip-field"><span>Cut between clips</span><select :value="selectedId ?? ''" aria-label="Transition cut" :disabled="disabled" @change="emit('select', ($event.target as HTMLSelectElement).value)"><option value="" disabled>Select a cut</option><option v-for="choice in choices" :key="choice.id" :value="choice.id" :disabled="choice.locked">{{ choice.name }}</option></select></label>
    <p v-if="!cut?.eligible" class="nle-transition-hint">{{ cut?.reason || 'Select the second of two adjoining video clips, or split a clip to create a cut.' }}</p>
    <p v-else class="nle-transition-pair"><span>{{ cut.previous?.name }}</span><ArrowRightLeft :size="11" /><span>{{ selected?.item.name }}</span></p>
    <div class="nle-transition-presets"><button v-for="preset in TRANSITION_PRESETS" :key="preset.kind" :disabled="!enabled" :class="{ active: current?.kind === preset.kind }" :aria-label="`Apply ${preset.label} transition`" :aria-pressed="current?.kind === preset.kind" :title="preset.description" @click="apply(preset.kind)"><span class="nle-transition-demo" :data-effect="preset.kind"><i /><b /></span><span>{{ preset.label }}</span></button></div>
    <div v-if="current" class="nle-transition-adjustments"><label class="clip-field"><span>Duration<output>{{ (current.durationMs / 1000).toFixed(2) }}s</output></span><input :value="current.durationMs / 1000" type="number" min="0.1" :max="maxMs / 1000" step="0.05" aria-label="Transition duration" :disabled="!enabled" @change="duration" /></label><div class="nle-transition-quick"><button v-for="ms in [250, 500, 1000]" :key="ms" :disabled="!enabled || ms > maxMs" @click="emit('apply', { ...current, durationMs: ms })">{{ ms / 1000 }}s</button></div><button class="clip-button nle-transition-preview" :aria-pressed="previewing" :disabled="!enabled" @click="emit('preview')"><Play :size="12" />{{ previewing ? 'Replay transition' : 'Preview transition' }}</button><button class="clip-link nle-transition-remove" :disabled="!enabled" @click="emit('apply', null)"><RotateCcw :size="11" />Remove transition</button>
      <div class="nle-transition-bulk"><button class="clip-button nle-transition-preview" :disabled="!bulkEnabled" :title="bulk?.reason" aria-describedby="transition-bulk-description transition-bulk-count" @click="applyAll"><ArrowRightLeft :size="12" />Apply to all cuts</button><p id="transition-bulk-count" class="clips-subtle" aria-live="polite">{{ bulk?.changed ?? 0 }} {{ bulk?.changed === 1 ? 'cut' : 'cuts' }} to update · {{ bulk?.skipped ?? 0 }} skipped</p><p id="transition-bulk-description" class="clips-subtle">All unlocked video tracks · same preset and exact duration. Short clips, gaps and unrelated overlaps are skipped.</p><p v-if="bulk?.reason" class="clips-subtle" role="status">{{ bulk.reason }}</p></div>
    </div>
    <p class="nle-transition-footnote">Transitions overlap the clips and shorten their video track. Audio and text tracks stay in place. Remove transition changes only the selected cut. Use audio fades to smooth a soundtrack separately.</p>
  </section>
</template>

<style scoped>
.nle-transition-bulk { padding-top: 13px; border-top: 1px solid #ffffff0d; }
.nle-transition-bulk p { margin: 8px 0; font-size: 10px; line-height: 1.6; }
</style>
