import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import http from 'node:http';
import express from 'express';
import WebSocket from 'ws';
import type { AssemblyTurn } from '../src/assemblyai-stream.js';
import type { RelayHandle } from '../src/ws.js';

test('shared music suggests library songs, feeds Notes, and never publishes a cue', async t => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'lumen-shared-lyrics-'));
  process.env.LUMEN_DATA_DIR = directory;
  const { CONTENT_FILE } = await import('../src/paths.js');
  const { initDb } = await import('../src/db.js'), db = initDb();
  const { login, createUser, setGrant } = await import('../src/auth.js');
  const headers = { Cookie: `lumen_session=${login('admin', 'admin')!.sessionId}`, 'Content-Type': 'application/json' };
  const restricted = createUser('lyrics-only', 'Lyrics only', 'test-password')!;
  setGrant(restricted.id, 'lyrics-target', 'author');
  const limited = { Cookie: `lumen_session=${login('lyrics-only', 'test-password')!.sessionId}` };
  await fs.writeFile(CONTENT_FILE, JSON.stringify({ version: 2, channels: [
    { id: 'lyrics-source', kind: 'lyrics' }, { id: 'lyrics-target', kind: 'lyrics' },
    { id: 'scripture', kind: 'scripture' }, { id: 'notes', kind: 'notes', playlistId: 'notes-deck' },
  ], playlists: [{ id: 'notes-deck', items: [{ id: 'note', type: 'notes', title: 'Note', body: '', layout: 'statement' }] }] }));
  const { SharedListeningHub } = await import('../src/shared-listening.js'), shared = new SharedListeningHub();
  const { createWorship } = await import('../src/worship.js');
  const streams: { turn: (turn: AssemblyTurn) => void; closed: boolean }[] = [];
  const worship = await createWorship({ setAuthoritativeChannel() {}, injectRemote() {} } as unknown as RelayHandle, shared, {
    key: async () => 'fake-key', createStream: (_key, turn) => {
      const stream = { turn, closed: false }; streams.push(stream);
      return { connected: Promise.resolve(), send() {}, finish() {}, close() { stream.closed = true; } };
    },
  });
  const song = worship.library.saveSong({ title: 'Z Morning Light', sections: [{ id: 'chorus', label: 'Chorus', text: 'Morning light surrounds us with a joyful song of hope' }] });
  for(let i=0;i<501;i++)worship.library.saveSong({title:`A filler ${i}`,sections:[{id:'verse',label:'Verse',text:'Unrelated distant mountain train'}]});
  assert(!worship.library.songs().some(value=>value.id===song.id),'Fixture is beyond the browsing page');
  const { createNotes } = await import('../src/notes.js');
  const notes = createNotes({ shared, library: worship.library, listener: worship.listener, otherListeningActive: worship.hasActiveListening });
  const app = express(); app.use(express.json()); app.use('/api', shared.router, worship.router, notes.router);
  const server = http.createServer(app);
  server.on('upgrade', (req, socket, head) => worship.cloudWss.handleUpgrade(req, socket, head, ws => worship.cloudWss.emit('connection', ws, req)));
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  const base = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
  const sockets: WebSocket[] = [];
  t.after(async () => { for (const socket of sockets) socket.terminate(); notes.close(); shared.close(); worship.close(); server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve())); db.close(); await fs.rm(directory, { recursive: true, force: true }); });
  const wait = async (check: () => boolean) => { for (let i = 0; i < 200; i++) { if (check()) return; await new Promise(r => setTimeout(r, 10)); } throw Error('Timed out waiting for shared stream'); };
  const start = (id: string, mode = 'assisted') => fetch(`${base}/api/worship/channels/${id}/listening`, { method: 'POST', headers: { ...headers, Origin: base }, body: JSON.stringify({ provider: 'assemblyai', mode }) });
  assert.equal((await start('lyrics-source', 'automatic')).status, 422);
  const response = await start('lyrics-source'); assert.equal(response.status, 200);
  const lease = await response.json();
  const socket = new WebSocket(`${base.replace('http:', 'ws:')}/worship/listening/stream?channel=lyrics-source&session=${lease.id}`, { headers: { ...headers, Origin: base } }); sockets.push(socket);
  await wait(() => shared.snapshot().session?.state === 'listening');
  assert.equal(shared.snapshot().session?.source, 'lyrics');
  assert.equal((await start('lyrics-target')).status, 409, 'No second recognizer');
  const linked = await fetch(`${base}/api/notes/channels/notes/items/note/listening/link`, { method: 'POST', headers, body: JSON.stringify({ sessionId: lease.id }) });
  assert.equal(linked.status, 200);
  const initial = worship.library.workspace('lyrics-source');
  const target = worship.library.workspace('lyrics-target');
  for (let order = 0; order < 3; order++) streams[0].turn({ type: 'Turn', turn_order: order, end_of_turn: true, transcript: song.sections[0].text });
  assert.equal(shared.snapshot().result?.candidate?.selection.kind, 'lyrics');
  assert.equal(shared.snapshot().result?.switched, false);
  const endpoint = `${base}/api/worship/channels/lyrics-target/listening/shared-result?session=${lease.id}`;
  const suggestion = await (await fetch(endpoint, { headers })).json();
  assert.equal(suggestion.result.candidate.selection.songId, song.id, 'Library matching works without a setlist');
  assert.equal(suggestion.result.workspace.channelId, 'lyrics-target');
  assert.deepEqual(worship.library.workspace('lyrics-source'), initial);
  assert.deepEqual(worship.library.workspace('lyrics-target'), target);
  assert.equal((await fetch(endpoint, { headers: limited })).status, 403, 'Target access does not grant source transcript access');
  assert.equal((await fetch(endpoint.replace(lease.id, 'old-session'), { headers })).status, 409);
  const note = await (await fetch(`${base}/api/notes/channels/notes/items/note`, { headers })).json();
  assert.equal(note.segments.length, 3, 'Notes receives the same single stream');
  assert.equal(streams.length, 1);
  streams[0].turn({ type: 'Turn', turn_order: 4, end_of_turn: true, transcript: 'unrelated train station weather information' });
  assert.equal((await (await fetch(endpoint, { headers })).json()).result.candidate, null, 'No stale song retained after a nonmatch');
  const manual = await fetch(`${base}/api/worship/channels/lyrics-source/command`, { method: 'POST', headers, body: JSON.stringify({ revision: initial.revision, command: { type: 'take', selection: { kind: 'lyrics', songId: song.id, sectionId: song.sections[0].id } } }) });
  assert.equal(manual.status, 200); assert.equal(streams[0].closed, false, 'Manual publication keeps linked listening alive');
  shared.end(lease.id);
  assert.equal((await fetch(endpoint, { headers })).status, 409, 'Stopped sessions cannot leak old suggestions');
});
