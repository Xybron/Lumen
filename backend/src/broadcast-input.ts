import type { Writable } from 'node:stream';

export class BroadcastInputError extends Error {
  constructor(public reason: 'input-stalled' | 'input-backlog' | 'encoder-exit') {
    super(reason);
  }
}

/** A busy encoder may still be producing output while draining a large chunk.
 * Permit that progress, but never wait indefinitely or raise the memory cap. */
export function writeBroadcastInput(input: Writable, bytes: Buffer, options: {
  limit: number;
  progress: () => number;
  idleMs?: number;
  maximumMs?: number;
}): Promise<void> {
  if (input.destroyed || input.writableEnded) return Promise.reject(new BroadcastInputError('encoder-exit'));
  if (input.writableLength + bytes.length > options.limit) return Promise.reject(new BroadcastInputError('input-backlog'));
  return new Promise((resolve, reject) => {
    const started = Date.now();
    let changedAt = started, progress = options.progress(), settled = false;
    const finish = (error?: Error | null) => {
      if (settled) return;
      settled = true; clearInterval(timer); input.off('close', closed);
      if (error) reject(error); else resolve();
    };
    const closed = () => finish(new BroadcastInputError('encoder-exit'));
    const timer = setInterval(() => {
      const next = options.progress(), now = Date.now();
      if (next > progress) { progress = next; changedAt = now; }
      if (now - started >= (options.maximumMs ?? 16_000) || now - changedAt >= (options.idleMs ?? 8000)) finish(new BroadcastInputError('input-stalled'));
    }, 250);
    timer.unref(); input.once('close', closed);
    try { input.write(bytes, error => finish(error ? new BroadcastInputError('encoder-exit') : undefined)); }
    catch { finish(new BroadcastInputError('encoder-exit')); }
  });
}
