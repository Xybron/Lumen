// Shared declaration contract for Studio. Draft scenes and committed output snapshots are
// deliberately separate: editing a live scene never edits the picture on air.
export interface StudioAudio {
  volume: number;
  muted: boolean;
  mode: 'always' | 'follow';
  delayMs: number;
}

export interface StudioSource {
  id: string;
  name: string;
  kind: 'camera' | 'screen' | 'microphone' | 'image' | 'video' | 'audio' | 'channel';
  url?: string;
  channelId?: string;
  loop: boolean;
  playback?: { paused: boolean; restart: number };
  audio: StudioAudio;
}

export interface AnimationPose {
  // Offsets are pixels on the 1920 × 1080 design canvas, relative to the
  // layer's saved position. Scale and rotation use the layer's centre.
  x: number;
  y: number;
  scale: number;
  opacity: number;
  rotation: number;
}

export interface AnimationKeyframe extends AnimationPose {
  offset: number; // Normalised animation time, from 0 to 1.
}

export interface LayerAnimation {
  enabled: boolean;
  preset: 'fade' | 'slide-up' | 'slide-down' | 'slide-left' | 'slide-right' | 'scale' | 'custom';
  durationMs: number;
  delayMs: number;
  easing: 'linear' | 'ease-in' | 'ease-out' | 'ease-in-out';
  // Entrance animations always finish at the saved, untransformed design pose.
  keyframes: AnimationKeyframe[];
}

// Station-wide reusable definitions. Layers receive independent animation copies,
// so renaming or deleting a library entry never changes a scene already in use.
export interface StudioAnimationPreset {
  id: string;
  name: string;
  animation: LayerAnimation;
  createdAt: string;
  updatedAt: string;
}

export interface SceneLayer {
  id: string;
  name: string;
  kind: 'source' | 'text' | 'shape';
  sourceId?: string;
  visible: boolean;
  locked: boolean;
  // Percentages of a 16:9 composition, independent of render resolution.
  x: number;
  y: number;
  width: number;
  height: number;
  opacity: number;
  fit: 'cover' | 'contain';
  text: string;
  color: string;
  background: string;
  fontSize: number; // pixels on a 1920 × 1080 design canvas
  fontWeight: number;
  align: 'left' | 'center' | 'right';
  radius: number;
  // Channel content can inherit a transparent, geometry-aware Studio overlay
  // rather than the channel's full slide background. Existing layers use slide.
  channelStyle?: 'slide' | 'overlay';
  animation?: LayerAnimation;
}

export interface StudioScene {
  id: string;
  name: string;
  background: string;
  layers: SceneLayer[]; // bottom to top
}

export interface StudioOutput {
  id: string;
  name: string;
  mode: 'program' | 'scene';
  scene: StudioScene | null; // pinned, committed snapshot
  sceneRunId?: string; // Fresh only when a pinned scene is deliberately routed.
  blanked: boolean;
  audioEnabled: boolean;
}

export interface ProgramTransition {
  // A new token for each deliberate Take. Renderers ignore stored tokens at
  // startup, so reconnecting never replays an old transition.
  id: string;
  kind: 'cut' | 'fade';
  durationMs: number;
}

// A temporary visual insert, never a replacement for the committed Studio
// composition. Its audio always comes from the underlying Studio Program.
export interface ChannelProgramInsert {
  id: string;
  channelId: string;
  sourceId: string;
  mode: 'overlay' | 'fullscreen';
  layer: SceneLayer;
}

export interface ProductionState {
  version: 1;
  revision: number;
  updatedAt: string;
  scenes: StudioScene[];
  sources: StudioSource[];
  previewSceneId: string | null;
  program: StudioScene | null;
  programTransition?: ProgramTransition;
  channelInsert?: ChannelProgramInsert;
  // Separate channel and Studio sockets may arrive in either order. Renderers
  // retain the prior Program picture until this authoritative cue is observed.
  programCueGate?: { channelId: string; revision: number };
  // Scene Takes can contain several live text channels. These authoritative
  // minimums prevent a stale cue flash across independent WebSockets.
  programCueGates?: { channelId: string; revision: number }[];
  animationPresets?: StudioAnimationPreset[];
  outputs: StudioOutput[];
  masterVolume: number;
  masterMuted: boolean;
  // Routed once to every audio-enabled final output, independently of scenes.
  // Null/absent retains the station's existing explicit mix without choosing an input.
  mainAudioSourceId?: string | null;
}

export interface StudioRecording {
  id: string;
  name: string;
  status: 'starting' | 'recording' | 'stopping' | 'finalizing' | 'complete' | 'interrupted' | 'error';
  createdAt: string;
  durationMs: number;
  bytes: number;
  error?: string;
}

export interface StudioStatus {
  state: 'offline' | 'starting' | 'running' | 'error';
  error?: string;
  fps: number;
  levels: Record<string, number>;
  sources: Record<string, 'ready' | 'missing' | 'loading' | 'error'>;
  sourceErrors: Record<string, string>;
  recording: StudioRecording | null;
  broadcast?: { id: string; state: 'starting' | 'live' | 'stopping' | 'stopped' | 'error' };
}

export type StudioCommand =
  // Studio/Multiview controls and configured shortcuts exchange buses atomically.
  // Legacy/API callers can omit swapPreview to leave their prepared scene alone.
  | { type: 'take'; sceneId: string; transition?: 'cut' | 'fade'; durationMs?: number; swapPreview?: boolean }
  | { type: 'route'; outputId: string; sceneId: string | null }
  | { type: 'blank'; outputId: string; blanked: boolean }
  | { type: 'set-main-audio'; sourceId: string | null }
  | { type: 'save-animation-preset'; name: string; animation: LayerAnimation }
  | { type: 'rename-animation-preset'; presetId: string; name: string }
  | { type: 'delete-animation-preset'; presetId: string };

export type StudioSignalMessage = {
  t: string;
  peerId?: string;
  key?: string;
  outputId?: string;
  sourceId?: string;
  description?: RTCSessionDescriptionInit;
  candidate?: RTCIceCandidateInit;
  state?: ProductionState;
  status?: StudioStatus;
  recording?: StudioRecording;
  // Renderer-only broadcast commands. Streaming consumes the same final
  // Program stream but has an encoder lifetime independent of recording.
  broadcast?: { id: string; profile: '720p' | '1080p' };
  error?: string;
};
