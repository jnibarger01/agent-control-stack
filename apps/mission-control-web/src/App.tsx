import { Route, Routes, useLocation, useParams } from "react-router";
import { LiveProvider, useAudit, useAgent, useAgents, useApprovals, useConnector, useConnectors, useExecution, useExecutor, useExecutors, useOverview, useQueue, useStreamState, useTrace } from "./data/live";
import type { EventSourceFactory } from "./data/stream";
import { clockTime } from "./design/format";
import { EmptyState } from "./design/primitives";
import { QueryBoundary } from "./design/QueryBoundary";
import { CommandPage } from "./features/command/CommandPage";
import { ApprovalsPage } from "./features/approvals/ApprovalsPage";
import { ExecutionPage } from "./features/execution/ExecutionPage";
import { AgentDetailPage, AgentsPage, ConnectorDetailPage, ConnectorsPage, ExecutorDetailPage, ExecutorsPage } from "./features/registry/pages";
import { AuditPage } from "./features/audit/AuditPage";
import { MetricsPage } from "./features/metrics/MetricsPage";
import { PolicyPage } from "./features/policy/PolicyPage";
import { SystemPage } from "./features/system/SystemPage";
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
function ApprovalsRoute() {
  const query = useApprovals();
  return <QueryBoundary query={query} what="Approvals">{(data) => <ApprovalsPage data={data} />}</QueryBoundary>;
}
function ExecutionRoute() {
  const query = useExecution();
  return <QueryBoundary query={query} what="Execution">{(data) => <ExecutionPage data={data} />}</QueryBoundary>;
}
function AgentsRoute() {
  const query = useAgents();
  return <QueryBoundary query={query} what="Agents">{(agents) => <AgentsPage agents={agents} />}</QueryBoundary>;
}
function AgentRoute() {
  const { id = "" } = useParams();
  const query = useAgent(id);
  return <QueryBoundary query={query} what="Agent">{(data) => <AgentDetailPage data={data} />}</QueryBoundary>;
}
function ExecutorsRoute() {
  const query = useExecutors();
  return <QueryBoundary query={query} what="Executors">{(executors) => <ExecutorsPage executors={executors} />}</QueryBoundary>;
}
function ExecutorRoute() {
  const { id = "" } = useParams();
  const query = useExecutor(id);
  return <QueryBoundary query={query} what="Executor">{(data) => <ExecutorDetailPage data={data} />}</QueryBoundary>;
}
function ConnectorsRoute() {
  const query = useConnectors();
  return <QueryBoundary query={query} what="Connectors">{(connectors) => <ConnectorsPage connectors={connectors} />}</QueryBoundary>;
}
function ConnectorRoute() {
  const { id = "" } = useParams();
  const query = useConnector(id);
  return <QueryBoundary query={query} what="Connector">{(data) => <ConnectorDetailPage data={data} />}</QueryBoundary>;
}
function MetricsRoute() {
  const query = useOverview();
  return <QueryBoundary query={query} what="Metrics">{(data) => <MetricsPage data={data} />}</QueryBoundary>;
}
function SystemRoute() {
  const query = useOverview();
  return <QueryBoundary query={query} what="System status">{(data) => <SystemPage data={data} />}</QueryBoundary>;
}
function PolicyRoute() {
  const query = useAudit({ name: "policy.decided", limit: 200 });
  return <QueryBoundary query={query} what="Policy decisions">{(data) => <PolicyPage events={data.events} />}</QueryBoundary>;
}
function TraceRoute() {
  const { id = "" } = useParams();
  const query = useTrace(id);
  return <QueryBoundary query={query} what="Work item">{(data) => <TracePage data={data} />}</QueryBoundary>;
}

function titleFor(pathname: string): string {
  if (pathname.startsWith("/queue/")) return "Execution trace";
  if (pathname.startsWith("/queue")) return "Work Queue";
  if (pathname.startsWith("/approvals")) return "Approvals";
  if (pathname.startsWith("/execution")) return "Execution";
  if (pathname.startsWith("/metrics")) return "Metrics";
  if (pathname.startsWith("/audit")) return "Audit";
  if (pathname.startsWith("/policy")) return "Policy";
  if (pathname.startsWith("/system")) return "System";
  if (pathname.startsWith("/agents/")) return "Agent";
  if (pathname.startsWith("/agents")) return "Agents";
  if (pathname.startsWith("/executors/")) return "Executor";
  if (pathname.startsWith("/executors")) return "Executors";
  if (pathname.startsWith("/connectors/")) return "Connector";
  if (pathname.startsWith("/connectors")) return "Connectors";
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
        <Route path="/approvals" element={<ApprovalsRoute />} />
        <Route path="/execution" element={<ExecutionRoute />} />
        <Route path="/metrics" element={<MetricsRoute />} />
        <Route path="/audit" element={<AuditPage />} />
        <Route path="/policy" element={<PolicyRoute />} />
        <Route path="/system" element={<SystemRoute />} />
        <Route path="/agents" element={<AgentsRoute />} />
        <Route path="/agents/:id" element={<AgentRoute />} />
        <Route path="/executors" element={<ExecutorsRoute />} />
        <Route path="/executors/:id" element={<ExecutorRoute />} />
        <Route path="/connectors" element={<ConnectorsRoute />} />
        <Route path="/connectors/:id" element={<ConnectorRoute />} />
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
