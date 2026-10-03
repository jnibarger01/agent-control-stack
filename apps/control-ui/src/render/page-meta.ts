/**
 * Canonical page titles and descriptions.
 *
 * This lives apart from the server renderer so the browser client can read it
 * without pulling the renderer, its redaction helpers and its work-item
 * projections into the client bundle. It carries only what the browser uses: nav
 * labels and heading text. Nav glyphs are produced server-side by `icon(view)`,
 * so no icon field is stored or shipped to the browser.
 */
export const PAGE_META: Record<string, { title: string; description: string }> = {
  overview: {
    title: "Mission Control",
    description: "Coordinate work, agents, and outcomes across the control plane."
  },
  queue: {
    title: "Work Queue",
    description: "Inspect work, admission, policy, and the next action that needs your attention."
  },
  execution: {
    title: "Execution",
    description: "Monitor live attempts, queues, failures, and throughput across the control plane."
  },
  approvals: {
    title: "Approvals",
    description: "Review policy-bound requests and record an explicit operator decision."
  },
  agents: {
    title: "Agents",
    description: "Registry identities, capability coverage, assignments, and observed health."
  },
  dispatch: {
    title: "Dispatch",
    description: "Run your installed CLI coding agents in a fresh git worktree, with explicit confirmation."
  },
  executors: {
    title: "Executors",
    description: "Inspect managed bridges, attested runtimes, and execution capabilities."
  },
  connectors: {
    title: "Connectors",
    description: "Registered integrations, granted scopes, and authenticated tunnel sessions."
  },
  metrics: {
    title: "Metrics",
    description: "Persisted execution telemetry and observed control-plane counters."
  },
  audit: {
    title: "Audit",
    description: "Investigate immutable events, actors, resources, and correlated decisions."
  },
  policy: {
    title: "Policy",
    description: "Understand evaluations, matched rules, and fail-closed decisions."
  },
  system: {
    title: "System",
    description: "Readiness checks, execution admission, and connected infrastructure."
  }
};
