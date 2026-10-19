import fs from 'node:fs/promises';
import { CONTENT_FILE } from './paths.js';
import { ensureChannels } from './migrate-content.js';
import { ContentSchema } from './schema.js';
import { atomicWriteJson, backupContent } from './atomic.js';
import { withContentLock } from './content-writer.js';
import type { AgentInput } from './agents.js';
import type { RelayHandle } from './ws.js';

// Projects an agent's declared inputs into content.json as kind:'capture' Sources
// so they appear in the routing matrix the operator authors. This is the ONLY
// writer of capture sources. IDs are DETERMINISTIC (src_cap_<agent>_<input>) so
// re-registration is idempotent (mirrors migrate-content's determinism rule).
//
// NOTE: content.json now has two writers — the operator (PUT /content) and this.
// Both go through atomicWriteJson (atomic rename, never a torn file); a concurrent
// last-write-wins race is possible and is flagged for a future shared write queue.

type AnyContent = Record<string, unknown> & { sources?: unknown[]; routes?: unknown[] };

interface CaptureSource {
  id: string;
  kind: 'capture';
  ref: string;
  label?: string;
  capture: { agentId: string; inputId: string; transport: string; signal: string; label?: string };
}

function srcId(agentId: string, inputId: string) {
  return `src_cap_${agentId}_${inputId}`;
}

async function readContent(): Promise<AnyContent> {
  const raw = await fs.readFile(CONTENT_FILE, 'utf8');
  return ensureChannels(JSON.parse(raw));
}

async function writeContent(content: AnyContent, relay: RelayHandle) {
  // Null any program/preview selection that now points at a removed source.
  const srcIds = new Set(((content.sources ?? []) as Array<{ id: string }>).map((s) => s.id));
  const program = content.program as { programSourceId?: string | null; previewSourceId?: string | null } | undefined;
  if (program) {
    if (program.programSourceId && !srcIds.has(program.programSourceId)) program.programSourceId = null;
    if (program.previewSourceId && !srcIds.has(program.previewSourceId)) program.previewSourceId = null;
  }
  const parsed = ContentSchema.safeParse(ensureChannels(content));
  if (!parsed.success) return;
  const next = { ...parsed.data, updatedAt: new Date().toISOString() };
  await backupContent();
  await atomicWriteJson(CONTENT_FILE, next);
  relay.injectRemote({ t: 'content-updated', updatedAt: next.updatedAt });
}

export function projectAgentSources(agentId: string, inputs: AgentInput[], relay: RelayHandle) {
  // Serialized read-modify-write so it never interleaves with PUT /content.
  return withContentLock(async () => {
    const content = await readContent();
    const sources = (content.sources ?? []) as CaptureSource[];
    for (const input of inputs) {
      const id = srcId(agentId, input.inputId);
      if (!sources.find((s) => s.id === id)) {
        sources.push({
          id,
          kind: 'capture',
          ref: `${agentId}:${input.inputId}`,
          label: input.label,
          capture: { agentId, inputId: input.inputId, transport: input.transport, signal: input.signal, label: input.label },
        });
      }
    }
    content.sources = sources;
    await writeContent(content, relay);
  });
}

export function pruneAgentSources(agentId: string, relay: RelayHandle) {
  return withContentLock(async () => {
    const content = await readContent();
    const sources = ((content.sources ?? []) as CaptureSource[]).filter(
      (s) => !(s.kind === 'capture' && s.capture?.agentId === agentId),
    );
    const srcIds = new Set(sources.map((s) => s.id));
    const routes = ((content.routes ?? []) as Array<{ sourceId: string }>).filter((r) => srcIds.has(r.sourceId));
    content.sources = sources;
    content.routes = routes;
    await writeContent(content, relay);
  });
}
