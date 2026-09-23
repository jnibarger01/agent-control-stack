import { endpoints } from "../api/endpoints";
import type {
  ConnectorSummary,
  ExecutionAttempt,
  HealthResponse,
  LivezResponse,
  ProjectedActor,
  RegistryAgentView,
  RuntimeObservabilitySnapshot,
  SafeLease,
  SessionInfo,
  StoredAuditEvent,
  WorkItem,
  WorkItemDetailResponse
} from "../api/types";
import { sanitizeLease, latestAttempt, leaseForAttempt, type ExecutionRow } from "../domain/execution";
import { parsePrometheus, summarizeMetrics, type GatewayMetricSummary, type MetricSample } from "../domain/metrics";
import { EventStream } from "./events";
import { keys } from "./reconcile";
import { sessionStore } from "./session";
import { queryCache, useQuery, type UseQueryResult } from "./query";

/** The single live channel for the whole app. Views read it; only the shell starts/stops it. */
export const eventStream = new EventStream({
  backfill: (signal) => endpoints.listEvents({ limit: 500 }, signal),
  headCheck: (afterSequence, signal) => endpoints.listEvents({ afterSequence, limit: 20 }, signal),
  onUnauthorized: sessionStore.markUnauthenticated
});

const READ_STALE_MS = 15_000;

export function useWorkItems(): UseQueryResult<WorkItem[]> {
  return useQuery(keys.workItems, (signal) => endpoints.listWorkItems({}, signal), { staleMs: READ_STALE_MS });
}

export function useWorkItem(id: string | undefined): UseQueryResult<WorkItemDetailResponse> {
  return useQuery(
    id ? keys.workItem(id) : null,
    async (signal) => {
      const detail = await endpoints.getWorkItem(id!, signal);
      // Defence in depth: never keep secret-bearing lease keys even if a gateway sends them.
      return {
        ...detail,
        attemptLeases: detail.attemptLeases.map((lease) => sanitizeLease(lease as unknown as Record<string, unknown>))
      };
    },
    { staleMs: READ_STALE_MS }
  );
}

export function useRegistryAgents(): UseQueryResult<RegistryAgentView[]> {
  return useQuery(keys.agents, (signal) => endpoints.listRegistryAgents(signal), { staleMs: READ_STALE_MS });
}

export function useRuntimeObservability(): UseQueryResult<RuntimeObservabilitySnapshot> {
  return useQuery(keys.runtimes, (signal) => endpoints.runtimeObservability(signal), { staleMs: 10_000 });
}

export function useProjectedActors(): UseQueryResult<ProjectedActor[]> {
  return useQuery(keys.actors, (signal) => endpoints.listProjectedActors(signal), { staleMs: READ_STALE_MS });
}

/** Authoritative connector registry: complete regardless of audit-log scan depth; never carries key material. */
export function useConnectors(): UseQueryResult<ConnectorSummary[]> {
  return useQuery(keys.connectors, (signal) => endpoints.listConnectors(signal), { staleMs: READ_STALE_MS });
}

/** Sanitized identity of the signed-in operator; never the token or the credential's scopes. */
export function useSession(): UseQueryResult<SessionInfo> {
  return useQuery(keys.session, (signal) => endpoints.getSession(signal), { staleMs: 60_000 });
}

export function useAgentDetail(id: string | undefined) {
  return useQuery(
    id ? keys.agent(id) : null,
    async (signal) => {
      const [detail, capabilities] = await Promise.all([
        endpoints.getRegistryAgent(id!, signal),
        endpoints.listAgentCapabilities(id!, signal)
      ]);
      return { ...detail, capabilities };
    },
    { staleMs: READ_STALE_MS }
  );
}

export function useEventBackfill(): UseQueryResult<StoredAuditEvent[]> {
  return useQuery(keys.events, (signal) => endpoints.listEvents({ limit: 500 }, signal), { staleMs: READ_STALE_MS });
}

export interface LedgerBundle {
  events: StoredAuditEvent[];
  /** False when the scan hit its cap before reaching the end of the log. */
  complete: boolean;
  scanned: number;
}

const LEDGER_PAGE = 500;
const LEDGER_MAX_PAGES = 20;

/**
 * Pages the append-only audit log from the start (afterSequence cursor) so
 * connector/tunnel history registered long ago is still discoverable. Bounded
 * to LEDGER_MAX_PAGES; the result says whether it reached the end.
 */
export function useLedger(): UseQueryResult<LedgerBundle> {
  return useQuery(
    `${keys.events}:ledger`,
    async (signal) => {
      const events: StoredAuditEvent[] = [];
      let after = 0;
      for (let page = 0; page < LEDGER_MAX_PAGES; page += 1) {
        const batch = await endpoints.listEvents({ afterSequence: after, limit: LEDGER_PAGE }, signal);
        events.push(...batch);
        if (batch.length < LEDGER_PAGE) return { events, complete: true, scanned: events.length };
        after = batch[batch.length - 1]!.sequence;
      }
      return { events, complete: false, scanned: events.length };
    },
    { staleMs: 30_000 }
  );
}

export interface HealthBundle {
  livez: { ok: boolean; status?: string } | { error: unknown };
  readyz: (HealthResponse & { httpStatus: number }) | { error: unknown };
  health: (HealthResponse & { httpStatus: number }) | { error: unknown };
  checkedAt: number;
}

/** livez / readyz / health are read independently: each can fail (or be unknown) on its own. */
export function useHealth(): UseQueryResult<HealthBundle> {
  return useQuery(
    keys.health,
    async (signal) => {
      const settle = async <T>(promise: Promise<T>): Promise<T | { error: unknown }> => {
        try {
          return await promise;
        } catch (error) {
          return { error };
        }
      };
      const [livez, readyz, health] = await Promise.all([
        settle<LivezResponse>(endpoints.livez(signal)),
        settle(endpoints.readyz(signal)),
        settle(endpoints.health(signal))
      ]);
      return { livez, readyz, health, checkedAt: Date.now() };
    },
    { staleMs: 10_000 }
  );
}

export interface MetricsBundle {
  samples: MetricSample[];
  summary: GatewayMetricSummary;
  fetchedAt: number;
}

export function useMetrics(): UseQueryResult<MetricsBundle> {
  return useQuery(
    keys.metrics,
    async (signal) => {
      const samples = parsePrometheus(await endpoints.metricsText(signal));
      return { samples, summary: summarizeMetrics(samples), fetchedAt: Date.now() };
    },
    { staleMs: 5_000 }
  );
}

// --- execution aggregation -----------------------------------------------------

/** Work items that can plausibly have attempts; drafts and pending approvals have none yet. */
const ATTEMPT_STATUSES = new Set([
  "approved",
  "running",
  "cancelling",
  "succeeded",
  "failed",
  "unknown",
  "quarantined",
  "cancelled",
  "blocked"
]);
const EXECUTION_SCAN_LIMIT = 40;
const EXECUTION_CONCURRENCY = 5;

export interface ExecutionBundle {
  rows: ExecutionRow[];
  scanned: number;
  candidates: number;
  truncated: boolean;
  details: Map<string, WorkItemDetailResponse>;
}

async function mapLimit<T, R>(items: readonly T[], limit: number, fn: (item: T) => Promise<R>): Promise<R[]> {
  const out: R[] = new Array(items.length);
  let cursor = 0;
  const workers = Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (cursor < items.length) {
      const index = cursor++;
      out[index] = await fn(items[index]!);
    }
  });
  await Promise.all(workers);
  return out;
}

/**
 * The gateway has no execution-list route: attempts and leases are only served
 * per work item. This bounds the fan-out (most recently updated first, small
 * concurrency) and reuses the per-item cache, rather than issuing an unbounded
 * request storm. `truncated` is surfaced in the UI so the limit is never hidden.
 */
export function useExecutions(workItems: readonly WorkItem[] | undefined): UseQueryResult<ExecutionBundle> {
  const candidates = (workItems ?? [])
    .filter((item) => ATTEMPT_STATUSES.has(item.status))
    .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
  const scan = candidates.slice(0, EXECUTION_SCAN_LIMIT);
  const signature = scan.map((item) => `${item.id}@${item.updatedAt}`).join(",");
  return useQuery(
    workItems ? `${keys.executions}:${signature}` : null,
    async (signal) => {
      const details = new Map<string, WorkItemDetailResponse>();
      await mapLimit(scan, EXECUTION_CONCURRENCY, async (item) => {
        const detail = await endpoints.getWorkItem(item.id, signal);
        details.set(item.id, {
          ...detail,
          attemptLeases: detail.attemptLeases.map((l) => sanitizeLease(l as unknown as Record<string, unknown>))
        });
      });
      const rows: ExecutionRow[] = [];
      for (const item of scan) {
        const detail = details.get(item.id);
        if (!detail) continue;
        const attempts: ExecutionAttempt[] = detail.executionAttempts;
        const attempt = latestAttempt(attempts);
        if (!attempt) continue;
        const lease: SafeLease | undefined = leaseForAttempt(detail.attemptLeases, attempt.attemptId);
        rows.push({
          key: attempt.attemptId,
          workItem: detail.workItem,
          attempt,
          lease,
          retryCount: Math.max(0, attempts.length - 1),
          attemptCount: attempts.length
        });
      }
      return {
        rows,
        scanned: scan.length,
        candidates: candidates.length,
        truncated: candidates.length > scan.length,
        details
      };
    },
    { staleMs: READ_STALE_MS }
  );
}

export { queryCache };
