import { createHash } from "node:crypto";
import { redactValue } from "@agent-control-stack/shared";
import type { WorkItem } from "@agent-control-stack/work-items";
import { z } from "zod";

const GRAPH_REQUEST_TIMEOUT_MS = 2_000;
const STATUS_REQUEST_TIMEOUT_MS = 10_000;
const MAX_ITEMS = 20;
const FETCH_CONCURRENCY = 4;

function redactDisplayText(value: string): string {
  const redacted = redactValue(value);
  return typeof redacted === "string" ? redacted : "[redacted]";
}

const SourceRuntimeSchema = z.enum([
  "codex", "hermes", "openclaw", "opencode", "claude", "pi"
]);
const CanonicalStatusSchema = z.enum([
  "queued", "starting", "running", "waiting_approval", "blocked",
  "retrying", "completed", "failed", "cancelled"
]);
const CanonicalNodeTypeSchema = z.enum([
  "user_request", "orchestrator", "agent", "tool", "mcp_server",
  "approval_gate", "data_store", "external_service", "artifact", "final_output"
]);
const CanonicalEdgeTypeSchema = z.enum([
  "sequence", "delegation", "data", "control", "approval", "artifact"
]);
const CanonicalEdgeStatusSchema = z.enum([
  "pending", "active", "satisfied", "failed", "cancelled"
]);

const GraphNodeSchema = z.object({
  id: z.string().uuid(),
  nodeType: CanonicalNodeTypeSchema,
  status: CanonicalStatusSchema,
  label: z.string().min(1).max(256),
  parentNodeId: z.string().uuid().nullable()
});

const GraphEdgeSchema = z.object({
  id: z.string().uuid(),
  fromNodeId: z.string().uuid(),
  toNodeId: z.string().uuid(),
  edgeType: CanonicalEdgeTypeSchema,
  status: CanonicalEdgeStatusSchema
});
const VisualizerSystemStatusSchema = z.object({
  schemaVersion: z.literal(1),
  generatedAt: z.string().datetime({ offset: true }),
  status: z.enum(["healthy", "degraded", "unhealthy"]),
  eventStreams: z.object({
    activeClients: z.number().int().nonnegative()
  }),
  executions: z.object({
    activeCount: z.number().int().nonnegative(),
    queueDepth: z.number().int().nonnegative()
  }).nullable(),
  runtimes: z.array(z.object({
    runtime: SourceRuntimeSchema,
    status: z.enum(["healthy", "degraded", "unhealthy", "unavailable", "unknown"])
  })).length(6),
  database: z.object({
    availability: z.enum(["available", "unavailable"])
  }),
  approvals: z.object({
    pendingCount: z.number().int().nonnegative()
  }).nullable()
}).superRefine((value, ctx) => {
  SourceRuntimeSchema.options.forEach((runtime, index) => {
    if (value.runtimes[index]?.runtime !== runtime) {
      ctx.addIssue({
        code: "custom",
        path: ["runtimes", index, "runtime"],
        message: "runtime health must use canonical order"
      });
    }
  });
  const databaseAvailable = value.database.availability === "available";
  if (databaseAvailable !== (value.executions !== null && value.approvals !== null)) {
    ctx.addIssue({
      code: "custom",
      path: ["database", "availability"],
      message: "durable summaries must match database availability"
    });
  }
  const hasUnhealthyRuntime = value.runtimes.some((runtime) => runtime.status === "unhealthy");
  const allRuntimesHealthy = value.runtimes.every((runtime) => runtime.status === "healthy");
  const expectedState = !databaseAvailable || hasUnhealthyRuntime
    ? "unhealthy"
    : allRuntimesHealthy
      ? "healthy"
      : "degraded";
  if (value.status !== expectedState) {
    ctx.addIssue({
      code: "custom",
      path: ["status"],
      message: "overall health must match database and runtime evidence"
    });
  }
});

const GraphResponseSchema = z.object({
  schemaVersion: z.literal(2),
  revision: z.number().int().nonnegative(),
  eventPosition: z.number().int().nonnegative(),
  execution: z.object({
    id: z.string().uuid(),
    sourceRuntime: SourceRuntimeSchema,
    status: CanonicalStatusSchema,
    rootNodeId: z.string().uuid(),
    finalOutputNodeId: z.string().uuid().nullable()
  }).passthrough(),
  nodes: z.array(GraphNodeSchema).max(256),
  edges: z.array(GraphEdgeSchema).max(512)
}).passthrough().superRefine((value, ctx) => {
  const nodeIds = new Set(value.nodes.map((node) => node.id));
  const edgeIds = new Set(value.edges.map((edge) => edge.id));
  if (nodeIds.size !== value.nodes.length) {
    ctx.addIssue({ code: "custom", path: ["nodes"], message: "graph node ids must be unique" });
  }
  if (edgeIds.size !== value.edges.length) {
    ctx.addIssue({ code: "custom", path: ["edges"], message: "graph edge ids must be unique" });
  }
  if (!nodeIds.has(value.execution.rootNodeId)) {
    ctx.addIssue({ code: "custom", path: ["execution", "rootNodeId"], message: "root node must exist" });
  }
  if (value.execution.finalOutputNodeId !== null && !nodeIds.has(value.execution.finalOutputNodeId)) {
    ctx.addIssue({ code: "custom", path: ["execution", "finalOutputNodeId"], message: "final output node must exist" });
  }
  value.nodes.forEach((node, index) => {
    if (node.parentNodeId !== null && !nodeIds.has(node.parentNodeId)) {
      ctx.addIssue({ code: "custom", path: ["nodes", index, "parentNodeId"], message: "parent node must exist" });
    }
  });
  value.edges.forEach((edge, index) => {
    if (!nodeIds.has(edge.fromNodeId) || !nodeIds.has(edge.toNodeId)) {
      ctx.addIssue({ code: "custom", path: ["edges", index], message: "edge endpoints must exist" });
    }
  });
});

export type VisualizerProjectionState =
  | "available"
  | "not_projected"
  | "unavailable";

export type VisualizerProjectionItem = Readonly<{
  workItemId: string;
  title: string;
  risk: WorkItem["risk"];
  acsStatus: WorkItem["status"];
  executionId: string;
  state: VisualizerProjectionState;
  projection?: Readonly<{
    revision: number;
    eventPosition: number;
    sourceRuntime: string;
    status: z.infer<typeof CanonicalStatusSchema>;
    rootNodeId: string;
    finalOutputNodeId: string | null;
    nodes: readonly z.infer<typeof GraphNodeSchema>[];
    edges: readonly z.infer<typeof GraphEdgeSchema>[];
  }>;
}>;
export type VisualizerProjectionResponse = Readonly<{
  schemaVersion: 1;
  configured: boolean;
  generatedAt: string;
  items: readonly VisualizerProjectionItem[];
}>;

export type VisualizerIntegrationStatus = Readonly<{
  schemaVersion: 1;
  configured: boolean;
  reachable: boolean;
  state: "not_configured" | "healthy" | "degraded" | "unhealthy" | "unavailable";
  sampledAt: string;
  sourceGeneratedAt: string | null;
  database: "available" | "unavailable" | null;
  activeExecutions: number | null;
  queueDepth: number | null;
  pendingApprovals: number | null;
  eventStreamClients: number | null;
  runtimes: readonly Readonly<{
    runtime: "codex" | "hermes" | "openclaw" | "opencode" | "claude" | "pi";
    status: "healthy" | "degraded" | "unhealthy" | "unavailable" | "unknown";
  }>[];
}>;

export type VisualizerProjectionClientOptions = Readonly<{
  baseUrl: string;
  fetchImpl?: typeof fetch;
}>;

export function visualizerBaseUrl(input: string): string {
  const url = new URL(input);
  const valid =
    url.protocol === "http:" &&
    url.hostname === "127.0.0.1" &&
    url.port.length > 0 &&
    (url.pathname === "/" || url.pathname === "") &&
    !url.username &&
    !url.password &&
    !url.search &&
    !url.hash;
  if (!valid) {
    throw new Error(
      "ACS_VISUALIZER_URL must be a credential-free http://127.0.0.1:<port> origin."
    );
  }
  return url.origin;
}

export function visualizerBaseUrlFromEnv(
  env: NodeJS.ProcessEnv = process.env
): string | null {
  const value = env.ACS_VISUALIZER_URL?.trim();
  return value ? visualizerBaseUrl(value) : null;
}
/** Must remain identical to Visualizer acsExecutionIdForWorkItem(); both repos pin the same fixture. */
export function visualizerExecutionIdForAcsWorkItem(workItemId: string): string {
  const bytes = Buffer.from(
    createHash("sha256")
      .update(`agent-workflow-visualizer:acs:execution:${workItemId}`)
      .digest()
      .subarray(0, 16)
  );
  bytes.writeUInt8((bytes.readUInt8(6) & 0x0f) | 0x50, 6);
  bytes.writeUInt8((bytes.readUInt8(8) & 0x3f) | 0x80, 8);
  const hex = bytes.toString("hex");
  return [
    hex.slice(0, 8),
    hex.slice(8, 12),
    hex.slice(12, 16),
    hex.slice(16, 20),
    hex.slice(20)
  ].join("-");
}

export class VisualizerProjectionClient {
  readonly #baseUrl: string;
  readonly #fetch: typeof fetch;

  constructor(options: VisualizerProjectionClientOptions) {
    this.#baseUrl = visualizerBaseUrl(options.baseUrl);
    this.#fetch = options.fetchImpl ?? fetch;
  }

  async read(
    workItems: readonly WorkItem[],
    requestedLimit = MAX_ITEMS
  ): Promise<VisualizerProjectionResponse> {
    const limit = Math.min(
      MAX_ITEMS,
      Math.max(1, Number.isSafeInteger(requestedLimit) ? requestedLimit : MAX_ITEMS)
    );
    const selected = [...workItems]
      .sort((left, right) => right.updatedAt.localeCompare(left.updatedAt))
      .slice(0, limit);
    const items = await mapLimit(
      selected,
      FETCH_CONCURRENCY,
      (item) => this.#readOne(item)
    );
    return {
      schemaVersion: 1,
      configured: true,
      generatedAt: new Date().toISOString(),
      items
    };
  }

  async status(): Promise<VisualizerIntegrationStatus> {
    const sampledAt = new Date().toISOString();
    let response: Response;
    try {
      response = await this.#fetch(
        `${this.#baseUrl}/api/v1/system-status`,
        {
          method: "GET",
          headers: { accept: "application/json" },
          signal: AbortSignal.timeout(STATUS_REQUEST_TIMEOUT_MS)
        }
      );
    } catch {
      return unavailableStatus(sampledAt, false);
    }
    if (!response.ok) {
      return unavailableStatus(sampledAt, true);
    }
    try {
      const status = VisualizerSystemStatusSchema.parse(await response.json());
      return {
        schemaVersion: 1,
        configured: true,
        reachable: true,
        state: status.status,
        sampledAt,
        sourceGeneratedAt: status.generatedAt,
        database: status.database.availability,
        activeExecutions: status.executions?.activeCount ?? null,
        queueDepth: status.executions?.queueDepth ?? null,
        pendingApprovals: status.approvals?.pendingCount ?? null,
        eventStreamClients: status.eventStreams.activeClients,
        runtimes: status.runtimes
      };
    } catch {
      return unavailableStatus(sampledAt, true);
    }
  }

  async #readOne(item: WorkItem): Promise<VisualizerProjectionItem> {
    const executionId = visualizerExecutionIdForAcsWorkItem(item.id);
    let response: Response;
    try {
      response = await this.#fetch(
        `${this.#baseUrl}/api/v1/executions/${encodeURIComponent(executionId)}/graph`,
        {
          method: "GET",
          headers: { accept: "application/json" },
          signal: AbortSignal.timeout(GRAPH_REQUEST_TIMEOUT_MS)
        }
      );
    } catch {
      return baseItem(item, executionId, "unavailable");
    }
    if (response.status === 404) {
      return baseItem(item, executionId, "not_projected");
    }
    if (!response.ok) {
      return baseItem(item, executionId, "unavailable");
    }
    try {
      const graph = GraphResponseSchema.parse(await response.json());
      if (graph.execution.id !== executionId) {
        return baseItem(item, executionId, "unavailable");
      }
      return {
        ...baseItem(item, executionId, "available"),
        projection: {
          revision: graph.revision,
          eventPosition: graph.eventPosition,
          sourceRuntime: graph.execution.sourceRuntime,
          status: graph.execution.status,
          rootNodeId: graph.execution.rootNodeId,
          finalOutputNodeId: graph.execution.finalOutputNodeId,
          nodes: graph.nodes.map((node) => ({
            ...node,
            label: redactDisplayText(node.label)
          })),
          edges: graph.edges
        }
      };
    } catch {
      return baseItem(item, executionId, "unavailable");
    }
  }
}

function unavailableStatus(
  sampledAt: string,
  reachable: boolean
): VisualizerIntegrationStatus {
  return {
    schemaVersion: 1,
    configured: true,
    reachable,
    state: "unavailable",
    sampledAt,
    sourceGeneratedAt: null,
    database: null,
    activeExecutions: null,
    queueDepth: null,
    pendingApprovals: null,
    eventStreamClients: null,
    runtimes: []
  };
}

function baseItem(
  item: WorkItem,
  executionId: string,
  state: VisualizerProjectionState
): VisualizerProjectionItem {
  return {
    workItemId: item.id,
    title: redactDisplayText(item.title),
    risk: item.risk,
    acsStatus: item.status,
    executionId,
    state
  };
}

async function mapLimit<T, U>(
  items: readonly T[],
  concurrency: number,
  fn: (item: T) => Promise<U>
): Promise<U[]> {
  const output = new Array<U>(items.length);
  let cursor = 0;
  const workers = Array.from(
    { length: Math.min(concurrency, items.length) },
    async () => {
      for (;;) {
        const index = cursor;
        cursor += 1;
        if (index >= items.length) return;
        output[index] = await fn(items[index]!);
      }
    }
  );
  await Promise.all(workers);
  return output;
}
