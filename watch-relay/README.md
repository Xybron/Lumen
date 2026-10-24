# Lumen Watch relay

A separate, viewer-facing live HLS service. The station pushes its actual Program
picture and mixed audio out to this relay; viewers never connect to the station,
operator UI or station API. It does not embed YouTube or Facebook.

Prepared public address: **https://stream-lumen.xybron.com/watch/live**.
The application stays at **https://lumen.xybron.com**. These files do not deploy
anything or modify DNS. Supply the VPS details and approve deployment separately.

## Multiple churches / workspace tenants

Shared hosting must use explicit tenant mode. The ordinary local launcher stays
single-station and unchanged; global publishing/viewer keys must not be shared
between unrelated churches. A workspace is identified by its immutable team UUID,
not a renameable display name, account email or an arbitrary browser parameter.

Provisioning is a **server-administrator step**. First verify the requester's
current owner membership in the authoritative workspace records. Then copy
`tenants.example.json` into a private service configuration location, use the
real workspace UUID, and generate different high-entropy publishing and private
viewer tokens for every workspace. Blank example keys intentionally fail closed.
Do not commit the populated file or send it through frontend settings. There is
no public provisioning endpoint, automatic owner claim or billable service.

```dotenv
LUMEN_WATCH_TENANTS_FILE=/etc/lumen-watch-tenants.json
```

The version-1 file contains `tenants: [{ workspaceId, pushToken, viewerToken,
allowedSlugs: ['live', 'program'], privateSlugs: ['program'] }]`. It must be an
owner-only, regular non-symlink file owned by the service user (for example,
`chmod 600` after assigning its owner). At most 256 registrations and 1 MiB are
accepted. UUIDs and allowed stream slugs are explicit; duplicate workspace IDs,
reused credentials, weak keys or malformed private settings abort startup.
In Docker, mount the populated file read-only and ensure the container service
UID can read it without widening its host permissions.

Each station uses the same `LUMEN_WORKSPACE_ID` as its registered workspace, plus
only that workspace's `LUMEN_WATCH_RELAY_TOKEN` and separate output viewer token.
Namespaced routes are:

```text
/watch/<workspaceId>/live
/output/<workspaceId>/program#key=<that workspace's viewer token>
/api/push/<workspaceId>/<slug>/...
/api/watch/<workspaceId>/<slug>
/api/output/<workspaceId>/<slug>/...
/hls/<workspaceId>/<slug>/<session>/<file>
```

Tenant mode disables **all legacy unscoped** stream, publishing and HLS routes,
even if old global environment credentials remain set. Shared script/style
assets remain common. There is no fallback from a missing workspace or rejected
workspace token to a global credential. Two workspaces may both use `live` and
`program`; state, media directories, session replay fences and private-cookie
names/signatures include workspace + slug. A cookie/key for one workspace cannot
authorize another, and rotating one viewer key does not revoke another's session.
Public `live` feeds are intentionally audience-viewable; UUIDs are not secrets or
privacy controls. Use private `program` for access-controlled production links.

Resource limits remain bounded on the free/self-hosted deployment: by default
eight registered stream histories in the relay, up to two per workspace, at most
two simultaneous uploads per workspace/eight globally, and bounded per-stream
segment windows. The server administrator can size constructor limits for its
deployment; this is not an unlimited bandwidth/storage promise. Removing a
workspace from the registry and restarting disables its routes without deleting
its retained replay metadata. Restart always returns streams Offline.

For a single-organisation local rehearsal, omit `LUMEN_WATCH_TENANTS_FILE` and
keep the existing legacy configuration. Tenant mode does not migrate, rename or
publish existing stations automatically. Configure the tenant relay first, then
explicitly bind and restart the intended station; normal Go Live confirmation
is still required. Studio devices, Main audio and social stream keys remain
station-local. Never expose the local Studio backend as a shared tenant gateway.

## Secure clean Program output

The relay can additionally host a protected, interface-free Program output for
remote production tools such as OBS Browser Source. This is separate from the
public audience-facing `/watch/live` page. Configure an explicitly protected slug
and a **different**, randomly generated viewer key on the HTTPS relay:

```dotenv
LUMEN_WATCH_SLUGS=live,program
LUMEN_WATCH_PRIVATE_SLUGS=program
LUMEN_WATCH_VIEWER_TOKEN=<a separate high-entropy secret of 32–256 printable characters>
```

Never put a real secret in this repository or reuse `LUMEN_WATCH_PUSH_TOKEN` as
the viewer key. Invalid private configuration fails closed at startup; it never
silently makes the requested private slug public. Public `live` behavior remains
unchanged. The operator-facing station configuration must point its protected
output publishing at the same `program` slug. The relay does not start streaming
or change the station's selected destinations, recording or Main audio.

Use `https://your-relay.example/output/program#key=<viewer-key>` as the clean
viewer/OBS page. Adding `&audio=1` to the fragment explicitly requests audio;
ordinary browsers may still require a play gesture. Default playback is muted.
The page fills its viewport with the picture, without Watch branding, navigation
or permanent playback controls. Double-click or `F` requests fullscreen; `M`
toggles sound. A relay feed has the normal HLS buffering delay and is not a
zero-latency monitor connection.

The fragment is not sent in HTTP requests. The page consumes it immediately,
removes it from the address bar, then exchanges it in an Authorization header
for a one-hour, HttpOnly, Secure, SameSite=Strict signed cookie. The cookie name
and signature are scoped to the output slug; `Path=/` covers that slug's status
and HLS paths. The key stays only in page memory for renewal while the page is
open. It is not written to browser storage, HTML or the cookie. Both the legacy
Watch API and **all** HLS playlists/segments for a protected slug require viewer
authorization, so alternate URLs cannot bypass the clean player's access gate.
Protected responses are private/no-store. Avoid proxy/CDN rules that override
these headers, and keep normal TLS-proxy rate limiting in place.

To revoke all current links and browser sessions, rotate
`LUMEN_WATCH_VIEWER_TOKEN` on the relay and restart it, then update the station's
viewer-key setting and distribute the new link. Old keys and signed cookies are
rejected immediately. This phase does not implement individually named viewer
accounts or per-recipient revocation. Links are bearer capabilities: share only
with trusted recipients and protect any OBS configuration containing one.

For station-side verification, `GET /api/output/program/info` accepts the viewer
key as `Authorization: Bearer <viewer-key>` and returns only
`{ protected: true, slug: 'program', watchUrl: '/output/program', status }`.
`POST /api/output/program/session` performs the cookie exchange. Publishing still
uses its separate existing `/api/push/program/...` credential and protocol. No
operator endpoint, source list, saved stream key or live-control command is
available to output viewers.

External links require the separately configured HTTPS relay to be deployed and
the station to be sending its Program to that protected slug. Merely generating
a link does not expose a localhost station or automatically Go Live. No domain,
server, DNS record, tunnel or paid service is deployed by this feature.

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

The protected-output tests also check expiry/rotation, all alternate status/media
paths, cookie scope and unchanged public Watch behavior. With the parent Lumen
application dependencies installed, run the opt-in real-browser check from the
repository root:

```sh
LUMEN_TEST_OUTPUT_BROWSER=1 node --test watch-relay/test/output-browser.test.mjs
```

It generates H.264/AAC test media, opens the clean output in headless Chrome,
checks actual picture decoding through the HttpOnly cookie, confirms that no
request URL contains its fragment key, and checks access denial after session
removal. It uses only disposable loopback services and generated credentials.
The normal environment has no insecure-cookie toggle; the explicit
constructor-only local-test capability is checked against the socket's loopback
address and is never used by the command-line relay launcher.
