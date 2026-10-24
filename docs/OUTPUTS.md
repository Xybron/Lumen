# Screens and view-only output links

Studio → **Outputs** keeps the existing Follow Program / pinned scene routes,
picture blanking and per-output audio controls. Delivery setup does not change
scenes, Program selection, source settings, Main audio or saved streaming keys.
Display choices are local browser preferences; viewer capabilities are kept in
the station's separate private `outputs/links-private.json` file.

## Connected monitor or projector

1. Connect the display in the operating system and use an extended desktop.
2. In an output card choose **Set up → Display → Find displays**.
3. Grant the browser's window-management permission, choose the monitor, then
   select **Open output**.
4. Press **F** or choose **Fullscreen** in the output window if requested by the
   browser. Sound starts muted; explicitly enable it only if needed.

Display enumeration/placement depends on the browser's Window Management API.
Use a supporting Chrome/Edge browser on localhost or HTTPS. Permission denial,
unsupported browsers and disconnected displays have manual-window fallbacks:
open the output, move it onto the projector, then fullscreen it. No permission
is requested until Find displays is clicked. There is no silent fullscreen or
physical cable/device-control claim. The operating system still manages the
projector's resolution, mirroring and connection.

## Same-computer and OBS links

Select **Program links** for the actual live Program picture and mixed Main
audio, independent of any pinned screen. Or choose the link icon on an output
card to share that specific routed/blanked output.

In **This computer**, choose **Create output link**, then **Copy**. Paste it into
an OBS Browser Source (normally 1920×1080), or open it in a browser. The viewer is
a small standalone page: no Studio interface, source names, scene document,
recordings, credentials or operator API. Controls appear only on interaction.
**F** toggles fullscreen. Enable **Request sound in this viewer** before copying
if sound should play in OBS; browser autoplay policies may still require
interaction. This preference never unmutes a source or changes Main audio. A
named output with audio disabled remains silent regardless of the link option.

Links contain a high-entropy viewer capability in a URL fragment. The player
removes the fragment immediately and keeps it in memory only. Save the original
full link in OBS; re-open that original link after a page reload. Never put it in
a public document or screenshot. **Revoke link** stops connected viewer peers;
creating it again issues a different key. This does not stop the production
engine or modify the output's route/audio.

The dedicated viewer listener defaults to `127.0.0.1:3485`, starts only after an
explicit link/network action and is separate from Studio's backend. A busy port
produces an error rather than killing or reusing another application. Listener
startup is explicit again after a backend restart; saved link keys are retained.
There are at most four viewers per link and twelve across the listener.

## Local-network screens

In **Local network**, select a connected private IPv4 interface and confirm.
Then create/copy its network link for a device on the same trusted network.
The loopback listener stays available, so enabling LAN does not invalidate an
existing same-computer OBS link. Switching the interface disconnects only the
old network viewers. Selecting **Off · this computer only** disables LAN.

LAN uses HTTP/WebRTC on the selected private interface. The OS firewall and
network must allow the dedicated viewer port and local WebRTC media traffic;
guest Wi-Fi/client isolation can prevent the connection. Keep this on a trusted
church network. **Do not port-forward or tunnel this listener or Studio's
backend to the internet.** Studio's main listener remains unchanged. LAN is not
automatically reopened after restarting the backend.

## Secure external Program

Internet sharing uses the separate HTTPS Watch relay, not a LAN/localhost URL.
The UI shows **Relay setup required** until private-relay configuration exists,
and returns a link only after **Verify relay** confirms the protected endpoint.
This code does not deploy hosting, change DNS or expose ports on your behalf.

On the relay, use a dedicated private slug, separate from public Watch:

```dotenv
LUMEN_WATCH_SLUGS=live,program
LUMEN_WATCH_PRIVATE_SLUGS=program
LUMEN_WATCH_VIEWER_TOKEN=<a fresh high-entropy viewer key, different from the push token>
```

On the station backend, keep the normal public Watch publishing configuration
and add the protected destination:

```dotenv
LUMEN_WATCH_RELAY_URL=https://stream-lumen.xybron.com
LUMEN_WATCH_RELAY_SLUG=live
LUMEN_WATCH_RELAY_TOKEN=<existing relay publishing token>
LUMEN_OUTPUT_RELAY_SLUG=program
LUMEN_OUTPUT_VIEWER_TOKEN=<same private viewer key as the relay>
```

`LUMEN_OUTPUT_RELAY_URL` and `LUMEN_OUTPUT_RELAY_TOKEN` can select a different
relay; otherwise the existing Watch relay URL/publishing token are used. Keep
these environment files outside Git, protected by the OS. Do not put keys in
frontend environment variables. Use the relay README's HTTPS reverse-proxy and
service setup; no paid add-on is required by this implementation, but hosting
and bandwidth still follow your existing provider's limits.

Choose **External → Verify relay**, copy the private Program link, then use the
normal **Go Live** confirmation with **Lumen Watch enabled** to send Program.
Nothing streams automatically, enables Facebook/YouTube, starts recording or
rewrites saved destinations. This first version sends the private output while
the Watch destination is sending; it is not a separate relay-only start button.
It has the normal HLS buffering delay, unlike local WebRTC outputs.

The existing encoded HLS is reused for a bounded independent private publisher;
there is no second encoder. A failing private relay cannot block public Watch,
Facebook or YouTube. Before any private media is pushed, its endpoint must prove
that the dedicated slug is protected. All protected status, manifests and
segments require a viewer session. Public Watch remains public and separate.

The external link exchanges its fragment key for a one-hour HttpOnly, Secure,
SameSite cookie and renews while its original page remains open. Rotate the
viewer key on both relay and station and restart the respective services to
revoke all external links/sessions. Previously downloaded media can remain in a
player's bounded buffer briefly; this is not DRM. Per-recipient keys/accounts
are not provided in this phase. Private responses use no-store caching.

## Verification

```sh
npm run build
npm --prefix backend test
npm --prefix watch-relay test
npm run test:outputs
LUMEN_TEST_OUTPUT_BROWSER=1 npm --prefix watch-relay test
```

Tests use disposable stations, generated picture/audio and local test tokens,
never real production settings. Display tests simulate display enumeration and
exercise a real output window; final physical-monitor/projector placement and
cross-device LAN/firewall behavior must be checked on the target hardware.
The secure relay browser test decodes actual generated H.264/AAC, but is not a
claim that your public domain/VPS has been deployed or tested.

References: [Window Management](https://w3c.github.io/window-management/),
[Fullscreen](https://developer.mozilla.org/en-US/docs/Web/API/Element/requestFullscreen),
[Watch relay setup](../watch-relay/README.md).
