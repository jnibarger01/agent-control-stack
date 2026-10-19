/** The eleven canonical destinations. Pages not yet migrated link to the classic console, so nothing disappears. */
export interface NavItem {
  key: string;
  label: string;
  /** In-app route (React Router) when migrated. */
  route?: string;
  /** Classic console deep link when not yet migrated. */
  classic?: string;
  description: string;
}

export const NAV_ITEMS: NavItem[] = [
  { key: "overview", label: "Command", route: "/", description: "Live overview of agents, work and health" },
  { key: "queue", label: "Work Queue", route: "/queue", description: "All work items, plans and execution traces" },
  { key: "execution", label: "Execution", route: "/execution", description: "Attempts, leases and throughput" },
  { key: "approvals", label: "Approvals", route: "/approvals", description: "Work waiting on a human" },
  { key: "agents", label: "Agents", route: "/agents", description: "Registered agents and heartbeats" },
  { key: "executors", label: "Executors", route: "/executors", description: "Execution bridges and runtimes" },
  { key: "connectors", label: "Connectors", route: "/connectors", description: "Connector registry and sessions" },
  { key: "metrics", label: "Metrics", classic: "/#metrics", description: "Persisted telemetry" },
  { key: "audit", label: "Audit", classic: "/#audit", description: "Immutable event log" },
  { key: "policy", label: "Policy", classic: "/#policy", description: "Rules and recent decisions" },
  { key: "system", label: "System", classic: "/#system", description: "Readiness and probes" }
];
