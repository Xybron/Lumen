# Mobile emergency controller

Lumen's `/remote` surface is a focused phone controller, not another production
engine. The station continues rendering, recording and streaming if a phone
closes, loses Wi-Fi or releases control. No cloud connection or paid service is
required on a functioning local network. A public Lumen Watch link grants no
controller access.

## Controls

- **Live:** a silent, low-resolution live Program confidence monitor, a Preview
  design card, Cut and Fade with a duration. Both transitions swap buses, exactly
  like Studio. Preview/scene design cards and the fallback when video is
  unavailable are explicitly labelled, not presented as live camera/video.
- **Scenes:** tap a scene to select Preview; explicitly Cut/Fade to change Program.
- **Channels:** find Scripture or lyrics, prepare locally and Send live; navigate
  presentations; previous/next and hide/show. This updates only that channel's
  output, never selects a Studio scene or changes the audio mix. Existing channel
  ownership is respected; phone operation does not silently seize a channel.
- **Audio:** identify the existing Main input and its connection/mute state, see
  signal level, mute/unmute and adjust that input's volume. Main input selection,
  the rest of the mix and output mute stay in Studio.

Pairing grants Studio, channels and/or Main-audio control explicitly. It does not
grant scene editing, key access, recording/stream start/stop, device capture,
file access or local administrator login. Pairing and opening the controller do
not change any production settings. Deliberate accepted controls do change the
requested live state, so rehearse using test scenes/channels first.

## Local desktop rehearsal

Build, start the normal station and open `/remote` on the **same desktop** for a
loopback rehearsal. In Studio, sign in with the existing local operator account,
open **Mobile control**, choose permissions, generate a one-use pairing code,
then paste it into the controller. Cloud team sign-in is separate and never
implicitly grants station control. Use a different browser context to rehearse
another phone. The default local development password is not a production
credential; use trusted local operator accounts and change weak/default
passwords before normal use.

`127.0.0.1` on a phone means the phone itself, not the station. For an actual
phone, enable the dedicated HTTPS listener below. Do **not** expose the backend
port or Vite dev server on `0.0.0.0` to work around this.

## Actual phone on the church Wi-Fi

1. Find the station's connected private IPv4 address:

   ```sh
   npm run mobile:setup -- --help
   ```

2. Generate local-only TLS files (OpenSSL must be on PATH):

   ```sh
   npm run mobile:setup -- --address 192.168.1.20
   npm run build
   ```

   Replace the example with the actual address. This creates private
   `.mobile-local/` settings, a local CA and a 90-day server certificate. It
   never changes OS trust, installs software, changes firewall/router settings
   or overwrites an existing trust anchor. The files are Git-ignored. Never
   share `ca-key.pem` or `server-key.pem`, and never upload them to GitHub.

3. Transfer **only** `.mobile-local/tls/lumen-mobile-ca.crt` to the authorized
   phone using a trusted method. Verify the displayed SHA-256 fingerprint with
   the station operator before trusting it using the phone's certificate
   settings. The CA has authority to issue certificates; install it only on
   devices you manage/trust, protect its private key and remove this trust when
   no longer needed. Do not train operators to bypass HTTPS warnings. An
   administrator-managed certificate already trusted by the phone is preferable
   for permanent installations.

4. Stop the old development command yourself, then start:

   ```sh
   npm run dev:mobile
   ```

   Occupied ports fail without killing an existing station. This starts the
   normal station on loopback and a **separate** HTTPS mobile listener bound to
   the selected LAN interface. It reuses the existing station directory; it
   does not reset scenes, saved stream keys or Main audio. No stream or
   recording starts automatically. Opening a new browser/phone cannot reconnect
   microphones/cameras captured by a different browser; those remain managed
   by the station operator.

5. Open **Studio → Mobile control** on the station. Generate a pairing code
   with only the needed permissions. Open the displayed HTTPS `/remote` link
   on the phone and pair. An optional pairing link carries its one-use code in
   the URL fragment, which the controller immediately removes from history.
   Treat the code/link as a temporary secret and share it only with the intended
   operator. Codes expire after a short interval and work once.

6. The phone starts in monitor-only mode. Tap **Take control**. Another phone
   must explicitly confirm takeover; releasing/disconnecting does not stop
   production. Desktop operation remains available and an authorized desktop
   operator can revoke a paired device in **Mobile control**.

No firewall, router port forwarding, domain, cloud resource or paid add-on is
created. Guest Wi-Fi/client isolation may prevent phones reaching the station;
ask the network administrator to provide an appropriate trusted team network,
not to disable security globally. If the station IP changes or certificates
expire, deliberately archive the old `.mobile-local` directory and repeat setup
for the new address, then replace/remove old device trust as appropriate.

## Production configuration

The same backend can load administrator-managed TLS without the development
launcher:

```sh
LUMEN_MOBILE_ORIGIN=https://station.example.org:4433
LUMEN_MOBILE_HOST=192.168.1.20
LUMEN_MOBILE_PORT=4433
LUMEN_MOBILE_TLS_KEY=/absolute/private/server-key.pem
LUMEN_MOBILE_TLS_CERT=/absolute/private/server-cert.pem
```

Use a trusted certificate matching the exact origin, keep its private key
owner-only and configure the service environment securely. The main backend
must remain trusted/loopback. The mobile listener exposes only the phone UI,
built static assets and limited `/api/mobile/` controller endpoints—not the
legacy station APIs, media library, admin endpoints or raw Studio WebSocket.
Missing/partial TLS configuration fails closed. This phase is for a trusted LAN;
it is not a public multi-tenant control gateway or an internet relay. Remote
internet control needs a separate reviewed deployment/access layer.

## Connection and command safety

The screen distinguishes current station connection from production-engine
status. Missing/stale state, hidden/offline tabs, absent control lease and
in-flight actions disable mutation controls. Read-only state reconnects
automatically. Live commands are never saved in the offline draft outbox,
automatically retried or replayed after reconnect. If a command's response is
lost, inspect refreshed Program/channel/audio state before trying another action.

Server-side authority enforces scoped permissions, short-lived one-use state
tickets, revision checks, bounded requests and a renewable single-phone lease.
Expiry, revocation, restart and changes in the authorizing operator's permissions
invalidate control. Sessions are temporary HttpOnly cookies, not shared desktop
credentials. Exact Origin/Host checks supplement SameSite cookies; see
[OWASP CSRF guidance](https://cheatsheetseries.owasp.org/cheatsheets/Cross-Site_Request_Forgery_Prevention_Cheat_Sheet.html).
Network phones use HTTPS; loopback rehearsal is treated separately, consistent
with [secure-context requirements](https://developer.mozilla.org/en-US/docs/Web/Security/Defenses/Secure_Contexts).

## Verification

```sh
npm --prefix backend test
npm run test:mobile
```

Browser tests use disposable station data, test certificates and generated
media—not the operator's scenes, saved keys, microphones or Main audio settings.
Accepting the test CA in an automated browser is isolated test behavior, not a
production TLS bypass. Test on an actual authorized phone/network before relying
on the controller during a service; phone sleep, Wi-Fi and certificate trust are
device-specific operational checks.
