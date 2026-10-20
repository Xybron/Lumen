// Read-time normalizer that brings legacy (v1) content forward to the v2 shape
// without a destructive migration: it synthesizes channels/sources/destinations
// from the existing playlists when they're absent, then stamps version 2.
//
// CRITICAL: synthesis must be DETERMINISTIC. The same input must always produce
// the same channel/source IDs, because Live View subscriptions and presence are
// keyed off them — non-deterministic IDs would re-key every read and break sync.
// We derive IDs from the stable playlist id (chnl_<playlistId>, src_<channelId>).

type AnyContent = Record<string, unknown> & {
  playlists?: Array<{ id: string; name: string }>;
  channels?: unknown[];
  sources?: unknown[];
  destinations?: unknown[];
  routes?: unknown[];
  program?: unknown;
  version?: number;
};

const DEFAULT_DESTINATION = { id: 'dst_main', kind: 'screen', label: 'Main Screen' } as const;

export function ensureChannels<T extends AnyContent>(raw: T): T {
  const content: AnyContent = { ...raw };
  const playlists = Array.isArray(content.playlists) ? content.playlists : (content.playlists = []);

  // One prayer channel per existing playlist, derived deterministically — but
  // ONLY when the channels key is absent (legacy v1). An intentionally-empty
  // channels array (e.g. the operator deleted the last channel) is respected, so
  // a bare playlist doesn't resurrect a phantom channel.
  if (!Array.isArray(content.channels)) {
    content.channels = playlists.map((p) => ({
      id: `chnl_${p.id}`,
      name: p.name,
      kind: 'prayer' as const,
      playlistId: p.id,
    }));
  }

  const channels = content.channels as Array<{ id: string }>;

  // One channel-source per channel so the routing matrix has stable source IDs.
  if (!Array.isArray(content.sources)) {
    content.sources = channels.map((c) => ({ id: `src_${c.id}`, kind: 'channel' as const, ref: c.id }));
  }

  if (!Array.isArray(content.destinations) || content.destinations.length === 0) {
    content.destinations = [{ ...DEFAULT_DESTINATION }];
  }

  if (!Array.isArray(content.routes)) content.routes = [];
  if (!content.program || typeof content.program !== 'object') {
    content.program = { programSourceId: null, previewSourceId: null };
  }

  content.version = 2;
  return content as T;
}
