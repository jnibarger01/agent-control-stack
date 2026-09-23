import { ControlStackError } from "@agent-control-stack/shared";
import { z } from "zod";

export const RUNTIME_OBSERVABILITY_UNAVAILABLE_CODE = "RUNTIME_OBSERVABILITY_UNAVAILABLE";
export const RUNTIME_OBSERVABILITY_UNAVAILABLE_MESSAGE =
  "RUNTIME_OBSERVABILITY_UNAVAILABLE: Runtime observability is not available from this gateway.";

const runtimeKindSchema = z.enum(["codex", "hermes", "openclaw", "opencode", "claude", "pi"]);
const token = z.string().trim().min(1).max(128);
const timestamp = z.string().datetime({ offset: true });
const health = z.object({
  status: z.enum(["healthy", "degraded", "unhealthy", "unavailable", "unknown"]),
  readiness: z.enum(["ready", "not_ready", "unknown"]),
  latencyMs: z.number().nonnegative().nullable()
}).passthrough();
const capability = z.object({
  kind: token,
  enabled: z.boolean(),
  requiresApproval: z.boolean()
}).passthrough();
const discovery = z.object({
  schemaVersion: z.literal(1),
  generatedAt: timestamp,
  runtimes: z.array(z.object({
    runtime: z.object({ kind: runtimeKindSchema, displayName: token }).passthrough(),
    health,
    capabilities: z.array(capability).max(64),
    available: z.boolean(),
    availabilityReason: z.string().trim().min(1).max(512),
    version: z.object({ value: z.string().trim().max(128).nullable() }).passthrough()
  }).passthrough()).length(6)
}).passthrough();
const catalog = z.object({
  schemaVersion: z.literal(1),
  generatedAt: timestamp,
  runtimes: z.array(z.object({
    runtime: z.object({ kind: runtimeKindSchema }).passthrough(),
    inventory: z.object({ status: token }).passthrough(),
    agents: z.array(z.object({ agent: z.object({
      id: token,
      displayName: token,
      sourceRuntime: runtimeKindSchema,
      status: token
    }).passthrough() }).passthrough()).max(2048)
  }).passthrough()).length(6)
}).passthrough();

export const runtimeObservabilityConfigSchema = z.object({
  baseUrl: z.string().url().refine((value) => {
    const url = new URL(value);
    return url.hostname === "127.0.0.1" || url.hostname === "localhost";
  }, "runtime observability base URL must remain loopback"),
  timeoutMs: z.number().int().min(100).max(30_000).default(5_000)
}).strict();

export type RuntimeObservabilitySnapshot = {
  generatedAt: string;
  source: "visualizer";
  runtimes: Array<{
    kind: z.infer<typeof runtimeKindSchema>;
    displayName: string;
    version: string | null;
    available: boolean;
    health: string;
    readiness: string;
    latencyMs: number | null;
    inventoryStatus: string;
    agents: Array<{ id: string; name: string; status: string }>;
    capabilities: string[];
    approvalGatedCapabilities: number;
    reason: string;
  }>;
};
export type RuntimeObservabilityClient = { getSnapshot(): Promise<RuntimeObservabilitySnapshot> };

export function createUnavailableRuntimeObservabilityClient(): RuntimeObservabilityClient {
  return { async getSnapshot(): Promise<never> {
    throw new ControlStackError(RUNTIME_OBSERVABILITY_UNAVAILABLE_CODE, RUNTIME_OBSERVABILITY_UNAVAILABLE_MESSAGE);
  }};
}

export function createRuntimeObservabilityClient(
  config: z.infer<typeof runtimeObservabilityConfigSchema>
): RuntimeObservabilityClient {
  const parsed = runtimeObservabilityConfigSchema.parse(config);
  const baseUrl = parsed.baseUrl.replace(/\/+$/, "");
  return { async getSnapshot() {
    const [rawDiscovery, rawCatalog] = await Promise.all([
      getJson(baseUrl, "/api/v1/runtimes", parsed.timeoutMs),
      getJson(baseUrl, "/api/v1/agents", parsed.timeoutMs)
    ]);
    const d = discovery.parse(rawDiscovery);
    const c = catalog.parse(rawCatalog);
    const byRuntime = new Map(c.runtimes.map((item) => [item.runtime.kind, item] as const));
    return {
      generatedAt: d.generatedAt,
      source: "visualizer" as const,
      runtimes: d.runtimes.map((entry) => {
        const inventory = byRuntime.get(entry.runtime.kind);
        return {
          kind: entry.runtime.kind,
          displayName: entry.runtime.displayName,
          version: entry.version.value,
          available: entry.available,
          health: entry.health.status,
          readiness: entry.health.readiness,
          latencyMs: entry.health.latencyMs,
          inventoryStatus: inventory?.inventory.status ?? "unknown",
          agents: (inventory?.agents ?? []).map((card) => ({
            id: card.agent.id, name: card.agent.displayName, status: card.agent.status
          })),
          capabilities: entry.capabilities.filter((item) => item.enabled).map((item) => item.kind),
          approvalGatedCapabilities: entry.capabilities.filter((item) => item.enabled && item.requiresApproval).length,
          reason: entry.availabilityReason
        };
      })
    };
  }};
}

export function createRuntimeObservabilityClientFromEnv(env: NodeJS.ProcessEnv = process.env): RuntimeObservabilityClient {
  const baseUrl = env.ACS_RUNTIME_OBSERVABILITY_BASE_URL?.trim() || env.ACS_PORTFOLIO_BASE_URL?.trim();
  if (!baseUrl) return createUnavailableRuntimeObservabilityClient();
  const parsed = runtimeObservabilityConfigSchema.safeParse({
    baseUrl,
    timeoutMs: env.ACS_RUNTIME_OBSERVABILITY_TIMEOUT_MS === undefined
      ? 5_000 : Number(env.ACS_RUNTIME_OBSERVABILITY_TIMEOUT_MS)
  });
  return parsed.success ? createRuntimeObservabilityClient(parsed.data) : createUnavailableRuntimeObservabilityClient();
}

async function getJson(baseUrl: string, path: string, timeoutMs: number): Promise<unknown> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetch(baseUrl + path, { method: "GET", headers: { Accept: "application/json" }, signal: controller.signal });
    if (!response.ok) throw new Error("http");
    const body: unknown = await response.json().catch(() => null);
    if (!isObject(body) || containsCredentialField(body)) throw new Error("unsafe");
    return body;
  } catch (error) {
    const message = error instanceof Error && error.name === "AbortError"
      ? "RUNTIME_OBSERVABILITY_UNAVAILABLE: Visualizer request timed out."
      : RUNTIME_OBSERVABILITY_UNAVAILABLE_MESSAGE;
    throw new ControlStackError(RUNTIME_OBSERVABILITY_UNAVAILABLE_CODE, message);
  } finally {
    clearTimeout(timer);
  }
}
function isObject(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}
const CREDENTIAL_KEYS = new Set(["token", "accessToken", "refreshToken", "authorization", "privateKey", "secret", "password"]);
function containsCredentialField(value: unknown, depth = 0): boolean {
  if (depth > 12) return true;
  if (Array.isArray(value)) return value.some((item) => containsCredentialField(item, depth + 1));
  if (!isObject(value)) return false;
  return Object.entries(value).some(([key, item]) => CREDENTIAL_KEYS.has(key) || containsCredentialField(item, depth + 1));
}
