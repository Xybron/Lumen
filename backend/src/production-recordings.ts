import fs from 'node:fs/promises';
import { createReadStream, createWriteStream } from 'node:fs';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import path from 'node:path';
import ffmpeg from 'ffmpeg-static';
import { atomicWriteJson } from './atomic.js';
import { ProductionError } from './production-store.js';
import type { StudioRecording } from '../../shared/production.js';

interface SavedRecording extends StudioRecording { nextChunk: number }
export class RecordingStore {
  private records = new Map<string, SavedRecording>();
  private chains = new Map<string, Promise<unknown>>();
  constructor(private dir: string, private changed: () => void) {}
  async init() {
    await fs.mkdir(this.dir, { recursive: true });
    for (const name of await fs.readdir(this.dir)) {
      if (!/^rec_[\w-]+$/.test(name)) continue;
      try {
        const r: SavedRecording = JSON.parse(await fs.readFile(path.join(this.dir, name, 'recording.json'), 'utf8'));
        if (r.id !== name) continue;
        if (['starting', 'recording', 'stopping', 'finalizing'].includes(r.status)) {
          r.status = 'interrupted'; r.error = 'Station restarted. Saved chunks can be recovered.';
          // A crash between chunk fsync and metadata commit must not lose the
          // last durable chunk or cause a duplicate append on recovery.
          const parts = (await fs.readdir(path.join(this.dir, name))).filter(f => /^\d{8}\.part$/.test(f)).sort();
          r.nextChunk = 0; r.bytes = 0;
          for (const part of parts) {
            if (part !== `${String(r.nextChunk).padStart(8, '0')}.part`) break;
            r.bytes += (await fs.stat(path.join(this.dir, name, part))).size; r.nextChunk++;
          }
          await this.persist(r);
        }
        this.records.set(r.id, r);
      } catch (error) { console.warn('[studio] Could not read recording metadata:', name, (error as Error).message); }
    }
  }
  list(): StudioRecording[] {
    return [...this.records.values()].sort((a, b) => b.createdAt.localeCompare(a.createdAt)).map(({ nextChunk: _, ...r }) => ({ ...r }));
  }
  active() { return this.list().find(r => ['starting', 'recording', 'stopping'].includes(r.status)) ?? null; }
  private async persist(r: SavedRecording) { await atomicWriteJson(path.join(this.dir, r.id, 'recording.json'), r); }
  private serial<T>(id: string, fn: () => Promise<T>): Promise<T> {
    const run = (this.chains.get(id) ?? Promise.resolve()).then(fn);
    this.chains.set(id, run.catch(() => {}));
    return run;
  }
  async create(name: string) {
    if (this.active()) throw new ProductionError(409, 'A recording is already in progress.');
    const r: SavedRecording = {
      id: `rec_${randomUUID()}`, name, status: 'starting', createdAt: new Date().toISOString(),
      durationMs: 0, bytes: 0, nextChunk: 0,
    };
    // Reserve before the first await so simultaneous starts cannot both win.
    this.records.set(r.id, r);
    try { await fs.mkdir(path.join(this.dir, r.id)); await this.persist(r); }
    catch (e) { this.records.delete(r.id); throw e; }
    this.changed(); return { ...r };
  }
  async setStatus(id: string, status: SavedRecording['status'], error?: string) {
    return this.serial(id, async () => {
      const r = this.require(id);
      r.status = status; r.error = error;
      await this.persist(r); this.changed();
    });
  }
  private require(id: string) {
    const r = this.records.get(id);
    if (!r) throw new ProductionError(404, 'Recording not found.');
    return r;
  }
  async chunk(id: string, sequence: number, bytes: Buffer) {
    return this.serial(id, async () => {
      const r = this.require(id);
      if (sequence < r.nextChunk) return; // idempotent network retry
      if (!['starting', 'recording', 'stopping'].includes(r.status)) throw new ProductionError(409, 'Recording is closed.');
      if (sequence !== r.nextChunk) throw new ProductionError(409, `Expected chunk ${r.nextChunk}.`);
      const filename = path.join(this.dir, id, `${String(sequence).padStart(8, '0')}.part`);
      const tmp = `${filename}.tmp`;
      const handle = await fs.open(tmp, 'w');
      try { await handle.writeFile(bytes); await handle.sync(); } finally { await handle.close(); }
      await fs.rename(tmp, filename);
      r.nextChunk++; r.bytes += bytes.length;
      if (r.status === 'starting') r.status = 'recording';
      r.durationMs = Date.now() - Date.parse(r.createdAt);
      await this.persist(r); this.changed();
    });
  }
  async finish(id: string, durationMs?: number) {
    await this.serial(id, async () => {
      const r = this.require(id);
      if (r.status === 'complete' || r.status === 'finalizing') return;
      if (!r.nextChunk) throw new ProductionError(409, 'No recorded media has arrived yet.');
      if (durationMs !== undefined) r.durationMs = durationMs;
      r.status = 'finalizing'; r.error = undefined;
      await this.persist(r); this.changed();
      // The request acknowledges the queued finalization. MediaRecorder chunks
      // form ONE stream; they are joined in sequence, never treated as clips.
      void this.remux(r).catch(async error => {
        r.status = 'error'; r.error = `Finalization failed: ${(error as Error).message}. Saved chunks are retained; retry recovery.`;
        try { await this.persist(r); }
        catch (storageError) { console.error('[studio] Could not persist finalization error:', storageError); }
        this.changed();
      });
    });
  }
  private async remux(r: SavedRecording) {
    const dir = path.join(this.dir, r.id);
    const input = path.join(dir, 'capture.webm');
    const nextChunk = r.nextChunk;
    async function* parts() {
      for (let i = 0; i < nextChunk; i++) {
        for await (const data of createReadStream(path.join(dir, `${String(i).padStart(8, '0')}.part`))) yield data;
      }
    }
    await pipeline(Readable.from(parts()), createWriteStream(input));
    const executable = ffmpeg;
    if (!executable) throw new Error('FFmpeg is unavailable');
    const temp = path.join(dir, 'finalizing.webm');
    await new Promise<void>((resolve, reject) => {
      const proc = spawn(executable, ['-hide_banner', '-loglevel', 'error', '-y', '-i', input, '-map', '0', '-c', 'copy', '-f', 'webm', temp], { stdio: ['ignore', 'ignore', 'pipe'] });
      let stderr = '';
      proc.stderr.on('data', b => { stderr = (stderr + b).slice(-4000); });
      proc.once('error', reject);
      proc.once('close', code => code === 0 ? resolve() : reject(new Error(stderr || `FFmpeg exited ${code}`)));
    });
    await fs.rename(temp, path.join(dir, 'recording.webm'));
    r.bytes = (await fs.stat(path.join(dir, 'recording.webm'))).size;
    r.status = 'complete'; r.error = undefined;
    await this.persist(r); this.changed();
  }
  download(id: string) {
    const r = this.require(id);
    if (r.status !== 'complete') throw new ProductionError(409, 'This recording is not finalized yet.');
    return { path: path.join(this.dir, id, 'recording.webm'), name: `${r.name.replace(/[^\w .-]/g, '_')}.webm` };
  }
  async interruptActive(reason: string) {
    const active = this.active();
    if (active) await this.setStatus(active.id, 'interrupted', reason);
  }
}
