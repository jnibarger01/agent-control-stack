import { Route, Routes } from "react-router";
import { AuthRequiredError, SchemaError } from "./data/api";
import { useLiveOverview } from "./data/live";
import type { EventSourceFactory } from "./data/stream";
import { Skeleton, Unavailable } from "./design/primitives";
import { CommandPage } from "./features/command/CommandPage";
import { Shell } from "./shell/Shell";
import { clockTime } from "./design/format";

function Failure({ error }: { error: unknown }) {
  if (error instanceof AuthRequiredError) {
    return (
      <div role="alert" className="mx-auto max-w-lg rounded-card border border-line bg-surface p-8 text-center">
        <h2 className="text-lg font-semibold">Sign in required</h2>
        <p className="mt-2 text-sm text-muted">Your session is missing or expired. Sign in through the console, then return to this page.</p>
        <a href="/" className="mt-4 inline-block rounded-ctl bg-accent px-4 py-2 text-sm font-medium text-accent-ink">Open the console to sign in</a>
      </div>
    );
  }
  return <Unavailable what="Mission Control data" reason={error instanceof SchemaError ? `contract: ${error.reason}` : "request failed"} />;
}

export function App({ streamFactory }: { streamFactory?: EventSourceFactory }) {
  const { query, stream } = useLiveOverview(streamFactory);
  const data = query.data;
  const subtitle = data ? `Updated ${clockTime(data.generatedAt)}${stream === "stale" ? " · stale" : ""}` : "Loading from ACS…";
  return (
    <Shell overview={data} stream={stream} title="Command" subtitle={subtitle}>
      {query.isPending ? (
        <div className="space-y-4" aria-busy="true" aria-label="Loading overview">
          <Skeleton className="h-24" />
          <Skeleton className="h-72" />
          <Skeleton className="h-48" />
        </div>
      ) : query.isError && !data ? (
        <Failure error={query.error} />
      ) : data ? (
        <Routes>
          <Route path="*" element={<CommandPage data={data} stale={stream === "stale" || query.isError} />} />
        </Routes>
      ) : null}
    </Shell>
  );
}
