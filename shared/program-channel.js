// Pure shared presence rules. Inspect the committed Program, never the editable
// scene with the same ID. A fullscreen foreground insert obscures the base.
function onCanvas(layer) {
  return layer.visible && layer.opacity > 0 && layer.x < 100 && layer.y < 100
    && layer.x + layer.width > 0 && layer.y + layer.height > 0;
}

export function programChannelLayer(state, channelId) {
  if (!state) return null;
  const insert = state.channelInsert;
  if (insert?.channelId === channelId && onCanvas(insert.layer)) return insert.layer;
  if (insert?.mode === 'fullscreen') return null;
  const sources = new Set(state.sources.filter(source => source.kind === 'channel' && source.channelId === channelId).map(source => source.id));
  return [...(state.program?.layers ?? [])].reverse().find(layer => layer.kind === 'source' && sources.has(layer.sourceId) && onCanvas(layer)) ?? null;
}

export function programChannelVisible(state, channelId) {
  return programChannelLayer(state, channelId) !== null;
}
