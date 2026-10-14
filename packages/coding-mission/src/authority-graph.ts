import type { AutonomousAuthorityDefinition } from "./authority.js";
import type { ExecutorLane } from "./worker-execution.js";

/**
 * Read model of a mission's delegated authority: the mission grant at the root, every work unit beneath it, how each
 * unit's authority was narrowed from its parent, whether it could be exercised right now, and the delegation history.
 *
 * It is a projection. Enforcement stays at the execution boundary (`MissionAuthorityLedger.verifyDispatch` and
 * `requestChildWork`); nothing here grants anything, and a node's `effective` state is computed with the same checks
 * and in the same order so the view cannot say "active" for something dispatch would refuse.
 */
export const AUTHORITY_GRAPH_SCHEMA_VERSION = "acs.authority-graph.v1" as const;

export type AuthorityNodeState =
  "active" | "revoked" | "expired" | "superseded" | "subject_changed" | "integrity_failed" | "no_authority";

export interface AuthorityNarrowing {
  /** Parent entries the child does not hold. An empty array means the child kept everything for that dimension. */
  notInherited: { scope: string[]; toolClasses: string[]; privileges: string[] };
  limits: { parent: AutonomousAuthorityDefinition["limits"]; own: AutonomousAuthorityDefinition["limits"] };
  expiresAt: { parent: string; own: string };
  executingActorChanged: boolean;
}

export interface AuthorityGraphNode {
  unitId: string;
  parentUnitId: string | null;
  depth: number;
  unitStatus: string;
  /** "mission" for a root unit running under the mission grant, "derived" for child work, "none" if it has neither. */
  authoritySource: "mission" | "derived" | "none";
  grantId: string | null;
  definitionHash: string | null;
  derivedFromHash: string | null;
  executingActorId: string | null;
  /**
   * Executor lanes this unit's authority grants a tool runtime for, by the same mapping dispatch uses. A unit that names a
   * specific tool is checked against that exact tool at dispatch, which this lane-level view does not repeat.
   */
  permittedLanes: ExecutorLane[];
  expiresAt: string | null;
  purpose: string | null;
  createdAt: string | null;
  narrowing: AuthorityNarrowing | null;
  effective: { state: AuthorityNodeState; reason?: string };
}

export interface AuthorityGraphEvent {
  eventId: number;
  name: string;
  createdAt: string;
  body: unknown;
}

export interface AuthorityGraph {
  schemaVersion: typeof AUTHORITY_GRAPH_SCHEMA_VERSION;
  missionId: string;
  missionState: string;
  /** ACS's own clock at evaluation time. */
  evaluatedAt: string;
  /** "failed" when any record in the graph did not pass its integrity checks. */
  integrity: "verified" | "failed";
  root:
    | {
        grantId: string;
        grantHash: string;
        definitionHash: string;
        approverId: string;
        reason: string;
        executingActorId: string;
        expiresAt: string;
        policy: unknown;
        state: AuthorityNodeState;
        revocation: { actorId: string; reason: string } | null;
      }
    | { state: "integrity_failed" | "no_authority"; reason: string };
  nodes: AuthorityGraphNode[];
  edges: Array<{ from: string; to: string }>;
  counts: Record<AuthorityNodeState, number>;
  history: { events: AuthorityGraphEvent[]; truncated: boolean };
}

const scopeKey = (entry: { kind: string; id: string; coverage?: string }) =>
  `${entry.kind}:${entry.id}:${entry.coverage ?? ""}`;
const toolKey = (entry: { runtime: string; toolName: string }) => `${entry.runtime}:${entry.toolName}`;

function missing(parent: readonly string[], own: readonly string[]): string[] {
  const kept = new Set(own);
  return parent.filter((entry) => !kept.has(entry)).sort();
}

export function summarizeNarrowing(
  parent: AutonomousAuthorityDefinition,
  own: AutonomousAuthorityDefinition
): AuthorityNarrowing {
  return {
    notInherited: {
      scope: missing(parent.scope.map(scopeKey), own.scope.map(scopeKey)),
      toolClasses: missing(parent.toolClasses.map(toolKey), own.toolClasses.map(toolKey)),
      privileges: missing(parent.maximumPrivileges, own.maximumPrivileges)
    },
    limits: { parent: parent.limits, own: own.limits },
    expiresAt: { parent: parent.expiresAt, own: own.expiresAt },
    executingActorChanged: parent.executingActorId !== own.executingActorId
  };
}

export const EMPTY_STATE_COUNTS = (): Record<AuthorityNodeState, number> => ({
  active: 0,
  revoked: 0,
  expired: 0,
  superseded: 0,
  subject_changed: 0,
  integrity_failed: 0,
  no_authority: 0
});
