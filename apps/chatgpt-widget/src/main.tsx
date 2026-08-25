import React, { useEffect, useState, type ReactNode } from "react";
import { createRoot } from "react-dom/client";
import "./styles.css";

type Run = { id: string; title: string; status: string; risk: string; updatedAt: string };
type Dashboard = {
  health: { status: string };
  activeExecutions: number;
  blockedExecutions: number;
  pendingApprovals: number;
  findings: { total: number };
  recentExecutions: Run[];
};
type Detail = {
  execution: Run & { intent: string; requestedActions?: string[] };
  findings: string[];
  events: { name: string; time: string }[];
};
type Rpc = {
  id?: number;
  method?: string;
  params?: { structuredContent?: Dashboard };
  result?: { structuredContent?: Detail };
  error?: { message?: string };
};

class Bridge {
  id = 0;
  pending = new Map<number, { resolve: (value: unknown) => void; reject: (reason: Error) => void }>();
  listeners = new Set<(rpc: Rpc) => void>();
  constructor() {
    window.addEventListener("message", (event) => {
      if (event.source !== window.parent || event.data?.jsonrpc !== "2.0") return;
      const rpc = event.data as Rpc;
      if (rpc.id && this.pending.has(rpc.id)) {
        const pending = this.pending.get(rpc.id)!;
        this.pending.delete(rpc.id);
        if (rpc.error) pending.reject(new Error(rpc.error.message ?? "Bridge request failed"));
        else pending.resolve(rpc.result);
        return;
      }
      this.listeners.forEach((listener) => listener(rpc));
    });
  }
  on(listener: (rpc: Rpc) => void) {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }
  call(method: string, params?: unknown) {
    const id = ++this.id;
    window.parent.postMessage({ jsonrpc: "2.0", id, method, params }, "*");
    return new Promise<unknown>((resolve, reject) => this.pending.set(id, { resolve, reject }));
  }
}

const bridge = new Bridge();
const when = (value: string) => new Date(value).toLocaleString(undefined, { dateStyle: "medium", timeStyle: "short" });
const title = (value: string) => value.replaceAll("_", " ");

function Icon({
  name,
  size = 16
}: {
  name: "shield" | "pulse" | "ban" | "clock" | "search" | "message" | "arrow";
  size?: number;
}) {
  const paths: Record<typeof name, ReactNode> = {
    shield: <path d="m12 2 7 3.5V11c0 5-3.4 9.4-7 11-3.6-1.6-7-6-7-11V5.5L12 2Zm-3 10 2 2 4-4" />,
    pulse: <path d="M3 12h4l2.2-6 3.1 12 2.2-6H21" />,
    ban: (
      <>
        <circle cx="12" cy="12" r="9" />
        <path d="m8 8 8 8" />
      </>
    ),
    clock: (
      <>
        <circle cx="12" cy="12" r="9" />
        <path d="M12 7v5l3 2" />
      </>
    ),
    search: (
      <>
        <circle cx="11" cy="11" r="6" />
        <path d="m16 16 4 4" />
      </>
    ),
    message: (
      <>
        <path d="M20 11.5a7.5 7.5 0 0 1-8 7.5 8.6 8.6 0 0 1-3.6-.8L4 20l1.3-3.5A7.3 7.3 0 0 1 4 12a7.5 7.5 0 0 1 8-7.5 7.5 7.5 0 0 1 8 7Z" />
        <path d="M8 12h.01M12 12h.01M16 12h.01" />
      </>
    ),
    arrow: <path d="M5 12h14m-5-5 5 5-5 5" />
  };
  return (
    <svg
      aria-hidden="true"
      className="icon"
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.8"
      strokeLinecap="round"
      strokeLinejoin="round"
    >
      {paths[name]}
    </svg>
  );
}

function Metric({
  label,
  value,
  tone,
  icon
}: {
  label: string;
  value: number;
  tone: string;
  icon: Parameters<typeof Icon>[0]["name"];
}) {
  return (
    <article className={`metric metric-${tone}`}>
      <span className="metric-icon">
        <Icon name={icon} size={18} />
      </span>
      <div>
        <span className="metric-label">{label}</span>
        <strong>{value}</strong>
      </div>
      <span className="metric-spark" aria-hidden="true">
        <i />
        <i />
        <i />
        <i />
        <i />
        <i />
        <i />
      </span>
    </article>
  );
}

function Status({ value }: { value: string }) {
  return (
    <span className={`status status-${value}`}>
      <i />
      {title(value)}
    </span>
  );
}

function App() {
  const [dashboard, setDashboard] = useState<Dashboard>();
  const [detail, setDetail] = useState<Detail>();
  const [selectedId, setSelectedId] = useState<string>();
  const [error, setError] = useState<string>();
  const [loadingDetail, setLoadingDetail] = useState(false);

  useEffect(
    () =>
      bridge.on((rpc) => {
        if (rpc.method === "ui/notifications/tool-result" && rpc.params?.structuredContent?.recentExecutions) {
          setDashboard(rpc.params.structuredContent);
        }
      }),
    []
  );

  const inspect = async (id: string) => {
    try {
      setError(undefined);
      setLoadingDetail(true);
      setSelectedId(id);
      const result = (await bridge.call("tools/call", { name: "get_execution_detail", arguments: { id } })) as {
        structuredContent?: Detail;
      };
      setDetail(result.structuredContent);
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : "Unable to load authoritative execution detail.");
    } finally {
      setLoadingDetail(false);
    }
  };

  const explain = async () => {
    if (!detail) return;
    await bridge.call("ui/message", {
      role: "user",
      content: [{ type: "text", text: `Explain ACS execution ${detail.execution.id}.` }]
    });
  };

  if (!dashboard)
    return (
      <main className="loading">
        <Icon name="pulse" size={20} /> Loading ACS Control Center…
      </main>
    );

  return (
    <main className="console-shell">
      <header className="top-rail">
        <div className="brand">
          <span className="brand-mark">
            <Icon name="shield" size={18} />
          </span>
          <div>
            <h1>ACS Control Center</h1>
            <p>
              <i />
              All systems {dashboard.health.status}
            </p>
          </div>
        </div>
        <div className="rail-status">
          <span>
            <Icon name="pulse" />
            API health <b>{dashboard.health.status}</b>
          </span>
          <span>
            <Icon name="clock" />
            Read-only view
          </span>
        </div>
        <button
          className="rail-action"
          onClick={() => selectedId && void inspect(selectedId)}
          disabled={!selectedId || loadingDetail}
        >
          <Icon name="search" />
          Inspect
        </button>
      </header>

      <section className="metric-grid" aria-label="Operational metrics">
        <Metric label="Active executions" value={dashboard.activeExecutions} tone="blue" icon="pulse" />
        <Metric label="Blocked" value={dashboard.blockedExecutions} tone="red" icon="ban" />
        <Metric label="Pending approvals" value={dashboard.pendingApprovals} tone="amber" icon="clock" />
        <Metric label="Findings" value={dashboard.findings.total} tone="green" icon="shield" />
      </section>

      <section className="workbench">
        <section className="panel execution-panel">
          <header className="panel-heading">
            <div>
              <h2>Recent executions</h2>
              <p>
                <i />
                Live ACS state
              </p>
            </div>
            <span className="range">Last 24 hours</span>
          </header>
          <div className="table-wrap">
            <table>
              <thead>
                <tr>
                  <th>Execution</th>
                  <th>Status</th>
                  <th>Risk</th>
                  <th>Updated</th>
                  <th aria-label="Inspect" />
                </tr>
              </thead>
              <tbody>
                {dashboard.recentExecutions.length ? (
                  dashboard.recentExecutions.map((run) => (
                    <tr
                      className={selectedId === run.id ? "selected" : ""}
                      key={run.id}
                      onClick={() => void inspect(run.id)}
                    >
                      <td>
                        <strong>{run.title}</strong>
                        <small>{run.id}</small>
                      </td>
                      <td>
                        <Status value={run.status} />
                      </td>
                      <td>
                        <span className="risk">{run.risk}</span>
                      </td>
                      <td>{when(run.updatedAt)}</td>
                      <td>
                        <button
                          className="row-action"
                          onClick={(event) => {
                            event.stopPropagation();
                            void inspect(run.id);
                          }}
                        >
                          <Icon name="arrow" />
                        </button>
                      </td>
                    </tr>
                  ))
                ) : (
                  <tr>
                    <td colSpan={5} className="empty">
                      <Icon name="pulse" />
                      No executions are available for this ACS view.
                    </td>
                  </tr>
                )}
              </tbody>
            </table>
          </div>
          <footer className="panel-footer">
            Showing {dashboard.recentExecutions.length} most recently updated execution
            {dashboard.recentExecutions.length === 1 ? "" : "s"}.<span>Authoritative ACS store</span>
          </footer>
        </section>

        <aside className="panel inspector" aria-live="polite">
          <header className="panel-heading">
            <div>
              <h2>Execution detail</h2>
              <p>
                <i />
                {detail ? "Selected record" : "Awaiting selection"}
              </p>
            </div>
            {detail && <Status value={detail.execution.status} />}
          </header>
          {error && <p className="error">{error}</p>}
          {loadingDetail ? (
            <div className="inspector-empty">
              <Icon name="pulse" size={22} />
              Loading authoritative detail…
            </div>
          ) : detail ? (
            <>
              <div className="id-row">
                <span>Execution ID</span>
                <code>{detail.execution.id}</code>
              </div>
              <dl className="detail-grid">
                <div>
                  <dt>Risk</dt>
                  <dd>
                    <span className="risk">{detail.execution.risk}</span>
                  </dd>
                </div>
                <div>
                  <dt>Updated</dt>
                  <dd>{when(detail.execution.updatedAt)}</dd>
                </div>
              </dl>
              <section className="detail-section">
                <h3>Summary</h3>
                <p>{detail.execution.intent}</p>
              </section>
              <section className="detail-section">
                <h3>
                  Operational findings <em>{detail.findings.length}</em>
                </h3>
                {detail.findings.length ? (
                  <ul className="findings">
                    {detail.findings.map((finding) => (
                      <li key={finding}>
                        <Icon name="ban" />
                        {finding}
                      </li>
                    ))}
                  </ul>
                ) : (
                  <p className="muted">No operational findings recorded.</p>
                )}
              </section>
              <section className="detail-section timeline">
                <h3>Execution timeline</h3>
                {detail.events.length ? (
                  <ol>
                    {detail.events.map((event) => (
                      <li key={event.name + event.time}>
                        <span />
                        <div>
                          <strong>{event.name}</strong>
                          <small>{when(event.time)}</small>
                        </div>
                      </li>
                    ))}
                  </ol>
                ) : (
                  <p className="muted">No audit events are available.</p>
                )}
              </section>
              <footer className="inspector-footer">
                <button className="secondary" onClick={() => void inspect(detail.execution.id)}>
                  <Icon name="search" />
                  Refresh detail
                </button>
                <button className="primary" onClick={() => void explain()}>
                  <Icon name="message" />
                  Ask ChatGPT
                </button>
              </footer>
            </>
          ) : (
            <div className="inspector-empty">
              <span className="empty-mark">
                <Icon name="search" size={22} />
              </span>
              <h3>Select an execution</h3>
              <p>Choose a row to inspect its authoritative ACS record, findings, and audit trail.</p>
            </div>
          )}
        </aside>
      </section>
    </main>
  );
}

createRoot(document.getElementById("root")!).render(<App />);
