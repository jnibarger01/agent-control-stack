import { useMemo, useState } from "react";
import type { NetworkNode, OverviewReadModel } from "@agent-control-stack/mission-control-contract";
import { Card, DataTable, EmptyState, StatusPill, Unavailable, type Tone } from "../../design/primitives";
import { relativeTime } from "../../design/format";
import { layoutNetwork, neighbourhood, NETWORK_WIDTH } from "./network-layout";

const LIVENESS: Record<string, { tone: Tone; text: string; color: string }> = {
  online: { tone: "ok", text: "Online", color: "var(--ok)" },
  stale: { tone: "warn", text: "Stale", color: "var(--warn)" },
  observed: { tone: "info", text: "Observed", color: "var(--info)" },
  offline: { tone: "bad", text: "Offline", color: "var(--bad)" },
  unknown: { tone: "unknown", text: "Unknown", color: "var(--faint)" }
};
const live = (n: NetworkNode) => LIVENESS[n.liveness ?? "unknown"] ?? LIVENESS.unknown!;

export function AgentNetwork({ data }: { data: OverviewReadModel }) {
  const [selected, setSelected] = useState<string | null>(null);
  const [hovered, setHovered] = useState<string | null>(null);
  const [view, setView] = useState<"graph" | "table">("graph");
  const [onlyBound, setOnlyBound] = useState(false);
  const { nodes, edges } = data.network;

  const visible = useMemo(() => {
    if (!onlyBound) return nodes;
    const bound = new Set(edges.flatMap((e) => [e.from, e.to]));
    return nodes.filter((n) => bound.has(n.id));
  }, [nodes, edges, onlyBound]);
  const layout = useMemo(() => layoutNetwork(visible, edges), [visible, edges]);
  const focus = hovered ?? selected;
  const near = neighbourhood(focus, edges);
  const byId = useMemo(() => new Map(nodes.map((n) => [n.id, n] as const)), [nodes]);
  const selectedNode = selected ? byId.get(selected) : undefined;
  const agentCount = nodes.filter((n) => n.kind === "agent").length;
  const bindingCount = edges.length;

  const dim = (id: string) => (near && !near.has(id) ? 0.28 : 1);

  const header = (
    <div className="flex flex-wrap items-center gap-2">
      <button type="button" onClick={() => setOnlyBound((v) => !v)} aria-pressed={onlyBound} className="rounded-ctl border border-line px-2.5 py-1 text-xs text-muted hover:text-ink aria-pressed:border-accent aria-pressed:text-ink">Bound only</button>
      <div role="group" aria-label="Network view" className="flex overflow-hidden rounded-ctl border border-line text-xs">
        {(["graph", "table"] as const).map((v) => (
          <button key={v} type="button" onClick={() => setView(v)} aria-pressed={view === v} className="px-2.5 py-1 text-muted hover:text-ink aria-pressed:bg-accent-soft aria-pressed:text-ink">{v === "graph" ? "Graph" : "Table"}</button>
        ))}
      </div>
    </div>
  );

  return (
    <Card
      id="agent-network"
      title="Agent network"
      subtitle={`${agentCount} agent${agentCount === 1 ? "" : "s"} · ${bindingCount} proven binding${bindingCount === 1 ? "" : "s"}. Links appear only where ACS holds a lease or a reported task.`}
      action={header}
    >
      {data.sections.network.status !== "ok" ? (
        <Unavailable what="Agent network" {...(data.sections.network.reason ? { reason: data.sections.network.reason } : {})} />
      ) : agentCount === 0 ? (
        <EmptyState title="No agents registered">Register an agent and send a heartbeat; it will appear here with its real liveness.</EmptyState>
      ) : (
        <div className="grid grid-cols-1 gap-4 lg:grid-cols-[minmax(0,1fr)_260px]">
          <div className="min-w-0">
            {view === "graph" ? (
              <div tabIndex={0} role="region" aria-label="Agent network graph (scrollable)" className="overflow-x-auto rounded-ctl border border-line bg-surface-2/60">
                <svg viewBox={`0 0 ${layout.width} ${layout.height}`} role="group" aria-label="Agents on the left, bound work items on the right" className="block w-full min-w-[640px]" style={{ maxHeight: 620 }}>
                  <defs>
                    <clipPath id="clip-agent"><rect x={0} y={0} width={layout.agentX - 16} height={layout.height} /></clipPath>
                    <clipPath id="clip-work"><rect x={layout.workX + 8} y={0} width={196} height={layout.height} /></clipPath>
                    <linearGradient id="edge-grad" x1="0" x2="1">
                      <stop offset="0" stopColor="var(--violet)" />
                      <stop offset="1" stopColor="var(--cyan)" />
                    </linearGradient>
                  </defs>
                  <text x={layout.agentX - 18} y={16} textAnchor="end" fontSize="11" fill="var(--faint)" className="uppercase tracking-wider">Agents</text>
                  <text x={layout.workX} y={16} fontSize="11" fill="var(--faint)" className="uppercase tracking-wider">Bound work</text>
                  {layout.edges.map(({ edge, d, midX, midY }) => {
                    const active = !near || (near.has(edge.from) && near.has(edge.to));
                    return (
                      <g key={`${edge.from}|${edge.to}`} opacity={active ? 1 : 0.12} style={{ transition: "opacity .25s" }}>
                        <path d={d} fill="none" stroke="url(#edge-grad)" strokeWidth={edge.kind === "active_lease" ? 2.4 : 1.6} strokeDasharray={edge.kind === "reported_task" ? "5 5" : undefined} />
                        {edge.fencingEpoch !== undefined && active && <text x={midX} y={midY - 6} textAnchor="middle" fontSize="10" fill="var(--muted)">epoch {edge.fencingEpoch}</text>}
                      </g>
                    );
                  })}
                  <g aria-hidden="true" pointerEvents="none">
                    {layout.agents.filter(({ node }) => node.liveness === "online").map(({ node, x, y }) => (
                      <circle key={node.id} cx={x} cy={y} r={9} fill="var(--ok)" opacity={near && !near.has(node.id) ? 0.1 : 1} className="acs-pulse" />
                    ))}
                  </g>
                  {layout.agents.map(({ node, x, y }) => {
                    const l = live(node);
                    const isUnknown = node.liveness === undefined || node.liveness === "unknown";
                    return (
                      <g
                        key={node.id}
                        role="button"
                        tabIndex={0}
                        aria-pressed={selected === node.id}
                        aria-label={`${node.label}, agent, ${l.text}${bindingFor(node.id, data) ? `, bound to ${bindingFor(node.id, data)}` : ", no active binding"}`}
                        onClick={() => setSelected(selected === node.id ? null : node.id)}
                        onKeyDown={(e) => { if (e.key === "Enter" || e.key === " ") { e.preventDefault(); setSelected(selected === node.id ? null : node.id); } }}
                        onMouseEnter={() => setHovered(node.id)}
                        onMouseLeave={() => setHovered(null)}
                        onFocus={() => setHovered(node.id)}
                        onBlur={() => setHovered(null)}
                        opacity={dim(node.id)}
                        style={{ cursor: "pointer", transition: "opacity .25s" }}
                      >
                        <text x={x - 20} y={y + 4} textAnchor="end" fontSize="13" fill="var(--ink)" clipPath="url(#clip-agent)">{node.label}</text>
                        <circle cx={x} cy={y} r={9} fill={isUnknown ? "var(--surface)" : l.color} stroke={isUnknown ? "var(--faint)" : l.color} strokeWidth={2} strokeDasharray={isUnknown ? "3 3" : undefined} fillOpacity={isUnknown ? 1 : 0.9} />
                        {isUnknown && <text x={x} y={y + 4} textAnchor="middle" fontSize="11" fill="var(--faint)" aria-hidden="true">?</text>}
                        {selected === node.id && <circle cx={x} cy={y} r={14} fill="none" stroke="var(--accent)" strokeWidth={2} />}
                      </g>
                    );
                  })}
                  {layout.works.map(({ node, x, y }) => (
                    <g
                      key={node.id}
                      role="button"
                      tabIndex={0}
                      aria-pressed={selected === node.id}
                      aria-label={`${node.label} ${(node.detail ?? "unknown").replace(/_/g, " ")}, work item`}
                      onClick={() => setSelected(selected === node.id ? null : node.id)}
                      onKeyDown={(e) => { if (e.key === "Enter" || e.key === " ") { e.preventDefault(); setSelected(selected === node.id ? null : node.id); } }}
                      onMouseEnter={() => setHovered(node.id)}
                      onMouseLeave={() => setHovered(null)}
                      onFocus={() => setHovered(node.id)}
                      onBlur={() => setHovered(null)}
                      opacity={dim(node.id)}
                      style={{ cursor: "pointer", transition: "opacity .25s" }}
                    >
                      <rect x={x} y={y - 16} width={292} height={32} rx={9} fill="var(--surface-3)" stroke={selected === node.id ? "var(--accent)" : "var(--line-strong)"} strokeWidth={selected === node.id ? 2 : 1} />
                      <text x={x + 12} y={y + 4} fontSize="12.5" fill="var(--ink)" clipPath="url(#clip-work)">{node.label}</text>
                    </g>
                  ))}
                  <g aria-hidden="true" pointerEvents="none">
                    {layout.works.map(({ node, x, y }) => (
                      <text key={node.id} x={x + 280} y={y + 4} textAnchor="end" fontSize="10.5" fill="var(--muted)" opacity={dim(node.id)}>{(node.detail ?? "").replace(/_/g, " ")}</text>
                    ))}
                  </g>
                </svg>
                {layout.works.length === 0 && <p className="border-t border-line px-4 py-3 text-xs text-muted">No agent is bound to a work item right now. Agents are shown with their real liveness only.</p>}
              </div>
            ) : (
              <NetworkTable data={data} />
            )}
            <ul className="mt-3 flex flex-wrap gap-x-4 gap-y-1 text-xs text-muted" aria-label="Legend">
              {Object.values(LIVENESS).map((l) => (
                <li key={l.text} className="flex items-center gap-1.5"><span aria-hidden="true" className="inline-block h-2.5 w-2.5 rounded-full" style={{ background: l.color }} />{l.text}</li>
              ))}
              <li>Solid link: active lease (highest fencing epoch). Dashed: task reported by the agent.</li>
            </ul>
          </div>
          <aside aria-label="Selection details" className="rounded-ctl border border-line bg-surface-2/60 p-4 text-sm">
            {selectedNode ? <Details node={selectedNode} data={data} onSelect={setSelected} /> : <p className="text-muted">Select an agent or work item to see what ACS knows about it. Hovering highlights its real connections.</p>}
          </aside>
        </div>
      )}
    </Card>
  );
}

function bindingFor(agentId: string, data: OverviewReadModel): string {
  const labels = data.network.edges
    .filter((e) => e.from === agentId)
    .map((e) => data.network.nodes.find((n) => n.id === e.to)?.label)
    .filter((l): l is string => Boolean(l));
  return labels.join(", ");
}

function Details({ node, data, onSelect }: { node: NetworkNode; data: OverviewReadModel; onSelect: (id: string) => void }) {
  const l = live(node);
  const edges = data.network.edges.filter((e) => e.from === node.id || e.to === node.id);
  const other = (id: string) => data.network.nodes.find((n) => n.id === id);
  return (
    <div className="space-y-3">
      <div>
        <p className="text-xs uppercase tracking-wider text-muted">{node.kind === "agent" ? "Agent" : "Work item"}</p>
        <p className="mt-0.5 font-semibold break-words">{node.label}</p>
      </div>
      {node.kind === "agent" ? (
        <>
          <StatusPill tone={l.tone}>{l.text}</StatusPill>
          <dl className="space-y-1.5 text-xs">
            <div><dt className="text-muted">Role</dt><dd>{node.detail || "unknown"}</dd></div>
            <div><dt className="text-muted">Last heartbeat</dt><dd>{node.lastHeartbeatAt ? `${relativeTime(node.lastHeartbeatAt)}` : "no heartbeat evidence"}</dd></div>
            {node.capabilities?.length ? <div><dt className="text-muted">Capabilities</dt><dd className="flex flex-wrap gap-1 pt-1">{node.capabilities.map((c) => <span key={c} className="rounded-md bg-surface-3 px-1.5 py-0.5">{c}</span>)}</dd></div> : null}
          </dl>
        </>
      ) : (
        <StatusPill tone="neutral">{(node.detail ?? "unknown").replace(/_/g, " ")}</StatusPill>
      )}
      <div>
        <p className="text-xs uppercase tracking-wider text-muted">Connections</p>
        {edges.length === 0 ? <p className="mt-1 text-xs text-muted">No proven binding.</p> : (
          <ul className="mt-1 space-y-1.5 text-xs">
            {edges.map((e) => {
              const o = other(e.from === node.id ? e.to : e.from);
              return (
                <li key={`${e.from}|${e.to}`}>
                  <button type="button" onClick={() => o && onSelect(o.id)} className="text-left text-accent hover:underline">{o?.label ?? "unknown"}</button>
                  <span className="text-muted"> · {e.kind === "active_lease" ? `active lease, epoch ${e.fencingEpoch ?? "?"}` : "reported by agent"}</span>
                </li>
              );
            })}
          </ul>
        )}
      </div>
    </div>
  );
}

function NetworkTable({ data }: { data: OverviewReadModel }) {
  const agents = data.network.nodes.filter((n) => n.kind === "agent");
  return (
    <DataTable
      caption="Agents, liveness and bound work"
      rows={agents}
      rowKey={(n) => n.id}
      columns={[
        { key: "agent", header: "Agent", render: (n) => <span className="font-medium">{n.label}</span> },
        { key: "live", header: "Liveness", render: (n) => <StatusPill tone={live(n).tone}>{live(n).text}</StatusPill> },
        { key: "hb", header: "Last heartbeat", render: (n) => (n.lastHeartbeatAt ? relativeTime(n.lastHeartbeatAt) : "none") },
        { key: "work", header: "Bound work", render: (n) => bindingFor(n.id, data) || <span className="text-muted">none</span> },
        {
          key: "evidence",
          header: "Evidence",
          render: (n) => {
            const evidence = data.network.edges.filter((e) => e.from === n.id).map((e) => (e.kind === "active_lease" ? `active lease, epoch ${e.fencingEpoch ?? "?"}` : "reported task"));
            return evidence.length ? evidence.join("; ") : <span className="text-muted">none</span>;
          }
        }
      ]}
    />
  );
}

export { NETWORK_WIDTH };
