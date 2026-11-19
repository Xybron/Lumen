import test, { type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { outputVideoEncoding, outputVideoCodecPreference, OutputEncodingPolicy } from '../../frontend/src/lib/studio/output-encoding.js';
import { StudioPeer } from '../../frontend/src/lib/studio/signal.js';
import { MULTIVIEW_OUTPUT_ID } from '../../shared/multiview-layout.js';
import { PROGRAM_MONITOR_OUTPUT_ID } from '../../shared/program-monitor.js';

test('only full audience feeds request the conditional HD ceiling and codec preference', () => {
  for (const output of ['program', 'screen_main', 'screen_stage']) {
    assert.deepEqual(outputVideoEncoding(output), { maxBitrate: 8_000_000, maxFramerate: 30, scaleResolutionDownBy: 1 });
    assert.equal(outputVideoCodecPreference(output), 'video/H264');
  }
  assert.deepEqual(outputVideoEncoding('program', true), { scaleResolutionDownBy: 2, maxFramerate: 30 });
  assert.equal(outputVideoCodecPreference('program', true), undefined);
  for (const output of ['preview', MULTIVIEW_OUTPUT_ID, PROGRAM_MONITOR_OUTPUT_ID]) {
    assert.equal(outputVideoEncoding(output), undefined);
    assert.equal(outputVideoCodecPreference(output), undefined);
    assert.equal(outputVideoEncoding(output, true), undefined, 'An irrelevant compact flag cannot expand a private feed');
  }
});

function report(codec: string | null, framesEncoded = 1) {
  return new Map(codec ? [
    ['video', { type: 'outbound-rtp', kind: 'video', framesEncoded, codecId: 'codec' }],
    ['codec', { type: 'codec', mimeType: codec }],
  ] : []);
}

function fixture(t: TestContext, options: {
  noH264?: boolean; noCodecAPI?: boolean; codecRejected?: boolean;
  actualCodec?: string | null; getStats?: () => Promise<unknown>;
  parametersRejected?: boolean; connected?: boolean;
} = {}) {
  const codecs = [
    { mimeType: 'video/VP8', clockRate: 90000 },
    { mimeType: 'video/rtx', clockRate: 90000 },
    { mimeType: 'video/H264', clockRate: 90000, sdpFmtpLine: 'packetization-mode=1' },
    { mimeType: 'video/VP9', clockRate: 90000 },
    { mimeType: 'video/H264', clockRate: 90000, sdpFmtpLine: 'packetization-mode=0' },
    { mimeType: 'video/red', clockRate: 90000 },
    { mimeType: 'video/ulpfec', clockRate: 90000 },
  ];
  const connections: Connection[] = [];
  let capabilitiesCalls = 0;
  class Connection extends EventTarget {
    tracks: unknown[] = [];
    codecPreferences: typeof codecs = [];
    offeredEncodings: unknown[] = [];
    parameters = { encodings: [] as Record<string, unknown>[] };
    statsCalls = 0;
    setCalls = 0;
    connectionState = options.connected === false ? 'connecting' : 'connected';
    localDescription = { toJSON: () => ({ type: 'offer', sdp: 'fixture' }) };
    remoteDescription: unknown;
    sender = {
      getStats: async () => { this.statsCalls++; return options.getStats ? options.getStats() : report(options.actualCodec === undefined ? 'video/H264' : options.actualCodec); },
      getParameters: () => structuredClone(this.parameters),
      setParameters: async (parameters: typeof this.parameters) => {
        this.setCalls++;
        if (options.parametersRejected) throw Error('unsupported');
        this.parameters = structuredClone(parameters);
      },
    };
    constructor() { super(); connections.push(this); }
    addTransceiver(track: unknown, init: { direction: string; streams: unknown[]; sendEncodings: Record<string, unknown>[] }) {
      assert.equal(init.direction, 'sendonly');
      this.tracks.push(track);
      this.parameters.encodings = structuredClone(init.sendEncodings);
      return {
        sender: this.sender,
        setCodecPreferences: options.noCodecAPI ? undefined : (preferred: typeof codecs) => {
          if (options.codecRejected) throw Error('unsupported');
          this.codecPreferences = preferred;
        },
      };
    }
    addTrack(track: unknown) { this.tracks.push(track); }
    async createOffer() { this.offeredEncodings = structuredClone(this.parameters.encodings); return { type: 'offer', sdp: 'fixture' }; }
    async setLocalDescription() {}
    async setRemoteDescription(description: unknown) { this.remoteDescription = description; }
    close() { this.connectionState = 'closed'; }
    connect() { this.connectionState = 'connected'; this.dispatchEvent(new Event('connectionstatechange')); }
  }
  for (const [key, value] of Object.entries({
    RTCPeerConnection: Connection,
    RTCRtpSender: { getCapabilities: () => { capabilitiesCalls++; return { codecs: options.noH264 ? codecs.filter(codec => codec.mimeType !== 'video/H264') : codecs }; } },
  })) {
    const original = Object.getOwnPropertyDescriptor(globalThis, key);
    Object.defineProperty(globalThis, key, { configurable: true, value });
    t.after(() => { if (original) Object.defineProperty(globalThis, key, original); else Reflect.deleteProperty(globalThis, key); });
  }
  const video = { kind: 'video', contentHint: '' }, audio = { kind: 'audio', contentHint: '' };
  const stream = { getTracks: () => [video, audio] } as unknown as MediaStream;
  const messages: unknown[] = [];
  const signaling = { send: (message: unknown) => messages.push(message) } as ConstructorParameters<typeof StudioPeer>[0];
  const peer = new StudioPeer(signaling, 'audience', 'out:program');
  t.after(() => peer.close());
  return {
    peer, connection: connections[0], connections, stream, codecs, video, audio, messages,
    capabilitiesCalls: () => capabilitiesCalls,
    offer: () => peer.offer(stream, outputVideoEncoding('program'), outputVideoCodecPreference('program')),
    answer: () => peer.receive({ t: 'signal', peerId: 'audience', key: 'out:program', description: { type: 'answer', sdp: 'fixture' } }),
  };
}

async function flush() { for (let i = 0; i < 8; i++) await Promise.resolve(); }
const originalEncoding = [{ maxFramerate: 30, scaleResolutionDownBy: 1 }];

test('running H264 enables the ceiling after the answer while retaining all fallback codecs and shared tracks', async t => {
  const f = fixture(t);
  await f.offer();
  assert.deepEqual(f.connection.offeredEncodings, originalEncoding, 'The initial offer retains the default bitrate');
  assert.deepEqual(f.connection.codecPreferences, [...f.codecs.filter(c => c.mimeType === 'video/H264'), ...f.codecs.filter(c => c.mimeType !== 'video/H264')]);
  assert.deepEqual(f.connection.tracks, [f.video, f.audio]);
  assert.equal(f.connection.statsCalls, 0);
  await f.answer(); await flush();
  assert.deepEqual(f.connection.parameters.encodings, [{ ...originalEncoding[0], maxBitrate: 8_000_000 }]);
  assert.equal(f.connection.setCalls, 1);
  assert.equal(f.peer.videoEncodingDiagnostic.state, 'applied');
  assert.deepEqual([f.video.contentHint, f.audio.contentHint], ['', ''], 'Shared tracks retain browser adaptation');
});

test('compact output and input publishers retain their existing encodings without codec probes', async t => {
  const f = fixture(t);
  await f.peer.offer(f.stream, outputVideoEncoding('program', true), outputVideoCodecPreference('program', true));
  assert.deepEqual(f.connection.offeredEncodings, [{ scaleResolutionDownBy: 2, maxFramerate: 30 }]);
  await f.answer(); await flush();
  const input = new StudioPeer({ send() {} } as ConstructorParameters<typeof StudioPeer>[0], 'engine', 'in:camera');
  t.after(() => input.close());
  await input.offer(f.stream, { maxFramerate: 30 });
  assert.deepEqual(f.connections[1].offeredEncodings, [{ maxFramerate: 30 }]);
  assert.equal(f.capabilitiesCalls(), 0);
  assert.equal(f.connection.statsCalls, 0);
});

for (const [name, options] of [
  ['H264 absent', { noH264: true }],
  ['codec preferences API absent', { noCodecAPI: true }],
  ['codec preferences rejected', { codecRejected: true }],
  ['receiver negotiated VP8', { actualCodec: 'video/VP8' }],
  ['stats rejected', { getStats: async () => { throw Error('stats unavailable'); } }],
] as const) {
  test(`${name} retains the default bitrate with one copy of each track`, async t => {
    const f = fixture(t, options);
    await f.offer(); await f.answer(); await flush();
    assert.deepEqual(f.connection.parameters.encodings, originalEncoding);
    assert.deepEqual(f.connection.tracks, [f.video, f.audio]);
    assert.equal(f.connection.setCalls, 0);
    assert.equal(f.peer.videoEncodingDiagnostic.state, 'fallback');
    assert.equal(f.peer.videoEncodingDiagnostic.reason, 'actualCodec' in options ? 'negotiated-video/VP8' : 'getStats' in options ? 'stats-error' : 'codec-preference-unavailable');
  });
}

test('a rejected bitrate update is harmless and does not retry', async t => {
  const f = fixture(t, { parametersRejected: true });
  await f.offer(); await f.answer(); await flush();
  assert.deepEqual(f.connection.parameters.encodings, originalEncoding);
  assert.equal(f.connection.setCalls, 1);
  assert.equal(f.peer.videoEncodingDiagnostic.reason, 'parameters-error');
});

test('a late connection starts its own bounded probe without replacing other connection handlers', async t => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const f = fixture(t, { connected: false });
  let connectionEvents = 0;
  f.connection.addEventListener('connectionstatechange', () => connectionEvents++);
  await f.offer(); await f.answer(); await flush();
  t.mock.timers.tick(10_000); await flush();
  assert.equal(f.connection.statsCalls, 0);
  f.connection.connect(); await flush();
  assert.equal(connectionEvents, 1);
  assert.equal(f.connection.setCalls, 1);
});

test('missing encoded frames exhaust the bounded probe and retain the default bitrate', async t => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const f = fixture(t, { actualCodec: null });
  await f.offer(); await f.answer(); await flush();
  for (let i = 0; i < 65; i++) { t.mock.timers.tick(250); await flush(); }
  assert.equal(f.connection.statsCalls, 60);
  assert.equal(f.connection.setCalls, 0);
  assert.equal(f.peer.videoEncodingDiagnostic.reason, 'deadline');
  t.mock.timers.tick(10_000); await flush();
  assert.equal(f.connection.statsCalls, 60);
});

test('H264 frames arriving after a 6.6-second encoder startup still enable the ceiling', async t => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  let codec: string | null = null;
  const f = fixture(t, { getStats: async () => codec ? report(codec) : report('video/H264', 0) });
  let recoveries = 0;
  f.peer.onPreferredVideoStartupFailed = () => recoveries++;
  await f.offer(); await f.answer(); await flush();
  for (let i = 0; i < 26; i++) { t.mock.timers.tick(250); await flush(); }
  t.mock.timers.tick(100); await flush();
  assert.equal(f.connection.setCalls, 0);
  assert.equal(f.peer.videoEncodingDiagnostic.state, 'probing');
  codec = 'video/H264';
  t.mock.timers.tick(150); await flush();
  assert.equal(f.connection.setCalls, 1);
  assert.equal(f.peer.videoEncodingDiagnostic.state, 'applied');
  assert.equal(f.connection.parameters.encodings[0].maxBitrate, 8_000_000);
  assert.equal(f.peer.preferredVideoStartupFailed, false);
  t.mock.timers.tick(20_000); await flush();
  assert.equal(recoveries, 0, 'Normal slow encoder startup never triggers a codec replacement');
});

test('a repeated watch remembers a failed startup only for that viewer and drops both codec preference and HD budget', async t => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const f = fixture(t, { getStats: async () => report('video/H264', 0) });
  await f.offer(); await f.answer(); await flush();
  assert.equal(f.peer.preferredVideoStartupFailed, false, 'A single zero-frame report is insufficient');
  t.mock.timers.tick(250); await flush();
  assert.equal(f.peer.preferredVideoStartupFailed, true);
  const policy = new OutputEncodingPolicy();
  const key = 'audience:out:program';
  const retry = policy.configuration(key, 'program', false, f.peer.preferredVideoStartupFailed);
  f.peer.close();
  assert.equal(retry.codec, undefined);
  assert.deepEqual(retry.encoding, originalEncoding[0]);
  const replacement = new StudioPeer({ send() {} } as ConstructorParameters<typeof StudioPeer>[0], 'audience', 'out:program');
  t.after(() => replacement.close());
  await replacement.offer(f.stream, retry.encoding, retry.codec);
  assert.deepEqual(f.connections[1].offeredEncodings, originalEncoding);
  assert.deepEqual(f.connections[1].codecPreferences, []);
  assert.deepEqual(f.connections[1].tracks, [f.video, f.audio], 'The existing shared stream is reused');
  assert.deepEqual(policy.configuration(key, 'program'), retry, 'Subsequent watches keep the default policy');
  assert.equal(policy.reason(key), 'preferred-codec-zero-frames');
  assert.equal(policy.configuration('other:out:program', 'program').codec, 'video/H264');
  assert.equal(policy.configuration('audience:out:screen_stage', 'screen_stage').codec, 'video/H264');
  policy.forget(key);
  assert.equal(policy.configuration(key, 'program').codec, 'video/H264');
  policy.configuration(key, 'program', false, true);
  policy.forgetPeer('audience');
  assert.equal(policy.reason(key), undefined);
  policy.configuration(key, 'program', false, true);
  policy.clear();
  assert.equal(policy.reason(key), undefined);
});

test('a connected encoder with explicit zero frames notifies a non-retrying viewer once at 15 seconds', async t => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const f = fixture(t, { getStats: async () => report('video/H264', 0) });
  let recoveries = 0;
  f.peer.onPreferredVideoStartupFailed = () => recoveries++;
  await f.offer(); await f.answer(); await flush();
  for (let i = 0; i < 59; i++) { t.mock.timers.tick(250); await flush(); }
  assert.equal(f.connection.statsCalls, 60);
  assert.equal(recoveries, 0);
  t.mock.timers.tick(250); await flush();
  assert.equal(recoveries, 1);
  assert.equal(f.peer.videoEncodingDiagnostic.reason, 'zero-encoded-frames');
  assert.equal(f.peer.preferredVideoStartupFailed, true, 'The replacement can retain the observed failure');
  t.mock.timers.tick(20_000); await flush();
  assert.equal(recoveries, 1);
});

test('any encoded frame prevents a startup retry even when later reports omit codec data', async t => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  let reads = 0;
  const f = fixture(t, { getStats: async () => ++reads === 1
    ? new Map([['video', { type: 'outbound-rtp', kind: 'video', framesEncoded: 1 }]])
    : report('video/H264', 0) });
  let recoveries = 0;
  f.peer.onPreferredVideoStartupFailed = () => recoveries++;
  await f.offer(); await f.answer(); await flush();
  for (let i = 0; i < 61; i++) { t.mock.timers.tick(250); await flush(); }
  assert.equal(f.peer.preferredVideoStartupFailed, false);
  assert.equal(recoveries, 0);
});

for (const invalid of ['missing', 'rejected', 'pending', 'disconnected'] as const) {
  test(`prior zero frames cannot trigger codec recovery when the latest evidence is ${invalid}`, async t => {
    t.mock.timers.enable({ apis: ['setTimeout'] });
    let reads = 0;
    const f = fixture(t, { getStats: async () => {
      if (++reads <= 2 || invalid === 'disconnected') return report('video/H264', 0);
      if (invalid === 'rejected') throw Error('unavailable');
      if (invalid === 'pending') return new Promise(() => {});
      return report(null);
    } });
    let recoveries = 0;
    f.peer.onPreferredVideoStartupFailed = () => recoveries++;
    await f.offer(); await f.answer(); await flush();
    t.mock.timers.tick(250); await flush();
    assert.equal(f.peer.preferredVideoStartupFailed, true);
    if (invalid === 'disconnected') f.connection.connectionState = 'disconnected';
    t.mock.timers.tick(250); await flush();
    assert.equal(f.peer.preferredVideoStartupFailed, false);
    t.mock.timers.tick(20_000); await flush();
    assert.equal(recoveries, 0);
  });
}

test('late stats after an inconclusive deadline cannot revive old zero-frame evidence on a repeated watch', async t => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  let reads = 0;
  let resolve!: (value: unknown) => void;
  const f = fixture(t, { getStats: async () => ++reads <= 2
    ? report('video/H264', 0)
    : new Promise(r => { resolve = r; }) });
  let recoveries = 0;
  f.peer.onPreferredVideoStartupFailed = () => recoveries++;
  await f.offer(); await f.answer(); await flush();
  t.mock.timers.tick(250); await flush();
  assert.equal(f.peer.preferredVideoStartupFailed, true);
  t.mock.timers.tick(250); await flush();
  t.mock.timers.tick(15_000); await flush();
  assert.equal(f.peer.videoEncodingDiagnostic.reason, 'deadline');
  assert.equal(recoveries, 0);
  resolve(report('video/H264')); await flush();
  assert.equal(f.peer.preferredVideoStartupFailed, false);
  const policy = new OutputEncodingPolicy();
  assert.equal(policy.configuration('audience:out:program', 'program', false, f.peer.preferredVideoStartupFailed).codec, 'video/H264');
  assert.equal(policy.reason('audience:out:program'), undefined);
});

test('close cancels a scheduled retry', async t => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const f = fixture(t, { actualCodec: null });
  await f.offer(); await f.answer(); await flush();
  f.peer.close();
  f.connection.connect(); t.mock.timers.tick(10_000); await flush();
  assert.equal(f.connection.statsCalls, 1);
  assert.equal(f.connection.setCalls, 0);
});

for (const finish of ['close', 'deadline'] as const) {
  test(`a pending stats call cannot upgrade after ${finish} and never overlaps another read`, async t => {
    t.mock.timers.enable({ apis: ['setTimeout'] });
    let resolve!: (value: unknown) => void;
    const f = fixture(t, { getStats: () => new Promise(r => { resolve = r; }) });
    await f.offer(); await f.answer(); await flush();
    if (finish === 'close') f.peer.close();
    t.mock.timers.tick(20_000); await flush();
    assert.equal(f.connection.statsCalls, 1);
    resolve(report('video/H264')); await flush();
    assert.equal(f.connection.setCalls, 0);
    assert.deepEqual(f.connection.parameters.encodings, originalEncoding);
    assert.equal(f.peer.videoEncodingDiagnostic.state, finish === 'close' ? 'closed' : 'fallback');
    assert.equal(f.peer.videoEncodingDiagnostic.reason, finish === 'close' ? undefined : 'deadline');
  });
}
