// Run PDF decoding in a disposable process: malformed/large documents cannot
// monopolize the station event loop, and cancellation can stop native rendering.
import fs from 'node:fs/promises';
import path from 'node:path';
import { createRequire } from 'node:module';
import { getDocument } from 'pdfjs-dist/legacy/build/pdf.mjs';

const require = createRequire(import.meta.url);
const pdfRoot = path.dirname(require.resolve('pdfjs-dist/package.json'));

export async function renderDocument(input: string, output: string, onPage: (page: { page: number; width: number; height: number; total: number }) => void) {
  const loading = getDocument({
    data: new Uint8Array(await fs.readFile(input)),
    cMapUrl: path.join(pdfRoot, 'cmaps') + path.sep, cMapPacked: true,
    standardFontDataUrl: path.join(pdfRoot, 'standard_fonts') + path.sep,
    wasmUrl: path.join(pdfRoot, 'wasm') + path.sep,
    useSystemFonts: false, verbosity: 0,
  });
  const document = await loading.promise;
  try {
    if (!document.numPages || document.numPages > 200) throw new Error('Choose a document with 1–200 pages. Split a larger document into smaller files.');
    let bytes = 0;
    for (let index = 1; index <= document.numPages; index++) {
      const page = await document.getPage(index), original = page.getViewport({ scale: 1 });
      if (![original.width, original.height].every(value => Number.isFinite(value) && value > 0)) throw new Error('This document has an invalid page size.');
      const viewport = page.getViewport({ scale: 3840 / Math.max(original.width, original.height) });
      const factory = document.canvasFactory as { create(width: number, height: number): { canvas: HTMLCanvasElement & { toBuffer(type: string): Buffer }; context: CanvasRenderingContext2D }; destroy(value: unknown): void };
      const canvas = factory.create(Math.ceil(viewport.width), Math.ceil(viewport.height));
      try {
        await page.render({ canvasContext: canvas.context, canvas: canvas.canvas, viewport, background: 'rgb(255,255,255)' }).promise;
        const png = canvas.canvas.toBuffer('image/png');
        bytes += png.length;
        if (bytes > 1024 * 1024 * 1024) throw new Error('Rendered pages exceed 1 GB. Split this document into smaller files.');
        await fs.writeFile(path.join(output, `page-${index}.png`), png, { flag: 'wx' });
        onPage({ page: index, width: canvas.canvas.width, height: canvas.canvas.height, total: document.numPages });
      } finally { factory.destroy(canvas); page.cleanup(); }
    }
  } finally { await loading.destroy(); }
}

if (process.send) process.once('message', (message: { input: string; output: string }) => {
  void renderDocument(message.input, message.output, page => process.send?.({ page })).then(() => {
    process.send?.({ done: true }); process.disconnect?.();
  }).catch(error => {
    const text = error?.name === 'PasswordException' ? 'This PDF is password protected. Export an unlocked copy and try again.'
      : error?.name === 'InvalidPDFException' ? 'This PDF could not be read. Export a new PDF and try again.' : error?.message || 'The document could not be rendered.';
    process.send?.({ error: text }); process.disconnect?.(); process.exitCode = 1;
  });
});
