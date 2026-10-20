<script setup lang="ts">
import { nextTick, ref, watch } from 'vue';

// Inspector values come from revisioned station snapshots. Keep an unfinished
// edit local instead of letting a renderer heartbeat replace what is being typed.
defineOptions({ inheritAttrs: false });
const props = withDefaults(defineProps<{
  value: string | number;
  identity: string;
  pending?: boolean;
  type?: string;
  multiline?: boolean;
  live?: boolean;
  trim?: boolean;
  nonempty?: boolean;
  integer?: boolean;
  min?: number | string;
  max?: number | string;
  maxlength?: number | string;
}>(), { pending: false, type: 'text', multiline: false, live: false, trim: false, nonempty: false, integer: false });
const emit = defineEmits<{ commit: [value: string, identity: string] }>();
const draft = ref(String(props.value));
const dirty = ref(false);
let submitted: string | null = null, sawPending = false, draftIdentity = props.identity;

watch([() => props.identity, () => props.value, () => props.pending], ([identity, value, pending], [oldIdentity]) => {
  const current = String(value);
  if (identity !== oldIdentity) {
    draft.value = current; dirty.value = false; submitted = null; sawPending = false; draftIdentity = identity;
    return;
  }
  if (submitted !== null) {
    if (pending) sawPending = true;
    // Acknowledgement may be optimistic or confirmed. Failed/no-op writes fall
    // back to the station value when their queue drains, not while waiting.
    if (current === submitted || (!pending && sawPending)) submitted = null;
  }
  if (!dirty.value && submitted === null) draft.value = current;
}, { flush: 'sync' });

function input(event: Event) {
  draft.value = (event.target as HTMLInputElement).value;
  draftIdentity = props.identity;
  dirty.value = true;
  if (props.live) commit();
}
function normalise(value: string) {
  if (props.type === 'number') {
    let number = value.trim() ? Number(value) : NaN;
    if (!Number.isFinite(number)) return String(props.value);
    if (props.min !== undefined) number = Math.max(Number(props.min), number);
    if (props.max !== undefined) number = Math.min(Number(props.max), number);
    return String(props.integer ? Math.round(number) : number);
  }
  let next = props.trim ? value.trim() : value;
  if (props.maxlength !== undefined) next = next.slice(0, Number(props.maxlength));
  return props.nonempty && !next.trim() ? String(props.value) : next;
}
function commit() {
  if (!dirty.value) return;
  const value = normalise(draft.value), identity = draftIdentity;
  draft.value = value; dirty.value = false;
  if (value === submitted) return;
  // While saving, the visible props can still be an earlier queued value. A
  // quick A → B → A gesture must enqueue the final A instead of leaving B saved.
  if (value === String(props.value) && !props.pending) { submitted = null; return; }
  submitted = value; sawPending = props.pending;
  emit('commit', value, identity);
  void nextTick(() => {
    if (props.identity === identity && submitted === value && !dirty.value && !props.pending) {
      submitted = null; draft.value = String(props.value);
    }
  });
}
function keydown(event: KeyboardEvent) {
  if (event.isComposing) return;
  if (event.key === 'Escape') {
    event.preventDefault(); event.stopPropagation();
    draft.value = submitted ?? String(props.value); dirty.value = false;
  } else if (event.key === 'Enter' && !props.multiline) {
    event.preventDefault(); event.stopPropagation(); commit();
  }
}
</script>

<template>
  <textarea v-if="multiline" v-bind="$attrs" :value="draft" :maxlength="maxlength" @input="input" @change="commit" @blur="commit" @keydown="keydown" />
  <input v-else v-bind="$attrs" :type="type" :value="draft" :min="min" :max="max" :maxlength="maxlength" @input="input" @change="commit" @blur="commit" @keydown="keydown" />
</template>
