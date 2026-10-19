import { createContext, useCallback, useContext, useEffect, useMemo, useRef, type ReactNode } from "react";
import { keepPreviousData, useQuery, useQueryClient } from "@tanstack/react-query";
import { type AuditFilters, AuthRequiredError, NotFoundError, SchemaError, fetchAgent, fetchAgents, fetchAudit, fetchApprovals, fetchConnector, fetchConnectors, fetchExecution, fetchExecutor, fetchExecutors, fetchOverview, fetchQueue, fetchTrace } from "./api";
import { useEventStream, type EventSourceFactory, type StreamState } from "./stream";

export const ROOT_KEY = ["mission-control"] as const;
export const OVERVIEW_KEY = [...ROOT_KEY, "overview"] as const;
export const QUEUE_KEY = [...ROOT_KEY, "queue"] as const;
export const traceKey = (id: string) => [...ROOT_KEY, "trace", id] as const;
// One refetch per second at most keeps a busy event stream under the gateway's per-route read budget.
const COALESCE_MS = 1000;

const StreamContext = createContext<StreamState>("connecting");
export const useStreamState = () => useContext(StreamContext);

/**
 * One SSE connection for the whole app. Events never mutate state directly: they
 * invalidate every mission-control query (coalesced to one refetch window), so
 * the server stays the only source of truth. Reads also refetch on a bounded
 * interval (see TIME_DERIVED_REFRESH_MS) for facts that change without an event.
 */
export function LiveProvider({ factory, children }: { factory?: EventSourceFactory | undefined; children: ReactNode }) {
  const client = useQueryClient();
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const refresh = useCallback(
    (immediate: boolean) => {
      if (timer.current) {
        if (!immediate) return;
        clearTimeout(timer.current);
      }
      timer.current = setTimeout(
        () => {
          timer.current = null;
          void client.invalidateQueries({ queryKey: ROOT_KEY });
        },
        immediate ? 0 : COALESCE_MS
      );
    },
    [client]
  );
  useEffect(
    () => () => {
      if (timer.current) clearTimeout(timer.current);
    },
    []
  );
  const stream = useEventStream(() => refresh(false), () => refresh(true), factory);
  const value = useMemo(() => stream, [stream]);
  return <StreamContext.Provider value={value}>{children}</StreamContext.Provider>;
}

// Auth, not-found and contract violations are deterministic: retrying only delays the honest answer.
const retry = (count: number, error: unknown) =>
  !(error instanceof AuthRequiredError) && !(error instanceof SchemaError) && !(error instanceof NotFoundError) && count < 2;
// Agent staleness, SLA breaches and lease expiry change with wall-clock time and emit no event, so an
// otherwise-quiet console would show them indefinitely. A bounded refetch keeps them honest.
const TIME_DERIVED_REFRESH_MS = 60_000;
const shared = { staleTime: Infinity, refetchOnWindowFocus: true, refetchInterval: TIME_DERIVED_REFRESH_MS, retry } as const;

export const useOverview = () => useQuery({ queryKey: OVERVIEW_KEY, queryFn: ({ signal }) => fetchOverview(fetch, signal), ...shared });
export const useQueue = () => useQuery({ queryKey: QUEUE_KEY, queryFn: ({ signal }) => fetchQueue(fetch, signal), ...shared });
export const useTrace = (id: string) => useQuery({ queryKey: traceKey(id), queryFn: ({ signal }) => fetchTrace(id, fetch, signal), ...shared });
export const useApprovals = () => useQuery({ queryKey: [...ROOT_KEY, "approvals"], queryFn: ({ signal }) => fetchApprovals(fetch, signal), ...shared });
export const useExecution = () => useQuery({ queryKey: [...ROOT_KEY, "execution"], queryFn: ({ signal }) => fetchExecution(fetch, signal), ...shared });
export const useAgents = () => useQuery({ queryKey: [...ROOT_KEY, "agents"], queryFn: ({ signal }) => fetchAgents(fetch, signal), ...shared });
export const useAgent = (id: string) => useQuery({ queryKey: [...ROOT_KEY, "agent", id], queryFn: ({ signal }) => fetchAgent(id, fetch, signal), ...shared });
export const useExecutors = () => useQuery({ queryKey: [...ROOT_KEY, "executors"], queryFn: ({ signal }) => fetchExecutors(fetch, signal), ...shared });
export const useExecutor = (id: string) => useQuery({ queryKey: [...ROOT_KEY, "executor", id], queryFn: ({ signal }) => fetchExecutor(id, fetch, signal), ...shared });
export const useConnectors = () => useQuery({ queryKey: [...ROOT_KEY, "connectors"], queryFn: ({ signal }) => fetchConnectors(fetch, signal), ...shared });
export const useConnector = (id: string) => useQuery({ queryKey: [...ROOT_KEY, "connector", id], queryFn: ({ signal }) => fetchConnector(id, fetch, signal), ...shared });
// Keep the previous results on screen while a new filter loads, so typing never blanks the page.
export const useAudit = (filters: AuditFilters) => useQuery({ queryKey: [...ROOT_KEY, "audit", filters], queryFn: ({ signal }) => fetchAudit(filters, fetch, signal), placeholderData: keepPreviousData, ...shared });
