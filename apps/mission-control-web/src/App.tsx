import { Route, Routes, useLocation, useParams } from "react-router";
import { LiveProvider, useOverview, useQueue, useStreamState, useTrace } from "./data/live";
import type { EventSourceFactory } from "./data/stream";
import { clockTime } from "./design/format";
import { EmptyState } from "./design/primitives";
import { QueryBoundary } from "./design/QueryBoundary";
import { CommandPage } from "./features/command/CommandPage";
import { QueuePage } from "./features/queue/QueuePage";
import { TracePage } from "./features/trace/TracePage";
import { Shell } from "./shell/Shell";

function CommandRoute() {
  const query = useOverview();
  const stream = useStreamState();
  return <QueryBoundary query={query} what="Mission Control data">{(data) => <CommandPage data={data} stale={stream === "stale" || query.isError} />}</QueryBoundary>;
}
function QueueRoute() {
  const query = useQueue();
  return <QueryBoundary query={query} what="Work queue">{(data) => <QueuePage data={data} />}</QueryBoundary>;
}
function TraceRoute() {
  const { id = "" } = useParams();
  const query = useTrace(id);
  return <QueryBoundary query={query} what="Work item">{(data) => <TracePage data={data} />}</QueryBoundary>;
}

function titleFor(pathname: string): string {
  if (pathname.startsWith("/queue/")) return "Execution trace";
  if (pathname.startsWith("/queue")) return "Work Queue";
  if (pathname === "/") return "Command";
  return "Not found";
}

function Frame() {
  const overview = useOverview();
  const stream = useStreamState();
  const { pathname } = useLocation();
  const data = overview.data;
  const subtitle = data ? `Updated ${clockTime(data.generatedAt)}${stream === "stale" ? " · stale" : ""}` : "Loading from ACS…";
  return (
    <Shell overview={data} stream={stream} title={titleFor(pathname)} subtitle={subtitle}>
      <Routes>
        <Route path="/" element={<CommandRoute />} />
        <Route path="/queue" element={<QueueRoute />} />
        <Route path="/queue/:id" element={<TraceRoute />} />
        <Route path="*" element={<EmptyState title="Page not found">Use the navigation to pick a page.</EmptyState>} />
      </Routes>
    </Shell>
  );
}

export function App({ streamFactory }: { streamFactory?: EventSourceFactory }) {
  return (
    <LiveProvider factory={streamFactory}>
      <Frame />
    </LiveProvider>
  );
}
