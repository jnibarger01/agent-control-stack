/**
 * Every failure surfaced to the operator keeps its authority-relevant class:
 * an authorization failure must never be flattened into a generic error, and a
 * state conflict must never look like a retryable outage.
 */
export type AcsErrorKind =
  | "unauthorized" // 401: no/expired session
  | "forbidden" // 403: authenticated but role/scope/policy denied
  | "not_found" // 404
  | "conflict" // 409: state-machine / approval / lease conflict
  | "invalid" // 400/422: request rejected by canonical schema
  | "rate_limited" // 429
  | "unavailable" // 503: dependency not ready / capacity
  | "server" // other 5xx
  | "network" // fetch failed / offline
  | "aborted" // request cancelled by navigation/unmount
  | "protocol"; // response did not match the expected shape

export class AcsApiError extends Error {
  readonly kind: AcsErrorKind;
  readonly status: number | undefined;
  readonly code: string | undefined;
  readonly retryAfterSeconds: number | undefined;
  readonly body: unknown;

  constructor(
    kind: AcsErrorKind,
    message: string,
    extra: { status?: number; code?: string; retryAfterSeconds?: number; body?: unknown } = {}
  ) {
    super(message);
    this.name = "AcsApiError";
    this.kind = kind;
    this.status = extra.status;
    this.code = extra.code;
    this.retryAfterSeconds = extra.retryAfterSeconds;
    this.body = extra.body;
  }

  /** Errors where repeating the identical request cannot help. */
  get retryable(): boolean {
    return this.kind === "network" || this.kind === "unavailable" || this.kind === "server";
  }
}

export function isAcsApiError(value: unknown): value is AcsApiError {
  return value instanceof AcsApiError;
}

export function kindForStatus(status: number): AcsErrorKind {
  if (status === 401) return "unauthorized";
  if (status === 403) return "forbidden";
  if (status === 404) return "not_found";
  if (status === 409 || status === 410) return "conflict";
  if (status === 400 || status === 422) return "invalid";
  if (status === 429) return "rate_limited";
  if (status === 503) return "unavailable";
  if (status >= 500) return "server";
  return "protocol";
}

const HEADLINES: Record<AcsErrorKind, string> = {
  unauthorized: "Session expired or not signed in",
  forbidden: "Not permitted",
  not_found: "Not found",
  conflict: "State conflict",
  invalid: "Request rejected",
  rate_limited: "Rate limited",
  unavailable: "Service unavailable",
  server: "Gateway error",
  network: "Gateway unreachable",
  aborted: "Request cancelled",
  protocol: "Unexpected response"
};

export function errorHeadline(error: AcsApiError): string {
  return HEADLINES[error.kind];
}

/** One operator-facing line that preserves the authoritative backend code. */
export function describeError(error: unknown): string {
  if (!isAcsApiError(error)) return error instanceof Error ? error.message : "Unknown error";
  const parts = [errorHeadline(error)];
  if (error.status !== undefined) parts.push(`HTTP ${error.status}`);
  if (error.code) parts.push(error.code);
  const detail = error.message && error.message !== HEADLINES[error.kind] ? `: ${error.message}` : "";
  const retry = error.retryAfterSeconds !== undefined ? ` (retry after ${error.retryAfterSeconds}s)` : "";
  return `${parts.join(" · ")}${detail}${retry}`;
}
