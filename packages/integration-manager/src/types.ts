/**
 * Integration Manager: a read-only reconciliation engine for open pull requests.
 *
 * It observes pull-request state, simulates merges in an isolated clone, and reports which changes would satisfy the
 * repository's merge gate and in what order. It merges nothing and pushes nothing: merging stays with the repository's
 * own gate (the review-and-merge workflow and branch protections). This engine is a second opinion that is never
 * allowed to be more permissive than that gate, so it cannot become a competing authority.
 */
export const INTEGRATION_REPORT_SCHEMA_VERSION = "acs.integration-report.v1" as const;

export interface CheckSnapshot {
  name: string;
  /** GitHub check status, or a status-context state mapped onto it. */
  status: "COMPLETED" | "IN_PROGRESS" | "QUEUED" | "PENDING" | "WAITING" | "REQUESTED" | "UNKNOWN";
  /** Meaningful when COMPLETED. */
  conclusion: string | null;
}

export interface PullRequestSnapshot {
  number: number;
  title: string;
  author: string;
  state: "OPEN" | "CLOSED" | "MERGED";
  isDraft: boolean;
  isCrossRepository: boolean;
  headRef: string;
  headSha: string;
  baseRef: string;
  mergeable: "MERGEABLE" | "CONFLICTING" | "UNKNOWN";
  reviewDecision: "APPROVED" | "CHANGES_REQUESTED" | "REVIEW_REQUIRED" | null;
  unresolvedThreads: number;
  checks: CheckSnapshot[];
  changedFiles: string[];
  /** True when the source had more review threads, checks or files than it returned. Never silently truncated. */
  truncated: { threads: boolean; checks: boolean; files: boolean };
}

/** Read-only view of the forge. There is deliberately no method that changes anything. */
export interface PullRequestSource {
  listOpenPullRequests(): Promise<PullRequestSnapshot[]>;
}

export type GateBlockerCode =
  | "not_open"
  | "draft"
  | "fork_pull_request"
  | "author_not_allowed"
  | "gate_policy_modified"
  | "truncated_signals"
  | "conflicting"
  | "changes_requested"
  | "review_required"
  | "unresolved_threads"
  | "failing_checks";

export type GatePendingCode = "mergeable_unknown" | "checks_pending";

export interface GateFinding<Code extends string> {
  code: Code;
  detail: string;
}

export interface GateVerdict {
  /** eligible: every rule passes. blocked: at least one hard blocker. pending: no blocker, but signals are incomplete. */
  status: "eligible" | "blocked" | "pending";
  blockers: Array<GateFinding<GateBlockerCode>>;
  pending: Array<GateFinding<GatePendingCode>>;
  warnings: string[];
  failedChecks: Array<{ name: string; category: FailureCategory }>;
}

export type FailureCategory =
  "test" | "lint" | "typecheck" | "format" | "security" | "build" | "review-gate" | "deploy" | "unknown";

export interface GatePolicy {
  /** Files whose modification means the change alters the merge policy itself and needs manual review. */
  protectedPaths: readonly string[];
  /** When set, only these authors may be reported eligible. Source integrity. */
  allowedAuthors?: readonly string[];
  allowForkPullRequests: boolean;
}

/**
 * Mirrors `.github/workflows/jnibarger01-pr-review-merge.yml`: it ignores every author but `jnibarger01`, and refuses to
 * auto-merge a change to the workflow or to the review instructions it enforces. A test reads that workflow and fails if
 * these defaults drift from it, because this engine must never be more permissive than the gate it reports on.
 */
export const DEFAULT_GATE_POLICY: GatePolicy = {
  protectedPaths: [
    ".github/workflows/jnibarger01-pr-review-merge.yml",
    ".github/instructions/jnibarger01-pr-review.instructions.md"
  ],
  allowedAuthors: ["jnibarger01"],
  allowForkPullRequests: false
};

/** How the repository will land a pull request. The simulated history differs for each. */
export type MergeMethod = "merge" | "squash" | "rebase";

export interface MergeSimulation {
  /** merge-tree ran and the result is trustworthy. false means the head or base could not be evaluated. */
  evaluated: boolean;
  clean: boolean;
  conflicts: string[];
  /** Commits the base has gained since this head diverged. */
  behindBy: number;
  detail?: string;
}

export interface PullRequestAssessment {
  number: number;
  title: string;
  headSha: string;
  baseRef: string;
  gate: GateVerdict;
  dependsOn: number[];
  /** Merging this head onto the current base on its own. */
  standalone: MergeSimulation;
  /** Merging this head after every earlier queued pull request has been merged. Absent if it was not queued. */
  afterUpstream?: MergeSimulation;
  overlaps: Array<{ number: number; files: string[] }>;
  queuePosition?: number;
  wouldMerge: boolean;
  reasons: string[];
}

export interface IntegrationReport {
  schemaVersion: typeof INTEGRATION_REPORT_SCHEMA_VERSION;
  repository: string;
  baseRef: string;
  baseSha: string;
  /** The method the simulation modeled, as the repository's settings and the gate would select it. */
  mergeMethod: MergeMethod;
  generatedAt: string;
  /** Pull request numbers in the order they would merge, earliest first. */
  queue: number[];
  pullRequests: PullRequestAssessment[];
  warnings: string[];
  /** Always false: this engine reports and never merges. */
  merged: false;
}
