import {
  parseAgentDetail,
  parseAgentsList,
  parseApprovalsReadModel,
  parseConnectorDetail,
  parseConnectorsList,
  parseExecutorDetail,
  parseExecutorsList,
  parseExecutionReadModel,
  parseOverviewReadModel,
  parseQueueReadModel,
  parseTraceReadModel,
  type AgentDetail,
  type ApprovalsReadModel,
  type Connector,
  type ConnectorDetail,
  type Executor,
  type ExecutorDetail,
  type RegistryAgent,
  type ExecutionReadModel,
  type OverviewReadModel,
  type Parsed,
  type QueueReadModel,
  type TraceReadModel
} from "@agent-control-stack/mission-control-contract";

/** Session is missing/expired. The SPA never handles credentials; sign-in happens at the console root. */
export class AuthRequiredError extends Error {
  constructor() {
    super("authentication required");
    this.name = "AuthRequiredError";
  }
}
export class ApiError extends Error {
  constructor(readonly status: number) {
    super(`request failed with status ${status}`);
    this.name = "ApiError";
  }
}
export class NotFoundError extends Error {
  constructor() {
    super("not found");
    this.name = "NotFoundError";
  }
}
/** The response did not satisfy the shared contract; nothing from it is rendered. */
export class SchemaError extends Error {
  constructor(readonly reason: string) {
    super(`response failed contract validation (${reason})`);
    this.name = "SchemaError";
  }
}

export const OVERVIEW_URL = "/api/mission-control/overview";
export const QUEUE_URL = "/api/mission-control/queue";
export const APPROVALS_URL = "/api/mission-control/approvals";
export const EXECUTION_URL = "/api/mission-control/execution";
export const traceUrl = (id: string) => `/api/mission-control/work-items/${encodeURIComponent(id)}/trace`;

async function fetchContract<T>(url: string, parse: (input: unknown) => Parsed<T>, fetcher: typeof fetch, signal?: AbortSignal): Promise<T> {
  const res = await fetcher(url, {
    credentials: "same-origin",
    headers: { accept: "application/json" },
    cache: "no-store",
    ...(signal ? { signal } : {})
  });
  if (res.status === 401 || res.status === 403) throw new AuthRequiredError();
  if (res.status === 404) throw new NotFoundError();
  if (!res.ok) throw new ApiError(res.status);
  let body: unknown;
  try {
    body = await res.json();
  } catch {
    throw new SchemaError("not_json");
  }
  const parsed = parse(body);
  if (!parsed.ok) throw new SchemaError(parsed.reason);
  return parsed.value;
}

export const fetchOverview = (fetcher: typeof fetch = fetch, signal?: AbortSignal): Promise<OverviewReadModel> =>
  fetchContract(OVERVIEW_URL, parseOverviewReadModel, fetcher, signal);
export const fetchQueue = (fetcher: typeof fetch = fetch, signal?: AbortSignal): Promise<QueueReadModel> =>
  fetchContract(QUEUE_URL, parseQueueReadModel, fetcher, signal);
export const fetchTrace = (id: string, fetcher: typeof fetch = fetch, signal?: AbortSignal): Promise<TraceReadModel> =>
  fetchContract(traceUrl(id), parseTraceReadModel, fetcher, signal);
export const fetchApprovals = (fetcher: typeof fetch = fetch, signal?: AbortSignal): Promise<ApprovalsReadModel> =>
  fetchContract(APPROVALS_URL, parseApprovalsReadModel, fetcher, signal);
export const fetchExecution = (fetcher: typeof fetch = fetch, signal?: AbortSignal): Promise<ExecutionReadModel> =>
  fetchContract(EXECUTION_URL, parseExecutionReadModel, fetcher, signal);

/* ───────────── operator actions: existing authenticated routes, unchanged ───────────── */

export type ActionKind = "approve" | "deny" | "unblock" | "cancel" | "retry";
export const ACTION_PATH: Record<ActionKind, string> = { approve: "approve", deny: "reject", unblock: "unblock", cancel: "cancel", retry: "retry" };

export type ActionResult = { ok: true; status: number; workItemStatus?: string } | { ok: false; status: number; message: string };

/**
 * Sends one operator action to the gateway's existing route. The session cookie
 * (HttpOnly, SameSite=Strict) authenticates; the gateway alone decides whether the
 * action is permitted and returns its reason, which is shown verbatim (bounded, escaped by React).
 */
export async function postWorkItemAction(
  kind: ActionKind,
  workItemId: string,
  input: { reason?: string; actionHash?: string },
  fetcher: typeof fetch = fetch
): Promise<ActionResult> {
  const payload: Record<string, string> = {};
  if (kind !== "unblock" && input.reason) payload.reason = input.reason;
  if (kind === "approve" && input.actionHash) payload.actionHash = input.actionHash;
  try {
    const res = await fetcher(`/work-items/${encodeURIComponent(workItemId)}/${ACTION_PATH[kind]}`, {
      method: "POST",
      credentials: "same-origin",
      headers: { "content-type": "application/json", accept: "application/json" },
      body: JSON.stringify(payload)
    });
    if (res.ok) {
      // The returned work item status says what actually happened (for example an item with several
      // gated actions stays `needs_approval` after one is approved).
      const body = (await res.json().catch(() => ({}))) as { workItem?: { status?: unknown } };
      return { ok: true, status: res.status, ...(typeof body.workItem?.status === "string" ? { workItemStatus: body.workItem.status } : {}) };
    }
    const body = (await res.json().catch(() => ({}))) as { error?: unknown; code?: unknown };
    const detail = typeof body.error === "string" ? body.error : typeof body.code === "string" ? body.code : "";
    const message = res.status === 401 ? "Your session expired. Sign in again through the console." : detail ? detail.slice(0, 240) : `The gateway refused this action (${res.status}).`;
    return { ok: false, status: res.status, message };
  } catch {
    return { ok: false, status: 0, message: "Could not reach the gateway. Nothing was changed." };
  }
}

/* ───────────── registry pages: existing JSON routes, client-picked fields only ───────────── */

export const fetchAgents = async (fetcher: typeof fetch = fetch, signal?: AbortSignal): Promise<RegistryAgent[]> =>
  (await fetchContract("/api/agents", parseAgentsList, fetcher, signal)).agents;
export const fetchAgent = (id: string, fetcher: typeof fetch = fetch, signal?: AbortSignal): Promise<AgentDetail> =>
  fetchContract(`/api/agents/${encodeURIComponent(id)}`, parseAgentDetail, fetcher, signal);
export const fetchExecutors = async (fetcher: typeof fetch = fetch, signal?: AbortSignal): Promise<Executor[]> =>
  (await fetchContract("/api/executors", parseExecutorsList, fetcher, signal)).executors;
export const fetchExecutor = (id: string, fetcher: typeof fetch = fetch, signal?: AbortSignal): Promise<ExecutorDetail> =>
  fetchContract(`/api/executors/${encodeURIComponent(id)}`, parseExecutorDetail, fetcher, signal);
export const fetchConnectors = async (fetcher: typeof fetch = fetch, signal?: AbortSignal): Promise<Connector[]> =>
  (await fetchContract("/api/connectors", parseConnectorsList, fetcher, signal)).connectors;
export const fetchConnector = (id: string, fetcher: typeof fetch = fetch, signal?: AbortSignal): Promise<ConnectorDetail> =>
  fetchContract(`/api/connectors/${encodeURIComponent(id)}`, parseConnectorDetail, fetcher, signal);
