import { createContext, useCallback, useContext, useEffect, useMemo, useRef, type ReactNode } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { AuthRequiredError, NotFoundError, SchemaError, fetchApprovals, fetchExecution, fetchOverview, fetchQueue, fetchTrace } from "./api";
import { useEventStream, type EventSourceFactory, type StreamState } from "./stream";

export const ROOT_KEY = ["mission-control"] as const;
export const OVERVIEW_KEY = [...ROOT_KEY, "overview"] as const;
export const QUEUE_KEY = [...ROOT_KEY, "queue"] as const;
export const traceKey = (id: string) => [...ROOT_KEY, "trace", id] as const;
const COALESCE_MS = 750;

const StreamContext = createContext<StreamState>("connecting");
export const useStreamState = () => useContext(StreamContext);

/**
 * One SSE connection for the whole app. Events never mutate state directly: they
 * invalidate every mission-control query (coalesced to one refetch window), so
 * the server stays the only source of truth. No polling loop is added.
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
const shared = { staleTime: Infinity, refetchOnWindowFocus: true, retry } as const;

export const useOverview = () => useQuery({ queryKey: OVERVIEW_KEY, queryFn: ({ signal }) => fetchOverview(fetch, signal), ...shared });
export const useQueue = () => useQuery({ queryKey: QUEUE_KEY, queryFn: ({ signal }) => fetchQueue(fetch, signal), ...shared });
export const useTrace = (id: string) => useQuery({ queryKey: traceKey(id), queryFn: ({ signal }) => fetchTrace(id, fetch, signal), ...shared });
export const useApprovals = () => useQuery({ queryKey: [...ROOT_KEY, "approvals"], queryFn: ({ signal }) => fetchApprovals(fetch, signal), ...shared });
export const useExecution = () => useQuery({ queryKey: [...ROOT_KEY, "execution"], queryFn: ({ signal }) => fetchExecution(fetch, signal), ...shared });
