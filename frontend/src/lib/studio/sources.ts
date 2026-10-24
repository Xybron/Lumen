import type { Content, Item, ProjectionState } from '@/types';
import { subscribeWs, subscribeTopics } from '@/lib/ws';
import { startWs } from '@/lib/ws';
import type { ProductionState, StudioSource } from '../../../../shared/production';
import { acceptChannelProjection, programCueReady, programCuesReady } from './program-cue-gate';
import { MediaPlayback, playbackError } from './media-playback';
import { liveInputStatus } from './device-capture';

export interface MediaInput {
  source: StudioSource;
  element: HTMLImageElement | HTMLVideoElement | HTMLAudioElement | null;
  stream: MediaStream | null;
  node: AudioNode | null;
  gain: GainNode;
  delay: DelayNode;
  analyser: AnalyserNode;
  samples: Float32Array<ArrayBuffer>;
  error: string;
  playback: MediaPlayback;
  streamAudioTracks?: MediaStreamTrack[];
  stopStreamEvents?: () => void;
  channelItemKey?: string;
}

/** The painter needs pictures/content, never ownership of the audio graph. */
export interface SceneSourceBank {
  readonly inputs: ReadonlyMap<string, MediaInput>;
  image(url: string): HTMLImageElement;
  channelItem(input: MediaInput): Item | undefined;
  isTextChannel(input: MediaInput): boolean;
}

interface MultiviewVideo { url: string; element: HTMLVideoElement; paused: boolean }

export class SourceBank {
  readonly inputs = new Map<string, MediaInput>();
  private content: Content | null = null;
  private channelStates = new Map<string, ProjectionState>();
  private subscribed = new Set<string>();
  private stopWs: () => void;
  private images = new Map<string, HTMLImageElement>();
  private multiviewVideos = new Map<string, MultiviewVideo>();
  private multiviewInputs = new Map<string, MediaInput>();
  private multiviewBank: SceneSourceBank | null = null;
  constructor(readonly audio: AudioContext) {
    startWs();
    this.stopWs = subscribeWs(message => {
      if (message.t === 'state' && message.channel && acceptChannelProjection(message.channel, this.channelStates.get(message.channel), message.payload)) {
        this.channelStates.set(message.channel, message.payload);
        this.pruneMultiviewVideos();
      }
      if (message.t === 'content-updated') void this.loadContent();
    });
    void this.loadContent();
  }
  private async loadContent() {
    try { const r = await fetch('/api/content'); if (r.ok) { this.content = await r.json(); this.pruneMultiviewVideos(); } } catch { /* retry on next update */ }
  }
  sync(sources: StudioSource[]) {
    for (const [id, input] of this.inputs) {
      const next = sources.find(s => s.id === id);
      if (!next || next.kind !== input.source.kind || next.url !== input.source.url || next.channelId !== input.source.channelId) {
        this.dispose(input); this.inputs.delete(id);
      }
    }
    for (const source of sources) {
      let input = this.inputs.get(source.id);
      if (!input) {
        const gain = this.audio.createGain(), delay = this.audio.createDelay(2), analyser = this.audio.createAnalyser();
        analyser.fftSize = 256;
        delay.connect(gain); gain.connect(analyser);
        input = { source, element: null, stream: null, node: null, gain, delay, analyser, samples: new Float32Array(256), error: '', playback: new MediaPlayback() };
        this.inputs.set(source.id, input);
        if (source.kind === 'image') input.element = this.image(source.url!);
        else if (source.kind === 'video' || source.kind === 'audio') this.setMedia(input, source.url!, source.kind === 'audio');
      }
      const previous = input.source;
      input.source = source;
      input.gain.gain.setTargetAtTime(source.audio.muted ? 0 : source.audio.volume, this.audio.currentTime, 0.015);
      input.delay.delayTime.setTargetAtTime(source.audio.delayMs / 1000, this.audio.currentTime, 0.015);
      if (input.element instanceof HTMLMediaElement) {
        const element = input.element;
        element.loop = source.loop;
        if (['audio', 'video'].includes(source.kind)) {
          const restarted = (previous.playback?.restart ?? 0) !== (source.playback?.restart ?? 0);
          if (restarted) element.currentTime = 0;
          if (source.playback?.paused) input.playback.pause();
          else if (restarted || previous.playback?.paused) this.play(input, false);
        }
      }
      if (source.channelId && !this.subscribed.has(source.channelId)) {
        this.subscribed.add(source.channelId); subscribeTopics([source.channelId]);
      }
    }
    this.pruneMultiviewVideos();
  }
  image(url: string) {
    let image = this.images.get(url);
    if (!image) { image = new Image(); image.src = `/${url.replace(/^\//, '')}`; this.images.set(url, image); }
    return image;
  }
  private setMedia(input: MediaInput, url: string, audioOnly = false) {
    input.node?.disconnect();
    this.clearElement(input);
    input.error = '';
    const element = document.createElement(audioOnly ? 'audio' : 'video');
    element.src = `/${url.replace(/^\//, '')}`; element.loop = input.source.loop; element.preload = 'auto';
    if (element instanceof HTMLVideoElement) element.playsInline = true;
    input.element = element;
    input.playback.bind(element);
    element.onerror = () => { if (input.playback.isCurrent(element)) input.error = playbackError({ name: 'NotSupportedError' }, false); };
    input.node = this.audio.createMediaElementSource(element); input.node.connect(input.delay);
    if (!input.source.playback?.paused) this.play(input, false);
  }
  private play(input: MediaInput, live: boolean) {
    input.error = '';
    input.playback.play(error => { input.error = playbackError(error, live); });
  }
  private clearElement(input: MediaInput) {
    // Invalidate callbacks before pause/load reject any in-flight play request.
    input.playback.bind(null);
    if (input.element instanceof HTMLMediaElement) {
      input.element.onerror = null;
      input.element.pause(); input.element.srcObject = null;
      input.element.removeAttribute('src'); input.element.load();
    }
    input.element = null;
  }
  private syncStreamAudio(input: MediaInput) {
    const tracks = input.stream?.getAudioTracks().filter(track => track.readyState === 'live') ?? [];
    const previous = input.streamAudioTracks ?? [];
    if (tracks.length === previous.length && tracks.every((track, index) => track === previous[index])) return;
    input.node?.disconnect(); input.node = null;
    input.streamAudioTracks = tracks;
    if (tracks.length) {
      input.node = this.audio.createMediaStreamSource(new MediaStream(tracks));
      input.node.connect(input.delay);
    }
  }
  setStream(id: string, stream: MediaStream | null) {
    const input = this.inputs.get(id);
    if (!input) return;
    // Audio/video ontrack events normally share a stream. Replacing its media
    // element for every track both interrupts playback and loses late audio.
    if (input.stream === stream) { this.syncStreamAudio(input); return; }
    input.stopStreamEvents?.(); input.stopStreamEvents = undefined;
    input.node?.disconnect(); input.node = null;
    input.streamAudioTracks = [];
    this.clearElement(input);
    input.stream = stream; input.error = '';
    if (!stream) return;
    // Chromium needs a playing media element to pull remote WebRTC audio into
    // Web Audio (https://issues.chromium.org/issues/40094084). Keep it muted:
    // only our mix buses should send sound to outputs, never station speakers.
    // A screen/camera can deliver audio first. Keep a video element ready for
    // its later picture rather than replacing an already-playing audio element.
    const element = document.createElement(input.source.kind === 'microphone' ? 'audio' : 'video');
    element.muted = true; element.autoplay = true; element.srcObject = stream;
    if (element instanceof HTMLVideoElement) element.playsInline = true;
    input.element = element;
    input.playback.bind(element);
    element.onerror = () => { if (input.playback.isCurrent(element)) input.error = playbackError({ name: 'NotSupportedError' }, true); };
    const ended = new Set<MediaStreamTrack>();
    const changed = () => {
      if (input.stream !== stream) return;
      const tracks = stream.getTracks();
      for (const track of ended) if (!tracks.includes(track)) { track.removeEventListener('ended', changed); ended.delete(track); }
      for (const track of tracks) if (!ended.has(track)) { track.addEventListener('ended', changed); ended.add(track); }
      this.syncStreamAudio(input);
    };
    stream.addEventListener('addtrack', changed); stream.addEventListener('removetrack', changed);
    input.stopStreamEvents = () => {
      stream.removeEventListener('addtrack', changed); stream.removeEventListener('removetrack', changed);
      for (const track of ended) track.removeEventListener('ended', changed);
    };
    changed();
    this.play(input, true);
  }
  isTextChannel(input: MediaInput): boolean {
    const id = input.source.channelId;
    return !!id && (Object.prototype.hasOwnProperty.call(this.channelStates.get(id) ?? {}, 'cue') ||
      ['scripture', 'lyrics'].includes(this.content?.channels.find(c => c.id === id)?.kind ?? ''));
  }
  channelItem(input: MediaInput, prepareMedia = true): Item | undefined {
    const channelId = input.source.channelId;
    if (!channelId || !this.content) return;
    const state = this.channelStates.get(channelId);
    if (state?.blanked) return;
    if (state && 'cue' in state) return state.cue ?? undefined;
    if (['scripture','lyrics'].includes(this.content.channels.find(c=>c.id===channelId)?.kind??'')) return;
    const playlistId = state?.playlistId ?? this.content.channels.find(c => c.id === channelId)?.playlistId;
    const item = this.content.playlists.find(p => p.id === playlistId)?.items[state?.index ?? 0];
    if (!prepareMedia) return item;
    const url = item?.background?.kind === 'video' ? item.background.src : undefined;
    if (url !== input.channelItemKey) {
      input.channelItemKey = url;
      if (url) this.setMedia(input, url);
      else {
        input.node?.disconnect(); input.node = null;
        this.clearElement(input);
      }
    }
    return item;
  }
  /**
   * Inspecting inactive scenes must not activate/replace their production
   * players. Unmuted "always" channel audio could otherwise start just by
   * opening Multiview. Preview-only videos are muted DOM elements and are
   * intentionally never connected to a MediaElementAudioSourceNode.
   */
  multiviewView(sourceIds: ReadonlySet<string>): SceneSourceBank {
    this.multiviewInputs.clear();
    const retained = new Set<string>();
    for (const [id, input] of this.inputs) {
      if (!sourceIds.has(id)) continue;
      if (input.source.kind !== 'channel') { this.multiviewInputs.set(id, input); continue; }
      const item = this.channelItem(input, false);
      const url = item?.background?.kind === 'video' ? item.background.src : undefined;
      let element: HTMLVideoElement | null = null;
      if (url && input.channelItemKey === url && input.element instanceof HTMLVideoElement) {
        // Observe the exact live playback time without restarting/pausing it.
        element = input.element;
      } else if (url) {
        retained.add(id);
        let preview = this.multiviewVideos.get(id);
        if (preview?.url !== url) {
          this.releaseMultiviewVideo(id);
          const video = document.createElement('video');
          video.muted = video.defaultMuted = true; video.playsInline = true;
          video.loop = input.source.loop; video.preload = 'auto';
          video.src = `/${url.replace(/^\//, '')}`;
          preview = { url, element: video, paused: !!input.source.playback?.paused };
          this.multiviewVideos.set(id, preview);
          if (!preview.paused) void video.play().catch(() => {});
        } else if (preview.paused !== !!input.source.playback?.paused) {
          preview.paused = !!input.source.playback?.paused;
          if (preview.paused) preview.element.pause();
          else void preview.element.play().catch(() => {});
        }
        preview.element.loop = input.source.loop;
        element = preview.element;
      }
      // Clone only the visual handle. Neither peek nor paint can write to the
      // production input's media key, playback helper, error or audio node.
      this.multiviewInputs.set(id, { ...input, element });
    }
    for (const id of this.multiviewVideos.keys()) if (!retained.has(id)) this.releaseMultiviewVideo(id);
    if (!this.multiviewBank) this.multiviewBank = {
      inputs: this.multiviewInputs,
      image: url => this.image(url), isTextChannel: input => this.isTextChannel(input),
      channelItem: input => this.channelItem(input, false),
    };
    return this.multiviewBank;
  }
  private pruneMultiviewVideos() {
    for (const [id, preview] of this.multiviewVideos) {
      const input = this.inputs.get(id), item = input ? this.channelItem(input, false) : undefined;
      const url = item?.background?.kind === 'video' ? item.background.src : undefined;
      if (!input || preview.url !== url) this.releaseMultiviewVideo(id);
    }
  }
  private releaseMultiviewVideo(id: string) {
    const preview = this.multiviewVideos.get(id);
    if (!preview) return;
    this.multiviewVideos.delete(id);
    preview.element.pause(); preview.element.removeAttribute('src'); preview.element.load();
  }
  releaseMultiview() {
    for (const id of this.multiviewVideos.keys()) this.releaseMultiviewVideo(id);
    this.multiviewInputs.clear();
  }
  programCueReady(gate: ProductionState['programCueGate']) {
    return programCueReady(gate, gate ? this.channelStates.get(gate.channelId) : undefined);
  }
  programCuesReady(gates: ProductionState['programCueGates']) {
    return programCuesReady(gates, id => this.channelStates.get(id));
  }
  status() {
    const sources: Record<string, 'ready' | 'missing' | 'loading' | 'error'> = {}, levels: Record<string, number> = {}, sourceErrors: Record<string, string> = {};
    for (const [id, input] of this.inputs) {
      const kind = input.source.kind;
      const live = kind === 'camera' || kind === 'microphone' || kind === 'screen';
      sources[id] = input.error ? 'error' : live ? liveInputStatus(kind, input.stream, input.element instanceof HTMLVideoElement ? input.element : null) :
        input.element instanceof HTMLMediaElement ? input.element.readyState >= 2 ? 'ready' : 'loading' :
        input.element instanceof HTMLImageElement ? input.element.complete && input.element.naturalWidth > 0 ? 'ready' : 'loading' : 'ready';
      if (input.element instanceof HTMLImageElement && input.element.complete && !input.element.naturalWidth) sources[id] = 'error';
      if (input.error) sourceErrors[id] = input.error;
      input.analyser.getFloatTimeDomainData(input.samples);
      let peak = 0; for (const sample of input.samples) peak = Math.max(peak, Math.abs(sample));
      levels[id] = Math.min(1, peak);
    }
    return { sources, levels, sourceErrors };
  }
  private dispose(input: MediaInput) {
    input.stopStreamEvents?.(); input.stopStreamEvents = undefined;
    this.clearElement(input);
    input.node?.disconnect(); input.gain.disconnect(); input.delay.disconnect(); input.analyser.disconnect();
  }
  close() { this.stopWs(); this.releaseMultiview(); for (const input of this.inputs.values()) this.dispose(input); this.inputs.clear(); }
}
