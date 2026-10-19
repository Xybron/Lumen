<script setup lang="ts">
import { computed, ref, watch } from 'vue';
import { Radio, Plus, Play, Square, Loader2, KeyRound } from 'lucide-vue-next';
import { toast } from 'vue-sonner';
import { Dialog, DialogContent, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { Button } from '@/components/ui/button';
import { useContentStore } from '@/stores/content';
import { useStreamStore } from '@/stores/stream';
import { mediaApi } from '@/lib/api';
import { shortId } from '@/lib/ids';

const props = defineProps<{ open: boolean }>();
const emit = defineEmits<{ (e: 'update:open', v: boolean): void }>();

const content = useContentStore();
const stream = useStreamStore();

const engineEnabled = ref(false);
const targets = ref<Record<string, { hasKey: boolean }>>({});

const streamDests = computed(() => content.content.destinations.filter((d) => d.kind === 'stream'));

async function refresh() {
  try {
    const s = await mediaApi.streamStatus();
    engineEnabled.value = s.enabled;
    const t = await mediaApi.streamTargets();
    targets.value = Object.fromEntries(t.targets.map((x) => [x.destinationId, { hasKey: x.hasKey }]));
  } catch {
    engineEnabled.value = false;
  }
}
watch(() => props.open, (open) => { if (open) void refresh(); });

async function addDest(platform: 'youtube' | 'facebook' | 'custom') {
  const label = platform === 'youtube' ? 'YouTube' : platform === 'facebook' ? 'Facebook' : 'Custom RTMP';
  await content.save((d) => {
    d.destinations.push({ id: shortId('dst'), kind: 'stream', label, platform, enabled: true });
  });
}

// per-destination RTMP credential draft
const creds = ref<Record<string, { rtmpUrl: string; streamKey: string }>>({});
function credFor(id: string) {
  if (!creds.value[id]) creds.value[id] = { rtmpUrl: '', streamKey: '' };
  return creds.value[id];
}
async function saveTarget(destId: string, platform: string) {
  const c = credFor(destId);
  if (!c.rtmpUrl || !c.streamKey) return toast.error('RTMP URL and stream key required');
  try {
    await mediaApi.setStreamTarget(destId, { platform, rtmpUrl: c.rtmpUrl, streamKey: c.streamKey });
    c.streamKey = '';
    await refresh();
    toast.success('Stream key saved');
  } catch (e) {
    toast.error(`Save failed: ${(e as Error).message}`);
  }
}

const busy = ref<string | null>(null);
async function toggle(destId: string) {
  busy.value = destId;
  try {
    if (stream.stateFor(destId) === 'idle') await mediaApi.startStream(destId);
    else await mediaApi.stopStream(destId);
  } catch (e) {
    toast.error(/503/.test((e as Error).message) ? 'Media engine offline (set LUMEN_MEDIA_CTRL)' : (e as Error).message);
  } finally {
    busy.value = null;
  }
}

function stateColor(s: string) {
  return s === 'live' ? 'text-red-400' : s === 'connecting' ? 'text-amber-300' : 'text-white/40';
}
</script>

<template>
  <Dialog :open="open" @update:open="emit('update:open', $event)">
    <DialogContent class="sm:max-w-lg">
      <DialogHeader>
        <DialogTitle class="flex items-center gap-2">
          <Radio :size="16" class="text-accent" /> Live stream
          <span v-if="!engineEnabled" class="text-[10px] uppercase tracking-wide text-amber-300/80">engine offline</span>
        </DialogTitle>
      </DialogHeader>

      <p v-if="!engineEnabled" class="text-xs text-white/45 -mt-1">
        The media engine is off. Start the sidecar and set <span class="text-accent">LUMEN_MEDIA_CTRL</span> to go live.
        You can still configure destinations + keys now.
      </p>

      <div class="flex flex-col gap-3 max-h-[60vh] overflow-y-auto -mx-1 px-1">
        <div v-for="d in streamDests" :key="d.id" class="panel-soft p-3 flex flex-col gap-2.5">
          <div class="flex items-center gap-2">
            <span class="h-2 w-2 rounded-full" :class="stream.stateFor(d.id) === 'live' ? 'bg-red-400 animate-pulse' : stream.stateFor(d.id) === 'connecting' ? 'bg-amber-400 animate-pulse' : 'bg-white/25'" />
            <div class="flex-1 min-w-0">
              <div class="text-sm font-medium text-white">{{ d.label }}</div>
              <div class="text-[11px] tnum" :class="stateColor(stream.stateFor(d.id))">
                {{ stream.stateFor(d.id).toUpperCase() }}
                <span v-if="stream.stateFor(d.id) === 'live'">· {{ Math.floor(stream.uptimeFor(d.id) / 60) }}m {{ stream.uptimeFor(d.id) % 60 }}s</span>
              </div>
            </div>
            <Button
              :variant="stream.stateFor(d.id) === 'idle' ? 'accent' : 'default'"
              size="md"
              :disabled="busy === d.id || !engineEnabled || !targets[d.id]?.hasKey"
              @click="toggle(d.id)"
            >
              <Loader2 v-if="busy === d.id" :size="13" class="animate-spin" />
              <Play v-else-if="stream.stateFor(d.id) === 'idle'" :size="13" />
              <Square v-else :size="13" />
              {{ stream.stateFor(d.id) === 'idle' ? 'Go live' : 'Stop' }}
            </Button>
          </div>

          <!-- RTMP credentials -->
          <div class="flex items-center gap-1.5">
            <KeyRound :size="12" class="text-white/35 shrink-0" />
            <input
              v-model="credFor(d.id).rtmpUrl"
              :placeholder="targets[d.id]?.hasKey ? 'rtmp URL (saved — re-enter to change)' : 'rtmp://… server URL'"
              class="flex-1 h-8 rounded-lg bg-white/[0.05] border border-hair px-2 text-xs text-white outline-none focus:border-accent/60"
            />
            <input
              v-model="credFor(d.id).streamKey"
              type="password"
              placeholder="stream key"
              class="flex-1 h-8 rounded-lg bg-white/[0.05] border border-hair px-2 text-xs text-white outline-none focus:border-accent/60"
            />
            <Button variant="ghost" size="md" @click="saveTarget(d.id, d.platform ?? 'custom')">Save</Button>
          </div>
        </div>

        <div v-if="streamDests.length === 0" class="text-sm text-white/40 py-4 text-center">No stream destinations yet.</div>

        <div class="flex items-center gap-2">
          <span class="text-[11px] uppercase tracking-[0.12em] text-white/35">Add</span>
          <Button variant="ghost" size="md" @click="addDest('youtube')"><Plus :size="12" /> YouTube</Button>
          <Button variant="ghost" size="md" @click="addDest('facebook')"><Plus :size="12" /> Facebook</Button>
          <Button variant="ghost" size="md" @click="addDest('custom')"><Plus :size="12" /> Custom</Button>
        </div>
      </div>
    </DialogContent>
  </Dialog>
</template>
