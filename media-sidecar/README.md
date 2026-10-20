# Lumen media sidecar

The station-side **media plane**. Lumen's Vue/Express app is the control plane; this
process owns the actual media: WHIP ingest from phones/browser cameras, server-side
compositing of the Program bus, and RTMP/HLS egress to YouTube/Facebook.

It exposes a local-only HTTP control API on `127.0.0.1:7401` (`src/contract.ts`).
**Express is the only client** — the Vue app never talks to the sidecar directly,
so auth stays in one place and the port is never exposed.

## Status: STUB

`src/index.ts` ships as a **stub**: it implements the full control contract with
coherent fake state (egress goes `idle → connecting → live` on a timer) so the
entire control path — Vue → Express → sidecar → `mediastatus` → dashboard ON-AIR
pill — is exercisable with **no ffmpeg, no MediaMTX, no RTMP CDN, no camera**.

```bash
cd media-sidecar && npm install && npm run dev   # control API on :7401
# Then run the Lumen backend with LUMEN_MEDIA_CTRL=127.0.0.1:7401
```

## Making it real (recommended: MediaMTX + ffmpeg)

Replace the stub bodies (the HTTP surface stays identical, so Express is untouched):

- **Ingest** (`POST /ingest/whip`): run [MediaMTX](https://github.com/bluenviron/mediamtx)
  with WHIP enabled; return its WHIP URL for the phone/browser to POST its SDP to.
- **Program capture** (`POST /program`): point a headless Chromium at the
  `programSourceUrl` (`http://127.0.0.1:3000/out/<destinationId>`) and capture
  frames — this reuses Lumen's entire existing rendering stack as the compositor input.
- **Egress** (`POST /egress`): ffmpeg `-i <program-capture> -c:v h264 -f flv rtmp://…/<key>`,
  fanned out to N destinations with `tee`. Push `idle/connecting/live/error` back via
  `GET /status` (Express polls every 2s while non-idle).

LiveKit is an alternative for WebRTC-at-scale / remote contribution; the contract is
deliberately ingest-agnostic so swapping it in is a sidecar-internal change.

## Cannot be verified in a headless sandbox

`cargo`/Tauri build, real ffmpeg→RTMP egress against a CDN, MediaMTX WHIP/WHEP with real
ICE, headless-Chromium Program capture, and physical capture cards. The stub stands in
for all of these so the **control plane** is fully testable now.
