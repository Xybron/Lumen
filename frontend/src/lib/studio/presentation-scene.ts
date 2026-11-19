import type { ProductionState, StudioScene } from '../../../../shared/production';

/** Prepare a dedicated channel scene without touching committed Program,
 * output routes, Main audio, or the user's existing scene compositions. */
export function preparePresentationScene(state: ProductionState, channel: { id: string; name: string }, id: (prefix: string) => string): StudioScene {
  const existing = state.scenes.find(scene => scene.id.startsWith('presentation_') && scene.layers.some(layer =>
    layer.kind === 'source' && state.sources.some(source => source.id === layer.sourceId && source.kind === 'channel' && source.channelId === channel.id)));
  if (existing) return existing;
  if (state.scenes.length >= 60) throw new Error('Remove an unused scene before sending another presentation to Program.');
  let source = state.sources.find(candidate => candidate.kind === 'channel' && candidate.channelId === channel.id);
  if (!source) {
    if (state.sources.length >= 40) throw new Error('Remove an unused source before sending another presentation to Program.');
    source = { id: id('channel'), name: channel.name.slice(0, 100), kind: 'channel', channelId: channel.id, loop: false,
      audio: { volume: 1, muted: true, mode: 'follow', delayMs: 0 } };
    state.sources.push(source);
  }
  const scene: StudioScene = { id: id('presentation'), name: channel.name.slice(0, 100), background: '#000000', layers: [{
    id: id('layer'), name: channel.name.slice(0, 100), kind: 'source', sourceId: source.id,
    visible: true, locked: false, x: 0, y: 0, width: 100, height: 100, opacity: 1, fit: 'contain',
    text: '', color: '#ffffff', background: '#00000000', fontSize: 72, fontWeight: 500, align: 'center', radius: 0, channelStyle: 'slide',
  }] };
  state.scenes.push(scene);
  return scene;
}
