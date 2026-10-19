import type { ProductionState, SceneLayer } from './production.js';

export function programChannelLayer(state: ProductionState | null | undefined, channelId: string): SceneLayer | null;
export function programChannelVisible(state: ProductionState | null | undefined, channelId: string): boolean;
