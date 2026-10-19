import WebSocket from 'ws';
import { TestPatternInput, FileLoopInput, type CaptureInput } from './inputs.js';

// Lumen capture agent. Connects to the station's /agent socket (header-token
// auth), registers its inputs, heartbeats health, and reconnects with backoff —
// the vps-bridge shape, inverted (the agent is the client). Ships with STUB
// inputs so the full lifecycle runs without capture hardware.

const STATION = process.env.LUMEN_STATION_URL ?? 'ws://127.0.0.1:3000/agent';
const AGENT_ID = process.env.LUMEN_AGENT_ID;
const TOKEN = process.env.LUMEN_AGENT_TOKEN;
const NAME = process.env.LUMEN_AGENT_NAME ?? 'Stub Capture Agent';
const HEARTBEAT_MS = 20_000;
const RECONNECT_MS = [1000, 2000, 5000, 10000, 20000];

if (!AGENT_ID || !TOKEN) {
  console.error('Set LUMEN_AGENT_ID and LUMEN_AGENT_TOKEN (provision via POST /api/agents on the station).');
  process.exit(1);
}

const inputs: CaptureInput[] = [new TestPatternInput('test-0'), new FileLoopInput('file-0')];

let attempt = 0;
let heartbeat: ReturnType<typeof setInterval> | null = null;
let current: WebSocket | null = null;

function connect() {
  const ws = new WebSocket(STATION, { headers: { 'x-lumen-agent': AGENT_ID!, 'x-lumen-token': TOKEN! } });
  current = ws;

  ws.on('open', async () => {
    attempt = 0;
    for (const i of inputs) await i.start('srt://stub');
    ws.send(
      JSON.stringify({
        t: 'agent-register',
        agentId: AGENT_ID,
        name: NAME,
        platform: process.platform,
        version: 'stub-0.1',
        inputs: inputs.map((i) => i.describe()),
      }),
    );
    console.log(`[agent] registered ${inputs.length} input(s) with ${STATION}`);
    heartbeat = setInterval(() => {
      if (ws.readyState !== WebSocket.OPEN) return;
      ws.send(
        JSON.stringify({
          t: 'agent-heartbeat',
          agentId: AGENT_ID,
          status: 'online',
          inputs: inputs.map((i) => i.health()),
        }),
      );
    }, HEARTBEAT_MS);
  });

  ws.on('close', () => {
    if (heartbeat) {
      clearInterval(heartbeat);
      heartbeat = null;
    }
    const delay = RECONNECT_MS[Math.min(attempt, RECONNECT_MS.length - 1)];
    attempt += 1;
    console.log(`[agent] disconnected — reconnecting in ${delay}ms`);
    setTimeout(connect, delay);
  });
  ws.on('error', () => {
    /* 'close' follows */
  });
}

process.on('SIGINT', () => {
  try {
    current?.send(JSON.stringify({ t: 'agent-bye', agentId: AGENT_ID }));
  } catch {
    /* ignore */
  }
  inputs.forEach((i) => i.stop());
  current?.close();
  process.exit(0);
});

connect();
