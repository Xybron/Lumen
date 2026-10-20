import { defineStore } from 'pinia';
import { computed } from 'vue';
import { broadcast } from '@/lib/broadcast';
import { shortId } from '@/lib/ids';
import { useContentStore } from './content';
import { useEnginesStore } from './engines';
import type { Source } from '@/types';

// The Program/Preview switcher bus. Persists program/preview selection through the
// content store (optimistic save) AND emits a low-latency `program` frame so
// destination outputs cut immediately without waiting for the content reload.
export const useRoutingStore = defineStore('routing', () => {
  const content = useContentStore();
  const engines = useEnginesStore();

  const sources = computed<Source[]>(() => content.content.sources);
  const destinations = computed(() => content.content.destinations);
  const program = computed(() => content.content.program);

  // View-model for the switcher grid: resolve channel sources to their channel.
  const sourceVMs = computed(() =>
    sources.value.map((s) => {
      const channel = s.kind === 'channel' ? content.channels.find((c) => c.id === s.ref) ?? null : null;
      return {
        id: s.id,
        kind: s.kind,
        ref: s.ref,
        label: s.label ?? channel?.name ?? s.kind,
        channelId: channel?.id ?? null,
        isProgram: s.id === program.value.programSourceId,
        isPreview: s.id === program.value.previewSourceId,
      };
    }),
  );

  function emit() {
    broadcast({
      t: 'program',
      programSourceId: content.content.program.programSourceId,
      previewSourceId: content.content.program.previewSourceId,
    });
  }

  async function setPreview(sourceId: string | null) {
    await content.save((d) => {
      d.program.previewSourceId = sourceId;
    });
    emit();
  }

  async function setProgram(sourceId: string | null) {
    await content.save((d) => {
      d.program.programSourceId = sourceId;
    });
    emit();
  }

  // TAKE: the Preview source cuts to Program (standard switcher cut).
  async function take() {
    const pv = content.content.program.previewSourceId;
    if (!pv) return;
    await content.save((d) => {
      d.program.programSourceId = pv;
    });
    emit();
  }

  // The current item of a channel source (for thumbnails) — engines run for all
  // channels, so this is free on the operator station.
  function currentItemFor(channelId: string) {
    return engines.engineFor(channelId)?.current.value;
  }

  // Pin a live (announced) WebRTC source into content.sources so it can be routed
  // by id. Idempotent — returns the existing source id if already pinned.
  async function ensureWebrtcSource(publisherId: string, label: string): Promise<string> {
    const existing = content.content.sources.find((s) => s.kind === 'webrtc' && s.ref === publisherId);
    if (existing) return existing.id;
    const id = shortId('src');
    await content.save((d) => {
      d.sources.push({ id, kind: 'webrtc', ref: publisherId, label });
    });
    return id;
  }

  return {
    sources,
    destinations,
    program,
    sourceVMs,
    setPreview,
    setProgram,
    take,
    currentItemFor,
    ensureWebrtcSource,
  };
});
