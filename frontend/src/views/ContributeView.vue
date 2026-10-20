<script setup lang="ts">
import { computed, ref } from 'vue';
import { UploadCloud, ImageIcon, Music, CheckCircle2, Loader2 } from 'lucide-vue-next';
import { mediaApi } from '@/lib/api';

// Public mobile-first page for teammates to send media to the station. No login;
// uploads land in a quarantine and an operator approves them.
const name = ref('');
const kind = ref<'backgrounds' | 'music'>('backgrounds');
const file = ref<File | null>(null);
const busy = ref(false);
const done = ref(false);
const error = ref('');

const accept = computed(() => (kind.value === 'music' ? 'audio/*' : 'image/*,video/*'));

function onPick(e: Event) {
  file.value = (e.target as HTMLInputElement).files?.[0] ?? null;
  error.value = '';
}

async function submit() {
  if (!file.value || busy.value) return;
  busy.value = true;
  error.value = '';
  try {
    await mediaApi.contribute(file.value, kind.value, name.value.trim());
    done.value = true;
  } catch (e) {
    error.value = (e as Error).message.includes('415') ? 'That file type isn’t supported for this kind.' : 'Upload failed — try again.';
  } finally {
    busy.value = false;
  }
}

function reset() {
  done.value = false;
  file.value = null;
}
</script>

<template>
  <div class="min-h-screen w-screen bg-base text-textprimary flex items-center justify-center p-4">
    <div class="panel w-full max-w-sm p-6 flex flex-col gap-5">
      <div class="flex items-center gap-3">
        <div class="h-10 w-10 rounded-2xl bg-accent/15 text-accent flex items-center justify-center">
          <UploadCloud :size="18" />
        </div>
        <div>
          <div class="text-lg font-semibold tracking-display">Send media to Lumen</div>
          <div class="text-xs text-white/45">Goes to the operator for approval</div>
        </div>
      </div>

      <template v-if="!done">
        <label class="flex flex-col gap-1.5">
          <span class="text-xs font-medium text-white/55">Your name (optional)</span>
          <input
            v-model="name"
            class="h-10 rounded-xl bg-white/[0.05] border border-hair px-3 text-sm text-white outline-none focus:border-accent/60"
          />
        </label>

        <div class="flex flex-col gap-1.5">
          <span class="text-xs font-medium text-white/55">Type</span>
          <div class="grid grid-cols-2 gap-2">
            <button
              class="h-10 rounded-xl border flex items-center justify-center gap-2 text-sm transition-colors"
              :class="kind === 'backgrounds' ? 'bg-accent/15 text-accent border-accent/40' : 'bg-white/[0.04] text-white/65 border-hair'"
              @click="kind = 'backgrounds'; file = null"
            >
              <ImageIcon :size="14" /> Image / Video
            </button>
            <button
              class="h-10 rounded-xl border flex items-center justify-center gap-2 text-sm transition-colors"
              :class="kind === 'music' ? 'bg-accent/15 text-accent border-accent/40' : 'bg-white/[0.04] text-white/65 border-hair'"
              @click="kind = 'music'; file = null"
            >
              <Music :size="14" /> Music
            </button>
          </div>
        </div>

        <label class="block rounded-2xl border-2 border-dashed border-white/15 p-6 text-center cursor-pointer hover:border-accent/40 transition-colors">
          <input type="file" class="hidden" :accept="accept" @change="onPick" />
          <UploadCloud :size="22" class="mx-auto text-white/50 mb-2" />
          <div class="text-sm text-white/80 truncate">{{ file ? file.name : 'Tap to choose a file' }}</div>
        </label>

        <p v-if="error" class="text-xs text-red-400">{{ error }}</p>

        <button
          :disabled="!file || busy"
          class="h-11 rounded-xl bg-accent text-black font-medium text-sm hover:bg-accent/90 transition-colors disabled:opacity-40 flex items-center justify-center gap-2"
          @click="submit"
        >
          <Loader2 v-if="busy" :size="15" class="animate-spin" />
          {{ busy ? 'Sending…' : 'Send to operator' }}
        </button>
      </template>

      <template v-else>
        <div class="flex flex-col items-center text-center gap-3 py-4">
          <CheckCircle2 :size="40" class="text-accent" />
          <div class="text-base font-medium text-white">Sent for approval</div>
          <p class="text-sm text-white/55">The operator will see it on their station.</p>
          <button class="mt-2 text-sm text-accent hover:text-white transition-colors" @click="reset">Send another</button>
        </div>
      </template>
    </div>
  </div>
</template>
