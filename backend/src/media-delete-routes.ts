import { Router } from 'express';
import path from 'node:path';
import { requireSession } from './auth.js';
import { MEDIA_DIR, MEDIA_KINDS, safeMediaPath, type MediaKind } from './paths.js';
import { ProductionError } from './production-store.js';
import type { ProductionTransferAdapter } from './production-data-transfer.js';
import { MediaUsageError, removeLibraryFile, requireMediaAuthor } from './media-catalog.js';

export function createMediaDeleteRouter(production: Pick<ProductionTransferAdapter, 'withUnusedMedia'>) {
  const router = Router();
  router.delete('/media/:kind/:filename', requireSession, requireMediaAuthor, async (req, res) => {
    const kind = req.params.kind as MediaKind;
    if (!MEDIA_KINDS.includes(kind)) return res.status(400).json({ error: 'Choose a supported media library.' });
    const target = safeMediaPath(kind, String(req.params.filename));
    if (!target || path.basename(target) !== req.params.filename) return res.status(400).json({ error: 'Choose a valid media file.' });
    const id = `media/${kind}/${path.basename(target)}`;
    const converted = kind === 'backgrounds' && /\.mov$/i.test(target) ? target.replace(/\.mov$/i, '.mp4') : null;
    try {
      await production.withUnusedMedia([id, ...(converted ? [id.replace(/\.mov$/i, '.mp4')] : [])], async () => {
        await removeLibraryFile(MEDIA_DIR, kind, path.basename(target));
      });
      res.json({ ok: true });
    } catch (error) {
      if (error instanceof MediaUsageError) return res.status(error.status).json({ error: error.message, usage: error.usage });
      if (error instanceof ProductionError) return res.status(error.status).json({ error: error.message });
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return res.status(404).json({ error: 'This media file was already removed.' });
      res.status(500).json({ error: 'This media could not be deleted. Please try again.' });
    }
  });
  return router;
}
