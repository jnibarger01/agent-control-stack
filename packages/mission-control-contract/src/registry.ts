/**
 * Client-side picks for the existing registry JSON routes (/api/agents, /api/executors,
 * /api/connectors). These schemas are deliberately NOT strict: they copy only the fields the
 * UI renders and drop everything else (for example `endpoint`, `actorId`, `inputSchema`,
 * `lastError`), so a future server-side field can never reach the DOM by accident.
 */
import { z } from "zod";
import type { Parsed } from "./queue-trace.js";

const iso = z.string().min(1).max(64);
const short = (max: number) => z.string().max(max);

export const registryAgentSchema = z.object({
  id: z.string().min(1).max(200),
  name: short(200),
  kind: short(80),
  acpRole: short(80),
  status: short(40),
  effectiveStatus: short(40),
  heartbeatAgeMs: z.number().nonnegative().nullable().optional(),
  isStale: z.boolean().optional(),
  lastHeartbeatAt: iso.optional(),
  capabilities: z.array(z.object({ name: short(120), description: short(300).optional() })).max(200).default([])
});
export const agentsListSchema = z.object({ agents: z.array(registryAgentSchema).max(500) });
export const agentDetailSchema = z.object({
  agent: registryAgentSchema,
  activity: z.object({ activeSessionCount: z.number().int().nonnegative(), recentSessionCount: z.number().int().nonnegative(), lastActivityAt: iso.optional() }).optional(),
  sessions: z.array(z.unknown()).max(500).default([]),
  events: z.array(z.object({ sequence: z.number().int().nonnegative().optional(), name: short(120), timeUnixNano: z.string().regex(/^\d+$/).optional() })).max(500).default([])
});

export const executorSchema = z.object({
  id: z.string().min(1).max(200),
  displayName: short(200),
  kind: short(80),
  contract: short(80).optional(),
  configured: z.boolean(),
  status: short(60),
  scopes: z.array(short(120)).max(100).default([]),
  capabilityCount: z.number().int().nonnegative().optional(),
  unsupportedToolCount: z.number().int().nonnegative().optional()
});
export const executorsListSchema = z.object({ executors: z.array(executorSchema).max(100) });
export const executorDetailSchema = z.object({
  executor: executorSchema,
  runtimes: z.array(z.object({ runtimeId: short(200), status: short(60), scopes: z.array(short(120)).max(100).default([]), registeredAt: iso.optional(), attestedAt: iso.optional(), revokedAt: iso.optional() })).max(200).optional()
});

export const connectorSchema = z.object({
  id: z.string().min(1).max(200),
  displayName: short(200),
  allowedScopes: z.array(short(120)).max(100).default([]),
  status: short(40),
  publicKeyFingerprint: short(120).optional(),
  createdAt: iso.optional(),
  updatedAt: iso.optional(),
  sessionCount: z.number().int().nonnegative().default(0),
  activeSessionCount: z.number().int().nonnegative().default(0),
  lastHeartbeatAt: iso.optional(),
  nextSessionExpiryAt: iso.optional()
});
export const connectorsListSchema = z.object({ connectors: z.array(connectorSchema).max(500) });
export const connectorDetailSchema = z.object({
  connector: connectorSchema,
  sessions: z.array(z.object({ sessionId: short(200), tunnelId: short(200).optional(), status: short(40), effectiveStatus: short(40), staleReason: short(80).optional(), issuedAt: iso.optional(), expiresAt: iso.optional(), lastHeartbeatAt: iso.optional() })).max(500).default([]),
  /** The gateway returns at most 500 sessions; `total` is how many are stored. Absent from older gateways. */
  sessionWindow: z.object({ shown: z.number().int().nonnegative(), total: z.number().int().nonnegative() }).optional()
});

export type RegistryAgent = z.infer<typeof registryAgentSchema>;
export type AgentDetail = z.infer<typeof agentDetailSchema>;
export type Executor = z.infer<typeof executorSchema>;
export type ExecutorDetail = z.infer<typeof executorDetailSchema>;
export type Connector = z.infer<typeof connectorSchema>;
export type ConnectorDetail = z.infer<typeof connectorDetailSchema>;

function parseWith<T>(schema: z.ZodType<T>, input: unknown): Parsed<T> {
  const r = schema.safeParse(input);
  if (r.success) return { ok: true, value: r.data };
  return { ok: false, reason: `schema_invalid:${r.error.issues[0]?.path.join(".") ?? ""}` };
}
export const parseAgentsList = (i: unknown) => parseWith(agentsListSchema, i);
export const parseAgentDetail = (i: unknown) => parseWith(agentDetailSchema, i);
export const parseExecutorsList = (i: unknown) => parseWith(executorsListSchema, i);
export const parseExecutorDetail = (i: unknown) => parseWith(executorDetailSchema, i);
export const parseConnectorsList = (i: unknown) => parseWith(connectorsListSchema, i);
export const parseConnectorDetail = (i: unknown) => parseWith(connectorDetailSchema, i);
