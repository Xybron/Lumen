'use strict';

const { createInterface } = require('node:readline');
const VIDEO_BYTES = 1280 * 720 * 4;

function packet(type, value) {
  if (!(value instanceof Uint8Array) && !(value instanceof ArrayBuffer)) throw new Error('Invalid media buffer.');
  const bytes = value instanceof ArrayBuffer ? Buffer.from(value) : Buffer.from(value.buffer, value.byteOffset, value.byteLength);
  if (!((type === 1 && bytes.length === VIDEO_BYTES) || (type === 2 && bytes.length > 0 && bytes.length <= 32768 && bytes.length % 8 === 0)))
    throw new Error('Invalid media packet size.');
  const header = Buffer.alloc(12);
  header.writeUInt32LE(0x314d554c); header.writeUInt32LE(type, 4); header.writeUInt32LE(bytes.length, 8);
  return Buffer.concat([header, bytes]);
}

class DeviceTransport {
  constructor(child, onFailure) {
    this.child = child;
    this.pending = new Map();
    this.closed = false;
    this.ready = new Promise((resolve, reject) => { this.resolveReady = resolve; this.rejectReady = reject; });
    this.readyTimer = setTimeout(() => this.fail(new Error('Lumen devices did not start.')), 10000);
    this.onFailure = onFailure;
    this.lines = createInterface({ input: child.stdout });
    this.lines.on('line', line => {
      try {
        const message = JSON.parse(line);
        if (message.error) this.fail(new Error(message.error));
        if (message.state === 'ready') { clearTimeout(this.readyTimer); this.resolveReady(); }
        if (message.ack) {
          const pending = this.pending.get(message.ack);
          if (pending) { clearTimeout(pending.timer); this.pending.delete(message.ack); pending.resolve(!!message.accepted); }
        }
      } catch { this.fail(new Error('Invalid response from Lumen devices.')); }
    });
    child.once('error', error => this.fail(error));
    child.once('exit', () => { if (!this.closed) this.fail(new Error('Lumen devices disconnected.')); });
    child.stdin.on('error', error => this.fail(error));
  }
  send(type, value) {
    // At most one video and one audio packet can be in flight. No growing IPC or pipe queues.
    if (this.closed || this.pending.has(type)) return Promise.resolve(false);
    const bytes = packet(type, value);
    return new Promise(resolve => {
      const timer = setTimeout(() => this.fail(new Error('Lumen device stopped accepting media.')), 2000);
      this.pending.set(type, { resolve, timer });
      this.child.stdin.write(bytes);
    });
  }
  fail(error) { if (!this.closed) { this.close(error); this.onFailure(error); } }
  close(reason = new Error('Lumen devices stopped.')) {
    if (this.closed) return;
    this.closed = true;
    clearTimeout(this.readyTimer);
    this.rejectReady(reason);
    for (const entry of this.pending.values()) { clearTimeout(entry.timer); entry.resolve(false); }
    this.pending.clear();
    this.lines.close();
    this.child.stdin.end();
    // EOF normally releases camera/audio immediately. Reap a wedged helper too.
    const timer = setTimeout(() => this.child.kill(), 1000); timer.unref();
    this.child.once('exit', () => clearTimeout(timer));
  }
}
module.exports = { packet, DeviceTransport, VIDEO_BYTES };
