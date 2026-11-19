import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { fileURLToPath } from 'node:url';
import sharp from 'sharp';
import { PresentationDocuments } from '../src/presentation-documents.js';

const bundled = fileURLToPath(new URL('../../desktop/build/resources/documents/LibreOffice.app/Contents/MacOS/soffice', import.meta.url));
const converter = process.env.LUMEN_SOFFICE_PATH || (await fs.stat(bundled).then(() => bundled, () => ''));
test('official local LibreOffice converts a real PPTX with text, shapes and image into Program-ready pages', { skip: !converter }, async () => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'lumen-powerpoint-test-'));
  const service = new PresentationDocuments({ dataDir: directory, mediaDir: path.join(directory, 'media'), converter: async () => converter });
  try {
    const input = path.join(directory, 'upload.pptx'); await fs.copyFile(new URL('./fixtures/presentation-static.pptx', import.meta.url), input);
    const job = await service.start(input, 'Prayer gathering.pptx', 'channel', 'operator');
    await service.get(job.id, 'operator').work;
    assert.equal(job.state, 'ready', job.error); assert.equal(job.totalPages, 2);
    const result = await service.commit(job.id, 'operator', [1, 2]);
    assert.equal(result.sourceType, 'powerpoint'); assert.equal(result.pages[0].width, 3840); assert.equal(result.pages[0].height, 2160);
    if (process.env.LUMEN_DOCUMENT_PREVIEW) await fs.copyFile(path.join(directory, result.pages[0].path), process.env.LUMEN_DOCUMENT_PREVIEW);
    const picture = sharp(path.join(directory, result.pages[0].path));
    const sample = async (region: { left: number; top: number; width: number; height: number }) => sharp(await picture.clone().extract(region).toBuffer()).stats();
    const background = await sample({ left: 10, top: 10, width: 100, height: 100 });
    assert.ok(background.channels[2].mean > background.channels[0].mean + 40, 'the original blue slide background survives conversion');
    const image = await sample({ left: 2500, top: 700, width: 200, height: 200 });
    assert.ok(image.channels[0].mean > image.channels[2].mean + 80, 'the embedded orange image survives conversion');
    const title = await sample({ left: 170, top: 140, width: 2500, height: 260 });
    assert.ok(title.channels[0].max > 230 && title.channels[0].stdev > 20, 'the slide title renders visibly');
  } finally { await service.close(); await fs.rm(directory, { recursive: true, force: true }); }
});
