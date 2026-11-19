<script setup lang="ts">
import { ref, onBeforeUnmount } from 'vue';
import StudioMonitor from '@/components/studio/StudioMonitor.vue';
import '@/lib/studio/virtual-devices';

const sink = window.lumenProgramSink;
const monitor = ref<InstanceType<typeof StudioMonitor> | null>(null);
const canvas = document.createElement('canvas');
canvas.width = 1280; canvas.height = 720;
const context = canvas.getContext('2d', { alpha: false, willReadFrequently: true })!;
let generation = 0, videoCallback = 0, previousFrame = 0;
let audio: AudioContext | null = null, node: AudioWorkletNode | null = null;
let video: HTMLVideoElement | null = null;
function reset() {
  generation++;
  if (video && videoCallback) video.cancelVideoFrameCallback(videoCallback);
  videoCallback = 0; previousFrame = 0; video = null;
  node?.disconnect(); node = null;
  if (audio) void audio.close(); audio = null;
}
function failed(error: unknown) { reset(); sink?.fail(error instanceof Error ? error.message : 'Program capture failed.'); }
async function ready(value: boolean) {
  reset();
  const element = monitor.value?.video;
  if (!value || !sink || !element) return;
  video = element;
  const current = generation;
  const capture = async (now: number) => {
    if (current !== generation || !video) return;
    try {
      // requestVideoFrameCallback only forwards newly decoded frames. If the
      // peer stalls, the native camera expires its last frame automatically.
      if (now - previousFrame >= 30) {
        previousFrame = now;
        context.fillStyle = '#000'; context.fillRect(0, 0, 1280, 720);
        const scale = Math.min(1280 / video.videoWidth, 720 / video.videoHeight);
        const w = video.videoWidth * scale, h = video.videoHeight * scale;
        context.drawImage(video, (1280 - w) / 2, (720 - h) / 2, w, h);
        const pixels = context.getImageData(0, 0, 1280, 720).data;
        for (let i = 0; i < pixels.length; i += 4) { const red = pixels[i]; pixels[i] = pixels[i + 2]; pixels[i + 2] = red; }
        await sink.video(new Uint8Array(pixels.buffer));
      }
      if (current === generation && video) videoCallback = video.requestVideoFrameCallback(capture);
    } catch (error) { if (current === generation) failed(error); }
  };
  videoCallback = video.requestVideoFrameCallback(capture);
  try {
    const stream = video.srcObject as MediaStream | null;
    if (!stream?.getAudioTracks().length) throw new Error('Program has no Main audio track.');
    const currentAudio = new AudioContext({ sampleRate: 48000, latencyHint: 'interactive' });
    audio = currentAudio;
    await currentAudio.audioWorklet.addModule('/virtual-output-worklet.js');
    if (current !== generation) return;
    node = new AudioWorkletNode(currentAudio, 'lumen-program-audio', { numberOfInputs: 1, numberOfOutputs: 1,
      outputChannelCount: [2], channelCount: 2, channelCountMode: 'explicit' });
    const currentNode = node;
    node.port.onmessage = async event => {
      if (current !== generation) return;
      try { await sink.audio(new Uint8Array(event.data)); }
      catch (error) { if (current === generation) failed(error); }
      finally { currentNode.port.postMessage('ack'); }
    };
    currentAudio.createMediaStreamSource(stream).connect(node);
    node.connect(currentAudio.destination); // Silent output keeps worklet processing alive.
    await currentAudio.resume();
  } catch (error) { if (current === generation) failed(error); }
}
onBeforeUnmount(reset);
</script>
<template><StudioMonitor v-if="sink" ref="monitor" output-id="program" @ready="ready" /></template>
