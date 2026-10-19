/**
 * Mission Control read-model contract.
 *
 * Shared by the gateway mapper and the React SPA. The SPA validates every
 * response against these schemas; a response that fails to parse renders as
 * "unavailable", never as a partial or optimistic view. Objects are strict so
 * an unexpected field (for example a leaked secret) fails closed on the client
 * in addition to the server-side whitelist test.
 */
import { z } from "zod";

export const OVERVIEW_SCHEMA_VERSION = 1 as const;

const iso = z.string().min(1);

export const sectionStatusSchema = z
  .object({
    status: z.enum(["ok", "unavailable"]),
    /** Present when status is "unavailable". Stable, non-sensitive reason code. */
    reason: z.string().min(1).max(120).optional()
  })
  .strict();

export const livenessSchema = z.enum(["online", "stale", "offline", "observed", "unknown"]);
export type Liveness = z.infer<typeof livenessSchema>;

export const riskSchema = z.enum(["low", "medium", "high", "critical"]).or(z.string().min(1).max(32));

export const executionSchema = z
  .object({
    mode: z.enum(["strict", "admin", "unknown"]),
    modeProblem: z.enum(["missing", "corrupt"]).optional(),
    /** Worker backend label when the gateway knows it (never a secret). */
    backend: z.string().min(1).max(64).optional(),
    /** "yes" only when the recorded backend is the dry-run backend. */
    dryRun: z.enum(["yes", "no", "unknown"])
  })
  .strict();

export const pipelineItemSchema = z
  .object({
    id: z.string().min(1),
    title: z.string().max(300),
    intent: z.string().max(500),
    risk: riskSchema,
    status: z.string().min(1),
    updatedAt: iso,
    attemptStatus: z.string().min(1).optional(),
    attemptNumber: z.number().int().positive().optional(),
    agentId: z.string().min(1).max(200).optional()
  })
  .strict();

export const pipelineStageSchema = z
  .object({
    key: z.string().min(1),
    label: z.string().min(1),
    /** Exact count from the store when known, otherwise the shown-window count. */
    count: z.number().int().nonnegative(),
    countSource: z.enum(["store", "window"]),
    items: z.array(pipelineItemSchema)
  })
  .strict();

export const needsYouItemSchema = z
  .object({
    workItemId: z.string().min(1),
    title: z.string().max(300),
    status: z.enum(["needs_approval", "blocked", "quarantined"]),
    risk: riskSchema,
    since: iso
  })
  .strict();

export const expiringLeaseSchema = z
  .object({
    leaseId: z.string().min(1),
    workItemId: z.string().min(1),
    workerId: z.string().min(1),
    fencingEpoch: z.number().int().nonnegative(),
    expiresAt: iso
  })
  .strict();

export const networkNodeSchema = z
  .object({
    id: z.string().min(1),
    kind: z.enum(["agent", "work_item"]),
    label: z.string().max(200),
    liveness: livenessSchema.optional(),
    /** Agent role / kind, or work-item status. */
    detail: z.string().max(200).optional(),
    capabilities: z.array(z.string().max(80)).max(32).optional(),
    lastHeartbeatAt: iso.optional()
  })
  .strict();

export const networkEdgeSchema = z
  .object({
    from: z.string().min(1),
    to: z.string().min(1),
    /** Why this edge exists. Only canonical bindings produce edges. */
    kind: z.enum(["active_lease", "reported_task"]),
    fencingEpoch: z.number().int().nonnegative().optional()
  })
  .strict();

export const telemetrySchema = z
  .object({
    windowStart: iso,
    windowEnd: iso,
    succeeded: z.number().int().nonnegative(),
    failed: z.number().int().nonnegative(),
    averageRunMs: z.number().nonnegative().nullable(),
    averageQueueMs: z.number().nonnegative().nullable(),
    approvalsGranted: z.number().int().nonnegative().optional(),
    averageApprovalMs: z.number().nonnegative().nullable().optional(),
    throughput: z.array(
      z
        .object({
          at: iso,
          started: z.number().int().nonnegative(),
          completed: z.number().int().nonnegative(),
          failed: z.number().int().nonnegative()
        })
        .strict()
    )
  })
  .strict();

export const admissionSchema = z
  .object({
    active: z.number().int().nonnegative(),
    capacity: z.number().int().nonnegative(),
    queued: z.number().int().nonnegative(),
    saturated: z.boolean()
  })
  .strict();

export const infrastructureSchema = z
  .object({
    agents: z.object({ registered: z.number().int().nonnegative(), online: z.number().int().nonnegative() }).strict(),
    executors: z
      .object({
        total: z.number().int().nonnegative(),
        configured: z.number().int().nonnegative(),
        attestedRuntimes: z.number().int().nonnegative()
      })
      .strict(),
    connectors: z
      .object({
        registered: z.number().int().nonnegative(),
        enabled: z.number().int().nonnegative(),
        activeSessions: z.number().int().nonnegative()
      })
      .strict()
  })
  .strict();

export const activityEventSchema = z
  .object({
    sequence: z.number().int().nonnegative(),
    id: z.string().min(1),
    name: z.string().min(1),
    at: iso,
    /** Redacted, bounded single-line summary of the event attributes. */
    summary: z.string().max(400)
  })
  .strict();

export const readinessSchema = z
  .object({
    ok: z.boolean(),
    checks: z.array(z.object({ name: z.string().min(1), ok: z.boolean(), code: z.string().max(80).optional() }).strict())
  })
  .strict();

export const overviewReadModelSchema = z
  .object({
    schemaVersion: z.literal(OVERVIEW_SCHEMA_VERSION),
    generatedAt: iso,
    /** Highest audit sequence included in `activity`; null when no events. */
    eventSequence: z.number().int().nonnegative().nullable(),
    execution: executionSchema,
    sections: z
      .object({
        needsYou: sectionStatusSchema,
        network: sectionStatusSchema,
        pipeline: sectionStatusSchema,
        observability: sectionStatusSchema,
        activity: sectionStatusSchema,
        readiness: sectionStatusSchema
      })
      .strict(),
    needsYou: z
      .object({
        approvals: z.number().int().nonnegative(),
        blocked: z.number().int().nonnegative(),
        quarantined: z.number().int().nonnegative(),
        items: z.array(needsYouItemSchema).max(25),
        expiringLeases: z.array(expiringLeaseSchema).max(25)
      })
      .strict(),
    network: z.object({ nodes: z.array(networkNodeSchema), edges: z.array(networkEdgeSchema) }).strict(),
    pipeline: z
      .object({
        stages: z.array(pipelineStageSchema),
        /** Present when only a window of finished items is shown. */
        finishedWindow: z
          .object({ shown: z.number().int().nonnegative(), total: z.number().int().nonnegative() })
          .strict()
          .optional()
      })
      .strict(),
    observability: z
      .object({ telemetry: telemetrySchema.nullable(), admission: admissionSchema.nullable() })
      .strict(),
    infrastructure: infrastructureSchema.nullable(),
    activity: z.array(activityEventSchema).max(100),
    readiness: readinessSchema.nullable()
  })
  .strict();

export type OverviewReadModel = z.infer<typeof overviewReadModelSchema>;
export type NetworkNode = z.infer<typeof networkNodeSchema>;
export type NetworkEdge = z.infer<typeof networkEdgeSchema>;
export type PipelineStage = z.infer<typeof pipelineStageSchema>;
export type PipelineItem = z.infer<typeof pipelineItemSchema>;
export type NeedsYouItem = z.infer<typeof needsYouItemSchema>;
export type SectionStatus = z.infer<typeof sectionStatusSchema>;

export type ParseResult = { ok: true; value: OverviewReadModel } | { ok: false; reason: string };

/** Fail-closed parse: any schema violation is `unavailable`, never partially rendered. */
export function parseOverviewReadModel(input: unknown): ParseResult {
  const result = overviewReadModelSchema.safeParse(input);
  if (result.success) return { ok: true, value: result.data };
  const first = result.error.issues[0];
  return { ok: false, reason: `schema_invalid:${first?.path.join(".") ?? ""}` };
}
export * from "./queue-trace.js";
