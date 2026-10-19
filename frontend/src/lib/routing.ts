import type { Content, Source } from '@/types';

// Pure resolvers shared by the switcher and the destination output.

// The channel currently on the Program bus, if the program source is a channel.
export function resolveProgramChannel(content: Content, programSourceId?: string | null): string | null {
  const id = programSourceId ?? content.program?.programSourceId;
  if (!id) return null;
  const src = content.sources.find((s) => s.id === id);
  return src?.kind === 'channel' ? src.ref : null;
}

// A destination shows its DIRECT route (via:'direct') if one is pinned, otherwise
// it follows the Program bus — like a physical switcher's AUX-out vs PGM-out.
export function sourceForDestination(
  content: Content,
  destinationId: string,
  programSourceId?: string | null,
): Source | null {
  const direct = content.routes.find((r) => r.destinationId === destinationId && r.via === 'direct');
  if (direct) {
    const s = content.sources.find((x) => x.id === direct.sourceId);
    if (s) return s;
  }
  const progId = programSourceId ?? content.program?.programSourceId;
  return progId ? content.sources.find((s) => s.id === progId) ?? null : null;
}
