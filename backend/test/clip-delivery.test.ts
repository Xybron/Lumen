import test from 'node:test';
import assert from 'node:assert/strict';
import { chooseClipDestination, clipDeliveryFilename, CLIP_DELIVERY_CHUNK_BYTES, ClipDeliveryError, destinationLabel, requestClipBrowserDownload, requestClipDestinationPermission, saveClipExport, supportsClipSavePicker, type ClipDestination, type ClipSaveHandle, type ClipWritableFile } from '../../frontend/src/lib/clip-delivery.js';

const options = { container: 'mp4' as const, resolution: '1080p' as const };
const job = (bytes: number) => ({ id: 'export_fixture', bytes });
const nextTick = () => new Promise(resolve => setTimeout(resolve, 0));
function fixture(overrides: Partial<ClipWritableFile> = {}) {
  const events: string[] = [], writes: Uint8Array[] = [];
  const writer: ClipWritableFile = { async write(data) { writes.push(data.slice()); events.push('write'); }, async close() { events.push('close'); }, async abort() { events.push('abort'); }, ...overrides };
  const handle: ClipSaveHandle = { name: 'Sunday highlight.mp4', async createWritable(value) { assert.deepEqual(value, { keepExistingData: false }); events.push('create'); return writer; }, async getFile() { throw new Error('This unit fixture never opens a real file.'); } };
  const destination: ClipDestination = { kind: 'file', name: handle.name, handle, canRevealFolder: false };
  return { events, writes, writer, handle, destination };
}
function response(bytes: Uint8Array, claimed = bytes.byteLength): typeof fetch {
  return (async (_input, init) => { assert.equal(init?.credentials, 'include'); return new Response(bytes, { status: 200, headers: { 'Content-Length': String(claimed) } }); }) as typeof fetch;
}

test('the native picker is invoked immediately in the original gesture and returns only an opaque file capability', async () => {
  const f = fixture(); let invoked = false;
  const promise = chooseClipDestination(options, 'Sunday service', { secureContext: true, showSaveFilePicker: async value => { invoked = true; assert.equal(value.suggestedName, 'Sunday service.mp4'); assert.deepEqual(value.types[0].accept, { 'video/mp4': ['.mp4'] }); return f.handle; } });
  assert.equal(invoked, true, 'Picker call must not wait for draft saves, metadata or another promise');
  const destination = await promise; assert.ok(destination); assert.equal(destination.kind, 'file'); assert.equal(destination.canRevealFolder, false); assert.equal(destinationLabel(destination), f.handle.name);
});

test('picker cancellation, including a synchronous cancellation, never becomes a download or export request', async () => {
  for (const showSaveFilePicker of [() => { throw new DOMException('Cancelled', 'AbortError'); }, async () => { throw new DOMException('Cancelled', 'AbortError'); }]) {
    assert.equal(await chooseClipDestination(options, 'Cancelled', { secureContext: true, showSaveFilePicker }), null);
  }
});

test('unsupported/insecure browsers receive an honest browser Downloads destination with no folder reveal capability', async () => {
  let calls = 0;
  const environment = { secureContext: false, showSaveFilePicker: async () => { calls++; return fixture().handle; } };
  assert.equal(supportsClipSavePicker(environment), false);
  const destination = await chooseClipDestination(options, 'Sermon', environment); assert.equal(calls, 0);
  assert.deepEqual(destination, { kind: 'download', name: 'Sermon.mp4', canRevealFolder: false }); assert.equal(destinationLabel(destination!), 'Browser Downloads');
  await assert.rejects(saveClipExport(job(100), destination!, { fetcher: async () => { throw new Error('Must not fetch'); } }), (error: unknown) => error instanceof ClipDeliveryError && !error.fileSaved && error.phase === 'permission');
});

test('suggested names have one correct extension, no path/control syntax, and no reserved Windows basename', () => {
  assert.equal(clipDeliveryFilename({ ...options, container: 'wav' }, 'Sunday.mp4'), 'Sunday.wav');
  assert.equal(clipDeliveryFilename(options, 'A/B\\C: D\n'), 'A-B-C- D-.mp4');
  assert.equal(clipDeliveryFilename(options, 'CON'), '_CON.mp4');
  assert.equal(clipDeliveryFilename(options, ''), 'Lumen export.mp4');
  assert.equal(clipDeliveryFilename(options, 'Ɔdɔ · Sermon'), 'Ɔdɔ · Sermon.mp4');
});

test('permission failures remain actionable and never silently fall back to an unconfirmed download', async () => {
  await assert.rejects(chooseClipDestination(options, 'Permission', { secureContext: true, showSaveFilePicker: async () => { throw new DOMException('Denied', 'NotAllowedError'); } }), (error: unknown) => error instanceof ClipDeliveryError && error.phase === 'permission' && !error.fileSaved);
  const f = fixture(); f.handle.createWritable = async () => { throw new DOMException('Denied', 'NotAllowedError'); };
  let fetched = false;
  await assert.rejects(saveClipExport(job(4), f.destination, { fetcher: async () => { fetched = true; throw new Error('No transfer'); } }), (error: unknown) => error instanceof ClipDeliveryError && error.phase === 'permission' && !error.fileSaved);
  assert.equal(fetched, false);
});

test('file streaming splits large network chunks into bounded writes and obeys backpressure', async () => {
  let outstanding = 0, maximum = 0; const chunks: number[] = [];
  const f = fixture({ async write(bytes) { outstanding++; maximum = Math.max(maximum, outstanding); chunks.push(bytes.byteLength); await nextTick(); outstanding--; } });
  const length = CLIP_DELIVERY_CHUNK_BYTES * 4 + 17, progress: number[] = [];
  const result = await saveClipExport(job(length), f.destination, { fetcher: response(new Uint8Array(length)), onProgress: value => progress.push(value.written), acknowledge: async () => { f.events.push('release'); } });
  assert.equal(maximum, 1); assert.deepEqual(chunks, [65536, 65536, 65536, 65536, 17]); assert.equal(result.bytesWritten, length);
  assert.equal(result.acknowledged, true); assert.deepEqual(f.events, ['create', 'close', 'release']);
  assert.equal(progress[0], 0); assert.equal(progress.at(-1), length); assert.ok(progress.every((value, index) => index === 0 || value >= progress[index - 1]));
});

test('a render/download is not delivered until the destination close promise has actually completed', async () => {
  let finishClose!: () => void, started = false, released = false;
  const closed = new Promise<void>(resolve => { finishClose = resolve; });
  const f = fixture({ async close() { started = true; await closed; } });
  const saving = saveClipExport(job(8), f.destination, { fetcher: response(new Uint8Array(8)), acknowledge: async () => { released = true; } });
  while (!started) await nextTick(); assert.equal(released, false);
  finishClose(); await saving; assert.equal(released, true);
});

test('HTTP transfer errors and truncated/empty responses abort the destination without closing or releasing', async () => {
  for (const fetcher of [async () => new Response('Unavailable', { status: 503 }), response(new Uint8Array(12), 20), response(new Uint8Array(12), 12), response(new Uint8Array(0), 0)]) {
    const f = fixture(); let released = false;
    await assert.rejects(saveClipExport(job(20), f.destination, { fetcher: fetcher as typeof fetch, acknowledge: async () => { released = true; } }), (error: unknown) => error instanceof ClipDeliveryError && !error.fileSaved);
    assert.equal(released, false); assert.equal(f.events.includes('close'), false); assert.equal(f.events.filter(event => event === 'abort').length, 1);
  }
});

test('a mid-stream disconnect leaves the server temporary file available instead of falsely confirming delivery', async () => {
  const f = fixture(); let released = false, reads = 0;
  const fetcher = (async () => new Response(new ReadableStream<Uint8Array>({ pull(controller) { if (!reads++) controller.enqueue(new Uint8Array(5)); else controller.error(new Error('Disconnected')); } }), { headers: { 'Content-Length': '10' } })) as typeof fetch;
  await assert.rejects(saveClipExport(job(10), f.destination, { fetcher, acknowledge: async () => { released = true; } }), (error: unknown) => error instanceof ClipDeliveryError && error.phase === 'download' && !error.fileSaved);
  assert.equal(released, false); assert.ok(f.events.includes('abort')); assert.equal(f.events.includes('close'), false);
});

test('disk write and close failures never release an export or claim it is saved', async () => {
  for (const phase of ['write', 'close'] as const) {
    const f = fixture({ async [phase]() { throw new Error('Disk full'); } }); let released = false;
    await assert.rejects(saveClipExport(job(10), f.destination, { fetcher: response(new Uint8Array(10)), acknowledge: async () => { released = true; } }), (error: unknown) => error instanceof ClipDeliveryError && error.phase === phase && !error.fileSaved);
    assert.equal(released, false); assert.equal(f.events.filter(event => event === 'abort').length, 1);
  }
});

test('cleanup acknowledgement failure preserves the truthful saved-file result for a release-only retry', async () => {
  const f = fixture();
  await assert.rejects(saveClipExport(job(10), f.destination, { fetcher: response(new Uint8Array(10)), acknowledge: async () => { throw new Error('Station disconnected after close'); } }), (error: unknown) => error instanceof ClipDeliveryError && error.phase === 'release' && error.fileSaved && error.bytesWritten === 10);
  assert.equal(f.events.includes('close'), true); assert.equal(f.events.includes('abort'), false);
});

test('cancellation aborts an open destination exactly once and never acknowledges delivery', async () => {
  const f = fixture(), controller = new AbortController(); let released = false;
  await assert.rejects(saveClipExport(job(20), f.destination, { signal: controller.signal, fetcher: response(new Uint8Array(20)), onProgress: value => { if (value.written) controller.abort(); }, acknowledge: async () => { released = true; } }), (error: unknown) => error instanceof ClipDeliveryError && !error.fileSaved);
  assert.equal(released, false); assert.equal(f.events.filter(value => value === 'abort').length, 1); assert.equal(f.events.includes('close'), false);
});

test('network, disk-write and close stalls have finite deadlines and retain the temporary export', async () => {
  for (const phase of ['download', 'write', 'close'] as const) {
    const never = () => new Promise<void>(() => {}), f = fixture(phase === 'download' ? {} : { [phase]: never }); let released = false;
    const fetcher = phase === 'download' ? (() => new Promise<Response>(() => {})) as typeof fetch : response(new Uint8Array(8));
    await assert.rejects(saveClipExport(job(8), f.destination, { fetcher, stallTimeoutMs: 15, timeoutMs: 100, acknowledge: async () => { released = true; } }), (error: unknown) => error instanceof ClipDeliveryError && error.phase === phase && !error.fileSaved && /respond in time/.test(error.message));
    assert.equal(released, false); assert.equal(f.events.filter(value => value === 'abort').length, 1);
  }
});

test('a stalled release still reports an actually closed file, with cleanup left retryable', async () => {
  const f = fixture();
  await assert.rejects(saveClipExport(job(8), f.destination, { fetcher: response(new Uint8Array(8)), stallTimeoutMs: 15, acknowledge: () => new Promise(() => {}) }), (error: unknown) => error instanceof ClipDeliveryError && error.fileSaved && error.phase === 'release');
  assert.equal(f.events.includes('close'), true); assert.equal(f.events.includes('abort'), false);
});

test('fast chunk streams throttle progress observers while always reporting initial and final bytes', async () => {
  const f = fixture(), length = CLIP_DELIVERY_CHUNK_BYTES * 100, updates: number[] = [];
  await saveClipExport(job(length), f.destination, { fetcher: response(new Uint8Array(length)), onProgress: value => updates.push(value.written) });
  assert.equal(updates[0], 0); assert.equal(updates.at(-1), length); assert.ok(updates.length < 15, `One hundred fast writes should not cause one hundred reactive UI updates (${updates.length})`);
});

test('explicit permission retry requests access only when the previously chosen handle needs it', async () => {
  const f = fixture(); let requested = 0;
  f.handle.queryPermission = async () => 'granted'; f.handle.requestPermission = async () => { requested++; return 'granted'; };
  assert.equal(await requestClipDestinationPermission(f.destination), true); assert.equal(requested, 0);
  f.handle.queryPermission = async () => 'prompt'; assert.equal(await requestClipDestinationPermission(f.destination), true); assert.equal(requested, 1);
  f.handle.requestPermission = async () => 'denied'; assert.equal(await requestClipDestinationPermission(f.destination), false);
});

test('browser Downloads uses a private same-origin attachment and makes no release/save confirmation claim', () => {
  const events: string[] = [], link = { href: '', download: '', rel: '', hidden: false, click() { events.push('click'); }, remove() { events.push('remove'); } };
  const document = { createElement(tag: string) { assert.equal(tag, 'a'); return link; }, body: { appendChild(value: unknown) { assert.equal(value, link); events.push('append'); } } } as unknown as Document;
  requestClipBrowserDownload('export /test', 'Sermon.mp4', document);
  assert.equal(link.href, '/api/clips/exports/export%20%2Ftest/download'); assert.equal(link.download, 'Sermon.mp4'); assert.equal(link.hidden, true); assert.deepEqual(events, ['append', 'click', 'remove']);
});
