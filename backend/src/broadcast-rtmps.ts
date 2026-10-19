import net from 'node:net';
import tls from 'node:tls';
import type { BroadcastFailureCode } from './broadcast-process.js';

export type BroadcastTlsConnect = (options: tls.ConnectionOptions) => tls.TLSSocket;
export interface BroadcastRtmpsTransport {
  url: string;
  tcUrl: string;
  failure(): BroadcastFailureCode;
  close(): Promise<void>;
}
/** FFmpeg's bundled macOS TLS stack can stall after RTMP publish. Keep its
 * remuxer on a single private loopback connection; Node owns verified RTMPS.
 * No arbitrary hostname or plaintext external destination is accepted here. */
export async function openBroadcastRtmpsTransport(target: string, options: {
  connectTls?: BroadcastTlsConnect;
  onFailure?: (code: BroadcastFailureCode) => void;
} = {}): Promise<BroadcastRtmpsTransport> {
  let remote: URL;
  try { remote = new URL(target); } catch { throw new Error('Invalid secure stream destination.'); }
  const prefix = remote.hostname === 'a.rtmps.youtube.com' ? '/live2/' : remote.hostname === 'live-api-s.facebook.com' ? '/rtmp/' : '';
  if (!prefix || remote.protocol !== 'rtmps:' || remote.port && remote.port !== '443' || remote.username || remote.password || remote.hash || !remote.pathname.startsWith(prefix)) throw new Error('Only the fixed secure streaming providers are supported.');
  let accepted = false, closing = false, code: BroadcastFailureCode = 'unknown', client: net.Socket | null = null, upstream: tls.TLSSocket | null = null, closeTask: Promise<void> | null = null;
  let handshakeTimer: ReturnType<typeof setTimeout> | undefined;
  const server = net.createServer({ pauseOnConnect: true }, socket => {
    if (accepted || closing || socket.remoteAddress !== '127.0.0.1') { socket.destroy(); return; }
    accepted = true; client = socket; socket.setNoDelay(true);
    if (handshakeTimer) clearTimeout(handshakeTimer);
    // Never leave a reusable local forwarding port or accept a second client.
    server.close();
    socket.on('error', () => fail('network')); socket.on('close', () => { if (!closing) fail('network'); }); socket.setTimeout(8000, () => fail('network'));
    try {
      upstream = (options.connectTls ?? tls.connect)({ host: remote.hostname, port: 443, servername: remote.hostname,
        rejectUnauthorized: true, minVersion: 'TLSv1.2' });
      upstream.setNoDelay(true); upstream.setTimeout(8000, () => fail('network'));
      handshakeTimer = setTimeout(() => fail('network'), 8000); handshakeTimer.unref();
      upstream.once('secureConnect', () => {
        if (handshakeTimer) clearTimeout(handshakeTimer);
        if (closing) return;
        if (!upstream?.authorized) { fail('certificate'); return; }
        // pipe() obeys bounded socket high-water marks and pauses its source.
        // A slow network therefore reaches the existing per-sink queue limit,
        // never the shared encoder/recording path.
        socket.pipe(upstream); upstream.pipe(socket); socket.resume();
      });
      upstream.on('error', error => {
        const value = (error as NodeJS.ErrnoException).code ?? '';
        fail(/CERT|SELF_SIGNED|VERIFY_LEAF|ISSUER|TLS_CERT/.test(value) ? 'certificate' : 'network');
      });
      upstream.on('close', () => { if (!closing) fail('network'); });
    } catch { fail('network'); }
  });
  const fail = (failure: BroadcastFailureCode) => {
    if (closing) return; code = failure;
    // Destroy first, then notify; a callback cannot strand a socket by throwing.
    void close(); try { options.onFailure?.(failure); } catch { /* Media isolation remains intact. */ }
  };
  server.on('error', () => { if (accepted) fail('network'); });
  await new Promise<void>((resolve, reject) => {
    const unavailable = () => reject(new Error('The private streaming connection could not be opened.'));
    server.once('error', unavailable);
    server.listen(0, '127.0.0.1', () => { server.off('error', unavailable); resolve(); });
  });
  const address = server.address(); if (!address || typeof address === 'string') { server.close(); throw new Error('The private streaming connection is unavailable.'); }
  // A failed remuxer may never connect. Do not leave even a private listener
  // open until the longer renderer watchdog notices missing input.
  handshakeTimer = setTimeout(() => fail('network'), 8000); handshakeTimer.unref();
  async function close() {
    if (closeTask) return closeTask; closing = true;
    if (handshakeTimer) clearTimeout(handshakeTimer);
    client?.destroy(); upstream?.destroy();
    closeTask = new Promise<void>(resolve => {
      if (!server.listening) { resolve(); return; }
      server.close(() => resolve());
    });
    return closeTask;
  }
  return { url: `rtmp://127.0.0.1:${address.port}${remote.pathname}${remote.search}`,
    tcUrl: `rtmps://${remote.host}${prefix.slice(0, -1)}`, failure: () => code, close };
}
