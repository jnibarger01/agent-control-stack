import { abbrUiEnabled } from "../features/black-box/flag";

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

const CANONICAL_NAV: NavItem[] = [
  { key: "overview", label: "Command", route: "/", description: "Live overview of agents, work and health" },
  { key: "queue", label: "Work Queue", route: "/queue", description: "All work items, plans and execution traces" },
  { key: "execution", label: "Execution", route: "/execution", description: "Attempts, leases and throughput" },
  { key: "approvals", label: "Approvals", route: "/approvals", description: "Work waiting on a human" },
  { key: "agents", label: "Agents", route: "/agents", description: "Registered agents and heartbeats" },
  { key: "executors", label: "Executors", route: "/executors", description: "Execution bridges and runtimes" },
  { key: "connectors", label: "Connectors", route: "/connectors", description: "Connector registry and sessions" },
  { key: "metrics", label: "Metrics", route: "/metrics", description: "Persisted telemetry" },
  { key: "audit", label: "Audit", route: "/audit", description: "Immutable event log" },
  { key: "policy", label: "Policy", route: "/policy", description: "Rules and recent decisions" },
  { key: "system", label: "System", route: "/system", description: "Readiness and probes" }
];

/** Black Box is omitted unless VITE_ABBR_ENABLED=1, so the default console stays the eleven destinations. */
export const NAV_ITEMS: NavItem[] = abbrUiEnabled()
  ? [...CANONICAL_NAV, { key: "black-box", label: "Black Box", route: "/black-box", description: "Recorded runs, authorization, and evidence gaps" }]
  : CANONICAL_NAV;
