import express, { Router, type Request, type Response, type NextFunction } from 'express';
import https from 'node:https';
import type { IncomingMessage } from 'node:http';
import type { Duplex } from 'node:stream';
import { WebSocket, WebSocketServer } from 'ws';
import type { AddressInfo } from 'node:net';
import { createHash, randomBytes, randomUUID } from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';
import { z } from 'zod';
import { parseCookie, readSession, sessionUser, userCan, SESSION_COOKIE, type SessionUser } from './auth.js';
import { loadOwners } from './presence.js';
import { ProductionError } from './production-store.js';
import { SelectionSchema } from './worship-library.js';
import type { Content } from './schema.js';
import type { RelayHandle } from './ws.js';
import type { ProductionState, StudioScene, StudioStatus } from '../../shared/production.js';
import type { WorshipWorkspace, WorshipCommand, ScriptureSearchResult, LyricsSearchHit } from '../../shared/worship.js';
import type { MobileAction, MobileChannel, MobileDevice, MobileLease, MobilePermissions, MobileScene, MobileSnapshot, MobileSearchResults } from '../../shared/mobile-controller.js';

const opaque = () => randomBytes(24).toString('base64url');
const digest = (value: unknown) => createHash('sha256').update(JSON.stringify(value)).digest('hex');
const key = z.string().min(1).max(100);
const Permissions = z.object({ studio: z.boolean(), channels: z.boolean(), audio: z.boolean() }).strict();
export const MobileActionSchema = z.discriminatedUnion('type', [
  z.object({ type: z.literal('preview'), sceneId: key }).strict(),
  z.object({ type: z.literal('take'), transition: z.enum(['cut', 'fade']), durationMs: z.number().int().min(100).max(3000).optional() }).strict(),
  z.object({ type: z.literal('main-audio'), muted: z.boolean().optional(), volume: z.number().finite().min(0).max(1).optional() }).strict(),
  z.object({ type: z.literal('channel-take'), channelId: key, selection: z.union([SelectionSchema, z.object({ kind: z.literal('presentation'), index: z.number().int().min(0).max(10000) }).strict()]) }).strict(),
  z.object({ type: z.literal('channel-step'), channelId: key, direction: z.union([z.literal(1), z.literal(-1)]) }).strict(),
  z.object({ type: z.literal('channel-blank'), channelId: key, blanked: z.boolean() }).strict(),
]);
interface ProductionAdapter {
  get(): ProductionState; status(): StudioStatus;
  select(revision: number, sceneId: string, authorize: () => void): Promise<unknown>;
  take(revision: number, sceneId: string, transition: 'cut' | 'fade', durationMs: number, authorize: () => void): Promise<unknown>;
  audio(revision: number, patch: { muted?: boolean; volume?: number }, authorize: () => void): Promise<unknown>;
}
interface WorshipAdapter {
  workspace(id: string): WorshipWorkspace;
  search(id: string, query: string): { scripture(): ScriptureSearchResult; lyrics(): LyricsSearchHit[] };
  command(id: string, revision: number, command: WorshipCommand, authorize: () => void): unknown;
}
export interface MobileGatewayOptions { origin: string; host: string; port: number; key: Buffer; cert: Buffer }
export interface MobileControllerOptions {
  workspaceId: string; production: ProductionAdapter; worship: WorshipAdapter; relay: RelayHandle;
  content(): Promise<Content>; frontendDir: string; allowedLocalOrigins: string[];
  gateway?: MobileGatewayOptions; now?: () => number;
  attachProgramViewer?: (ws: WebSocket) => void;
  resolveOperator?: (cookie: string | undefined) => { sessionId: string; user: SessionUser } | null;
  resolveSession?: (id: string) => SessionUser | null;
  can?: (user: SessionUser, channelId: string) => boolean;
  owners?: () => Record<string, string>;
}
interface Pair { codeHash: string; issuer: string; userId: string; name: string; permissions: MobilePermissions; expiresAt: number }
interface Ticket { value: string; expiresAt: number; revision: number; fingerprint: string }
interface Device extends MobileDevice { issuer: string; userId: string; tokenHash: string; tickets: Map<string, Ticket>; busy: boolean }
const loopback = (value: string | undefined) => value === '127.0.0.1' || value === '::1' || value === '::ffff:127.0.0.1';
function cookieValue(header: string | undefined, name: string) { try { return parseCookie(header, name); } catch { return undefined; } }
const color = (value: string, fallback: string) => /^#[\da-f]{3,8}$/i.test(value) ? value : fallback;
function safeScene(scene: StudioScene): MobileScene {
  return { id: scene.id, name: scene.name, background: color(scene.background, '#15181b'), layers: scene.layers.filter(layer => layer.visible && layer.kind !== 'source').map(layer => ({
    id: layer.id, text: layer.kind === 'text' ? layer.text.slice(0, 500) : '', x: layer.x, y: layer.y, width: layer.width, height: layer.height,
    color: color(layer.color, '#ffffff'), background: color(layer.background, '#00000000'), fontSize: layer.fontSize, align: layer.align, opacity: layer.opacity,
  })) };
}
const asyncRoute = (fn: (req: Request, res: Response) => unknown | Promise<unknown>) => (req: Request, res: Response, next: NextFunction) => { void Promise.resolve().then(() => fn(req, res)).catch(next); };

/** Separate, capability-authenticated control surface. No legacy station API or
 * generic WebSocket is made reachable on the phone listener. All credentials,
 * device sessions, leases and action tickets are memory-only and restart-revoked. */
export async function createMobileController(options: MobileControllerOptions) {
  const now = options.now ?? Date.now, can = options.can ?? ((user, channel) => userCan(user, channel, 'author'));
  const lookup = options.resolveSession ?? sessionUser, owners = options.owners ?? loadOwners;
  const resolveOperator = options.resolveOperator ?? ((cookie: string | undefined) => {
    const id = cookieValue(cookie, SESSION_COOKIE), user = id ? lookup(id) : null;
    return id && user ? { sessionId: id, user } : null;
  });
  const localOrigins = new Set(options.allowedLocalOrigins.map(value => new URL(value).origin));
  for (const value of localOrigins) { const url = new URL(value); if (!['127.0.0.1', 'localhost', '[::1]'].includes(url.hostname) || !['http:', 'https:'].includes(url.protocol)) throw new Error('Mobile management only accepts explicit loopback origins.'); }
  const gatewayOrigin = options.gateway ? new URL(options.gateway.origin) : null;
  if (gatewayOrigin && (gatewayOrigin.protocol !== 'https:' || gatewayOrigin.username || gatewayOrigin.password || gatewayOrigin.href !== gatewayOrigin.origin + '/' || options.gateway!.port !== Number(gatewayOrigin.port || 443))) throw new Error('Mobile access requires an exact HTTPS origin matching its listener port.');
  const pairs = new Map<string, Pair>(), devices = new Map<string, Device>();
  const buckets = new Map<string, { at: number; count: number }>();
  const contentDigests = new WeakMap<Content, string>();
  const viewers = new Map<string, WebSocket>();
  const viewerServer = new WebSocketServer({ noServer: true, maxPayload: 128 * 1024 });
  let lease: MobileLease | null = null, closing = false;
  function prune() {
    const timestamp = now();
    for (const [id, pair] of pairs) if (pair.expiresAt <= timestamp) pairs.delete(id);
    for (const [id, device] of devices) {
      if (device.expiresAt <= timestamp) devices.delete(id);
      else for (const [key, ticket] of device.tickets) if (ticket.expiresAt <= timestamp) device.tickets.delete(key);
    }
    if (lease && (lease.expiresAt <= timestamp || ![...devices.values()].some(device => device.id === lease!.deviceId))) lease = null;
    for (const [id, value] of buckets) if (value.at + 60000 <= timestamp) buckets.delete(id);
  }
  function rate(req: Request, scope: string, limit: number, deviceId?: string) {
    prune(); const id = `${scope}:${deviceId ?? req.socket.remoteAddress ?? 'unknown'}`;
    if (!buckets.has(id) && buckets.size >= 1024) throw new ProductionError(429, 'Too many requests. Try again shortly.');
    const value = buckets.get(id) ?? { at: now(), count: 0 }; value.count++; buckets.set(id, value);
    if (value.count > limit) throw new ProductionError(429, 'Too many requests. Try again shortly.');
  }
  function boundary(req: Request, gateway: boolean, mutation = false) {
    if (closing) throw new ProductionError(503, 'The station is shutting down.');
    const allowed = gateway ? new Set([gatewayOrigin!.origin]) : localOrigins;
    if (!gateway && !loopback(req.socket.remoteAddress)) throw new ProductionError(403, 'Use the dedicated secure phone address.');
    if (![...allowed].some(value => new URL(value).host === req.headers.host)) throw new ProductionError(421, 'Unrecognized station address.');
    if (req.headers.origin !== undefined && !allowed.has(req.headers.origin)) throw new ProductionError(403, 'This page is not authorized to control the station.');
    if (mutation && (!req.headers.origin || !allowed.has(req.headers.origin))) throw new ProductionError(403, 'A same-origin control request is required.');
    if (req.headers['sec-fetch-site'] === 'cross-site') throw new ProductionError(403, 'Cross-site control requests are blocked.');
  }
  function issuer(device: Pick<Device, 'issuer' | 'userId'>): SessionUser {
    const user = lookup(device.issuer);
    if (!user || user.id !== device.userId || !can(user, '*')) throw new ProductionError(401, 'Station permission expired. Pair this device again from Studio.');
    return user;
  }
  function publicDevice(device: Device): MobileDevice { return { id: device.id, name: device.name, permissions: { ...device.permissions }, expiresAt: device.expiresAt }; }
  function authenticate(req: Request, gateway: boolean): Device {
    prune(); const token = cookieValue(req.headers.cookie, gateway ? '__Host-lumen_mobile' : 'lumen_mobile_local');
    const device = token ? devices.get(digest(token)) : undefined;
    if (!device) throw new ProductionError(401, 'Pair this phone from Studio to continue.');
    issuer(device); return device;
  }
  const cookie = (res: Response, token: string, gateway: boolean) => res.cookie(gateway ? '__Host-lumen_mobile' : 'lumen_mobile_local', token, { httpOnly: true, sameSite: 'strict', secure: gateway, path: '/', maxAge: 8 * 3600000 });
  function release(id: string) { if (lease?.deviceId === id) lease = null; }
  function revoke(id: string) { for (const [hash, device] of devices) if (device.id === id) { release(id); devices.delete(hash); } viewers.get(id)?.terminate(); viewers.delete(id); }
  function authorize(device: Device, requiredLease?: string, permission?: keyof MobilePermissions, channelId?: string) {
    prune(); if (devices.get(device.tokenHash) !== device) throw new ProductionError(401, 'This phone was disconnected. Pair again from Studio.');
    const user = issuer(device);
    if (permission && !device.permissions[permission]) throw new ProductionError(403, 'This phone does not have permission for that control.');
    if (requiredLease && (!lease || lease.id !== requiredLease || lease.deviceId !== device.id)) throw new ProductionError(409, 'Phone control changed or expired. Take control again before continuing.');
    if (channelId && (!can(user, channelId) || owners()[channelId] && owners()[channelId] !== user.id)) throw new ProductionError(409, 'Another operator controls this channel. Resolve channel ownership in Studio.');
    return user;
  }
  async function documents() {
    const content = await options.content(), production = options.production.get();
    let contentDigest = contentDigests.get(content);
    if (!contentDigest) { contentDigest = digest(content); contentDigests.set(content, contentDigest); }
    const channels = content.channels.map(channel => {
      const workspace = ['scripture', 'lyrics'].includes(channel.kind) ? options.worship.workspace(channel.id) : null;
      const state = workspace ?? options.relay.getChannelSnapshot?.(channel.id) ?? null;
      return { channel, workspace, state, playlist: content.playlists.find(playlist => playlist.id === channel.playlistId) };
    });
    return { content, production, channels, fingerprint: digest({ contentDigest, productionRevision: production.revision, channels: channels.map(value => [value.channel.id, value.state]) }) };
  }
  function channelSnapshot(value: Awaited<ReturnType<typeof documents>>['channels'][number]): MobileChannel {
    const { channel, workspace, state, playlist } = value;
    const projection = state as Record<string, unknown> | null;
    const item = playlist?.items[typeof projection?.index === 'number' ? projection.index : 0];
    const live = workspace ? workspace.live && { title: workspace.live.title, text: workspace.live.text, reference: workspace.live.reference }
      : item && state ? { title: item.title, text: item.body, reference: item.reference } : null;
    return { id: channel.id, name: channel.name, kind: channel.kind, revision: digest(state), live: live ?? null,
      blanked: workspace?.blanked ?? projection?.blanked === true,
      items: workspace ? [] : (playlist?.items ?? []).slice(0, 200).flatMap((item, index) => item.type === 'section' ? [] : [{ id: item.id, title: item.title || `Slide ${index + 1}`, text: item.body.slice(0, 500), index }]),
      ...(!workspace && (playlist?.items.length ?? 0) > 200 ? { itemsTruncated: true } : {}),
      ...(workspace ? { versionId: workspace.versionId } : {}) };
  }
  async function snapshot(device: Device): Promise<MobileSnapshot> {
    authorize(device); const value = await documents(); authorize(device);
    const timestamp = now(), status = options.production.status(), state = value.production;
    const ticket: Ticket = { value: opaque(), expiresAt: timestamp + 5000, revision: state.revision, fingerprint: value.fingerprint };
    device.tickets.set(ticket.value, ticket);
    while (device.tickets.size > 8) device.tickets.delete(device.tickets.keys().next().value!);
    const main = state.sources.find(source => source.id === state.mainAudioSourceId);
    return { workspaceId: options.workspaceId, serverTime: timestamp, ticket: ticket.value, ticketExpiresAt: ticket.expiresAt, device: publicDevice(device), lease: lease ? { ...lease } : null,
      production: { revision: state.revision, previewSceneId: state.previewSceneId, programId: state.program?.id ?? null, scenes: state.scenes.map(safeScene), program: state.program ? safeScene(state.program) : null },
      engine: { state: status.state, fps: status.fps, recording: !!status.recording, streaming: ['starting', 'live', 'stopping'].includes(status.broadcast?.state ?? '') },
      mainAudio: main ? { sourceId: main.id, name: main.name, volume: main.audio.volume, muted: main.audio.muted, masterMuted: state.masterMuted, status: status.sources[main.id] ?? 'missing', level: Math.max(0, Math.min(1, status.levels[main.id] ?? status.levels.master ?? 0)) } : null,
      channels: value.channels.map(channelSnapshot) };
  }
  async function execute(device: Device, action: MobileAction, ticket: Ticket, leaseId: string) {
    const permission = action.type.startsWith('channel-') ? 'channels' : action.type === 'main-audio' ? 'audio' : 'studio';
    const channelId = 'channelId' in action ? action.channelId : undefined;
    const guard = () => { authorize(device, leaseId, permission, channelId); if (now() > ticket.expiresAt) throw new ProductionError(409, 'This action is stale. Refresh and try again.'); };
    guard(); const value = await documents(); guard();
    if (ticket.fingerprint !== value.fingerprint) throw new ProductionError(409, 'The station changed. Review the current state before trying again.');
    if (action.type === 'preview') await options.production.select(ticket.revision, action.sceneId, guard);
    else if (action.type === 'take') {
      if (!value.production.previewSceneId) throw new ProductionError(409, 'Select a Preview scene first.');
      if (options.production.status().state !== 'running') throw new ProductionError(409, 'Start the production engine in Studio before switching Program.');
      await options.production.take(ticket.revision, value.production.previewSceneId, action.transition, action.durationMs ?? 300, guard);
    } else if (action.type === 'main-audio') {
      if (action.volume === undefined && action.muted === undefined) throw new ProductionError(422, 'Choose a volume or mute state.');
      await options.production.audio(ticket.revision, { volume: action.volume, muted: action.muted }, guard);
    } else {
      const channel = value.channels.find(channel => channel.channel.id === action.channelId);
      if (!channel) throw new ProductionError(404, 'Channel not found.');
      if (channel.workspace) {
        if (action.type === 'channel-take' && action.selection.kind !== channel.channel.kind) throw new ProductionError(422, 'Choose content for this channel type.');
        const command: WorshipCommand = action.type === 'channel-take'
          ? { type: 'take', selection: SelectionSchema.parse(action.selection) }
          : action.type === 'channel-step' ? { type: 'step', direction: action.direction } : { type: 'blank', value: action.blanked };
        await options.worship.command(channel.channel.id, channel.workspace.revision, command, guard);
      } else {
        const old = channel.state as Record<string, unknown> | null, items = channel.playlist?.items ?? [];
        let index = typeof old?.index === 'number' ? old.index : 0;
        if (action.type === 'channel-take') {
          if (action.selection.kind !== 'presentation') throw new ProductionError(422, 'Choose a presentation item.');
          index = action.selection.index;
        } else if (action.type === 'channel-step') { index += action.direction; while (items[index]?.type === 'section') index += action.direction; }
        if (!items[index] || items[index].type === 'section') throw new ProductionError(409, 'No playable item at that position.');
        guard();
        const payload = { channelId: channel.channel.id, playlistId: channel.channel.playlistId, index, mode: 'manual', playing: false,
          blanked: action.type === 'channel-blank' ? action.blanked : false, startedAt: null, durationMs: items[index].durationMs };
        options.relay.injectRemote({ t: 'state', channel: channel.channel.id, payload });
        options.relay.injectRemote({ t: 'mobile-channel-state', channel: channel.channel.id, payload });
      }
    }
  }
  function phoneRouter(gateway: boolean) {
    const router = Router();
    router.use('/mobile', (req, res, next) => {
      res.set({ 'Cache-Control': 'private, no-store', 'Referrer-Policy': 'no-referrer', 'X-Content-Type-Options': 'nosniff' });
      try { boundary(req, gateway, !['GET', 'HEAD'].includes(req.method)); next(); } catch (error) { next(error); }
    });
    router.get('/mobile/session', asyncRoute((req, res) => {
      try { const device = authenticate(req, gateway); res.json({ paired: true, workspaceId: options.workspaceId, device: publicDevice(device) }); }
      catch { res.json({ paired: false, workspaceId: options.workspaceId }); }
    }));
    router.post('/mobile/session', asyncRoute((req, res) => {
      rate(req, 'pair', 12); const input = z.object({ code: z.string().min(20).max(100), name: z.string().trim().min(1).max(60) }).strict().parse(req.body);
      const hash = digest(input.code), pair = pairs.get(hash); pairs.delete(hash);
      if (!pair || pair.expiresAt <= now()) throw new ProductionError(401, 'Pairing code is invalid or expired. Generate another in Studio.');
      issuer(pair); prune();
      if (devices.size >= 16) throw new ProductionError(409, 'Disconnect an unused phone in Studio before pairing another.');
      const token = opaque(), tokenHash = digest(token), device: Device = { id: randomUUID(), name: input.name, permissions: pair.permissions, expiresAt: now() + 8 * 3600000, issuer: pair.issuer, userId: pair.userId, tokenHash, tickets: new Map(), busy: false };
      devices.set(tokenHash, device); cookie(res, token, gateway); res.json({ paired: true, workspaceId: options.workspaceId, device: publicDevice(device) });
    }));
    router.delete('/mobile/session', asyncRoute((req, res) => { const device = authenticate(req, gateway); revoke(device.id); res.clearCookie(gateway ? '__Host-lumen_mobile' : 'lumen_mobile_local', { httpOnly: true, sameSite: 'strict', secure: gateway, path: '/' }); res.json({ paired: false, workspaceId: options.workspaceId }); }));
    router.get('/mobile/state', asyncRoute(async (req, res) => { const device = authenticate(req, gateway); rate(req, 'read', 180, device.id); res.json(await snapshot(device)); }));
    router.post('/mobile/lease', asyncRoute(async (req, res) => {
      const device = authenticate(req, gateway); rate(req, 'lease', 60, device.id); const input = z.object({ takeover: z.boolean().optional() }).strict().parse(req.body ?? {});
      authorize(device); prune();
      if (lease && lease.deviceId !== device.id && !input.takeover) throw new ProductionError(409, `Another phone has control. Review before taking over.`);
      if (!lease || lease.deviceId !== device.id) lease = { id: opaque(), deviceId: device.id, name: device.name, expiresAt: now() + 30000 };
      else lease.expiresAt = now() + 30000;
      res.json(await snapshot(device));
    }));
    router.delete('/mobile/lease', asyncRoute(async (req, res) => { const device = authenticate(req, gateway); release(device.id); device.tickets.clear(); res.json(await snapshot(device)); }));
    router.post('/mobile/control', asyncRoute(async (req, res) => {
      const device = authenticate(req, gateway); rate(req, 'control', 90, device.id);
      const input = z.object({ ticket: z.string().min(20).max(100), leaseId: z.string().min(20).max(100), action: MobileActionSchema }).strict().parse(req.body);
      const ticket = device.tickets.get(input.ticket); device.tickets.delete(input.ticket); // consumed before dispatch, never replayed/retried
      if (!ticket || input.ticket !== ticket.value || ticket.expiresAt <= now()) throw new ProductionError(409, 'This action is stale. Refresh and try again.');
      if (device.busy) throw new ProductionError(409, 'A phone action is still completing. Review the current state before trying again.');
      device.tickets.clear();
      device.busy = true;
      try { await execute(device, input.action, ticket, input.leaseId); res.json(await snapshot(device)); }
      finally { device.busy = false; }
    }));
    router.get('/mobile/search', asyncRoute(async (req, res) => {
      const device = authenticate(req, gateway); rate(req, 'search', 90, device.id); authorize(device, undefined, 'channels');
      const query = z.object({ channelId: key, q: z.string().max(500) }).strict().parse(req.query), value = await documents(); authorize(device);
      const channel = value.channels.find(channel => channel.channel.id === query.channelId);
      if (!channel) throw new ProductionError(404, 'Channel not found.');
      let results: MobileSearchResults['results'];
      if (channel.channel.kind === 'scripture') results = options.worship.search(query.channelId, query.q).scripture().verses.slice(0, 60).map(verse => ({ title: `${verse.bookName} ${verse.chapter}:${verse.verse}`, text: verse.text, selection: { kind: 'scripture', versionId: verse.versionId, book: verse.book, chapter: verse.chapter, verse: verse.verse } }));
      else if (channel.channel.kind === 'lyrics') results = options.worship.search(query.channelId, query.q).lyrics().slice(0, 30).flatMap(hit => hit.song.sections.map(section => ({ title: `${hit.song.title} · ${section.label}`, text: section.text, selection: { kind: 'lyrics' as const, songId: hit.song.id, sectionId: section.id } }))).slice(0, 100);
      else results = (channel.playlist?.items ?? []).flatMap((item, index) => item.type !== 'section' && `${item.title} ${item.body}`.toLowerCase().includes(query.q.toLowerCase()) ? [{ title: item.title || `Slide ${index + 1}`, text: item.body, selection: { kind: 'presentation' as const, index } }] : []).slice(0, 100);
      res.json({ results });
    }));
    return router;
  }
  const router = Router();
  router.use('/mobile/manage', (req, res, next) => {
    res.set('Cache-Control', 'private, no-store');
    try { boundary(req, false, !['GET', 'HEAD'].includes(req.method)); const operator = resolveOperator(req.headers.cookie); if (!operator) throw new ProductionError(401, 'Sign in as a station-wide operator to manage phones.'); if (!can(operator.user, '*')) throw new ProductionError(403, 'Station-wide author permission is required to manage phones.'); (req as Request & { mobileOperator?: typeof operator }).mobileOperator = operator; next(); } catch (error) { next(error); }
  });
  router.get('/mobile/manage', asyncRoute((_req, res) => { prune(); res.json({ enabled: !!options.gateway, workspaceId: options.workspaceId, ...(gatewayOrigin ? { url: `${gatewayOrigin.origin}/remote` } : {}), devices: [...devices.values()].map(publicDevice), lease }); }));
  router.post('/mobile/manage/pair', asyncRoute((req, res) => {
    rate(req, 'issue', 20); const input = z.object({ name: z.string().trim().max(60).optional(), permissions: Permissions }).strict().parse(req.body);
    if (!Object.values(input.permissions).some(Boolean)) throw new ProductionError(422, 'Choose at least one phone permission.');
    prune(); if (pairs.size >= 16) throw new ProductionError(409, 'Wait for unused pairing codes to expire before creating more.');
    const operator = (req as Request & { mobileOperator: { sessionId: string; user: SessionUser } }).mobileOperator;
    const code = opaque(), pair = { codeHash: digest(code), issuer: operator.sessionId, userId: operator.user.id, name: input.name ?? 'Phone', permissions: input.permissions, expiresAt: now() + 120000 };
    pairs.set(pair.codeHash, pair); res.json({ code, expiresAt: pair.expiresAt, ...(gatewayOrigin ? { url: `${gatewayOrigin.origin}/remote#pair=${encodeURIComponent(code)}` } : {}) });
  }));
  router.delete('/mobile/manage/devices/:id', asyncRoute((req, res) => { revoke(String(req.params.id)); res.json({ ok: true }); }));
  router.use(phoneRouter(false));
  router.use('/mobile', (_req, res) => res.status(404).json({ error: 'Phone control endpoint not found.' }));
  const errors = (error: Error, _req: Request, res: Response, _next: NextFunction) => {
    const status = error instanceof ProductionError ? error.status : error instanceof z.ZodError ? 422 : 500;
    res.status(status).json({ error: status === 500 ? 'The phone operation could not be completed. Review the station before trying again.' : error instanceof z.ZodError ? 'Invalid phone control request.' : error.message });
  };
  router.use('/mobile', errors);
  function handleUpgrade(req: IncomingMessage, socket: Duplex, head: Buffer, isGateway = false) {
    try {
      if (!options.attachProgramViewer || req.url !== '/mobile/signal') throw new ProductionError(404, 'Not found.');
      boundary(req as Request, isGateway, true);
      const device = authenticate(req as Request, isGateway); authorize(device, undefined, 'studio');
      rate(req as Request, 'viewer', 20, device.id);
      viewerServer.handleUpgrade(req, socket, head, ws => {
        viewers.get(device.id)?.terminate(); viewers.set(device.id, ws);
        ws.on('close', () => { if (viewers.get(device.id) === ws) viewers.delete(device.id); });
        options.attachProgramViewer!(ws);
      });
    } catch { socket.destroy(); }
  }
  const viewerTimer = setInterval(() => {
    for (const [id, ws] of viewers) {
      const device = [...devices.values()].find(device => device.id === id);
      try { if (!device) throw new Error('Revoked'); authorize(device, undefined, 'studio'); }
      catch { ws.terminate(); viewers.delete(id); }
    }
  }, 2000); viewerTimer.unref();
  let gateway: https.Server | undefined;
  if (options.gateway) {
    const app = express(); app.disable('x-powered-by');
    app.use((req, res, next) => {
      res.set({ 'Cache-Control': 'no-store', 'Referrer-Policy': 'no-referrer', 'X-Content-Type-Options': 'nosniff', 'X-Frame-Options': 'DENY', 'Content-Security-Policy': `default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; connect-src 'self' wss://${gatewayOrigin!.host}; object-src 'none'; base-uri 'none'; frame-ancestors 'none'`, 'Permissions-Policy': 'camera=(), microphone=(), display-capture=()' });
      try { boundary(req, true); next(); } catch (error) { res.status(error instanceof ProductionError ? error.status : 403).end(); }
    });
    app.use(express.json({ limit: '8kb', type: 'application/json' }));
    app.use('/api', phoneRouter(true));
    app.use('/api/mobile', errors);
    app.get('/remote', (_req, res) => res.sendFile(path.join(options.frontendDir, 'index.html')));
    app.get(/^\/assets\/[A-Za-z0-9_.-]+\.(?:js|css|woff2?|svg|png)$/, (req, res) => res.sendFile(path.join(options.frontendDir, req.path)));
    app.use((_req, res) => res.status(404).end());
    app.use(errors);
    gateway = https.createServer({ key: options.gateway.key, cert: options.gateway.cert, minVersion: 'TLSv1.2' }, app);
    gateway.on('upgrade', (req, socket, head) => handleUpgrade(req, socket, head, true));
    await new Promise<void>((resolve, reject) => { gateway!.once('error', reject); gateway!.listen(options.gateway!.port, options.gateway!.host, () => { gateway!.off('error', reject); resolve(); }); });
  }
  return { router, gateway, handleUpgrade, address: () => gateway?.address() as AddressInfo | null, async close() { closing = true; clearInterval(viewerTimer); pairs.clear(); devices.clear(); lease = null; for (const ws of viewers.values()) ws.terminate(); viewers.clear(); viewerServer.close(); if (gateway?.listening) await new Promise<void>(resolve => { gateway!.close(() => resolve()); gateway!.closeAllConnections(); }); } };
}

/** Explicitly configured HTTPS only; never silently bind an HTTP phone service. */
export async function mobileGatewayFromEnv(env: NodeJS.ProcessEnv = process.env): Promise<MobileGatewayOptions | undefined> {
  const names = ['LUMEN_MOBILE_ORIGIN', 'LUMEN_MOBILE_PORT', 'LUMEN_MOBILE_HOST', 'LUMEN_MOBILE_TLS_KEY', 'LUMEN_MOBILE_TLS_CERT'];
  if (!names.some(name => env[name] !== undefined)) return undefined;
  if (!env.LUMEN_MOBILE_ORIGIN || !env.LUMEN_MOBILE_TLS_KEY || !env.LUMEN_MOBILE_TLS_CERT) throw new Error('Mobile access needs an HTTPS origin, private TLS key and certificate. No insecure phone listener was started.');
  const port = Number(env.LUMEN_MOBILE_PORT ?? '4433');
  if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error('Choose a valid mobile HTTPS port.');
  const keyPath = path.resolve(env.LUMEN_MOBILE_TLS_KEY), certPath = path.resolve(env.LUMEN_MOBILE_TLS_CERT), info = await fs.lstat(keyPath);
  if (!info.isFile() || info.isSymbolicLink() || info.size > 65536 || process.platform !== 'win32' && (info.mode & 0o077)) throw new Error('Mobile TLS key must be a private regular file (mode 600).');
  return { origin: env.LUMEN_MOBILE_ORIGIN, host: env.LUMEN_MOBILE_HOST ?? '0.0.0.0', port, key: await fs.readFile(keyPath), cert: await fs.readFile(certPath) };
}
