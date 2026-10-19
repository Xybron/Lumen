import { randomBytes } from 'node:crypto';
import { getDb } from './db.js';
import { hashPassword, verifyPassword } from './pw.js';

// Capture-agent registry over SQLite (operational state, never in content.json).
// Tokens are hashed like user passwords (pw.ts). Mirrors the presence/ownership
// data-access idiom.

export interface AgentInput {
  inputId: string;
  label: string;
  signal: 'sdi' | 'hdmi' | 'ndi' | 'test' | 'file';
  transport: 'ndi' | 'srt' | 'rtmp';
  uri?: string;
}
export interface AgentInputHealth {
  inputId: string;
  state: 'idle' | 'streaming' | 'error' | 'no-signal';
}
export interface AgentSnapshot {
  agentId: string;
  name: string;
  status: 'online' | 'degraded' | 'offline';
  inputs: Array<AgentInput & { state?: AgentInputHealth['state'] }>;
}

export function createAgent(name: string): { id: string; token: string } {
  const id = `agt_${randomBytes(5).toString('hex')}`;
  const token = randomBytes(24).toString('hex');
  const { hash, salt } = hashPassword(token);
  getDb()
    .prepare(
      'INSERT INTO capture_agents (id, name, token_hash, token_salt, created_at, status) VALUES (?,?,?,?,?,?)',
    )
    .run(id, name, hash, salt, new Date().toISOString(), 'offline');
  return { id, token };
}

export function verifyAgentToken(id: string, token: string): boolean {
  const row = getDb().prepare('SELECT token_hash, token_salt FROM capture_agents WHERE id = ?').get(id) as
    | { token_hash: string; token_salt: string }
    | undefined;
  return !!row && verifyPassword(token, row.token_hash, row.token_salt);
}

export function setAgentMeta(agentId: string, platform?: string, version?: string) {
  getDb()
    .prepare('UPDATE capture_agents SET platform = ?, version = ? WHERE id = ?')
    .run(platform ?? null, version ?? null, agentId);
}

// Replace the agent's declared inputs (register-time).
export function upsertInputs(agentId: string, inputs: AgentInput[]) {
  const db = getDb();
  const now = new Date().toISOString();
  db.prepare('DELETE FROM capture_inputs WHERE agent_id = ?').run(agentId);
  const ins = db.prepare(
    'INSERT INTO capture_inputs (agent_id, input_id, label, signal, transport, uri, state, updated_at) VALUES (?,?,?,?,?,?,?,?)',
  );
  for (const i of inputs) ins.run(agentId, i.inputId, i.label, i.signal, i.transport, i.uri ?? null, 'idle', now);
}

export function touchHeartbeat(agentId: string, status: 'online' | 'degraded', health: AgentInputHealth[]) {
  const db = getDb();
  const now = new Date().toISOString();
  db.prepare('UPDATE capture_agents SET last_seen = ?, status = ? WHERE id = ?').run(now, status, agentId);
  const upd = db.prepare('UPDATE capture_inputs SET state = ?, updated_at = ? WHERE agent_id = ? AND input_id = ?');
  for (const h of health) upd.run(h.state, now, agentId, h.inputId);
}

export function markOffline(agentId: string) {
  getDb().prepare('UPDATE capture_agents SET status = ? WHERE id = ?').run('offline', agentId);
}

export function getInputs(agentId: string): AgentInput[] {
  return getDb()
    .prepare('SELECT input_id AS inputId, label, signal, transport, uri FROM capture_inputs WHERE agent_id = ?')
    .all(agentId) as AgentInput[];
}

export function listAgents(): AgentSnapshot[] {
  const db = getDb();
  const agents = db
    .prepare('SELECT id, name, status FROM capture_agents ORDER BY created_at')
    .all() as Array<{ id: string; name: string; status: string }>;
  return agents.map((a) => {
    const inputs = db
      .prepare('SELECT input_id, label, signal, transport, state FROM capture_inputs WHERE agent_id = ?')
      .all(a.id) as Array<{ input_id: string; label: string; signal: string; transport: string; state: string }>;
    return {
      agentId: a.id,
      name: a.name,
      status: a.status as AgentSnapshot['status'],
      inputs: inputs.map((i) => ({
        inputId: i.input_id,
        label: i.label,
        signal: i.signal as AgentInput['signal'],
        transport: i.transport as AgentInput['transport'],
        state: i.state as AgentInputHealth['state'],
      })),
    };
  });
}

export function removeAgent(agentId: string) {
  const db = getDb();
  db.prepare('DELETE FROM capture_inputs WHERE agent_id = ?').run(agentId);
  db.prepare('DELETE FROM capture_agents WHERE id = ?').run(agentId);
}
