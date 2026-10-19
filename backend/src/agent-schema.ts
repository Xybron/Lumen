import { z } from 'zod';

// Zod for the agent ↔ station protocol (the dedicated /agent socket).

export const AgentInputSchema = z.object({
  inputId: z.string(),
  label: z.string(),
  signal: z.enum(['sdi', 'hdmi', 'ndi', 'test', 'file']),
  transport: z.enum(['ndi', 'srt', 'rtmp']),
  uri: z.string().optional(),
});

export const AgentInputHealthSchema = z.object({
  inputId: z.string(),
  state: z.enum(['idle', 'streaming', 'error', 'no-signal']),
});

export const AgentRegisterSchema = z.object({
  t: z.literal('agent-register'),
  agentId: z.string(),
  name: z.string(),
  platform: z.string().optional(),
  version: z.string().optional(),
  inputs: z.array(AgentInputSchema),
});

export const AgentHeartbeatSchema = z.object({
  t: z.literal('agent-heartbeat'),
  agentId: z.string(),
  status: z.enum(['online', 'degraded']),
  inputs: z.array(AgentInputHealthSchema),
});
