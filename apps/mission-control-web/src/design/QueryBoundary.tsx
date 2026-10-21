import type { ReactNode } from "react";
import { AuthRequiredError, NotFoundError, SchemaError } from "../data/api";
import { EmptyState, Skeleton, Unavailable } from "./primitives";

export function Failure({ error, what = "Mission Control data" }: { error: unknown; what?: string }) {
  if (error instanceof AuthRequiredError) {
    return (
      <div role="alert" className="mx-auto max-w-lg rounded-card border border-line bg-surface p-8 text-center">
        <h2 className="text-lg font-semibold">Sign in required</h2>
        <p className="mt-2 text-sm text-muted">Your session is missing or expired. Sign in through the console, then return to this page.</p>
        <a href="/?next=%2Fnext%2F" className="mt-4 inline-block rounded-ctl bg-accent px-4 py-2 text-sm font-medium text-accent-ink">Open the console to sign in</a>
      </div>
    );
  }
  if (error instanceof NotFoundError) return <EmptyState title={`${what} not found`}>It may have been removed, or the link is wrong.</EmptyState>;
  return <Unavailable what={what} reason={error instanceof SchemaError ? `contract: ${error.reason}` : "request failed"} />;
}

/** Skeleton while loading, honest failure when there is nothing to show, last data kept when only a refetch fails. */
export interface QueryLike<T> {
  data: T | undefined;
  isPending: boolean;
  error: unknown;
}

/**
 * Every route renders through here, so a failed refetch over cached data is surfaced in one place: the last data
 * stays on screen, but with a warning, because a healthy SSE connection alone keeps the shell saying "Live".
 */
export function QueryBoundary<T>({ query, what, children }: { query: QueryLike<T>; what: string; children: (data: T) => ReactNode }) {
  if (query.data !== undefined) {
    if (query.error == null) return <>{children(query.data)}</>;
    return (
      <div className="space-y-6">
        <p role="alert" className="rounded-card border border-warn/50 bg-surface px-4 py-3 text-sm text-warn">
          {what} may be out of date. The latest refresh failed, so this shows the last data received.
        </p>
        {children(query.data)}
      </div>
    );
  }
  if (query.isPending) {
    return (
      <div className="space-y-4" aria-busy="true" aria-label={`Loading ${what}`}>
        <Skeleton className="h-24" />
        <Skeleton className="h-72" />
      </div>
    );
  }
  return <Failure error={query.error} what={what} />;
}
