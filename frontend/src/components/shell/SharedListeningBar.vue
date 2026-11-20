<script setup lang="ts">
import { computed, ref, watch } from 'vue';
import { AudioLines, ChevronDown, CircleAlert, LoaderCircle, Square } from 'lucide-vue-next';
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover';
import { useCachedOverlay } from '@/composables/useCachedOverlay';
import { useSharedListeningStore } from '@/stores/shared-listening';
import { useIdentityStore } from '@/stores/identity';
import { useNotesListeningStore } from '@/stores/notes-listening';
import { useWorshipStore } from '@/stores/worship';

const listening = useSharedListeningStore(), identity = useIdentityStore(), notes = useNotesListeningStore(), worship = useWorshipStore();
const open = ref(false);
const active = useCachedOverlay(() => { open.value = false; });
const canStop = computed(() => listening.session?.ownerId === identity.me?.id);
const pendingScripture = computed(() => Object.entries(worship.listening).find(([id, value]) => value.starting && !value.session && worship.listeningControlsFor(id).provider === 'assemblyai')?.[0]);
const pending = computed(() => !listening.session && (notes.starting || !!pendingScripture.value));
const visible = computed(() => !!(listening.session || listening.notice || pending.value));
const warning = computed(() => !!(listening.error || listening.notice));
const transitioning = computed(() => pending.value || ['starting', 'finishing'].includes(listening.session?.state ?? ''));
const label = computed(() => warning.value ? 'Listening needs attention' : pending.value || listening.session?.state === 'starting'
  ? 'Starting listening' : listening.session?.state === 'finishing' ? 'Finishing transcript' : 'Listening on');
watch(visible, value => { if (!value) open.value = false; });
function cancel() {
  if (notes.starting) void notes.stop(false);
  if (pendingScripture.value) void worship.stopListening(pendingScripture.value);
}
</script>

<template>
  <div v-if="active && visible" class="listening-status" :class="{ 'has-warning': warning }">
    <Popover v-model:open="open">
      <PopoverTrigger as-child>
        <button type="button" class="listening-status-trigger" :aria-label="label + ' — session controls'" :title="label">
          <CircleAlert v-if="warning" :size="15" /><LoaderCircle v-else-if="transitioning" :size="15" class="listening-spinner" /><AudioLines v-else :size="15" />
          <span>{{ label }}</span><ChevronDown :size="12" class="listening-chevron" />
        </button>
      </PopoverTrigger>
      <PopoverContent side="bottom" align="start" :side-offset="10" class="listening-session-popover" aria-label="Shared listening session">
        <div class="listening-session-heading"><AudioLines :size="17" /><strong>{{ label }}</strong></div>
        <template v-if="listening.session">
          <dl>
            <div><dt>Provider</dt><dd>AssemblyAI</dd></div>
            <div><dt>{{ listening.session.source === 'lyrics' ? 'Lyrics' : 'Scripture' }}</dt><dd>{{ listening.session.source === 'lyrics' ? 'Song suggestions' : listening.session.mode === 'automatic' ? 'Auto publish' : 'Prepare only' }}</dd></div>
            <div><dt>Notes</dt><dd>{{ listening.session.linkedNotes ? `${listening.session.linkedNotes} linked` : 'None linked' }}</dd></div>
          </dl>
          <p v-if="listening.error" role="status" class="listening-message">{{ listening.error }}</p>
          <button v-if="canStop" type="button" class="listening-stop" :disabled="listening.busy || listening.session.state === 'finishing'" @click="listening.stop()" aria-label="Stop shared listening"><Square :size="13" />Stop listening</button>
          <p v-else class="listening-owner">Started by another operator</p>
        </template>
        <template v-else-if="pending"><p>Connecting your microphone…</p><button type="button" class="listening-stop" @click="cancel" aria-label="Cancel shared listening start">Cancel start</button></template>
        <template v-else><p role="alert" class="listening-message">{{ listening.notice }}</p><button type="button" class="listening-stop" @click="listening.dismissError()">Dismiss</button></template>
      </PopoverContent>
    </Popover>
  </div>
</template>

<style scoped>
.listening-status{flex-shrink:0;min-width:0;color:#9dd7c0}
.listening-status-trigger{display:flex;align-items:center;gap:7px;min-height:32px;padding:5px 9px;border:1px solid #86c6ad35;border-radius:8px;background:#86c6ad0b;font-size:11px;font-weight:500;white-space:nowrap}
.listening-status-trigger:hover,.listening-status-trigger[data-state=open]{background:#86c6ad18;border-color:#86c6ad70}
.listening-status-trigger:focus-visible{outline:2px solid var(--accent);outline-offset:3px}
.listening-chevron{opacity:.6}.has-warning{color:#f5c884}.listening-spinner{animation:listening-spin 1.4s linear infinite}
.listening-session-popover{width:280px;max-width:calc(100vw - 24px);font-size:12px;padding:16px;gap:14px}
.listening-session-heading{display:flex;align-items:center;gap:8px;color:#b8dfcf}.listening-session-heading strong{font-weight:600}
.listening-session-popover dl{display:grid;gap:10px;margin:0}.listening-session-popover dl>div{display:flex;justify-content:space-between;gap:16px}
.listening-session-popover dt,.listening-owner{color:var(--text-muted)}.listening-session-popover dd{margin:0;color:var(--text-primary)}
.listening-message{color:#f5c884;overflow-wrap:anywhere}.listening-stop{display:flex;align-items:center;justify-content:center;gap:8px;min-height:34px;border:1px solid var(--border-hair);border-radius:7px;background:var(--bg-hover);font-weight:500}
.listening-stop:hover{border-color:#86c6ad70}.listening-stop:disabled{opacity:.5;cursor:default}
@keyframes listening-spin{to{transform:rotate(360deg)}}
@media(prefers-reduced-motion:reduce){.listening-spinner{animation:none}}
@media(max-width:600px){.listening-status-trigger span,.listening-chevron{display:none}.listening-status-trigger{width:32px;justify-content:center;padding:0}}
</style>
