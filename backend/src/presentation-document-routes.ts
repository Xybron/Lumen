import { Router, type Request, type Response } from 'express';
import multer from 'multer';
import fs from 'node:fs/promises';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { requireSession, userCan, type SessionUser } from './auth.js';
import { DATA_DIR, MEDIA_DIR, CONTENT_FILE } from './paths.js';
import { DOCUMENT_LIMIT_BYTES, PresentationDocuments } from './presentation-documents.js';
import { ProductionError } from './production-store.js';

export function createPresentationDocuments() {
  const service = new PresentationDocuments({ dataDir: DATA_DIR, mediaDir: MEDIA_DIR }), router = Router();
  const uploadDir = path.join(DATA_DIR, 'document-uploads');
  const upload = multer({ storage: multer.diskStorage({
    destination: (_req, _file, done) => { void fs.mkdir(uploadDir, { recursive: true }).then(() => done(null, uploadDir), error => done(error, '')); },
    filename: (_req, _file, done) => done(null, randomUUID()),
  }), limits: { fileSize: DOCUMENT_LIMIT_BYTES, files: 1, fields: 0 } }).single('file');
  router.use('/presentation-documents', requireSession, (_req, res, next) => { res.set('Cache-Control', 'private, no-store'); next(); });
  const user = (req: Request) => (req as Request & { user: SessionUser }).user;
  const fail = (res: Response, error: unknown) => {
    const code = (error as NodeJS.ErrnoException)?.code;
    res.status(error instanceof ProductionError ? error.status : code === 'ENOSPC' ? 507 : 500)
      .json({ error: error instanceof ProductionError ? error.message : code === 'ENOSPC' ? 'This station is low on storage. Free some space and try again.' : 'The document could not be imported. Try again.' });
  };
  async function authorize(req: Request, channelId: string) {
    if (!channelId || !userCan(user(req), channelId, 'author')) throw new ProductionError(403, 'Presentation author permission is required.');
    const content = JSON.parse(await fs.readFile(CONTENT_FILE, 'utf8'));
    if (!content.channels?.some((channel: { id: string }) => channel.id === channelId)) throw new ProductionError(404, 'This presentation no longer exists.');
  }
  const jobFor = async (req: Request) => { const job = service.get(String(req.params.id), user(req).id); await authorize(req, job.channelId); return job; };
  router.get('/presentation-documents/capabilities', async (_req, res) => { try { res.json(await service.available()); } catch (error) { fail(res, error); } });
  router.post('/presentation-documents', async (req, res) => {
    try { await authorize(req, typeof req.query.channelId === 'string' ? req.query.channelId : ''); }
    catch (error) { fail(res, error); return; }
    upload(req, res, async error => {
      if (error) { res.status(error instanceof multer.MulterError && error.code === 'LIMIT_FILE_SIZE' ? 413 : 400).json({ error: error instanceof multer.MulterError && error.code === 'LIMIT_FILE_SIZE' ? 'Choose a document smaller than 100 MB.' : 'Choose one PDF, PPT or PPTX file.' }); return; }
      if (!req.file) { res.status(422).json({ error: 'Choose a document to import.' }); return; }
      try {
        await authorize(req, String(req.query.channelId));
        res.status(202).json(await service.start(req.file.path, req.file.originalname, String(req.query.channelId), user(req).id));
      } catch (error) { fail(res, error); }
      finally { await fs.rm(req.file.path, { force: true }).catch(() => {}); }
    });
  });
  router.get('/presentation-documents/:id', async (req, res) => { try { res.json((await jobFor(req)).snapshot); } catch (error) { fail(res, error); } });
  router.get('/presentation-documents/:id/pages/:page', async (req, res) => {
    try {
      const job = await jobFor(req), page = Number(req.params.page);
      if (!Number.isInteger(page) || !job.snapshot.pages.some(value => value.page === page)) throw new ProductionError(404, 'This page is not available.');
      res.type('png').sendFile(path.join(job.directory, `page-${page}.png`));
    } catch (error) { fail(res, error); }
  });
  router.post('/presentation-documents/:id/commit', async (req, res) => {
    try {
      await jobFor(req);
      if (!Array.isArray(req.body?.pages) || req.body.pages.length > 200 || req.body.pages.some((page: unknown) => typeof page !== 'number')) throw new ProductionError(422, 'Choose the pages to import.');
      res.json(await service.commit(String(req.params.id), user(req).id, req.body.pages));
    } catch (error) { fail(res, error); }
  });
  router.delete('/presentation-documents/:id', async (req, res) => { try { await jobFor(req); await service.remove(String(req.params.id), user(req).id); res.status(204).end(); } catch (error) { fail(res, error); } });
  return { router, close: () => service.close() };
}
