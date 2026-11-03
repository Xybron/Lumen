import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import type { IncomingMessage } from 'node:http';
import { WebSocket } from 'ws';
import { ProductionHub } from '../src/production-hub.js';
import { initialProduction } from '../src/production-schema.js';
import { PROGRAM_MONITOR_OUTPUT_ID } from '../../shared/program-monitor.js';

class Socket extends EventEmitter {
  readyState = WebSocket.OPEN;
  messages: Record<string, unknown>[] = [];
  send(value: string) { this.messages.push(JSON.parse(value)); }
  ping() {}
  close() { if (this.readyState === WebSocket.CLOSED) return; this.readyState = WebSocket.CLOSED; this.emit('close'); }
  terminate() { this.close(); }
  frame(value: unknown) { this.emit('message', Buffer.from(JSON.stringify(value))); }
}

test('meter fanout updates controllers but only engine or audio changes wake projector clients', t => {
  const state = initialProduction();
  const status = { state: 'running' as const, fps: 30, levels: { master: 0 }, sources: {}, sourceErrors: {}, recording: null };
  const hub = new ProductionHub(req => req.headers['x-engine'] === 'yes', () => state, () => status);
  t.after(() => hub.close());
  const connect = (engine = false) => {
    const socket = new Socket();
    hub.wss.emit('connection', socket, { headers: engine ? { 'x-engine': 'yes' } : {} });
    return socket;
  };
  const engine = connect(true), control = connect(), monitor = connect(), output = new Socket();
  monitor.frame({ t: 'watch', outputId: 'screen_main', monitorOnly: true });
  hub.attachOutputViewer(output as unknown as WebSocket, 'screen_main');
  hub.broadcast({ t: 'status', status });
  for (const socket of [engine, control, monitor, output]) socket.messages = [];
  for (let i = 0; i < 100; i++) {
    hub.broadcast({ t: 'status', status: { ...status, levels: { master: i / 100 } } });
  }
  assert.equal(control.messages.length, 100);
  assert.deepEqual([engine.messages.length, monitor.messages.length, output.messages.length], [0, 0, 0]);
  state.outputs[0].audioEnabled = true;
  hub.broadcast({ t: 'state', state }); hub.broadcast({ t: 'state', state });
  assert.deepEqual(output.messages, [{ t: 'output-status', outputId: 'screen_main', engineState: 'running', audioEnabled: true }]);
  hub.broadcast({ t: 'status', status: { ...status, state: 'offline' } });
  assert.equal(output.messages.at(-1)?.engineState, 'offline');
  assert.equal((monitor.messages.at(-1)?.status as typeof status).state, 'offline');
  state.outputs.shift();
  hub.broadcast({ t: 'state', state });
  assert.equal(output.readyState, WebSocket.CLOSED, 'An output removed from the document immediately revokes its scoped connection');
});

test('authenticated mobile monitor is silent, narrow and cannot become a public monitor or operator', t => {
  const state = initialProduction();
  state.sources.push({ id: 'private-camera', name: 'Private device', kind: 'camera', loop: false, url: 'media/private-input', audio: { volume: 1, muted: false, mode: 'always', delayMs: 0 } });
  const hub = new ProductionHub(req => req.headers['x-test-engine'] === 'yes', () => state,
    () => ({ state: 'running', fps: 30, levels: { privateInput: .7 }, sources: {}, sourceErrors: { input: 'private diagnostic' }, recording: null }));
  t.after(() => hub.close());
  const engine = new Socket(); hub.wss.emit('connection', engine as unknown as WebSocket, { headers: { 'x-test-engine': 'yes' } } as IncomingMessage);
  const engineId = engine.messages[0].peerId;
  const publicViewer = new Socket(); hub.attachOutputViewer(publicViewer as unknown as WebSocket, PROGRAM_MONITOR_OUTPUT_ID);
  assert.equal(publicViewer.readyState, WebSocket.CLOSED, 'A public output capability cannot access the private monitor.');
  const phone = new Socket(); engine.messages = [];
  hub.attachMobileProgramViewer(phone as unknown as WebSocket);
  assert.equal(phone.messages[0].outputId, PROGRAM_MONITOR_OUTPUT_ID);
  assert.equal(phone.messages[0].audioEnabled, false);
  assert.equal(engine.messages.at(-1)?.outputId, PROGRAM_MONITOR_OUTPUT_ID);
  assert.doesNotMatch(JSON.stringify(phone.messages), /Private device|private-input|private diagnostic|privateInput|sources|scenes|recording/);
  hub.broadcast({ t: 'state', state });
  assert.equal(phone.readyState, WebSocket.OPEN, 'A normal state update does not accidentally revoke the private mobile monitor.');
  assert.equal(phone.messages.at(-1)?.audioEnabled, false);
  engine.messages = [];
  for (const outputId of ['program', 'preview', 'multiview', 'recording', 'screen_main']) phone.frame({ t: 'watch', outputId });
  phone.frame({ t: 'publish', sourceId: 'private-camera' });
  phone.frame({ t: 'take', sceneId: state.scenes[0].id });
  phone.frame({ t: 'signal', peerId: engineId, key: 'out:preview', description: { type: 'answer', sdp: 'forged' } });
  phone.frame({ t: 'signal', peerId: engineId, key: `out:${PROGRAM_MONITOR_OUTPUT_ID}`, description: { type: 'offer', sdp: 'forged' } });
  assert.deepEqual(engine.messages, []);
  phone.frame({ t: 'signal', peerId: engineId, key: `out:${PROGRAM_MONITOR_OUTPUT_ID}`, description: { type: 'answer', sdp: 'valid scoped answer' } });
  assert.equal(engine.messages.at(-1)?.key, `out:${PROGRAM_MONITOR_OUTPUT_ID}`);
  phone.frame({ t: 'unwatch', outputId: PROGRAM_MONITOR_OUTPUT_ID });
  const before = engine.messages.length;
  phone.frame({ t: 'signal', peerId: engineId, key: `out:${PROGRAM_MONITOR_OUTPUT_ID}`, description: { type: 'answer', sdp: 'stale' } });
  assert.equal(engine.messages.length, before);
});
