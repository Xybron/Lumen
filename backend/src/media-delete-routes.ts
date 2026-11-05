import { Router } from 'express';
import fs from 'node:fs/promises';
import path from 'node:path';
import { requireSession } from './auth.js';
import { MEDIA_DIR, MEDIA_KINDS, safeMediaPath, type MediaKind } from './paths.js';
import { ProductionError } from './production-store.js';
import type { ProductionTransferAdapter } from './production-data-transfer.js';

export function createMediaDeleteRouter(production: Pick<ProductionTransferAdapter, 'withUnusedMedia'>) {
  const router = Router();
  router.delete('/media/:kind/:filename', requireSession, async (req, res) => {
    const kind = req.params.kind as MediaKind;
    if (!MEDIA_KINDS.includes(kind)) return res.status(400).json({ error: 'Choose a supported media library.' });
    const target = safeMediaPath(kind, String(req.params.filename));
    if (!target) return res.status(400).json({ error: 'Choose a valid media file.' });
    const id = `media/${kind}/${path.basename(target)}`;
    const converted = kind === 'backgrounds' && /\.mov$/i.test(target) ? target.replace(/\.mov$/i, '.mp4') : null;
    try {
      await production.withUnusedMedia([id, ...(converted ? [id.replace(/\.mov$/i, '.mp4')] : [])], async () => {
        await fs.unlink(target);
        if (converted) await Promise.allSettled([
          fs.unlink(converted),
          fs.unlink(path.join(MEDIA_DIR, 'thumbnails', path.basename(target).replace(/\.mov$/i, '.jpg'))),
        ]);
      });
      res.json({ ok: true });
    } catch (error) {
      if (error instanceof ProductionError) return res.status(error.status).json({ error: error.message });
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return res.status(404).json({ error: 'This media file was already removed.' });
      res.status(500).json({ error: 'This media could not be deleted. Please try again.' });
    }
  });
  return router;
}
