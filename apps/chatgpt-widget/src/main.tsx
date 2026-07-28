import { useEffect, useState } from "react";
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
type Detail = { execution: Run & { intent: string }; findings: string[]; events: { name: string; time: string }[] };
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
        const p = this.pending.get(rpc.id)!;
        this.pending.delete(rpc.id);
        if (rpc.error) p.reject(new Error(rpc.error.message ?? "Bridge request failed"));
        else p.resolve(rpc.result);
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
const when = (v: string) => new Date(v).toLocaleString();
function App() {
  const [dashboard, setDashboard] = useState<Dashboard>();
  const [detail, setDetail] = useState<Detail>();
  const [error, setError] = useState<string>();
  useEffect(
    () =>
      bridge.on((rpc) => {
        if (rpc.method === "ui/notifications/tool-result" && rpc.params?.structuredContent?.recentExecutions)
          setDashboard(rpc.params.structuredContent);
      }),
    []
  );
  const inspect = async (id: string) => {
    try {
      setError(undefined);
      const result = (await bridge.call("tools/call", { name: "get_execution_detail", arguments: { id } })) as {
        structuredContent?: Detail;
      };
      setDetail(result.structuredContent);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Unable to load detail.");
    }
  };
  const explain = async () => {
    if (detail)
      await bridge.call("ui/message", {
        role: "user",
        content: [{ type: "text", text: `Explain ACS execution ${detail.execution.id}.` }]
      });
  };
  if (!dashboard) return <main className="loading">Loading ACS Control Center…</main>;
  return (
    <main className="app">
      <section>
        <header>
          <div>
            <h1>ACS Control Center</h1>
            <p>Read-only operational view</p>
          </div>
          <b className={`health ${dashboard.health.status}`}>{dashboard.health.status}</b>
        </header>
        <div className="metrics">
          {[
            ["Active executions", dashboard.activeExecutions, ""],
            ["Blocked", dashboard.blockedExecutions, "danger"],
            ["Pending approvals", dashboard.pendingApprovals, "warn"],
            ["Findings", dashboard.findings.total, "warn"]
          ].map(([label, value, tone]) => (
            <article className={String(tone)} key={String(label)}>
              <span>{label}</span>
              <strong>{value}</strong>
            </article>
          ))}
        </div>
        <h2>Recent executions</h2>
        <div className="table">
          <table>
            <thead>
              <tr>
                <th>Execution</th>
                <th>Status</th>
                <th>Risk</th>
                <th>Updated</th>
                <th />
              </tr>
            </thead>
            <tbody>
              {dashboard.recentExecutions.map((run) => (
                <tr key={run.id}>
                  <td>
                    <strong>{run.title}</strong>
                    <small>{run.id}</small>
                  </td>
                  <td>
                    <i className={run.status}>{run.status.replaceAll("_", " ")}</i>
                  </td>
                  <td>{run.risk}</td>
                  <td>{when(run.updatedAt)}</td>
                  <td>
                    <button onClick={() => void inspect(run.id)}>Inspect</button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </section>
      <aside>
        <h2>Execution detail</h2>
        {error && <p className="error">{error}</p>}
        {detail ? (
          <>
            <dl>
              <dt>ID</dt>
              <dd>{detail.execution.id}</dd>
              <dt>Status</dt>
              <dd>{detail.execution.status}</dd>
              <dt>Risk</dt>
              <dd>{detail.execution.risk}</dd>
            </dl>
            <h3>Summary</h3>
            <p>{detail.execution.intent}</p>
            <h3>Findings</h3>
            <ul>
              {detail.findings.map((f) => (
                <li key={f}>{f}</li>
              ))}
            </ul>
            <h3>Recent events</h3>
            <ul>
              {detail.events.map((e) => (
                <li key={e.name + e.time}>
                  {e.name}
                  <small>{when(e.time)}</small>
                </li>
              ))}
            </ul>
            <button onClick={() => void inspect(detail.execution.id)}>Inspect run</button>
            <button onClick={() => void explain()}>Ask ChatGPT to explain</button>
          </>
        ) : (
          <p>Select an execution to inspect its authoritative ACS record.</p>
        )}
      </aside>
    </main>
  );
}
createRoot(document.getElementById("root")!).render(<App />);
