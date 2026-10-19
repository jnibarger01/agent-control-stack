import {
  parseOverviewReadModel,
  parseQueueReadModel,
  parseTraceReadModel,
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
