# Lumen

A sleek, single-operator projection platform for live events — worship services,
conferences, classrooms, presentations. The operator runs the dashboard on their
laptop; the projection opens in a second browser tab (or on a separate device)
and goes fullscreen on the projector.

No database. The whole deck lives on the file system as a folder of media and
a single `content.json` manifest. Cross-tab sync runs over `BroadcastChannel`
for the same-browser fast path; cross-device sync runs over a built-in
WebSocket relay so a phone or tablet can drive a display on another machine.

## Stack

- **Frontend** — Vue 3, Vite, TypeScript, Pinia, Vue Router, Tailwind, VueUse,
  Lucide icons, vue-draggable-plus, vue-sonner.
- **Backend** — Express, `ws`, Zod, Multer, sharp (thumbnails). ~300 lines.
- **Data** — single JSON manifest + a `media/` directory.

## Quick start

```bash
# from repo root
npm run install:all

npm run dev
```

This starts the Express API + WebSocket on `http://127.0.0.1:3000` and the
Vite dev server on `http://127.0.0.1:5173`. Open the dashboard at
[http://127.0.0.1:5173](http://127.0.0.1:5173).

To project: from the dashboard header, click **Open Live View** — a new tab
opens at `/live`. Drag that tab to your projector display and press **F** for
fullscreen.

## Production build

```bash
npm run build
npm start
```

The Express server serves the built SPA, the API, and the WebSocket on port
3000.

## Data folder

By default lives at `./data/`:

```text
data/
├── content.json           # the manifest — single source of truth
├── media/
│   ├── backgrounds/       # images & videos
│   ├── music/             # audio files
│   └── thumbnails/        # auto-generated, 320px JPEGs
└── backups/               # rolling 10 most recent content.json snapshots
```

Override with `LUMEN_DATA_DIR=/some/path npm start`.

The manifest is **never** written non-atomically: the backend writes to
`content.json.tmp` and renames into place, and snapshots the previous version
to `backups/` before every mutation (rolling 10).

## Operator controls

| Key             | Action                          |
| --------------- | ------------------------------- |
| Space           | play / pause                    |
| → / Enter       | next slide                      |
| ←               | previous slide                  |
| M               | toggle Auto / Manual            |
| B / L           | blank screen (audio continues)  |
| 1–9             | jump to slide N                 |
| F               | fullscreen (Live View)          |
| Esc             | exit fullscreen                 |
| ?               | show shortcut overlay           |

In **Auto** mode, the slide advances when its `durationMs` elapses. In
**Manual**, the timer never runs; you advance with → / ← / Enter.

## Sync & connectivity

Lumen uses two transports for state sync, fanned out from the same
`broadcast()` API in the frontend:

- **`BroadcastChannel`** — same-origin, same-browser. Zero latency, zero infra.
  Used when the dashboard and Live View are tabs in the same browser.
- **WebSocket relay** at `/ws` — cross-device. The Express server runs a
  stateless relay that forwards every message to all other connected peers.
  It also caches the most recent `state`, `music`, and `content-updated`
  messages, so a freshly-connected client (e.g. a Live View opened on a
  separate machine) catches up immediately without waiting for the dashboard
  to publish.

The Live View shows a small **reconnecting…** badge in the bottom-left when
the WebSocket isn't connected. The slide content stays frozen on the last
known state — the congregation never sees the UI flicker.

**Reconnect behavior:**

- Exponential backoff: 500ms → 1s → 2s → 5s → 10s (capped).
- Heartbeat ping every 20s; if no traffic for 25s, the socket is closed and
  reconnect kicks in.
- `navigator.onLine` is observed: when the OS reports the network is back,
  any pending backoff is aborted and a connection attempt fires immediately.
- On (re)connect the server replays cached state, so the Live View resyncs
  without operator intervention.

## Architecture notes

- **State origination.** Dashboard publishes `ProjectionState` snapshots and
  ~8 Hz `tick` messages. Live View is a pure mirror — it never originates
  state. Mounting fires `{ t: 'hello' }`; the dashboard responds with a full
  snapshot (and the WS server has a cache fallback).
- **Wall-clock timing.** Progress is computed against `performance.now()`, not
  a counted-up `setInterval`, so backgrounded tabs and CPU throttling don't
  drift the timer.
- **Wake Lock.** `useWakeLock('screen')` on the Live View prevents the
  projector laptop from sleeping during a service.
- **Atomic writes.** Manifest mutations: write to temp file → fsync → rename.
  POSIX guarantees rename atomicity on the same filesystem.
- **Optimistic UI.** Dashboard mutations apply locally and PUT in the
  background; on 4xx/5xx the local snapshot rolls back and a Sonner toast
  surfaces the error.
- **Cursor & UI.** Live View hides the cursor after 2s of idleness and listens
  for double-click → fullscreen so the operator can recover quickly if the
  hotkey didn't land in the right tab.
- **Reduced motion.** All transforms collapse to opacity-only fades when the
  OS reports `prefers-reduced-motion: reduce`.

## Project layout

```text
backend/
  src/
    server.ts      # Express + http server bootstrap
    routes.ts      # /api/content, /api/media/*
    ws.ts          # WebSocket relay (with snapshot cache)
    schema.ts      # Zod schemas mirroring the frontend types
    atomic.ts      # write-temp-then-rename + rolling backups
    thumbs.ts      # sharp/ffmpeg thumbnail generation
    paths.ts       # data dir resolution + traversal-safe joins

frontend/
  src/
    views/         # DashboardView, LiveView
    components/    # dashboard rails, live layers, shadcn-vue ui
    stores/        # content, playback, music (Pinia)
    lib/
      api.ts       # REST client
      broadcast.ts # fan-out: BroadcastChannel + WebSocket
      ws.ts        # singleton WS client (reconnect, heartbeat, status)
      timer.ts     # wall-clock timer used by the playback store
      keyboard.ts  # useShortcuts hook
      preload.ts   # next-slide media warmup
    types.ts       # Content / Item / ProjectionState / BroadcastMsg
```

## Deploy hardening

- Bind Express to `127.0.0.1` (default) and reverse-proxy through nginx or
  Caddy. Make sure to forward the WebSocket upgrade headers on `/ws`.
- Front it with HTTP basic auth at the proxy for over-the-internet use.
- Run with `pm2 start "npm start" --name lumen` (or systemd).
- Use HTTPS — browser secure-context APIs (Wake Lock, fullscreen) want it,
  and `wss://` is required when the page is served over `https://`.

### Caddy example

```caddyfile
lumen.example.com {
  reverse_proxy 127.0.0.1:3000
}
```

Caddy auto-upgrades WebSocket connections and provisions Let's Encrypt certs.

### Nginx example

```nginx
location / {
  proxy_pass http://127.0.0.1:3000;
}

location /ws {
  proxy_pass http://127.0.0.1:3000;
  proxy_http_version 1.1;
  proxy_set_header Upgrade $http_upgrade;
  proxy_set_header Connection "upgrade";
  proxy_read_timeout 3600s;
}
```

## What's intentionally not in v1

- Multi-user / multi-operator (single source of truth assumed)
- A real database
- Cloud sync
- Bible API integration (paste your verses in by hand)
- Authentication — Lumen is designed for trusted networks. If you expose it
  over the internet, add basic auth at the reverse proxy.
