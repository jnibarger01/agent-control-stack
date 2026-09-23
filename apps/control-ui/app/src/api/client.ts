import { sessionStore } from "../state/session";
import { AcsApiError, kindForStatus } from "./errors";

export interface RequestOptions {
  method?: "GET" | "POST";
  body?: unknown;
  signal?: AbortSignal;
  headers?: Record<string, string>;
  query?: Record<string, string | number | boolean | undefined>;
  /** Parse as text instead of JSON (Prometheus exposition). */
  as?: "json" | "text";
}

export type Fetcher = typeof fetch;

export interface AcsClientConfig {
  baseUrl?: string;
  fetcher?: Fetcher;
  /** Called on any 401 from an authenticated route so the shell can present sign-in. */
  onUnauthorized?: () => void;
  /** Called after any successful authenticated (non-public) response. */
  onAuthenticated?: () => void;
}

function buildUrl(base: string, path: string, query: RequestOptions["query"]): string {
  const params = new URLSearchParams();
  for (const [key, value] of Object.entries(query ?? {})) {
    if (value !== undefined && value !== "") params.set(key, String(value));
  }
  const qs = params.toString();
  return `${base}${path}${qs ? `?${qs}` : ""}`;
}

function safeParse(text: string): unknown {
  if (!text) return undefined;
  try {
    return JSON.parse(text);
  } catch {
    return undefined;
  }
}

/**
 * The single fetch boundary for Mission Control. Authentication is the
 * gateway's HttpOnly, SameSite=Strict session cookie: this code never reads,
 * stores, or forwards an operator token, so there is nothing to leak.
 */
export class AcsClient {
  private readonly baseUrl: string;
  private readonly fetcher: Fetcher;
  private readonly onUnauthorized: (() => void) | undefined;
  private readonly onAuthenticated: (() => void) | undefined;

  constructor(config: AcsClientConfig = {}) {
    this.baseUrl = config.baseUrl ?? "";
    this.fetcher = config.fetcher ?? ((...args) => globalThis.fetch(...args));
    this.onUnauthorized = config.onUnauthorized;
    this.onAuthenticated = config.onAuthenticated;
  }

  async request<T = unknown>(path: string, options: RequestOptions = {}): Promise<T> {
    const method = options.method ?? "GET";
    const headers: Record<string, string> = { accept: options.as === "text" ? "text/plain" : "application/json" };
    if (options.body !== undefined) headers["content-type"] = "application/json";
    Object.assign(headers, options.headers);

    let response: Response;
    try {
      response = await this.fetcher(buildUrl(this.baseUrl, path, options.query), {
        method,
        headers,
        credentials: "same-origin",
        cache: "no-store",
        ...(options.body !== undefined ? { body: JSON.stringify(options.body) } : {}),
        ...(options.signal ? { signal: options.signal } : {})
      });
    } catch (error) {
      if (options.signal?.aborted || (error instanceof DOMException && error.name === "AbortError")) {
        throw new AcsApiError("aborted", "Request cancelled");
      }
      throw new AcsApiError("network", "Could not reach the ACS gateway");
    }

    const text = await response.text().catch(() => "");
    // /session/login legitimately answers 401 for a wrong token; it is not an expired session.
    const isLogin = path === "/session/login";
    const isPublic = path === "/livez" || path === "/readyz" || path === "/health";
    if (response.status === 401 && !isLogin && !isPublic) this.onUnauthorized?.();
    if (response.ok && !isLogin && !isPublic) this.onAuthenticated?.();
    if (!response.ok) {
      const body = safeParse(text);
      const record = body && typeof body === "object" ? (body as Record<string, unknown>) : {};
      const retryHeader = Number(response.headers.get("retry-after"));
      const retryBody = typeof record.retry_after_seconds === "number" ? record.retry_after_seconds : undefined;
      // Policy denials (approve/unblock → 403) carry their rationale under `decision.reason`, not `error`.
      const decision =
        record.decision && typeof record.decision === "object" ? (record.decision as Record<string, unknown>) : {};
      const message =
        typeof record.error === "string" ? record.error : typeof decision.reason === "string" ? decision.reason : "";
      throw new AcsApiError(kindForStatus(response.status), message, {
        status: response.status,
        ...(typeof record.code === "string" ? { code: record.code } : {}),
        ...(Number.isFinite(retryHeader) && retryHeader > 0
          ? { retryAfterSeconds: retryHeader }
          : retryBody !== undefined
            ? { retryAfterSeconds: retryBody }
            : {}),
        body
      });
    }

    if (options.as === "text") return text as T;
    if (response.status === 204 || text === "") return undefined as T;
    const parsed = safeParse(text);
    if (parsed === undefined)
      throw new AcsApiError("protocol", "Response was not valid JSON", { status: response.status });
    return parsed as T;
  }
}

export const defaultClient = new AcsClient({
  onUnauthorized: sessionStore.markUnauthenticated,
  onAuthenticated: sessionStore.markAuthenticated
});
