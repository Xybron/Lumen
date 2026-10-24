import { computed, ref, shallowRef, watch } from 'vue';
import { defineStore } from 'pinia';
import { toast } from 'vue-sonner';
import { studioApi } from '@/lib/studio/api';
import { useContentStore } from '@/stores/content';
import { StudioPeer, StudioSignal } from '@/lib/studio/signal';
import { shortId } from '@/lib/ids';
import { animationFromPreset, cloneAnimation } from '@/lib/studio/animation';
import { openDeviceCapture, type InputSelection } from '@/lib/studio/device-capture';
import { arrangeLayers, layerAlignment, layerPreset, nudgeLayerGeometry, reorderLayers, type LayerAlignment, type LayerArrangeAction, type LayerPreset } from '@/lib/studio/layer-layout';
import type { ProductionState, StudioStatus, StudioRecording, StudioScene, SceneLayer, StudioSource, StudioCommand, LayerAnimation } from '../../../shared/production';

export function newLayer(patch: Partial<SceneLayer> = {}): SceneLayer {
  return { id: shortId('layer'), name: 'Text', kind: 'text', visible: true, locked: false,
    x: 10, y: 40, width: 80, height: 20, opacity: 1, fit: 'cover', text: 'Your words here',
    color: '#ffffff', background: '#00000000', fontSize: 72, fontWeight: 500, align: 'center', radius: 0, ...patch };
}

export const useStudioStore = defineStore('studio', () => {
  const state = shallowRef<ProductionState | null>(null);
  const status = ref<StudioStatus>({ state: 'offline', fps: 0, levels: {}, sources: {}, sourceErrors: {}, recording: null });
  const recordings = ref<StudioRecording[]>([]);
  const loading = ref(true), saving = ref(0), engineBusy = ref(false), recordingBusy = ref(false);
  const selectedLayerId = ref<string | null>(null);
  const connectedSources = ref<string[]>([]);
  const captures = new Map<string, { stream: MediaStream; peer: StudioPeer | null }>();
  const signal = new StudioSignal();
  const selectedScene = computed(() => state.value?.scenes.find(s => s.id === state.value?.previewSceneId) ?? null);
  const selectedLayer = computed(() => selectedScene.value?.layers.find(l => l.id === selectedLayerId.value) ?? null);
  // Preview can change through a server-side bus swap or another operator,
  // not just selectScene(). Never leave the outgoing scene's layer selected.
  watch(() => state.value?.previewSceneId, () => { selectedLayerId.value = null; });
  const animationPresets = computed(() => [...(state.value?.animationPresets ?? [])].sort((a, b) => a.name.localeCompare(b.name)));
  let writes: Promise<unknown> = Promise.resolve();
  const pendingEdits = new Map<string, { mutator: (draft: ProductionState) => void; promise: Promise<void> }>();
  // Keep the last acknowledged document separate from a local Preview edit.
  // The WebSocket often acknowledges a save before its HTTP response arrives;
  // an older response must not roll the editor back to a previous revision.
  let confirmedState: ProductionState | null = null;
  function acceptState(document: ProductionState) {
    if (confirmedState && document.revision <= confirmedState.revision) return;
    confirmedState = document;
    state.value = document;
  }

  signal.subscribe(m => {
    if (m.state) acceptState(m.state);
    if (m.status) {
      const old = status.value.recording;
      status.value = m.status;
      if (old?.id !== m.status.recording?.id || old?.status !== m.status.recording?.status) void refreshRecordings();
    }
    if (m.t === 'error' && m.error) toast.error(m.error);
    if (m.t === 'publish-ready' && m.sourceId && m.peerId && m.key) {
      const capture = captures.get(m.sourceId);
      if (capture) {
        capture.peer?.close(); capture.peer = new StudioPeer(signal, m.peerId, m.key);
        void capture.peer.offer(capture.stream).catch(e => toast.error(`Input connection failed: ${e.message}`));
      }
    }
    if (m.t === 'signal' && m.key?.startsWith('in:')) void captures.get(m.key.slice(3))?.peer?.receive(m).catch(() => {});
  });
  signal.onConnected = () => { for (const sourceId of captures.keys()) signal.send({ t: 'publish', sourceId }); };
  signal.onDisconnected = () => { for (const capture of captures.values()) { capture.peer?.close(); capture.peer = null; } };

  async function load() {
    loading.value = !state.value;
    try {
      const [document, engine] = await Promise.all([studioApi.get(), studioApi.status()]);
      acceptState(document);
      status.value = engine;
    }
    catch (e) { toast.error((e as Error).message); }
    finally { loading.value = false; }
  }
  function enqueue(operation: () => Promise<void>) {
    saving.value++;
    const run = writes.then(operation).catch(async error => {
      // Discard only the failed optimistic edit, not the mounted workspace.
      // Focused property inputs retain their own in-progress draft.
      state.value = confirmedState;
      toast.error(error.message); await load(); throw error;
    })
      .finally(() => saving.value--);
    writes = run.catch(() => {});
    return run;
  }
  function edit(mutator: (draft: ProductionState) => void, liveKey?: string): Promise<void> {
    const pending = liveKey ? pendingEdits.get(liveKey) : undefined;
    if (pending) {
      pending.mutator = mutator;
      return pending.promise;
    }
    // Only consecutive edits to the same live control can be coalesced. A
    // different property or a command is an ordering boundary, never crossed.
    pendingEdits.clear();
    const entry = { mutator, promise: Promise.resolve() };
    entry.promise = enqueue(async () => {
      if (liveKey && pendingEdits.get(liveKey) === entry) pendingEdits.delete(liveKey);
      if (!state.value) return;
      const next = structuredClone(state.value); entry.mutator(next);
      // Make the draft visible immediately while serializing writes. The
      // server still owns Program snapshots, routing and persistent Main audio.
      state.value = next;
      acceptState(await studioApi.save(next));
    });
    if (liveKey) pendingEdits.set(liveKey, entry);
    return entry.promise;
  }
  function command(command: StudioCommand) {
    pendingEdits.clear();
    return enqueue(async () => { if (state.value) acceptState(await studioApi.command(state.value.revision, command)); });
  }
  function setMainAudio(sourceId: string | null) { return command({ type: 'set-main-audio', sourceId }); }
  function saveAnimationPreset(name: string, animation: LayerAnimation) {
    return command({ type: 'save-animation-preset', name: name.trim(), animation: cloneAnimation(animation) });
  }
  function renameAnimationPreset(presetId: string, name: string) { return command({ type: 'rename-animation-preset', presetId, name: name.trim() }); }
  function deleteAnimationPreset(presetId: string) { return command({ type: 'delete-animation-preset', presetId }); }
  function applyAnimationPreset(presetId: string, layerId: string, sceneId = selectedScene.value?.id) {
    return edit(draft => {
      const preset = draft.animationPresets?.find(item => item.id === presetId);
      if (!preset) throw new Error('This animation preset is no longer in the library. Choose another preset.');
      const layer = draft.scenes.find(scene => scene.id === sceneId)?.layers.find(item => item.id === layerId);
      if (!layer) throw new Error('The selected layer is no longer available.');
      if (layer.locked) throw new Error('Unlock this layer before applying an animation preset.');
      layer.animation = animationFromPreset(preset);
    });
  }
  async function selectScene(id: string) { selectedLayerId.value = null; await edit(d => { d.previewSceneId = id; }); }
  async function addScene(duplicate = false) {
    const id = shortId('scene'), selected = selectedScene.value;
    const scene: StudioScene = duplicate && selected ? { ...structuredClone(selected), id, name: `${selected.name.slice(0, 95)} copy`, layers: selected.layers.map(l => ({ ...l, id: shortId('layer') })) } :
      { id, name: 'Untitled scene', background: '#141b21', layers: [] };
    await edit(d => { d.scenes.push(scene); d.previewSceneId = id; }); selectedLayerId.value = null;
  }
  async function removeScene(id: string) {
    await edit(d => { d.scenes = d.scenes.filter(s => s.id !== id); if (d.previewSceneId === id) d.previewSceneId = d.scenes[0]?.id ?? null; });
  }
  function updateScene(patch: Partial<StudioScene>, id = selectedScene.value?.id) {
    return edit(d => { const scene = d.scenes.find(s => s.id === id); if (scene) Object.assign(scene, patch); },
      Object.keys(patch).length === 1 && patch.background !== undefined ? `scene:${id}:background` : undefined);
  }
  async function addLayer(patch: Partial<SceneLayer>) {
    const sceneId = selectedScene.value?.id;
    if (!sceneId) return;
    const layer = newLayer(patch);
    await edit(d => { d.scenes.find(s => s.id === sceneId)?.layers.push(layer); });
    if (state.value?.previewSceneId === sceneId) selectedLayerId.value = layer.id;
  }
  function updateLayer(id: string, patch: Partial<SceneLayer>, sceneId = selectedScene.value?.id) {
    return edit(d => {
      const layer = d.scenes.find(s => s.id === sceneId)?.layers.find(l => l.id === id);
      if (!layer) return;
      // Locking protects the content and geometry, including queued operations.
      // Names, visibility and the lock itself remain editable from the layer list.
      if (layer.locked) {
        for (const key of ['name', 'visible', 'locked'] as const) {
          if (patch[key] !== undefined) Object.assign(layer, { [key]: patch[key] });
        }
      } else {
        const { id: _id, ...changes } = patch;
        Object.assign(layer, changes);
      }
    }, Object.keys(patch).length === 1 && ['color', 'background', 'opacity'].some(key => key in patch)
      ? `layer:${sceneId}:${id}:${Object.keys(patch)[0]}` : undefined);
  }
  function removeLayer(id: string) {
    const sceneId = selectedScene.value?.id;
    return edit(d => {
      const scene = d.scenes.find(s => s.id === sceneId);
      const layer = scene?.layers.find(l => l.id === id);
      if (!scene || !layer || layer.locked) return;
      scene.layers = scene.layers.filter(l => l.id !== id);
      if (selectedLayerId.value === id && state.value?.previewSceneId === sceneId) selectedLayerId.value = null;
    });
  }
  function moveLayer(id: string, step: number) {
    return arrangeLayer(id, step > 0 ? 'forward' : 'backward');
  }
  async function duplicateLayer(id: string) {
    const sceneId = selectedScene.value?.id;
    const duplicateId = shortId('layer');
    let duplicated = false;
    await edit(d => {
      const scene = d.scenes.find(s => s.id === sceneId);
      const index = scene?.layers.findIndex(l => l.id === id) ?? -1;
      if (!scene || index < 0) return;
      if (scene.layers.length >= 40) throw new Error('A scene can contain up to 40 layers.');
      const original = scene.layers[index];
      const layer = { ...structuredClone(original), id: duplicateId, name: `${original.name.slice(0, 95)} copy`, locked: false,
        x: Math.min(100, original.x + 2), y: Math.min(100, original.y + 2) };
      scene.layers.splice(index + 1, 0, layer);
      duplicated = true;
    });
    if (duplicated && state.value?.previewSceneId === sceneId) selectedLayerId.value = duplicateId;
  }
  function reorderLayer(id: string, targetId: string, placement: 'before' | 'after') {
    const sceneId = selectedScene.value?.id;
    return edit(d => {
      const scene = d.scenes.find(s => s.id === sceneId);
      if (scene) scene.layers = reorderLayers(scene.layers, id, targetId, placement);
    });
  }
  function arrangeLayer(id: string, action: LayerArrangeAction) {
    const sceneId = selectedScene.value?.id;
    return edit(d => {
      const scene = d.scenes.find(s => s.id === sceneId);
      if (scene) scene.layers = arrangeLayers(scene.layers, id, action);
    });
  }
  function transformLayer(id: string, transform: (layer: SceneLayer) => Partial<SceneLayer>) {
    const sceneId = selectedScene.value?.id;
    return edit(d => {
      const layer = d.scenes.find(s => s.id === sceneId)?.layers.find(l => l.id === id);
      if (layer && !layer.locked) Object.assign(layer, transform(layer));
    });
  }
  function alignLayer(id: string, alignment: LayerAlignment) { return transformLayer(id, layer => layerAlignment(layer, alignment)); }
  function presetLayer(id: string, preset: LayerPreset) { return transformLayer(id, layer => layerPreset(layer, preset)); }
  function nudgeLayer(id: string, dx: number, dy: number) { return transformLayer(id, layer => nudgeLayerGeometry(layer, dx, dy)); }
  async function addSource(source: StudioSource) {
    const sceneId = selectedScene.value?.id;
    // New inputs are opt-in audio. Importing a video or connecting a camera
    // must never interrupt the main feed, even through another creation path.
    const safeSource = { ...source, audio: { ...source.audio, muted: true } };
    const textChannel = source.kind === 'channel' && ['scripture', 'lyrics'].includes(useContentStore().content?.channels.find(c => c.id === source.channelId)?.kind ?? '');
    const layer = newLayer({ name: source.name, kind: 'source', sourceId: source.id, x: 0, y: 0, width: 100, height: 100,
      ...(textChannel ? { channelStyle: 'overlay' as const, fontSize: 68 } : {}) });
    await edit(d => {
      d.sources.push(safeSource);
      const scene = d.scenes.find(s => s.id === sceneId);
      if (scene && !['audio', 'microphone'].includes(source.kind)) {
        // Text sources belong above the camera; new media backgrounds stay
        // behind existing text and graphics. Operators can reorder either.
        if (textChannel) scene.layers.push(layer);
        else scene.layers.unshift(layer);
      }
    });
  }
  function disconnectSource(id: string) {
    const capture = captures.get(id); if (!capture) return;
    captures.delete(id); capture.peer?.close(); capture.stream.getTracks().forEach(t => { t.onended = null; t.stop(); });
    connectedSources.value = [...captures.keys()]; signal.send({ t: 'unpublish', sourceId: id });
  }
  // Read-only access for muted local animation rehearsals. Preview components
  // must never stop these tracks: their lifetime belongs to the publisher.
  function sourceStream(id: string) { return captures.get(id)?.stream ?? null; }
  function cameraStreams() { return [...captures.values()].map(capture => capture.stream).filter(stream => stream.getVideoTracks().some(track => track.readyState === 'live')); }
  function rememberedInputSelection(id: string): InputSelection {
    try {
      const saved = JSON.parse(localStorage.getItem(`lumen:input:${id}`) ?? '{}');
      return {
        videoDeviceId: typeof saved?.videoDeviceId === 'string' ? saved.videoDeviceId : undefined,
        audioDeviceId: typeof saved?.audioDeviceId === 'string' ? saved.audioDeviceId : undefined,
        includeAudio: typeof saved?.includeAudio === 'boolean' ? saved.includeAudio : false,
        width: Number.isInteger(saved?.width) && saved.width > 0 ? saved.width : undefined,
        height: Number.isInteger(saved?.height) && saved.height > 0 ? saved.height : undefined,
        frameRate: typeof saved?.frameRate === 'number' && Number.isFinite(saved.frameRate) && saved.frameRate > 0 ? saved.frameRate : undefined,
      };
    } catch { return {}; }
  }
  /** Device IDs remain local to the browser that supplies this source. */
  function inputSelection(id: string): InputSelection {
    const saved = rememberedInputSelection(id), stream = sourceStream(id);
    if (!stream) return saved;
    const video = stream.getVideoTracks().find(track => track.readyState === 'live');
    const audio = stream.getAudioTracks().find(track => track.readyState === 'live');
    return {
      ...saved,
      videoDeviceId: video?.getSettings().deviceId || saved.videoDeviceId,
      audioDeviceId: audio?.getSettings().deviceId || saved.audioDeviceId,
      includeAudio: !!audio,
    };
  }
  function rememberInputSelection(id: string, selection: InputSelection) {
    try { localStorage.setItem(`lumen:input:${id}`, JSON.stringify(selection)); } catch { /* private browsing */ }
  }
  function publishCapture(id: string, stream: MediaStream) {
    if (captures.get(id)?.stream === stream) return;
    disconnectSource(id);
    captures.set(id, { stream, peer: null }); connectedSources.value = [...captures.keys()];
    for (const track of stream.getTracks()) track.onended = () => {
      // An event queued by the previous input must not release its replacement.
      if (captures.get(id)?.stream === stream) disconnectSource(id);
    };
    signal.send({ t: 'publish', sourceId: id });
  }
  async function connectSource(source: StudioSource, videoDeviceId?: string, audioDeviceId?: string, includeAudio?: boolean, preparedStream?: MediaStream, format?: Pick<InputSelection, 'width' | 'height' | 'frameRate'>) {
    if (!navigator.mediaDevices) throw new Error('Device access requires localhost or HTTPS.');
    // Device IDs belong to this browser, not the shared production document.
    // Remember explicit selections so reconnecting Camera 2 cannot silently
    // replace it with the default camera (or lose its enabled audio track).
    const saved = rememberedInputSelection(source.id);
    videoDeviceId ??= saved.videoDeviceId;
    audioDeviceId ??= saved.audioDeviceId;
    includeAudio ??= saved.includeAudio ?? false;
    const selectedFormat = { width: (format ?? saved).width, height: (format ?? saved).height, frameRate: (format ?? saved).frameRate };
    const remember = () => rememberInputSelection(source.id, { videoDeviceId, audioDeviceId, includeAudio, ...selectedFormat });
    // Keep the explicit selection even if the first attempt is denied or busy.
    // The saved source's Connect action must retry that card, not the default.
    remember();
    const stream = preparedStream ?? (source.kind === 'screen' ? await navigator.mediaDevices.getDisplayMedia({ video: { frameRate: 30 }, audio: true }) :
      await openDeviceCapture(source.kind === 'camera' ? 'camera' : 'microphone', { videoDeviceId, audioDeviceId, includeAudio, ...selectedFormat }));
    // Resolve "Default" to the actual device for subsequent reconnects. A
    // removed HDMI adapter must never turn a saved camera into the laptop cam.
    videoDeviceId = stream.getVideoTracks()[0]?.getSettings().deviceId || videoDeviceId;
    audioDeviceId = stream.getAudioTracks()[0]?.getSettings().deviceId || audioDeviceId;
    remember();
    publishCapture(source.id, stream);
  }
  /** The caller stages an independent input; Save transfers ownership here.
   * Cancel never reaches this method, and failed saves retain the old publisher. */
  async function saveSourceProperties(id: string, patch: Partial<StudioSource>, replacement?: { stream: MediaStream; selection?: InputSelection }) {
    const previousStream = sourceStream(id);
    const validate = (source?: StudioSource) => {
      if (!source) throw new Error('This source no longer exists. Close Properties and choose another source.');
      if ((patch.id !== undefined && patch.id !== id) || (patch.kind !== undefined && patch.kind !== source.kind)) {
        throw new Error('A source’s identity and type cannot be changed in Properties.');
      }
      if (replacement) {
        if (!['camera', 'screen', 'microphone'].includes(source.kind)) throw new Error('This source cannot use a live input.');
        const video = replacement.stream.getVideoTracks().some(track => track.readyState === 'live');
        const audio = replacement.stream.getAudioTracks().some(track => track.readyState === 'live');
        if ((source.kind === 'microphone' ? !audio : !video) || (source.kind === 'camera' && replacement.selection?.includeAudio && !audio)) {
          throw new Error('The selected input stopped before it could be saved. Preview it again and retry.');
        }
      }
      return source;
    };
    try {
      validate(state.value?.sources.find(source => source.id === id));
      const changes = structuredClone(patch);
      await edit(draft => {
        const source = validate(draft.sources.find(source => source.id === id));
        Object.assign(source, changes, { id, kind: source.kind });
      });
      validate(state.value?.sources.find(source => source.id === id));
      if (replacement) {
        const { stream } = replacement;
        const selection = { ...rememberedInputSelection(id), ...replacement.selection };
        selection.videoDeviceId = stream.getVideoTracks()[0]?.getSettings().deviceId || selection.videoDeviceId;
        selection.audioDeviceId = stream.getAudioTracks()[0]?.getSettings().deviceId || selection.audioDeviceId;
        selection.includeAudio = stream.getAudioTracks().some(track => track.readyState === 'live');
        publishCapture(id, stream);
        rememberInputSelection(id, selection);
      }
    } catch (error) {
      if (replacement && replacement.stream !== previousStream) replacement.stream.getTracks().forEach(track => track.stop());
      throw error;
    }
  }
  async function removeSource(id: string) {
    // The server refuses deleting a source still used by a committed live scene.
    await edit(d => { d.sources = d.sources.filter(s => s.id !== id); for (const scene of d.scenes) scene.layers = scene.layers.filter(l => l.sourceId !== id); });
    disconnectSource(id);
    try { localStorage.removeItem(`lumen:input:${id}`); } catch { /* storage unavailable */ }
  }
  function updateSource(id: string, patch: Partial<StudioSource>) { return edit(d => { const source = d.sources.find(s => s.id === id); if (source) Object.assign(source, patch); }); }
  async function toggleEngine() {
    engineBusy.value = true;
    try { status.value = status.value.state === 'running' ? await studioApi.stop() : await studioApi.start(); }
    catch (e) { toast.error((e as Error).message); status.value = await studioApi.status(); }
    finally { engineBusy.value = false; }
  }
  async function refreshRecordings() { try { recordings.value = await studioApi.recordings(); } catch { /* sign-in gate */ } }
  async function toggleRecord() {
    recordingBusy.value = true;
    try {
      if (status.value.recording) await studioApi.stopRecording(status.value.recording.id);
      else await studioApi.record(`Service ${new Date().toLocaleString().replace(/[/,:]/g, '-')}`);
      status.value = await studioApi.status(); await refreshRecordings();
    } catch (e) { toast.error((e as Error).message); }
    finally { recordingBusy.value = false; }
  }
  async function recoverRecording(id: string) { try { await studioApi.recover(id); await refreshRecordings(); } catch (e) { toast.error((e as Error).message); } }
  window.addEventListener('beforeunload', e => {
    if (captures.size) { e.preventDefault(); e.returnValue = ''; }
  });
  return { state, status, loading, saving, recordings, engineBusy, recordingBusy, selectedLayerId, selectedScene, selectedLayer, connectedSources, animationPresets, reconnect: () => signal.reconnect(),
    load, edit, command, selectScene, addScene, removeScene, updateScene, addLayer, updateLayer, removeLayer, moveLayer, duplicateLayer, reorderLayer, arrangeLayer, alignLayer, presetLayer, nudgeLayer, addSource, removeSource, updateSource,
    connectSource, disconnectSource, sourceStream, cameraStreams, inputSelection, saveSourceProperties, setMainAudio, toggleEngine, refreshRecordings, toggleRecord, recoverRecording,
    saveAnimationPreset, renameAnimationPreset, deleteAnimationPreset, applyAnimationPreset };
});
