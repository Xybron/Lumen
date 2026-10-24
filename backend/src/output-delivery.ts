import { Router } from 'express';
import http from 'node:http';
import { randomBytes, createHash, timingSafeEqual } from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import type { AddressInfo } from 'node:net';
import { WebSocket, WebSocketServer } from 'ws';
import { z } from 'zod';
import type { ProductionState } from '../../shared/production.js';
import { ProductionHub } from './production-hub.js';
import { ProductionError } from './production-store.js';
import { PROGRAM_MONITOR_OUTPUT_ID } from '../../shared/program-monitor.js';

const outputId = z.string().regex(/^[a-zA-Z0-9_-]{1,80}$/);
const capability = z.string().regex(/^[A-Za-z0-9_-]{43}$/);
const storedSchema = z.object({ version: z.literal(1), links: z.array(z.object({ outputId, key: capability, createdAt: z.string().datetime() }).strict()).max(12) }).strict();
type Link = z.infer<typeof storedSchema>['links'][number];
interface Listener { host: string; port: number; server: http.Server; sockets: Set<WebSocket> }
export interface OutputDeliveryStatus {
  running: boolean; host: string; port: number;
  interfaces: Array<{ address: string; label: string }>;
  links: Array<{ outputId: string; enabled: true; createdAt: string; url: string | null; localUrl: string | null; networkUrl: string | null; viewers: number }>;
  maxViewers: number; perLinkLimit: number;
}
const privateV4 = (address: string) => /^(?:10\.|192\.168\.|172\.(?:1[6-9]|2\d|3[01])\.)/.test(address);
export function outputInterfaces() {
  return Object.entries(os.networkInterfaces()).flatMap(([name, addresses]) => (addresses ?? [])
    .filter(item => item.family === 'IPv4' && !item.internal && privateV4(item.address))
    .map(item => ({ address: item.address, label: `${name} · ${item.address}` })));
}
const digest = (value: string) => createHash('sha256').update(value).digest();
const sameKey = (left: string, right: string) => timingSafeEqual(digest(left), digest(right));
const HTML = `<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Lumen output</title><link rel="stylesheet" href="/viewer.css"></head><body class="idle"><video id="picture" autoplay playsinline muted></video><div id="message" role="status">Connecting to output…</div><div id="controls"><button id="sound" type="button">Enable sound</button><button id="fullscreen" type="button">Fullscreen</button></div><script src="/viewer.js" defer></script></body></html>`;
const CSS = `*{box-sizing:border-box}html,body{margin:0;width:100%;height:100%;overflow:hidden;background:#000;color:#a8b1ba;font:14px system-ui,sans-serif}video{width:100%;height:100%;object-fit:contain;background:#000}#message{position:fixed;inset:0;display:grid;place-content:center;pointer-events:none}.hidden{display:none!important}#controls{position:fixed;bottom:20px;right:20px;display:flex;gap:8px;transition:opacity .15s}button{border:1px solid #ffffff22;border-radius:8px;background:#181c21eb;color:#e3e8ee;padding:10px 14px;font:inherit;cursor:pointer}button:focus-visible{outline:2px solid #7dd3fc;outline-offset:2px}button:disabled{opacity:.5;cursor:default}.idle{cursor:none}.idle #controls{opacity:0;pointer-events:none}@media(prefers-reduced-motion:reduce){#controls{transition:none}}`;
const SCRIPT = `(()=>{'use strict';
const video=document.getElementById('picture'),message=document.getElementById('message'),sound=document.getElementById('sound');
const id=location.pathname.split('/').pop(),parameters=new URLSearchParams(location.hash.slice(1)),key=parameters.get('key');let requestedAudio=parameters.get('audio')==='1';
if(location.hash)history.replaceState(null,'',location.pathname);
let socket=null,pc=null,remote=null,pending=[],stopped=false,backoff=500,reconnect,requestTimer,idleTimer,epoch=0,chain=Promise.resolve(),allowAudio=false;
const show=text=>{message.textContent=text;message.classList.remove('hidden')};
function reset(){epoch++;if(pc){pc.ontrack=null;pc.onconnectionstatechange=null;pc.close()}pc=null;remote=null;pending=[];video.srcObject=null;show('Waiting for the production engine');}
function send(value){if(socket&&socket.readyState===WebSocket.OPEN)socket.send(JSON.stringify(value));}
function watch(){send({t:'watch',outputId:id});}
async function receive(m){if(m.t==='connected'){backoff=500;allowAudio=m.audioEnabled===true;video.muted=!requestedAudio||!allowAudio;sound.disabled=!allowAudio;sound.textContent=!allowAudio?'Sound unavailable':video.muted?'Enable sound':'Mute output';if(m.engineState!=='running')show('Waiting for the production engine');return;}
if(m.t==='output-status'){const before=allowAudio;allowAudio=m.audioEnabled===true;sound.disabled=!allowAudio;if(!allowAudio){video.muted=true;sound.textContent='Sound unavailable'}else{if(!before&&requestedAudio)video.muted=false;sound.textContent=video.muted?'Enable sound':'Mute output';}if(m.engineState!=='running'&&m.engineState!=='starting')reset();return;}
if(m.t!=='signal'||m.key!=='out:'+id||!m.peerId)return;
if(m.description&&m.description.type==='offer'){const early=pending;reset();pending=early.filter(item=>item.peerId===m.peerId).map(item=>item.candidate);const turn=epoch,connection=new RTCPeerConnection({iceServers:[]});pc=connection;remote=m.peerId;
connection.ontrack=e=>{if(pc!==connection)return;video.srcObject=e.streams[0]||new MediaStream([e.track]);video.play().catch(()=>{if(pc!==connection)return;video.muted=true;requestedAudio=false;sound.textContent=allowAudio?'Enable sound':'Sound unavailable';video.play().catch(()=>{})});};
connection.onicecandidate=e=>{if(e.candidate&&pc===connection)send({t:'signal',peerId:m.peerId,key:'out:'+id,candidate:e.candidate.toJSON()});};
connection.onconnectionstatechange=()=>{if(pc===connection&&['failed','closed'].includes(connection.connectionState))reset();};
await connection.setRemoteDescription(m.description);if(turn!==epoch||pc!==connection)return;for(const item of pending.splice(0))await connection.addIceCandidate(item).catch(()=>{});
await connection.setLocalDescription(await connection.createAnswer());if(turn===epoch&&pc===connection)send({t:'signal',peerId:m.peerId,key:'out:'+id,description:connection.localDescription.toJSON()});
}else if(m.candidate){if(pc&&m.peerId===remote){if(pc.remoteDescription)await pc.addIceCandidate(m.candidate).catch(()=>{});else if(pending.length<64)pending.push(m.candidate);}else if(!pc&&pending.length<64)pending.push({peerId:m.peerId,candidate:m.candidate});}}
function connect(){if(stopped)return;if(!key||!/^[A-Za-z0-9_-]{43}$/.test(key)){show('This output link is missing its access key');return;}
const connection=new WebSocket((location.protocol==='https:'?'wss:':'ws:')+'//'+location.host+'/signal');socket=connection;
connection.onopen=()=>{if(socket===connection)send({t:'auth',outputId:id,key});};connection.onmessage=e=>{try{const m=JSON.parse(e.data);chain=chain.then(()=>{if(socket===connection&&connection.readyState===WebSocket.OPEN)return receive(m);}).catch(()=>{if(socket===connection)reset();});}catch{}};
connection.onclose=e=>{if(socket!==connection)return;reset();if(stopped)return;if(e.code===1008){show('This output link is unavailable or has been revoked');return;}show('Reconnecting to output…');reconnect=setTimeout(connect,backoff);backoff=Math.min(5000,backoff*2);};connection.onerror=()=>connection.close();}
video.addEventListener('playing',()=>message.classList.add('hidden'));
sound.addEventListener('click',()=>{if(!allowAudio)return;video.muted=!video.muted;requestedAudio=!video.muted;sound.textContent=video.muted?'Enable sound':'Mute output';video.play().catch(()=>{video.muted=true;requestedAudio=false;sound.textContent='Enable sound';});});
function fullscreen(){if(!document.fullscreenElement)document.documentElement.requestFullscreen?.().catch(()=>{});else document.exitFullscreen?.().catch(()=>{});}
document.getElementById('fullscreen').addEventListener('click',fullscreen);document.addEventListener('dblclick',fullscreen);document.addEventListener('keydown',e=>{if(e.key.toLowerCase()==='f')fullscreen();});
function awake(){document.body.classList.remove('idle');clearTimeout(idleTimer);idleTimer=setTimeout(()=>document.body.classList.add('idle'),2500);}document.addEventListener('pointermove',awake);document.addEventListener('keydown',awake);
window.addEventListener('pagehide',()=>{stopped=true;clearTimeout(reconnect);clearInterval(requestTimer);clearTimeout(idleTimer);socket?.close();reset();});
requestTimer=setInterval(()=>{if(!pc||['failed','closed','disconnected'].includes(pc.connectionState))watch();},3000);connect();})();`;

/** Dedicated read-only listener. Its router must be mounted behind the station's
 * operator + same-origin controls; viewer capabilities never reach station APIs. */
export async function createOutputDelivery(options: { directory: string; hub: ProductionHub; getState: () => ProductionState; listenPort?: number }) {
  const directory = path.resolve(options.directory), filename = path.join(directory, 'links-private.json');
  const existing = await fs.lstat(directory).catch(error => { if (error.code !== 'ENOENT') throw error; return null; });
  if (existing && (!existing.isDirectory() || existing.isSymbolicLink())) throw new ProductionError(503, 'Output sharing requires a private settings directory.');
  await fs.mkdir(directory, { recursive: true, mode: 0o700 }); await fs.chmod(directory, 0o700);
  let links: Link[] = [];
  const info = await fs.lstat(filename).catch(error => { if (error.code !== 'ENOENT') throw error; return null; });
  if (info) {
    if (!info.isFile() || info.isSymbolicLink() || info.size > 65536 || process.platform !== 'win32' && (info.mode & 0o077)) throw new ProductionError(503, 'Output link settings are not a private regular file.');
    try { links = storedSchema.parse(JSON.parse(await fs.readFile(filename, 'utf8'))).links; }
    catch { throw new ProductionError(503, 'Output link settings could not be read. Existing files were preserved.'); }
    if (new Set(links.map(link => link.outputId)).size !== links.length) throw new ProductionError(503, 'Output link settings contain duplicate entries.');
  }
  let local: Listener | null = null, network: Listener | null = null, configuredPort = options.listenPort ?? 3485, closed = false;
  let operations: Promise<unknown> = Promise.resolve();
  const viewers = new Map<WebSocket, string>(), pending = new Set<WebSocket>();
  const wss = new WebSocketServer({ noServer: true, maxPayload: 72 * 1024, perMessageDeflate: false });
  const validOutput = (id: string) => id === 'program' || options.getState().outputs.some(output => output.id === id && !['preview', 'multiview', 'recording', PROGRAM_MONITOR_OUTPUT_ID].includes(id));
  async function persist(next: Link[]) {
    const temporary = path.join(directory, `links-${randomBytes(12).toString('hex')}.tmp`);
    try {
      const handle = await fs.open(temporary, 'wx', 0o600);
      try { await handle.writeFile(JSON.stringify({ version: 1, links: next }, null, 2)); await handle.sync(); }
      finally { await handle.close(); }
      await fs.rename(temporary, filename); links = next;
    } finally { await fs.unlink(temporary).catch(() => {}); }
  }
  function status(): OutputDeliveryStatus {
    const makeUrl = (listener: Listener | null, link: Link) => listener ? `http://${listener.host}:${listener.port}/output/${link.outputId}#key=${link.key}` : null;
    return { running: !!local, host: network?.host ?? '127.0.0.1', port: local?.port ?? configuredPort,
      interfaces: outputInterfaces(), links: links.filter(link => validOutput(link.outputId)).map(link => {
        const localUrl = makeUrl(local, link);
        return { outputId: link.outputId, enabled: true, createdAt: link.createdAt, url: localUrl, localUrl,
          networkUrl: makeUrl(network, link), viewers: [...viewers.values()].filter(id => id === link.outputId).length };
      }), maxViewers: 12, perLinkLimit: 4 };
  }
  async function stopListener(listener: Listener | null) {
    if (!listener) return;
    for (const ws of listener.sockets) ws.terminate();
    await new Promise<void>(resolve => { listener.server.close(() => resolve()); listener.server.closeAllConnections(); });
  }
  async function listen(host: string, port: number): Promise<Listener> {
    const sockets = new Set<WebSocket>();
    const server = http.createServer({ maxHeaderSize: 8192, headersTimeout: 5000, requestTimeout: 10000 }, (req, res) => {
      const origin = `http://${host}:${(server.address() as AddressInfo).port}`;
      res.setHeader('Cache-Control', 'no-store'); res.setHeader('Referrer-Policy', 'no-referrer'); res.setHeader('X-Content-Type-Options', 'nosniff');
      res.setHeader('Content-Security-Policy', `default-src 'none'; script-src 'self'; style-src 'self'; connect-src 'self' ${origin.replace('http:', 'ws:')}; media-src 'self' blob:; base-uri 'none'; frame-ancestors 'none'; form-action 'none'`);
      res.setHeader('Permissions-Policy', 'camera=(), microphone=(), geolocation=()');
      if (req.headers.host !== new URL(origin).host) { res.writeHead(421).end(); return; }
      let url: URL; try { url = new URL(req.url ?? '/', origin); } catch { res.writeHead(400).end(); return; }
      if (!['GET', 'HEAD'].includes(req.method ?? '') || url.search) { res.writeHead(404).end(); return; }
      const body = /^\/output\/[a-zA-Z0-9_-]{1,80}$/.test(url.pathname) ? HTML : url.pathname === '/viewer.js' ? SCRIPT : url.pathname === '/viewer.css' ? CSS : null;
      if (body === null) { res.writeHead(404).end(); return; }
      res.writeHead(200, { 'Content-Type': url.pathname === '/viewer.js' ? 'text/javascript; charset=utf-8' : url.pathname === '/viewer.css' ? 'text/css; charset=utf-8' : 'text/html; charset=utf-8', 'Content-Length': Buffer.byteLength(body) });
      res.end(req.method === 'HEAD' ? undefined : body);
    });
    server.on('upgrade', (req, socket, head) => {
      const address = server.address() as AddressInfo | null, origin = address && `http://${host}:${address.port}`;
      if (!origin || req.url !== '/signal' || req.headers.host !== new URL(origin).host || req.headers.origin !== origin || pending.size + viewers.size >= 12 || wss.clients.size >= 24) { socket.destroy(); return; }
      wss.handleUpgrade(req, socket, head, ws => {
        sockets.add(ws); pending.add(ws);
        const timer = setTimeout(() => ws.close(1008, 'Output authorization required'), 3000); timer.unref();
        ws.once('close', () => { clearTimeout(timer); sockets.delete(ws); pending.delete(ws); viewers.delete(ws); });
        ws.on('error', () => ws.terminate());
        ws.once('message', raw => {
          clearTimeout(timer); pending.delete(ws);
          try {
            const bytes = Array.isArray(raw) ? Buffer.concat(raw) : Buffer.isBuffer(raw) ? raw : Buffer.from(raw);
            if (bytes.byteLength > 1024) throw new Error();
            const auth = z.object({ t: z.literal('auth'), outputId, key: capability }).strict().parse(JSON.parse(bytes.toString()));
            const saved = links.find(link => link.outputId === auth.outputId);
            if (!saved || !validOutput(auth.outputId) || !sameKey(saved.key, auth.key)
              || viewers.size >= 12 || [...viewers.values()].filter(id => id === auth.outputId).length >= 4) throw new Error();
            viewers.set(ws, auth.outputId); options.hub.attachOutputViewer(ws, auth.outputId);
          } catch { ws.close(1008, 'Output link is unavailable'); }
        });
      });
    });
    try { await new Promise<void>((resolve, reject) => { server.once('error', reject); server.listen(port, host, () => { server.off('error', reject); resolve(); }); }); }
    catch { throw new ProductionError(503, 'The output listener could not start. Check that its port and selected network interface are available.'); }
    return { host, port: (server.address() as AddressInfo).port, server, sockets };
  }
  async function ensureLocal() { if (!local) { local = await listen('127.0.0.1', configuredPort); configuredPort = local.port; } }
  const router = Router();
  const action = (fn: () => Promise<unknown>) => {
    const current = operations.then(async () => { if (closed) throw new ProductionError(503, 'Output sharing has closed.'); return fn(); });
    operations = current.catch(() => {}); return current;
  };
  router.get('/', (_req, res) => { res.set('Cache-Control', 'private, no-store').json(status()); });
  router.post('/links', (req, res, next) => { void action(async () => {
    const input = z.object({ outputId }).strict().parse(req.body);
    if (!validOutput(input.outputId)) throw new ProductionError(404, 'Output not found.');
    await ensureLocal();
    if (!links.some(link => link.outputId === input.outputId)) await persist([...links.filter(link => validOutput(link.outputId)), { outputId: input.outputId, key: randomBytes(32).toString('base64url'), createdAt: new Date().toISOString() }]);
    res.set('Cache-Control', 'private, no-store').json(status());
  }).catch(next); });
  router.delete('/links/:outputId', (req, res, next) => { void action(async () => {
    const id = outputId.parse(req.params.outputId); await persist(links.filter(link => link.outputId !== id));
    for (const [ws, value] of viewers) if (value === id) { ws.close(1008, 'Output link revoked'); ws.terminate(); }
    res.set('Cache-Control', 'private, no-store').json(status());
  }).catch(next); });
  router.post('/network', (req, res, next) => { void action(async () => {
    const input = z.object({ host: z.string().max(64), port: z.number().int().min(1024).max(65535).optional() }).strict().parse(req.body);
    if (input.host !== '127.0.0.1' && !outputInterfaces().some(item => item.address === input.host)) throw new ProductionError(422, 'Choose a connected private-network interface.');
    const selectedPort = input.port ?? local?.port ?? configuredPort;
    if (local && selectedPort !== local.port) throw new ProductionError(409, 'Existing output links use another port. Restart output sharing before changing its port.');
    if (!local) configuredPort = selectedPort;
    await ensureLocal();
    if (input.host === '127.0.0.1') { const previous = network; network = null; await stopListener(previous); }
    else if (network?.host !== input.host) {
      const replacement = await listen(input.host, local!.port), previous = network; network = replacement; await stopListener(previous);
    }
    res.set('Cache-Control', 'private, no-store').json(status());
  }).catch(next); });
  return { router, async close() {
    closed = true; await operations;
    const a = local, b = network; local = null; network = null;
    await Promise.all([stopListener(a), stopListener(b)]);
    for (const ws of wss.clients) ws.terminate();
    await new Promise<void>(resolve => wss.close(() => resolve()));
  } };
}
