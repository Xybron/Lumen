import { defineStore } from 'pinia';
import { computed, ref, watch } from 'vue';
import { mediaUrl } from '@/lib/api';
import { useContentStore } from './content';

// Web Audio fades — a GainNode lets us crossfade between tracks click-free,
// which a raw <audio> element can't do.
export const useMusicStore = defineStore('music', () => {
  const content = useContentStore();

  const audio = new Audio();
  audio.crossOrigin = 'anonymous';
  audio.preload = 'auto';

  let ctx: AudioContext | null = null;
  let gain: GainNode | null = null;
  let source: MediaElementAudioSourceNode | null = null;

  const playing = ref(false);
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
    source.connect(gain).connect(ctx.destination);
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
    audio.loop = mode.value === 'loop';
    currentTrack.value = rel;
  }

  async function play() {
    if (mode.value === 'off') return;
    ensureGraph();
    await ctx?.resume();
    if (!currentTrack.value) {
      const first = content.content.music.current ?? queue.value[0];
      if (!first) return;
      await loadTrack(first);
    }
    if (gain) gain.gain.value = 0;
    try {
      await audio.play();
      playing.value = true;
      fadeTo(volume.value, content.content.music.fadeInMs);
    } catch {
      // Autoplay blocked — operator must click play once.
      playing.value = false;
    }
  }

  function pause() {
    fadeTo(0, content.content.music.fadeOutMs);
    setTimeout(() => {
      audio.pause();
      playing.value = false;
    }, content.content.music.fadeOutMs);
  }

  function toggle() {
    if (playing.value) pause();
    else void play();
  }

  async function skip() {
    if (mode.value !== 'playlist' || queue.value.length === 0) return;
    queueIndex.value = (queueIndex.value + 1) % queue.value.length;
    await loadTrack(queue.value[queueIndex.value]);
    if (playing.value) await audio.play();
  }

  async function jumpToTrack(rel: string) {
    const i = queue.value.indexOf(rel);
    if (i < 0) return;
    queueIndex.value = i;
    await loadTrack(rel);
    void content.updateMusic({ current: rel });
    if (playing.value) await audio.play();
    else void play();
  }

  async function removeTrack(rel: string) {
    const wasCurrent = currentTrack.value === rel;
    const nextQueue = queue.value.filter((t) => t !== rel);
    await content.updateMusic({
      queue: nextQueue,
      ...(wasCurrent ? { current: nextQueue[0] } : {}),
    });
    if (wasCurrent) {
      audio.pause();
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
    if (mode.value === 'playlist') void skip();
  });

  watch(volume, (v) => {
    if (gain && ctx) gain.gain.setValueAtTime(v, ctx.currentTime);
  });

  watch(mode, (m) => {
    audio.loop = m === 'loop';
    if (m === 'off') pause();
  });

  // A remote clear can remove the playing queue entry without going through
  // removeTrack(). Release its cached audio so Play cannot resurrect that file.
  watch(() => [queue.value, content.content.music.current] as const, () => {
    const track = currentTrack.value;
    if (track && !queue.value.includes(track) && content.content.music.current !== track) {
      audio.pause(); audio.removeAttribute('src'); audio.load();
      currentTrack.value = null; playing.value = false; queueIndex.value = 0;
    }
  });

  return {
    playing,
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
