import { defineStore } from 'pinia';
import { computed, ref, watch } from 'vue';
import { mediaUrl } from '@/lib/api';
import { useContentStore } from './content';
import { useIdentityStore } from './identity';
import { toast } from 'vue-sonner';

// Web Audio fades — a GainNode lets us crossfade between tracks click-free,
// which a raw <audio> element can't do.
export const useMusicStore = defineStore('music', () => {
  const content = useContentStore();
  const identity = useIdentityStore();

  const audio = new Audio();
  audio.crossOrigin = 'anonymous';
  audio.preload = 'auto';

  let ctx: AudioContext | null = null;
  let gain: GainNode | null = null;
  let source: MediaElementAudioSourceNode | null = null;
  let program: MediaStreamAudioDestinationNode | null = null;
  let monitor: GainNode | null = null;
  let pauseHandle: ReturnType<typeof setTimeout> | undefined;
  let generation = 0;
  const autoEnabled = ref(false);
  const monitorEnabled = ref(false);

  const playing = ref(false);
  const starting = ref(false);
  const currentTrack = ref<string | null>(null);
  const queueIndex = ref(0);

  const volume = computed(() => content.content.music.volume);
  const mode = computed(() => content.content.music.mode);
  const queue = computed(() => content.content.music.queue);

  function ensureGraph() {
    if (ctx) return;
    const Ctor = window.AudioContext ?? (window as unknown as { webkitAudioContext: typeof AudioContext }).webkitAudioContext;
    ctx = new Ctor();
    source = ctx.createMediaElementSource(audio);
    gain = ctx.createGain();
    gain.gain.value = volume.value;
    program = ctx.createMediaStreamDestination();
    monitor = ctx.createGain();
    monitor.gain.value = monitorEnabled.value ? 1 : 0;
    source.connect(gain);
    gain.connect(program);
    gain.connect(monitor).connect(ctx.destination);
  }

  function fadeTo(target: number, ms: number) {
    if (!ctx || !gain) return;
    const now = ctx.currentTime;
    gain.gain.cancelScheduledValues(now);
    gain.gain.setValueAtTime(gain.gain.value, now);
    gain.gain.linearRampToValueAtTime(target, now + ms / 1000);
  }

  async function loadTrack(rel: string) {
    const url = mediaUrl(rel);
    if (!url) return;
    audio.src = url;
    audio.loop = autoEnabled.value && mode.value === 'loop';
    currentTrack.value = rel;
    const index = queue.value.indexOf(rel);
    if (index >= 0) queueIndex.value = index;
  }

  async function play() {
    const request = ++generation;
    starting.value = true;
    clearTimeout(pauseHandle);
    try {
      ensureGraph();
      await ctx?.resume();
      if (request !== generation) return;
      if (!currentTrack.value) {
        const first = content.content.music.current ?? queue.value[0];
        if (!first) return;
        await loadTrack(first);
      }
      if (request !== generation) return;
      if (gain) gain.gain.value = 0;
      const { useStudioStore } = await import('./studio');
      await useStudioStore().publishPresentationMusic(getProgramStream());
      if (request !== generation) return;
      await audio.play();
      if (request !== generation) return;
      playing.value = true;
      fadeTo(volume.value, content.content.music.fadeInMs);
    } catch (error) {
      if (request !== generation) return;
      audio.pause();
      playing.value = false;
      toast.error(error instanceof Error ? error.message : 'Could not send music to Program.');
    } finally { if (request === generation) starting.value = false; }
  }

  function getProgramStream(): MediaStream {
    ensureGraph();
    return program!.stream;
  }

  function setMonitorEnabled(enabled: boolean) {
    monitorEnabled.value = enabled;
    if (monitor && ctx) monitor.gain.setValueAtTime(enabled ? 1 : 0, ctx.currentTime);
  }

  async function setAutoEnabled(enabled: boolean) {
    autoEnabled.value = enabled;
    if (enabled && mode.value === 'off') {
      try { await content.updateMusic({ mode: queue.value.length > 1 ? 'playlist' : 'loop' }); }
      catch (error) { autoEnabled.value = false; toast.error(error instanceof Error ? error.message : 'Could not enable automatic music.'); }
    }
    audio.loop = autoEnabled.value && mode.value === 'loop';
  }

  function pause() {
    generation++; starting.value = false;
    clearTimeout(pauseHandle);
    playing.value = false;
    fadeTo(0, content.content.music.fadeOutMs);
    pauseHandle = setTimeout(() => { audio.pause(); }, content.content.music.fadeOutMs);
  }

  function toggle() {
    if (playing.value) pause();
    else void play();
  }

  async function skip() {
    if (queue.value.length === 0) return;
    queueIndex.value = (queueIndex.value + 1) % queue.value.length;
    await loadTrack(queue.value[queueIndex.value]);
    if (playing.value) await play();
  }

  async function jumpToTrack(rel: string) {
    const i = queue.value.indexOf(rel);
    if (i < 0) return;
    queueIndex.value = i;
    await loadTrack(rel);
    void content.updateMusic({ current: rel });
    await play();
  }

  async function removeTrack(rel: string) {
    const wasCurrent = currentTrack.value === rel;
    const nextQueue = queue.value.filter((t) => t !== rel);
    await content.updateMusic({
      queue: nextQueue,
      ...(wasCurrent ? { current: nextQueue[0] } : {}),
    });
    if (wasCurrent) {
      generation++; starting.value = false; clearTimeout(pauseHandle); audio.pause();
      currentTrack.value = null;
      playing.value = false;
      queueIndex.value = 0;
    } else {
      // Keep queueIndex aligned with the (shorter) queue.
      queueIndex.value = Math.max(
        0,
        nextQueue.findIndex((t) => t === currentTrack.value),
      );
    }
  }

  async function reorderTrack(fromIdx: number, toIdx: number) {
    if (fromIdx === toIdx) return;
    const next = [...queue.value];
    const [moved] = next.splice(fromIdx, 1);
    if (!moved) return;
    next.splice(toIdx, 0, moved);
    await content.updateMusic({ queue: next });
    if (currentTrack.value) {
      queueIndex.value = next.indexOf(currentTrack.value);
    }
  }

  audio.addEventListener('ended', () => {
    if (autoEnabled.value && mode.value === 'playlist') void skip();
    else playing.value = false;
  });
  audio.addEventListener('error', () => {
    generation++; starting.value = false; clearTimeout(pauseHandle); audio.pause(); playing.value = false;
    if (gain && ctx) {
      gain.gain.cancelScheduledValues(ctx.currentTime);
      gain.gain.setValueAtTime(0, ctx.currentTime);
    }
    toast.error('This music track could not be played. Choose another track or check its media file.');
  });

  watch(volume, (v) => {
    if (gain && ctx && playing.value) gain.gain.setValueAtTime(v, ctx.currentTime);
  });

  watch(mode, (m) => {
    audio.loop = autoEnabled.value && m === 'loop';
    if (m === 'off') autoEnabled.value = false;
  });

  // Signing out or switching operator must stop audio immediately, including
  // local monitoring, without waiting for the normal musical fade-out.
  watch(() => [identity.me?.id, identity.ready && identity.can('*', 'author')] as const, ([id, allowed], [previous]) => {
    if (!identity.ready || id === previous && allowed) return;
    generation++; starting.value = false; clearTimeout(pauseHandle); audio.pause();
    playing.value = false; autoEnabled.value = false; audio.loop = false;
    setMonitorEnabled(false);
    if (gain && ctx) {
      gain.gain.cancelScheduledValues(ctx.currentTime);
      gain.gain.setValueAtTime(0, ctx.currentTime);
    }
  });

  // A remote clear can remove the playing queue entry without going through
  // removeTrack(). Release its cached audio so Play cannot resurrect that file.
  watch(() => [queue.value, content.content.music.current] as const, () => {
    const track = currentTrack.value;
    if (track && !queue.value.includes(track) && content.content.music.current !== track) {
      generation++; starting.value = false; clearTimeout(pauseHandle); audio.pause(); audio.removeAttribute('src'); audio.load();
      currentTrack.value = null; playing.value = false; queueIndex.value = 0;
    }
  });

  return {
    playing,
    starting,
    autoEnabled,
    monitorEnabled,
    setAutoEnabled,
    setMonitorEnabled,
    getProgramStream,
    currentTrack,
    volume,
    mode,
    queue,
    play,
    pause,
    toggle,
    skip,
    jumpToTrack,
    removeTrack,
    reorderTrack,
  };
});
