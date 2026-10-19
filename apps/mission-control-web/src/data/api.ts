import { parseOverviewReadModel, type OverviewReadModel } from "@agent-control-stack/mission-control-contract";

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
/** The response did not satisfy the shared contract; nothing from it is rendered. */
export class SchemaError extends Error {
  constructor(readonly reason: string) {
    super(`response failed contract validation (${reason})`);
    this.name = "SchemaError";
  }
}

export const OVERVIEW_URL = "/api/mission-control/overview";

export async function fetchOverview(fetcher: typeof fetch = fetch, signal?: AbortSignal): Promise<OverviewReadModel> {
  const res = await fetcher(OVERVIEW_URL, {
    credentials: "same-origin",
    headers: { accept: "application/json" },
    cache: "no-store",
    ...(signal ? { signal } : {})
  });
  if (res.status === 401 || res.status === 403) throw new AuthRequiredError();
  if (!res.ok) throw new ApiError(res.status);
  let body: unknown;
  try {
    body = await res.json();
  } catch {
    throw new SchemaError("not_json");
  }
  const parsed = parseOverviewReadModel(body);
  if (!parsed.ok) throw new SchemaError(parsed.reason);
  return parsed.value;
}
