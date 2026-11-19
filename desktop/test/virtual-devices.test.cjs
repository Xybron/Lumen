const test = require('node:test');
const assert = require('node:assert/strict');
const { PassThrough } = require('node:stream');
const { EventEmitter } = require('node:events');
const vm = require('node:vm');
const fs = require('node:fs');
const path = require('node:path');
const { packet, DeviceTransport, VIDEO_BYTES } = require('../app/virtual-device-transport.cjs');
const { canOperate } = require('../app/virtual-devices.cjs');

function helper() {
  const child = new EventEmitter();
  child.stdin = new PassThrough(); child.stdout = new PassThrough();
  child.kill = () => child.emit('exit', 0);
  return child;
}
test('native framing rejects invalid video/audio sizes and preserves binary payloads', () => {
  const video = packet(1, new Uint8Array(VIDEO_BYTES));
  assert.equal(video.readUInt32LE(), 0x314d554c);
  assert.equal(video.readUInt32LE(4), 1);
  assert.equal(video.readUInt32LE(8), VIDEO_BYTES);
  const sound = new Float32Array([0.25, -0.5]);
  assert.equal(packet(2, sound.buffer).readFloatLE(12), 0.25);
  assert.equal(packet(2, sound.buffer).readFloatLE(16), -0.5);
  for (const [kind, bytes] of [[1, 100], [2, 0], [2, 7], [2, 32776], [3, 8]])
    assert.throws(() => packet(kind, new Uint8Array(bytes)));
  assert.throws(() => packet(2, 'invalid'));
});
test('slow native consumer cannot create an unbounded media queue', async () => {
  const child = helper(), failures = [], writes = [];
  child.stdin.on('data', bytes => writes.push(bytes));
  const transport = new DeviceTransport(child, error => failures.push(error));
  child.stdout.write('{"state":"ready"}\n'); await transport.ready;
  const video = transport.send(1, new Uint8Array(VIDEO_BYTES));
  for (let i = 0; i < 30; i++) assert.equal(await transport.send(1, new Uint8Array(VIDEO_BYTES)), false);
  const audio = transport.send(2, new Uint8Array(8192));
  assert.equal(writes.length, 2, 'one packet per media kind, regardless of offered frame count');
  child.stdout.write('{"ack":2,"accepted":true}\n{"ack":1,"accepted":true}\n');
  assert.equal(await video, true); assert.equal(await audio, true);
  const next = transport.send(2, new Uint8Array(8192));
  transport.close(); child.emit('exit', 0);
  assert.equal(await next, false, 'stop releases pending renderer invokes');
  assert.equal(await transport.send(1, new Uint8Array(VIDEO_BYTES)), false);
  assert.deepEqual(failures, []);
});
test('native crash closes delivery and reports failure', async () => {
  const child = helper(), failures = [];
  child.stdin.resume();
  const transport = new DeviceTransport(child, error => failures.push(error.message));
  child.stdout.write('{"state":"ready"}\n'); await transport.ready;
  const pending = transport.send(2, new Uint8Array(8192));
  child.emit('exit', 1);
  assert.equal(await pending, false);
  assert.equal(failures.length, 1);
  assert.match(failures[0], /disconnected/);
});
test('device controls require global author or administrator access', () => {
  assert.equal(canOperate(null), false);
  assert.equal(!!canOperate({ user: {}, grants: [{ channelId: '*', role: 'viewer' }] }), false);
  assert.equal(!!canOperate({ user: {}, grants: [{ channelId: 'presentation', role: 'owner' }] }), false);
  assert.equal(canOperate({ user: {}, grants: [{ channelId: '*', role: 'author' }] }), true);
  assert.equal(canOperate({ user: { isAdmin: true }, grants: [] }), true);
});
test('audio worklet preserves stereo, duplicates mono, and bounds stalled delivery', () => {
  let Processor;
  const context = vm.createContext({ Float32Array, Number, AudioWorkletProcessor: class {
    constructor() { this.messages = []; this.port = { postMessage: data => this.messages.push(data) }; }
  }, registerProcessor: (_name, processor) => { Processor = processor; } });
  vm.runInContext(fs.readFileSync(path.join(__dirname, '../../frontend/public/virtual-output-worklet.js'), 'utf8'), context);
  const instance = new Processor();
  const left = new Float32Array(128).fill(0.25), right = new Float32Array(128).fill(-0.5);
  for (let i = 0; i < 8; ++i) instance.process([[left, right]]);
  assert.equal(instance.messages.length, 1);
  let samples = new Float32Array(instance.messages[0]);
  assert.equal(samples.length, 2048); assert.equal(samples[0], 0.25); assert.equal(samples[1], -0.5);
  for (let i = 0; i < 80; ++i) instance.process([[left]]);
  assert.equal(instance.messages.length, 1, 'audio backlog does not grow before acknowledgment');
  instance.port.onmessage();
  for (let i = 0; i < 8; ++i) instance.process([[left]]);
  samples = new Float32Array(instance.messages[1]);
  assert.equal(samples[0], samples[1]);
});
