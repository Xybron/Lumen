import fs from 'node:fs/promises';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { fork, spawn, type ChildProcess, type ForkOptions } from 'node:child_process';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { ProductionError } from './production-store.js';
import type { PresentationDocumentImport, PresentationDocumentJob, PresentationDocumentKind } from '../../shared/presentation-documents.js';

export const DOCUMENT_LIMIT_BYTES = 100 * 1024 * 1024;
const lifetime = 60 * 60 * 1000;
export function documentKind(filename: string): PresentationDocumentKind | null {
  return /\.pdf$/i.test(filename) ? 'pdf' : /\.(pptx|ppt)$/i.test(filename) ? 'powerpoint' : null;
}
export async function documentConverter() {
  const configured = process.env.LUMEN_SOFFICE_PATH;
  const candidates = configured ? [configured] : process.platform === 'darwin' ? ['/Applications/LibreOffice.app/Contents/MacOS/soffice']
    : process.platform === 'win32' ? [path.join(process.env.ProgramFiles || 'C:\\Program Files', 'LibreOffice/program/soffice.com'), path.join(process.env['ProgramFiles(x86)'] || 'C:\\Program Files (x86)', 'LibreOffice/program/soffice.com')]
    : ['/usr/bin/libreoffice', '/usr/bin/soffice'];
  for (const candidate of candidates) if (path.isAbsolute(candidate) && await fs.stat(candidate).then(value => value.isFile(), () => false)) return candidate;
  return null;
}
function stopProcess(child: ChildProcess) {
  if (!child.pid || child.exitCode !== null) return;
  if (process.platform === 'win32') {
    const kill = spawn('taskkill', ['/pid', String(child.pid), '/t', '/f'], { windowsHide: true, stdio: 'ignore' }); kill.on('error', () => child.kill());
  } else { try { process.kill(-child.pid, 'SIGKILL'); } catch { child.kill('SIGKILL'); } }
}
interface StoredJob { snapshot: PresentationDocumentJob; userId: string; channelId: string; directory: string; input: string; expires: number; abort: AbortController; work?: Promise<void>; committed?: PresentationDocumentImport; committing?: Promise<PresentationDocumentImport> }
interface Options { dataDir: string; mediaDir: string; converter?: () => Promise<string | null>; worker?: string }

export class PresentationDocuments {
  private jobs = new Map<string, StoredJob>();
  private active: string | null = null;
  private starting = false;
  private closed = false;
  private timer: ReturnType<typeof setInterval>;
  constructor(private options: Options) {
    this.timer = setInterval(() => { for (const [id, job] of this.jobs) if (job.expires < Date.now() && !job.committing) void this.remove(id, job.userId).catch(() => {}); }, 60_000);
    this.timer.unref();
  }
  async available() { return { pdf: true, powerpoint: !!await (this.options.converter ?? documentConverter)(), maxBytes: DOCUMENT_LIMIT_BYTES, maxPages: 200 }; }
  get(id: string, userId: string) {
    const job = this.jobs.get(id);
    if (!job || job.userId !== userId) throw new ProductionError(404, 'This import is no longer available. Choose the document again.');
    job.expires = Date.now() + lifetime;
    return job;
  }
  async start(upload: string, sourceName: string, channelId: string, userId: string) {
    if (this.starting) throw new ProductionError(409, 'Another document is being prepared. Wait for it to finish before importing another.');
    this.starting = true;
    try { return await this.startUnlocked(upload, sourceName, channelId, userId); }
    finally { this.starting = false; }
  }
  private async startUnlocked(upload: string, sourceName: string, channelId: string, userId: string) {
    if (this.closed) throw new ProductionError(503, 'This station is shutting down.');
    if (this.active) throw new ProductionError(409, 'Another document is being prepared. Wait for it to finish before importing another.');
    if (this.jobs.size >= 8) throw new ProductionError(409, 'Close an existing document import before starting another.');
    const sourceType = documentKind(sourceName);
    if (!sourceType) throw new ProductionError(422, 'Choose a PDF, PPT or PPTX file.');
    const stat = await fs.stat(upload);
    if (!stat.size || stat.size > DOCUMENT_LIMIT_BYTES) throw new ProductionError(422, 'Choose a non-empty document smaller than 100 MB.');
    const handle = await fs.open(upload, 'r'); const header = Buffer.alloc(8);
    try { await handle.read(header, 0, header.length, 0); } finally { await handle.close(); }
    const valid = sourceType === 'pdf' ? header.toString('ascii', 0, 5) === '%PDF-'
      : /\.pptx$/i.test(sourceName) ? header.subarray(0, 4).equals(Buffer.from([0x50, 0x4b, 3, 4])) : header.equals(Buffer.from('d0cf11e0a1b11ae1', 'hex'));
    if (!valid) throw new ProductionError(422, 'This file does not match its document type. Export a new PDF or PowerPoint and try again.');
    const converter = sourceType === 'powerpoint' ? await (this.options.converter ?? documentConverter)() : null;
    if (sourceType === 'powerpoint' && !converter) throw new ProductionError(503, 'PowerPoint conversion is not installed on this station. Install the current Lumen desktop build or LibreOffice, or export your presentation as PDF.');
    const id = `doc_${randomUUID()}`, directory = path.join(this.options.dataDir, 'document-imports', id);
    this.active = id;
    try {
      await fs.mkdir(directory, { recursive: true });
      const input = path.join(directory, `source${path.extname(sourceName).toLowerCase()}`);
      await fs.rename(upload, input);
      const snapshot: PresentationDocumentJob = { id, sourceName: path.basename(sourceName).slice(0, 240), sourceType, state: sourceType === 'pdf' ? 'rendering' : 'converting', completedPages: 0, totalPages: 0, pages: [] };
      const job: StoredJob = { snapshot, userId, channelId, directory, input, expires: Date.now() + lifetime, abort: new AbortController() };
      this.jobs.set(id, job);
      job.work = this.prepare(job, converter).catch(error => {
        snapshot.state = 'error'; snapshot.error = job.abort.signal.aborted ? 'Document import cancelled.' : (error as Error).message;
      }).finally(() => { if (this.active === id) this.active = null; });
      return snapshot;
    } catch (error) { this.active = null; await fs.rm(directory, { recursive: true, force: true }); throw error; }
  }
  private async prepare(job: StoredJob, converter: string | null) {
    let pdf = job.input;
    if (converter) {
      const profile = path.join(job.directory, 'profile'); await fs.mkdir(path.join(profile, 'user'), { recursive: true });
      // Isolated profile; embedded macros are disabled and documents do not
      // update external links. No operator LibreOffice session/profile is used.
      await fs.writeFile(path.join(profile, 'user/registrymodifications.xcu'), '<?xml version="1.0" encoding="UTF-8"?><oor:items xmlns:oor="http://openoffice.org/2001/registry"><item oor:path="/org.openoffice.Office.Common/Security/Scripting"><prop oor:name="MacroSecurityLevel" oor:op="fuse"><value>3</value></prop></item><item oor:path="/org.openoffice.Office.Common/Load"><prop oor:name="UpdateLinkMode" oor:op="fuse"><value>0</value></prop></item></oor:items>');
      await this.convert(converter, [`-env:UserInstallation=${pathToFileURL(profile).href}`, '--headless', '--nologo', '--nodefault', '--norestore', '--convert-to', 'pdf:impress_pdf_Export', '--outdir', job.directory, job.input], job.abort.signal);
      pdf = path.join(job.directory, 'source.pdf');
      if (!await fs.stat(pdf).then(value => value.isFile() && value.size > 0 && value.size <= DOCUMENT_LIMIT_BYTES * 2, () => false)) throw new Error('PowerPoint conversion failed. Check the file in PowerPoint or export it as PDF and try again.');
    }
    job.snapshot.state = 'rendering';
    await this.render(pdf, job);
    job.snapshot.state = 'ready';
  }
  private convert(executable: string, args: string[], signal: AbortSignal) {
    return new Promise<void>((resolve, reject) => {
      const child = spawn(executable, args, { windowsHide: true, detached: process.platform !== 'win32', stdio: 'ignore' });
      let settled = false;
      const done = (error?: Error) => { if (settled) return; settled = true; clearTimeout(timer); signal.removeEventListener('abort', abort); error ? reject(error) : resolve(); };
      const abort = () => { stopProcess(child); done(new Error('Document import cancelled.')); };
      const timer = setTimeout(() => { stopProcess(child); done(new Error('PowerPoint conversion took too long. Export this document as PDF and try again.')); }, 180_000);
      signal.addEventListener('abort', abort, { once: true }); if (signal.aborted) abort();
      child.once('error', () => done(new Error('The PowerPoint converter could not start. Reinstall the Lumen desktop build or import a PDF.')));
      child.once('exit', code => done(code === 0 ? undefined : new Error('PowerPoint conversion failed. Export this document as PDF and try again.')));
    });
  }
  private render(pdf: string, job: StoredJob) {
    return new Promise<void>((resolve, reject) => {
      const worker = this.options.worker ?? fileURLToPath(new URL(import.meta.url.endsWith('.ts') ? './document-render-worker.ts' : './document-render-worker.js', import.meta.url));
      const options: ForkOptions & { windowsHide: boolean } = { detached: process.platform !== 'win32', windowsHide: true, stdio: ['ignore', 'ignore', 'ignore', 'ipc'], execArgv: [...process.execArgv.filter(value => !value.startsWith('--test')), '--max-old-space-size=1024'] };
      const child = fork(worker, [], options);
      let settled = false, completed = false;
      const done = (error?: Error) => { if (settled) return; settled = true; clearTimeout(timer); job.abort.signal.removeEventListener('abort', abort); if (error) stopProcess(child); error ? reject(error) : resolve(); };
      const abort = () => done(new Error('Document import cancelled.'));
      const timer = setTimeout(() => done(new Error('Document rendering took too long. Split the document into smaller files.')), 180_000);
      job.abort.signal.addEventListener('abort', abort, { once: true });
      child.on('message', (message: any) => {
        if (message.error) return done(new Error(String(message.error)));
        if (message.done) { completed = true; return; }
        if (message.page) {
          const { page, width, height, total } = message.page;
          job.snapshot.totalPages = total; job.snapshot.completedPages = page;
          job.snapshot.pages.push({ page, width, height, previewUrl: `/api/presentation-documents/${job.snapshot.id}/pages/${page}` });
        }
      });
      child.once('error', () => done(new Error('The PDF renderer could not start. Reinstall the Lumen desktop build.')));
      child.once('exit', code => done(code === 0 && completed ? undefined : new Error('This document could not be rendered. Export a new PDF and try again.')));
      child.send({ input: pdf, output: job.directory }); if (job.abort.signal.aborted) abort();
    });
  }
  async commit(id: string, userId: string, selected: number[]) {
    const job = this.get(id, userId);
    if (job.committed) return job.committed;
    if (job.committing) return job.committing;
    if (job.snapshot.state !== 'ready') throw new ProductionError(409, 'Wait until all pages are prepared before importing.');
    const pages = [...new Set(selected)].sort((a, b) => a - b);
    if (!pages.length || pages.some(page => !Number.isInteger(page) || page < 1 || page > job.snapshot.totalPages)) throw new ProductionError(422, 'Select at least one valid page.');
    job.committing = (async () => {
      const promoted: string[] = [], originalDir = path.join(this.options.dataDir, 'presentation-documents', id);
      await fs.mkdir(path.join(this.options.mediaDir, 'backgrounds'), { recursive: true });
      try {
        await fs.mkdir(originalDir, { recursive: true });
        await fs.copyFile(job.input, path.join(originalDir, path.basename(job.input)));
        const result: PresentationDocumentImport = { sourceId: id, sourceName: job.snapshot.sourceName, sourceType: job.snapshot.sourceType, totalPages: job.snapshot.totalPages, pages: [] };
        for (const page of pages) {
          const info = job.snapshot.pages[page - 1], name = `${id}-page-${page}.png`, target = path.join(this.options.mediaDir, 'backgrounds', name);
          await fs.copyFile(path.join(job.directory, `page-${page}.png`), target, fs.constants.COPYFILE_EXCL); promoted.push(target);
          result.pages.push({ page, title: `${job.snapshot.sourceName} · ${page}`, path: `media/backgrounds/${name}`, width: info.width, height: info.height });
        }
        await fs.writeFile(path.join(originalDir, 'manifest.json'), JSON.stringify(result, null, 2));
        job.committed = result; return result;
      } catch (error) { await Promise.all(promoted.map(file => fs.rm(file, { force: true }))); await fs.rm(originalDir, { recursive: true, force: true }); throw error; }
    })();
    try { return await job.committing; } finally { job.committing = undefined; }
  }
  async remove(id: string, userId: string) {
    const job = this.get(id, userId);
    if (job.committing) await job.committing.catch(() => {});
    job.abort.abort(); await job.work; this.jobs.delete(id);
    await fs.rm(job.directory, { recursive: true, force: true });
  }
  async close() { this.closed = true; clearInterval(this.timer); await Promise.all([...this.jobs].map(([id, job]) => this.remove(id, job.userId))); }
}
