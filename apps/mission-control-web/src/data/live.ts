import { useCallback, useEffect, useRef } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { AuthRequiredError, SchemaError, fetchOverview } from "./api";
import { useEventStream, type EventSourceFactory, type StreamState } from "./stream";

export const OVERVIEW_KEY = ["mission-control", "overview"] as const;
const COALESCE_MS = 750;

/**
 * Overview data driven by the existing SSE stream. Events never mutate state
 * directly: they invalidate the query (coalesced to one refetch per window), so
 * the server remains the only source of truth. No polling loop is added.
 */
export function useLiveOverview(factory?: EventSourceFactory) {
  const client = useQueryClient();
  const query = useQuery({
    queryKey: OVERVIEW_KEY,
    queryFn: ({ signal }) => fetchOverview(fetch, signal),
    staleTime: Infinity,
    refetchOnWindowFocus: true,
    // Auth and contract violations are deterministic: retrying only delays the honest answer.
    retry: (count, error) => !(error instanceof AuthRequiredError) && !(error instanceof SchemaError) && count < 2
  });
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const refresh = useCallback(
    (immediate = false) => {
      if (timer.current) {
        if (!immediate) return;
        clearTimeout(timer.current);
      }
      timer.current = setTimeout(
        () => {
          timer.current = null;
          void client.invalidateQueries({ queryKey: OVERVIEW_KEY });
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
  const stream: StreamState = useEventStream(() => refresh(), () => refresh(true), factory);
  return { query, stream, refresh: () => refresh(true) };
}
