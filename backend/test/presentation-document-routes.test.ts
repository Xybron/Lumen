import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import express from 'express';

test('document imports require authorship, keep previews private, recheck grants and never publish content', async t => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'lumen-documents-http-')), previous = process.env.LUMEN_DATA_DIR; process.env.LUMEN_DATA_DIR = directory;
  let server: http.Server | undefined, documents: ReturnType<typeof import('../src/presentation-document-routes.js')['createPresentationDocuments']> | undefined, identity: { close(): void } | undefined;
  t.after(async () => {
    server?.closeAllConnections(); if (server) await new Promise<void>(resolve => server!.close(() => resolve()));
    await documents?.close(); identity?.close();
    if (previous === undefined) delete process.env.LUMEN_DATA_DIR; else process.env.LUMEN_DATA_DIR = previous;
    await fs.rm(directory, { recursive: true, force: true });
  });
  const { DATA_DIR, CONTENT_FILE } = await import('../src/paths.js'); assert.equal(DATA_DIR, directory);
  const { initDb } = await import('../src/db.js'); identity = initDb();
  const { login, createUser, setGrant } = await import('../src/auth.js');
  const author = createUser('document-author', 'Author', 'test-password')!; setGrant(author.id, 'channel', 'author');
  const headers = { Cookie: `lumen_session=${login('document-author', 'test-password')!.sessionId}` };
  const viewer = createUser('document-viewer', 'Viewer', 'test-password')!; setGrant(viewer.id, '*', 'viewer');
  const limited = { Cookie: `lumen_session=${login('document-viewer', 'test-password')!.sessionId}` };
  const content = JSON.stringify({ version: 2, channels: [{ id: 'channel', playlistId: 'deck', kind: 'presentation' }], playlists: [{ id: 'deck', items: [] }] });
  await fs.writeFile(CONTENT_FILE, content);
  const { createPresentationDocuments } = await import('../src/presentation-document-routes.js'); documents = createPresentationDocuments();
  const app = express(); app.use(express.json()); app.use('/api', documents.router); server = http.createServer(app);
  await new Promise<void>(resolve => server!.listen(0, '127.0.0.1', resolve));
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}/api/presentation-documents`;
  assert.equal((await fetch(`${base}/capabilities`)).status, 401);
  assert.equal((await fetch(`${base}?channelId=channel`, { method: 'POST', headers: limited })).status, 403);
  const stream = '0.2 0.5 0.8 rg 0 0 320 180 re f';
  const objects = ['<< /Type /Catalog /Pages 2 0 R >>', '<< /Type /Pages /Count 1 /Kids [3 0 R] >>', '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 320 180] /Resources << >> /Contents 4 0 R >>', `<< /Length ${stream.length} >>\nstream\n${stream}\nendstream`];
  let pdf = '%PDF-1.4\n'; const offsets = [0];
  for (const [index, object] of objects.entries()) { offsets.push(pdf.length); pdf += `${index + 1} 0 obj\n${object}\nendobj\n`; }
  const xref = pdf.length; pdf += `xref\n0 5\n0000000000 65535 f \n${offsets.slice(1).map(value => `${String(value).padStart(10, '0')} 00000 n \n`).join('')}trailer\n<< /Size 5 /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`;
  const body = new FormData(); body.append('file', new Blob([pdf], { type: 'application/pdf' }), 'A real page.pdf');
  const created = await fetch(`${base}?channelId=channel`, { method: 'POST', headers, body }); assert.equal(created.status, 202);
  let job = await created.json();
  for (let i = 0; i < 100 && !['ready', 'error'].includes(job.state); i++) { await new Promise(resolve => setTimeout(resolve, 50)); job = await (await fetch(`${base}/${job.id}`, { headers })).json(); }
  assert.equal(job.state, 'ready', job.error);
  const preview = job.pages[0].previewUrl;
  assert.equal((await fetch(new URL(preview, base))).status, 401);
  assert.equal((await fetch(`${base}/${job.id}`, { headers: limited })).status, 404);
  const shown = await fetch(new URL(preview, base), { headers }); assert.equal(shown.status, 200); assert.equal(shown.headers.get('cache-control'), 'private, no-store'); assert.equal(shown.headers.get('content-type'), 'image/png');
  setGrant(author.id, 'channel', 'viewer');
  const commit = () => fetch(`${base}/${job.id}/commit`, { method: 'POST', headers: { ...headers, 'Content-Type': 'application/json' }, body: JSON.stringify({ pages: [1] }) });
  assert.equal((await commit()).status, 403, 'Revoking author access blocks promotion');
  setGrant(author.id, 'channel', 'author'); const result = await commit(); assert.equal(result.status, 200);
  const imported = await result.json(); await fs.access(path.join(directory, imported.pages[0].path));
  assert.equal(await fs.readFile(CONTENT_FILE, 'utf8'), content, 'Import never changes public presentation or Program before the caller saves reviewed slides');
  assert.equal((await fetch(`${base}/${job.id}`, { method: 'DELETE', headers })).status, 204);
  assert.equal((await fetch(`${base}/${job.id}`, { headers })).status, 404);
  await fs.access(path.join(directory, imported.pages[0].path));
});
