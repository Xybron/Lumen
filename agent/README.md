# Lumen capture agent

Runs on the machine with the capture hardware. It registers its inputs with a
Lumen station over the `/agent` WebSocket (header-token auth), heartbeats health,
and reconnects with backoff. Each declared input appears in the station's routing
matrix as a `kind:'capture'` source. The agent pushes **media out-of-band**
(NDI/SRT/RTMP to the media engine) — only signalling/health rides the control link.

## Provision + run

```bash
# On the station (admin): create the agent → get a one-time token
curl -b cookies -X POST localhost:3000/api/agents -d '{"name":"Stage Rack"}' -H 'content-type: application/json'
# → { "agentId": "agt_…", "token": "…" }

cd agent && npm install
LUMEN_STATION_URL=ws://<station>:3000/agent \
LUMEN_AGENT_ID=agt_… LUMEN_AGENT_TOKEN=… LUMEN_AGENT_NAME="Stage Rack" \
npm run dev
```

## Status: STUB providers

`src/inputs.ts` ships `TestPatternInput` and `FileLoopInput` (synthetic), so the
**entire registration → source-in-matrix → health → reconnect → deregister loop is
exercisable with no capture card.** `NdiInput`/`DeckLinkInput` are interface stubs
that throw on `start()` until built against the NDI SDK / Blackmagic DeckLink SDK
(native, out of sandbox scope). The only method a hardware build must implement is
`CaptureInput.start()`.
