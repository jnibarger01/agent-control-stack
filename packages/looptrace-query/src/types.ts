import type { EvidenceEvent } from "./model.js";

/** Caller-supplied lookup. At least one identifier is required; no unrestricted enumeration exists. */
export interface Lookup {
  trace_id?: string | undefined;
  request_id?: string | undefined;
  work_item_id?: string | undefined;
  execution_id?: string | undefined;
}

export type SourceStatusKind = "ok" | "unavailable" | "not_configured" | "error";

export interface SourceReport {
  source: string;
  status: SourceStatusKind;
  events: number;
  /** Short, sanitised, non-secret description (never a raw path or raw error with payloads). */
  detail?: string | undefined;
}

export interface SourceResult {
  events: EvidenceEvent[];
  report: SourceReport;
}

/** Hard bounds. Every query is bounded in depth, size and time. */
export const LIMITS = {
  maxEventsPerWorkItem: 1500,
  maxWorkItemsPerQuery: 25,
  maxLineageDepth: 20,
  defaultPageSize: 100,
  maxPageSize: 200,
  queryDeadlineMs: 8000,
  maxIdentifierLength: 160,
  maxFrameBytes: 256 * 1024
} as const;

export class Deadline {
  private readonly expiresAt: number;
  constructor(ms: number = LIMITS.queryDeadlineMs, private readonly clock: () => number = () => Date.now()) {
    this.expiresAt = clock() + ms;
  }
  expired(): boolean {
    return this.clock() > this.expiresAt;
  }
}

export class QueryError extends Error {
  constructor(
    readonly code:
      | "INVALID_ARGUMENT"
      | "NOT_FOUND"
      | "AMBIGUOUS_IDENTIFIER"
      | "UNAUTHENTICATED"
      | "SOURCE_NOT_CONFIGURED"
      | "SOURCE_UNAVAILABLE"
      | "UNSUPPORTED_ASSERTION"
      | "DEADLINE_EXCEEDED"
      | "INTERNAL",
    message: string
  ) {
    super(message);
    this.name = "QueryError";
  }
}

export interface ReleaseObserverConfig {
  /** Operator-configured directories shaped like ~/releases/<component>/<sha7>-label/RELEASE.json. */
  releaseRoots: string[];
}

export interface HealthTarget {
  name: string;
  /** Operator-configured GET endpoint. Callers can never supply a URL. */
  url: string;
}

export interface QueryConfig {
  /** ACS control-plane SQLite path, opened read-only. null => ACS source not configured. */
  acsDbPath: string | null;
  jcTraceRoots: string[];
  hermesStateDb: string | null;
  releaseRoots: string[];
  healthTargets: HealthTarget[];
  /** HMAC key for grants. null => no principal can authenticate => every call is UNAUTHENTICATED. */
  grantKey: Buffer | null;
  /** Injectable for tests. */
  now: () => Date;
}
