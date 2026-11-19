import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import sharp from 'sharp';
import { documentKind, PresentationDocuments } from '../src/presentation-documents.js';

function pdfFixture() {
  const contents = ['q 0.15 0.45 0.8 rg 0 0 640 360 re f Q BT /F1 32 Tf 1 1 1 rg 50 180 Td (First slide) Tj ET', 'q 0.2 0.7 0.4 rg 0 0 360 640 re f Q BT /F1 24 Tf 1 1 1 rg 30 320 Td (Second page) Tj ET'];
  const objects = [
    '<< /Type /Catalog /Pages 2 0 R >>', '<< /Type /Pages /Count 2 /Kids [3 0 R 4 0 R] >>',
    '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 640 360] /Resources << /Font << /F1 5 0 R >> >> /Contents 6 0 R >>',
    '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 360 640] /Resources << /Font << /F1 5 0 R >> >> /Contents 7 0 R >>',
    '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>', ...contents.map(value => `<< /Length ${value.length} >>\nstream\n${value}\nendstream`),
  ];
  let document = '%PDF-1.4\n', offsets = [0];
  for (const [index, object] of objects.entries()) { offsets.push(Buffer.byteLength(document)); document += `${index + 1} 0 obj\n${object}\nendobj\n`; }
  const xref = Buffer.byteLength(document); document += `xref\n0 ${offsets.length}\n0000000000 65535 f \n`;
  for (const offset of offsets.slice(1)) document += `${String(offset).padStart(10, '0')} 00000 n \n`;
  return document + `trailer\n<< /Size ${offsets.length} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`;
}
async function fixture() {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'lumen-document-test-'));
  const service = new PresentationDocuments({ dataDir: directory, mediaDir: path.join(directory, 'media'), converter: async () => null });
  return { directory, service, async close() { await service.close(); await fs.rm(directory, { recursive: true, force: true }); } };
}
test('PDF renders real high-resolution pages, protects staging, and commits a selected subset idempotently', async () => {
  const f = await fixture();
  try {
    const input = path.join(f.directory, 'upload.pdf'); await fs.writeFile(input, pdfFixture());
    const job = await f.service.start(input, 'Prayer briefing.pdf', 'channel', 'operator');
    assert.throws(() => f.service.get(job.id, 'someone-else'), /no longer available/);
    const stored = f.service.get(job.id, 'operator'); await stored.work;
    assert.equal(job.state, 'ready', job.error); assert.equal(job.totalPages, 2);
    assert.deepEqual(job.pages.map(({ width, height }) => [width, height]), [[3840, 2160], [2160, 3840]]);
    const stats = await sharp(path.join(stored.directory, 'page-1.png')).stats();
    assert.ok(stats.channels[2].mean > stats.channels[0].mean + 50, 'rendered pixels retain the blue page background');
    await assert.rejects(f.service.commit(job.id, 'operator', [0]), /valid page/);
    const result = await f.service.commit(job.id, 'operator', [2, 2]);
    assert.equal(result.pages.length, 1); assert.equal(result.pages[0].page, 2);
    assert.deepEqual(await f.service.commit(job.id, 'operator', [1]), result, 'retry cannot duplicate or change an already committed import');
    const promoted = path.join(f.directory, result.pages[0].path); await fs.access(promoted);
    await f.service.remove(job.id, 'operator'); await fs.access(promoted);
    assert.equal(await fs.readFile(path.join(f.directory, 'presentation-documents', job.id, 'source.pdf'), 'utf8'), pdfFixture());
  } finally { await f.close(); }
});
test('type checks, missing converter, malformed PDFs and cancellation fail without promoted assets', async () => {
  const f = await fixture();
  try {
    assert.equal(documentKind('meeting.PPTX'), 'powerpoint'); assert.equal(documentKind('active.pptm'), null);
    const wrong = path.join(f.directory, 'wrong'); await fs.writeFile(wrong, 'not-a-pdf');
    await assert.rejects(f.service.start(wrong, 'wrong.pdf', 'channel', 'operator'), /does not match/);
    const ppt = path.join(f.directory, 'ppt'); await fs.writeFile(ppt, Buffer.from('504b030400000000', 'hex'));
    await assert.rejects(f.service.start(ppt, 'talk.pptx', 'channel', 'operator'), /not installed/);
    const malformed = path.join(f.directory, 'bad'); await fs.writeFile(malformed, '%PDF-1.7 broken document');
    const bad = await f.service.start(malformed, 'bad.pdf', 'channel', 'operator'); await f.service.get(bad.id, 'operator').work;
    assert.equal(bad.state, 'error'); await assert.rejects(f.service.commit(bad.id, 'operator', [1]), /Wait until/);
    await f.service.remove(bad.id, 'operator');
    const valid = path.join(f.directory, 'cancel'); await fs.writeFile(valid, pdfFixture());
    const cancelled = await f.service.start(valid, 'cancel.pdf', 'channel', 'operator');
    await f.service.remove(cancelled.id, 'operator');
    assert.throws(() => f.service.get(cancelled.id, 'operator'), /no longer available/);
    assert.equal(await fs.stat(path.join(f.directory, 'media/backgrounds')).then(() => true, () => false), false);
  } finally { await f.close(); }
});
test('only one concurrent document preparation is accepted', async () => {
  const f = await fixture();
  try {
    const a = path.join(f.directory, 'a'), b = path.join(f.directory, 'b'); await fs.writeFile(a, pdfFixture()); await fs.writeFile(b, pdfFixture());
    const results = await Promise.allSettled([f.service.start(a, 'a.pdf', 'channel', 'operator'), f.service.start(b, 'b.pdf', 'channel', 'operator')]);
    assert.equal(results.filter(result => result.status === 'fulfilled').length, 1);
    assert.equal(results.filter(result => result.status === 'rejected').length, 1);
  } finally { await f.close(); }
});
