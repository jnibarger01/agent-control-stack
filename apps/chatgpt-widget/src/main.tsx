import { useEffect, useMemo, useState } from "react";
import { createRoot } from "react-dom/client";
import "./styles.css";

type JsonRpcMessage = {
  jsonrpc?: "2.0";
  id?: number;
  method?: string;
  params?: unknown;
  result?: unknown;
  error?: { message?: string };
};

type Execution = {
  id: string;
  title: string;
  status: string;
  risk: string;
  updatedAt: string;
};

type DashboardData = {
  health: { status: "healthy" | "degraded" | "unhealthy"; checks: number; failingChecks: number };
  activeExecutions: number;
  blockedExecutions: number;
  pendingApprovals: number;
  findings: { total: number; blocked: number; failed: number; quarantined: number };
  recentExecutions: Execution[];
};

type ExecutionDetail = {
  execution: Execution & { intent: string; requestedActions: string[]; resultSummary?: string };
  findings: string[];
  events: Array<{ name: string; time: string }>;
};

class McpAppsBridge {
  private nextId = 1;
  private pending = new Map<number, { resolve: (value: unknown) => void; reject: (error: Error) => void }>();
  private handlers = new Set<(message: JsonRpcMessage) => void>();

  constructor() {
    window.addEventListener("message", (event) => {
      if (event.source !== window.parent || !event.data || event.data.jsonrpc !== "2.0") return;
      const message = event.data as JsonRpcMessage;
      if (typeof message.id === "number" && this.pending.has(message.id)) {
        const pending = this.pending.get(message.id)!;
        this.pending.delete(message.id);
        if (message.error) pending.reject(new Error(message.error.message ?? "MCP Apps request failed"));
        else pending.resolve(message.result);
        return;
      }
      this.handlers.forEach((handler) => handler(message));
    });
  }

  subscribe(handler: (message: JsonRpcMessage) => void): () => void {
    this.handlers.add(handler);
    return () => this.handlers.delete(handler);
  }

  request(method: string, params?: unknown): Promise<unknown> {
    const id = this.nextId++;
    window.parent.postMessage({ jsonrpc: "2.0", id, method, params }, "*");
    return new Promise((resolve, reject) => this.pending.set(id, { resolve, reject }));
  }
}

const bridge = new McpAppsBridge();

function outputFrom(message: JsonRpcMessage): DashboardData | undefined {
  if (message.method !== "ui/notifications/tool-result") return undefined;
  const result = message.params as { structuredContent?: DashboardData } | undefined;
  return result?.structuredContent;
}

function timestamp(value: string): string {
  return new Date(value).toLocaleString(undefined, { dateStyle: "medium", timeStyle: "short" });
}

function statusLabel(status: string): string {
  return status.replaceAll("_", " ");
}

function App() {
  const [dashboard, setDashboard] = useState<DashboardData>();
  const [detail, setDetail] = useState<ExecutionDetail>();
  const [selectedId, setSelectedId] = useState<string>();
  const [error, setError] = useState<string>();

  useEffect(() =>
    bridge.subscribe((message) => {
      const next = outputFrom(message);
      if (next) setDashboard(next);
    }), []);

  const selected = useMemo(
    () => dashboard?.recentExecutions.find((execution) => execution.id === selectedId),
    [dashboard, selectedId]
  );

  async function inspect(id: string) {
    setSelectedId(id);
    setError(undefined);
    try {
      const response = (await bridge.request("tools/call", {
        name: "get_execution_detail",
        arguments: { id }
      })) as { structuredContent?: ExecutionDetail };
      setDetail(response.structuredContent);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Unable to retrieve execution detail.");
    }
  }

  async function explain(id: string) {
    setError(undefined);
    try {
      await bridge.request("ui/message", {
        role: "user",
        content: [{ type: "text", text: `Explain why ACS execution ${id} is ${selected?.status ?? "in its current state"}.` }]
      });
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Unable to request an explanation.");
    }
  }

  if (!dashboard) {
    return <main className="loading" aria-live="polite">Loading ACS Control Center…</main>;
  }

  const healthClass = dashboard.health.status;
  return <main className="control-center">
    <section className="overview" aria-label="ACS overview">
      <header className="header">
        <div><h1>ACS Control Center</h1><p>Read-only operational view</p></div>
        <span className={`health ${healthClass}`}>{dashboard.health.status}</span>
      </header>
      <div className="metrics">
        <Metric label="Active executions" value={dashboard.activeExecutions} />
        <Metric label="Blocked" value={dashboard.blockedExecutions} tone="danger" />
        <Metric label="Pending approvals" value={dashboard.pendingApprovals} tone="warning" />
        <Metric label="Findings" value={dashboard.findings.total} tone={dashboard.findings.total ? "warning" : "success"} />
      </div>
      <section className="table-section">
        <div className="section-heading"><h2>Recent executions</h2><span>{dashboard.recentExecutions.length} shown</span></div>
        <div className="table-wrap"><table><thead><tr><th>Execution</th><th>Status</th><th>Risk</th><th>Updated</th><th><span className="visually-hidden">Actions</span></th></tr></thead>
          <tbody>{dashboard.recentExecutions.map((execution) => <tr key={execution.id} className={selectedId === execution.id ? "selected" : ""}>
            <td><strong>{execution.title}</strong><small>{execution.id}</small></td>
            <td><Status value={execution.status} /></td><td><span className="risk">{execution.risk}</span></td><td>{timestamp(execution.updatedAt)}</td>
            <td><button type="button" onClick={() => void inspect(execution.id)}>Inspect</button></td>
          </tr>)}</tbody>
        </table></div>
      </section>
    </section>
    <aside className="detail" aria-live="polite">
      <h2>Execution detail</h2>
      {error && <p className="error" role="alert">{error}</p>}
      {!detail && <p className="empty">Select an execution to inspect its authoritative ACS record.</p>}
      {detail && <><dl><div><dt>ID</dt><dd>{detail.execution.id}</dd></div><div><dt>Status</dt><dd><Status value={detail.execution.status} /></dd></div><div><dt>Risk</dt><dd>{detail.execution.risk}</dd></div></dl>
        <h3>Summary</h3><p>{detail.execution.intent}</p>
        <h3>Findings</h3>{detail.findings.length ? <ul>{detail.findings.map((finding) => <li key={finding}>{finding}</li>)}</ul> : <p className="empty">No operational findings.</p>}
        <h3>Recent events</h3>{detail.events.length ? <ol>{detail.events.map((event) => <li key={`${event.time}-${event.name}`}><strong>{event.name}</strong><small>{timestamp(event.time)}</small></li>)}</ol> : <p className="empty">No recent audit events.</p>}
        <div className="actions"><button type="button" onClick={() => void inspect(detail.execution.id)}>Inspect run</button><button type="button" className="secondary" onClick={() => void explain(detail.execution.id)}>Ask ChatGPT to explain</button></div>
      </>}
    </aside>
  </main>;
}

function Metric({ label, value, tone }: { label: string; value: number; tone?: string }) {
  return <article className={`metric ${tone ?? ""}`}><span>{label}</span><strong>{value}</strong></article>;
}

function Status({ value }: { value: string }) {
  return <span className={`status ${value}`}>{statusLabel(value)}</span>;
}

createRoot(document.getElementById("root")!).render(<App />);
