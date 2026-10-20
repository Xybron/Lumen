# Lumen Watch relay

A separate, public-only live HLS service. The station pushes its actual Program
picture and mixed audio out to this relay; viewers never connect to the station,
operator UI or station API. It does not embed YouTube or Facebook.

Prepared public address: **https://stream-lumen.xybron.com/watch/live**.
The application stays at **https://lumen.xybron.com**. These files do not deploy
anything or modify DNS. Supply the VPS details and approve deployment separately.

## Run Studio and Watch together locally

No VPS, public domain or TLS certificate is needed for local development. From
the **Lumen repository root**, stop the existing `npm run dev` command, then run:

```sh
npm run dev:watch
```

The command starts all three services, bound to this computer only:

- Studio: **http://127.0.0.1:5173/studio**
- Backend: **http://127.0.0.1:3000**
- Watch: **http://127.0.0.1:3480/watch/live**

Sign in to Studio with your usual account. Your existing scenes, committed
Program and Main audio selection are used directly—not a sample video or a
copy of your station. Reconnect any live microphone, camera or screen share
after restarting; browser capture cannot be silently restored. Open **Go Live**,
review, then confirm **Go Live**. Open the Watch link in another tab to see and
hear the resulting HLS stream. Watch begins Offline and starts playback muted;
unmute its player to hear Main audio. Expect a short live-stream buffer delay.

The Go Live panel shows **Local Lumen Watch** and all three destinations.
Facebook and YouTube work normally: enable the destinations you want, review
them, then confirm **Go Live**. They send a real public-platform stream, while
the Watch link stays on this computer. Nothing streams automatically when the
launcher starts. Local recording follows your saved preference and is shown in
the confirmation before it starts.

Your existing social keys, destination selections and quality preferences are
loaded privately into a temporary settings copy after exclusive station
ownership is acquired. Keys are never returned to the browser. The local Watch
destination starts enabled; use its normal toggle to switch it off if desired.
Any streaming setup/key edits in this run affect only the temporary copy, not
your normal saved streaming setup. The relay's one-use publishing token remains
in memory. Your scene and audio settings are not rewritten by the launcher;
edits you deliberately make inside Studio still save normally to your real
station. The saved stream-key file remains unchanged.

Press **Ctrl+C** in the launcher terminal to stop all three owned services and
remove their private temporary streaming files and settings copy. Your normal
`npm run dev` continues to use your unchanged saved production setup. Occupied ports or an already-running
backend using the same station data cause a clear error; no existing process is
killed or taken over. The normal production connector still requires public
HTTPS—local HTTP is available only through this dedicated launcher.

Optional ports, if another application uses the defaults:

```sh
npm run dev:watch -- --backend-port 3001 --studio-port 5174 --watch-port 3481
```

The local Watch link is single-machine only, not a LAN/public deployment.
Facebook and YouTube still use their normal verified RTMPS connections. Do not
expose the local ports through a tunnel or change their loopback bindings. Use the
separate HTTPS relay deployment below for remote Watch audiences. Install dependencies
with the repository's `npm run install:all` first if this is a fresh checkout.

## Run with Node

Requires Node 22 or newer. In this directory run `npm ci --omit=dev
--ignore-scripts`. Make a private service environment from `.env.example`; generate
a unique token with `node -e "console.log(require('node:crypto').randomBytes(48).toString('hex'))"`.
Keep that token outside the repository, browser bundles and public URLs. Start
with `node --env-file=/etc/lumen-watch.env server.mjs`, using your actual private
environment path. The default listener is `127.0.0.1:3480` for a TLS reverse proxy.

For a persistent process, adapt `lumen-watch.service.example`: create a dedicated
unprivileged service user and writable `/var/lib/lumen-watch` directory, install
the package at `/opt/lumen-watch`, and protect the environment file from other
users. `Caddyfile.example` terminates HTTPS for the confirmed watch hostname.
Only the reverse proxy should be internet-facing; do not expose the station's
ports or share this service's push token with viewers. hls.js is installed from
the official npm registry and served locally, including its packaged license;
the player has no third-party CDN script dependency.

## Run with Docker

Build with `docker build -t lumen-watch .`. A prepared invocation is:

```sh
docker run --name lumen-watch --restart unless-stopped \
  --env-file /etc/lumen-watch.env \
  -e HOST=0.0.0.0 -e LUMEN_WATCH_DATA_DIR=/data \
  -p 127.0.0.1:3480:3480 -v lumen-watch-data:/data lumen-watch
```

Use a named volume as above (created with the image's unprivileged ownership),
or explicitly grant the container's `node` user write access to a bind mount.
Put the TLS proxy in front, as with Node. Do not mount the station's recordings,
database or source tree into the relay.

## Configure the private station

Set these **server environment variables**, then restart the station backend:

```dotenv
LUMEN_WATCH_RELAY_URL=https://stream-lumen.xybron.com
LUMEN_WATCH_RELAY_SLUG=live
LUMEN_WATCH_RELAY_TOKEN=<the same secret as LUMEN_WATCH_PUSH_TOKEN>
```

The station adapter requires a public HTTPS origin, resolves and pins approved
public DNS addresses for each request, disallows private/loopback destinations,
and never follows redirects. Its localhost exception is an explicit constructor
option used only by disposable tests; there is no production environment bypass.
If all three variables are absent, the independent watch destination remains
unconfigured. Invalid settings remain unconfigured with a safe error.

## Protocol and limits

Publishing requests use `Authorization: Bearer <push token>`, never query strings:

- `POST /api/push/live/sessions`, JSON `{ "epoch": "unique-station-session-id" }`
  returns an opaque `sessionId`. Repeating the current epoch is idempotent.
- `PUT /api/push/live/<sessionId>/segment-<8–20 digits>.ts` uploads each completed
  H.264/AAC MPEG-TS segment. Bytes are immutable within that relay session.
- `PUT /api/push/live/<sessionId>/index.m3u8` publishes **last**, only after every
  referenced segment exists. Only the generated, unencrypted single-rendition
  media playlist is accepted; no external URLs, keys, maps or nested paths.
- `POST /api/push/live/<sessionId>/end`, JSON `{}`, makes it Offline immediately.

The public surface is `/watch/live`, `/api/watch/live`, local player assets and
current-session `/hls/live/<sessionId>/...` only. Nothing exposes the token or
operator API. Slug allowlists default to your `LUMEN_WATCH_SLUGS` list. If omitted,
at most 8 distinct slugs can be created; use the allowlist in production.

Defaults: 8 MB per segment, 64 KB per playlist, at most 12 playlist segments,
32 staged/retained segments and 64 MB media per stream. Uploaded windows advance
monotonically; old-session uploads cannot overwrite the current stream. Media is
written atomically, with one preceding bounded window retained for players.
The station has no unbounded upload queue, uses request deadlines/cancellation,
and uploads completed segment files before manifest publication.

The player reports Connecting after begin, **not Live**, until media is published
and decoded. If the sequence stops advancing for 18 seconds, status becomes
Offline and public media is no longer served. Repeated copies of the same frozen
playlist do not refresh this timer. Ended/stale session media is deleted after
the 2-minute live-only grace period; a restart always comes back Offline, removes
old media and retains the recent epoch replay fence. This is a live relay, not a
recording archive or replay service. Existing browsers may retain downloaded
media briefly; segment HTTP cache lifetime is 30 seconds, playlists are no-store.

Allowlist/secret authentication is station-level, not a paid public video CDN.
Monitor VPS bandwidth, disk and CPU and add your normal TLS proxy rate limiting
for large audiences. One HLS rendition is provided; adaptive bitrate transcoding,
private viewer accounts and DRM are not implemented. Autoplay starts muted so
browser permissions are respected; viewers can unmute via the native controls.

## Verification

`npm test` runs security/session/quota/Offline tests using temporary files and
ephemeral loopback ports. In the repository's `backend` directory:

```sh
node --import tsx --test test/broadcast-relay.test.ts
node --import tsx test/watch-relay-browser.mjs
```

The latter generates actual H.264/AAC HLS with FFmpeg, publishes it through the
station adapter, decodes it in headless Chrome with the local hls.js player, and
checks mobile layout, fullscreen, stale/offline behavior and end/cleanup. It
uses no physical devices, live station, real credentials or external deployment.
