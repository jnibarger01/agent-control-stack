import { AcsClient, defaultClient } from "./client";
import type {
  AgentDetailResponse,
  ApprovalResult,
  ConnectorRegistrationBody,
  ConnectorSummary,
  HealthResponse,
  LivezResponse,
  PolicyExplainInput,
  PolicyExplainResult,
  ProjectedActor,
  RegistryAgentView,
  RegistryCapability,
  SessionInfo,
  StoredAuditEvent,
  TunnelSessionBody,
  UnblockResult,
  WorkItem,
  WorkItemDetailResponse
} from "./types";

/**
 * Typed wrappers over routes that exist in apps/gateway/src/server.ts. Every
 * function names its route in one place so a contract change is a one-file
 * edit; components never build URLs. Mutations return the authoritative
 * backend response and never assume success.
 */
export function createEndpoints(client: AcsClient = defaultClient) {
  const enc = encodeURIComponent;
  return {
    // --- session -----------------------------------------------------------
    login: (token: string, signal?: AbortSignal) =>
      client.request<void>("/session/login", { method: "POST", body: { token }, ...(signal ? { signal } : {}) }),
    /** Sanitized identity of the signed-in caller; never the token or the credential's scopes. */
    getSession: (signal?: AbortSignal) => client.request<SessionInfo>("/session", signal ? { signal } : {}),

    // --- health (public routes: liveness/readiness are distinct concepts) ----
    livez: (signal?: AbortSignal) => client.request<LivezResponse>("/livez", signal ? { signal } : {}),
    /** /readyz returns 503 with a full body when not ready; callers need that body. */
    readyz: (signal?: AbortSignal) => readHealth(client, "/readyz", signal),
    health: (signal?: AbortSignal) => readHealth(client, "/health", signal),

    // --- work items ----------------------------------------------------------
    listWorkItems: async (query: { status?: string } = {}, signal?: AbortSignal) =>
      (
        await client.request<{ workItems: WorkItem[] }>("/work-items", {
          query,
          ...(signal ? { signal } : {})
        })
      ).workItems,
    getWorkItem: (id: string, signal?: AbortSignal) =>
      client.request<WorkItemDetailResponse>(`/work-items/${enc(id)}`, {
        query: { limit: 500 },
        ...(signal ? { signal } : {})
      }),
    createWorkItem: (body: Record<string, unknown>) =>
      client.request<WorkItem>("/work-items", { method: "POST", body }),
    approveWorkItem: (id: string, body: { reason: string; actionHash: string }) =>
      client.request<ApprovalResult>(`/work-items/${enc(id)}/approve`, { method: "POST", body }),
    rejectWorkItem: (id: string, body: { reason?: string }) =>
      client.request<{ workItem: WorkItem }>(`/work-items/${enc(id)}/reject`, { method: "POST", body }),
    cancelWorkItem: (id: string, body: { reason?: string }) =>
      client.request<{ workItem: WorkItem }>(`/work-items/${enc(id)}/cancel`, { method: "POST", body }),
    unblockWorkItem: (id: string) =>
      client.request<UnblockResult>(`/work-items/${enc(id)}/unblock`, { method: "POST", body: {} }),
    retryWorkItem: (id: string, body: { reason: string }) =>
      client.request<{ workItem: WorkItem }>(`/work-items/${enc(id)}/retry`, { method: "POST", body }),
    cloneWorkItem: (id: string, body: Record<string, unknown>) =>
      client.request<{ workItem: WorkItem }>(`/work-items/${enc(id)}/clone`, { method: "POST", body }),

    // --- policy --------------------------------------------------------------
    /** Explanation only: the gateway computes a decision and hash, records nothing, executes nothing. */
    explainPolicy: (input: PolicyExplainInput) =>
      client.request<PolicyExplainResult>("/policy/explain", { method: "POST", body: input }),

    // --- agents --------------------------------------------------------------
    listRegistryAgents: async (signal?: AbortSignal) =>
      (await client.request<{ agents: RegistryAgentView[] }>("/api/agents", signal ? { signal } : {})).agents,
    getRegistryAgent: (id: string, signal?: AbortSignal) =>
      client.request<AgentDetailResponse>(`/api/agents/${enc(id)}`, {
        query: { limit: 100 },
        ...(signal ? { signal } : {})
      }),
    listAgentCapabilities: async (id: string, signal?: AbortSignal) =>
      (
        await client.request<{ capabilities: RegistryCapability[] }>(`/api/agents/${enc(id)}/capabilities`, {
          ...(signal ? { signal } : {})
        })
      ).capabilities,
    registerAgent: (body: {
      id: string;
      name: string;
      kind: string;
      acpRole: string;
      provider?: string;
      model?: string;
    }) => client.request<{ agent: RegistryAgentView }>("/api/agents", { method: "POST", body }),
    /** Audit-derived actor projection (registry + connector/tunnel/worker evidence). */
    listProjectedActors: async (signal?: AbortSignal) =>
      (
        await client.request<{ agents: ProjectedActor[] }>("/agents", {
          query: { limit: 500 },
          ...(signal ? { signal } : {})
        })
      ).agents,

    // --- audit ---------------------------------------------------------------
    listEvents: async (query: { limit?: number; afterSequence?: number } = {}, signal?: AbortSignal) =>
      (await client.request<{ events: StoredAuditEvent[] }>("/api/events", { query, ...(signal ? { signal } : {}) }))
        .events,

    // --- metrics (Prometheus text exposition; no JSON contract exists) ----------
    metricsText: (signal?: AbortSignal) =>
      client.request<string>("/metrics", { as: "text", ...(signal ? { signal } : {}) }),

    // --- connectors ----------------------------------------------------------
    /** Authoritative connector registry: never includes key material, only the public-key fingerprint. */
    listConnectors: async (signal?: AbortSignal) =>
      (await client.request<{ connectors: ConnectorSummary[] }>("/connectors", signal ? { signal } : {})).connectors,
    registerConnector: (body: ConnectorRegistrationBody) =>
      client.request<{ connector: unknown }>("/connectors", { method: "POST", body }),
    rotateConnectorKey: (id: string, body: { publicKeyPem: string; reason: string }) =>
      client.request<{ connector: unknown }>(`/connectors/${enc(id)}/rotate-key`, { method: "POST", body }),
    registerTunnelSession: (id: string, body: TunnelSessionBody) =>
      client.request<{ session: unknown }>(`/connectors/${enc(id)}/tunnel-sessions`, { method: "POST", body }),
    revokeTunnelSession: (id: string, tunnelId: string, sessionId: string) =>
      client.request<{ session: unknown }>(
        `/connectors/${enc(id)}/tunnels/${enc(tunnelId)}/sessions/${enc(sessionId)}/revoke`,
        { method: "POST", body: {} }
      )
  };
}

export type AcsEndpoints = ReturnType<typeof createEndpoints>;
export const endpoints: AcsEndpoints = createEndpoints();

async function readHealth(
  client: AcsClient,
  path: string,
  signal?: AbortSignal
): Promise<HealthResponse & { httpStatus: number }> {
  try {
    const body = await client.request<HealthResponse>(path, signal ? { signal } : {});
    return { ...body, httpStatus: 200 };
  } catch (error) {
    const body = (error as { body?: unknown; status?: number }).body;
    const status = (error as { status?: number }).status;
    if (status === 503 && body && typeof body === "object" && "checks" in body) {
      return { ...(body as HealthResponse), httpStatus: 503 };
    }
    throw error;
  }
}
