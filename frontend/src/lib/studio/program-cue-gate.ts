import type { ProductionState } from '../../../../shared/production';
import type { ProjectionState } from '../../types';

function authoritativeRevision(projection: ProjectionState | undefined): number | null {
  return projection && Object.prototype.hasOwnProperty.call(projection, 'cue')
    && Number.isSafeInteger(projection.channelRevision) && projection.channelRevision! >= 0 ? projection.channelRevision! : null;
}

// Production routing and channel cues travel over separate connections. Only
// the authoritative worship projection (which owns `cue` + channelRevision)
// can acknowledge the cue commit required by a new Program route. Generic or
// optimistic presentation state must not release the previous good picture.
export function programCueReady(gate: ProductionState['programCueGate'], projection: ProjectionState | undefined): boolean {
  if (!gate) return true;
  if (!Number.isSafeInteger(gate.revision) || gate.revision < 0) return false;
  const revision = authoritativeRevision(projection);
  return projection?.channelId === gate.channelId && revision !== null && revision >= gate.revision;
}

export function programCuesReady(gates: ProductionState['programCueGates'], projection: (channelId: string) => ProjectionState | undefined): boolean {
  return !gates || gates.every(gate => programCueReady(gate, projection(gate.channelId)));
}

// Reconnect/replay must not replace a newer verse (or a newer blank command)
// with an older projection. Ordinary Presentation channels remain unrevisioned
// until an authoritative worship projection has actually been observed.
export function acceptChannelProjection(channelId: string, previous: ProjectionState | undefined, incoming: ProjectionState): boolean {
  if (!incoming || incoming.channelId !== channelId) return false;
  const revision = authoritativeRevision(incoming);
  if (Object.prototype.hasOwnProperty.call(incoming, 'channelRevision') && revision === null) return false;
  const previousRevision = previous?.channelId === channelId ? authoritativeRevision(previous) : null;
  return previousRevision === null || revision !== null && revision >= previousRevision;
}
