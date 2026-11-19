import fs from 'node:fs/promises';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import type { BroadcastIncident } from '../../shared/broadcast.js';

const count = z.number().finite().nonnegative();
const schema = z.object({
  at: z.string().datetime(),
  reason: z.enum(['input-stalled', 'input-backlog', 'encoder-exit', 'source-stalled', 'destinations-failed']),
  encoder: z.enum(['worker-h264', 'videotoolbox', 'mediafoundation', 'software']).nullable(),
  encoderFailure: z.enum(['protocol', 'certificate', 'publish-rejected', 'network', 'encoder', 'input', 'storage', 'backpressure', 'unknown']),
  profile: z.enum(['720p', '1080p']), destinations: count.max(4), queuedBytes: count, pendingInputBytes: count,
  maxInputWaitMs: count, inputAgeMs: count.nullable(), outputAgeMs: count.nullable(),
}).strict();

/** Store only bounded measurements and finite codes, never settings, media,
 * FFmpeg arguments, stderr, URLs, keys, or raw renderer error strings. */
export async function createBroadcastHealth(directory: string) {
  const filename = path.join(directory, 'broadcast-health.json');
  let latest: BroadcastIncident | null = null;
  try {
    const info = await fs.lstat(filename);
    if (info.isFile() && !info.isSymbolicLink() && info.size <= 4096) latest = schema.parse(JSON.parse(await fs.readFile(filename, 'utf8')));
  } catch { /* Diagnostics never block production or repair private settings. */ }
  let writes: Promise<void> = Promise.resolve();
  return {
    latest: () => latest ? { ...latest } : null,
    record(value: BroadcastIncident) {
      latest = schema.parse(value);
      const contents = JSON.stringify(latest);
      writes = writes.then(async () => {
        const temporary = `${filename}.${randomUUID()}.tmp`;
        try { await fs.writeFile(temporary, contents, { mode: 0o600, flag: 'wx' }); await fs.rename(temporary, filename); }
        catch { /* Recording/stream teardown must continue if diagnostics cannot be saved. */ }
        finally { await fs.unlink(temporary).catch(() => {}); }
      });
    },
    flush: () => writes,
  };
}
