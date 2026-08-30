/**
 * The attempt-scoped, READ-ONLY evidence surface (ADR 0015).
 *
 * Every capability here observes. None acts. There is deliberately NO
 * capability — no method name, no MCP tool, no dispatch branch — for write,
 * delete, shell/exec, package install, commit, restart, arbitrary network,
 * approval, retry/clone, or lifecycle mutation. Absence is proven at
 * compile time (the capability union is closed) and at test time
 * (`assertNoForbiddenCapability`).
 */

export const EVIDENCE_READ_CAPABILITIES = [
  "work_item_info",
  "attempt_info",
  "workspace_info",
  "read_file",
  "search_workspace",
  "list_directory",
  "git_status",
  "git_diff",
  "git_changed_files",
  "test_runs",
  "test_output",
  "execution_summary",
  "sandbox_summary",
  "policy_decision",
  "approval_summary",
  "audit_excerpt",
  "evidence_manifest"
] as const;

export type EvidenceReadCapability = (typeof EVIDENCE_READ_CAPABILITIES)[number];

/**
 * Any capability name matching one of these is a privileged action and MUST NOT
 * exist on an evidence surface. Used by tests over the concrete surface and
 * over `apps/evidence-mcp`'s tool list.
 */
export const FORBIDDEN_CAPABILITY_PATTERNS: readonly RegExp[] = [
  /write/i,
  /delete|remove|rm\b/i,
  /\bexec\b|shell|spawn|command|run_process|start_process/i,
  /install/i,
  /commit|push/i,
  /restart|reboot|kill/i,
  /network|fetch|http|curl|egress/i,
  /approve|approval\b(?!_summary)/i,
  /retry|clone/i,
  /transition|mutate|update|create(?!_)|cancel|reject|unblock|admit|lease|claim/i,
  /submit_(work_)?result|record_/i
];

export interface ForbiddenCapabilityViolation {
  name: string;
  pattern: string;
}

/**
 * Fail-closed: returns every capability/tool name that looks privileged. An
 * empty array is the only acceptable result for an evidence surface.
 */
export function assertNoForbiddenCapability(names: readonly string[]): ForbiddenCapabilityViolation[] {
  const violations: ForbiddenCapabilityViolation[] = [];
  for (const name of names) {
    if ((EVIDENCE_READ_CAPABILITIES as readonly string[]).includes(name)) continue;
    for (const pattern of FORBIDDEN_CAPABILITY_PATTERNS) {
      if (pattern.test(name)) {
        violations.push({ name, pattern: pattern.source });
        break;
      }
    }
  }
  return violations;
}

// --- capability input/output shapes ----------------------------------------

export interface ReadFileInput {
  path: string;
  offset?: number;
  length?: number;
}
export interface ListDirectoryInput {
  path: string;
  depth?: number;
}
export interface SearchWorkspaceInput {
  query: string;
  path?: string;
  maxResults?: number;
}
export interface AuditExcerptInput {
  limit?: number;
  afterSequence?: number;
}

/**
 * The surface type. Note the shape: a `Readonly` record of async READ
 * functions. There is no index signature and no way to add a member — adding a
 * privileged capability would require editing `EVIDENCE_READ_CAPABILITIES`,
 * which the architecture tests guard.
 */
export interface EvidenceReadSurface {
  readonly work_item_info: () => Promise<unknown>;
  readonly attempt_info: () => Promise<unknown>;
  readonly workspace_info: () => Promise<unknown>;
  readonly read_file: (input: ReadFileInput) => Promise<unknown>;
  readonly search_workspace: (input: SearchWorkspaceInput) => Promise<unknown>;
  readonly list_directory: (input: ListDirectoryInput) => Promise<unknown>;
  readonly git_status: () => Promise<unknown>;
  readonly git_diff: () => Promise<unknown>;
  readonly git_changed_files: () => Promise<unknown>;
  readonly test_runs: () => Promise<unknown>;
  readonly test_output: () => Promise<unknown>;
  readonly execution_summary: () => Promise<unknown>;
  readonly sandbox_summary: () => Promise<unknown>;
  readonly policy_decision: () => Promise<unknown>;
  readonly approval_summary: () => Promise<unknown>;
  readonly audit_excerpt: (input: AuditExcerptInput) => Promise<unknown>;
  readonly evidence_manifest: () => Promise<unknown>;
}

// Compile-time exhaustiveness: EvidenceReadSurface has exactly the capabilities.
type _AssertKeys = EvidenceReadCapability extends keyof EvidenceReadSurface
  ? keyof EvidenceReadSurface extends EvidenceReadCapability
    ? true
    : ["extra key on EvidenceReadSurface"]
  : ["missing capability on EvidenceReadSurface"];
const _keysOk: _AssertKeys = true;
void _keysOk;
