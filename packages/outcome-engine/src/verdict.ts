import {
  BLOCK_KINDS,
  TRUSTED_GRADES,
  type BlockKind,
  type CriterionRef,
  type ProbeResult,
  type VerdictInput,
  type VerdictResult
} from "./domain.js";
import { hasReadinessFloor } from "./criteria.js";

export const STALE_AFTER_MS = 60 * 60 * 1000;

const severity = (kind: BlockKind): number => BLOCK_KINDS.indexOf(kind);

function worst(kinds: readonly BlockKind[]): BlockKind | undefined {
  return [...kinds].sort((left, right) => severity(left) - severity(right))[0];
}

/** Reason codes that name a kind of undecided state, used to recover the block kind of a stored probe result. */
const KIND_BY_CODE: Readonly<Record<string, BlockKind>> = {
  integrity: "integrity",
  authority: "authority",
  evidence_unavailable: "evidence_unavailable",
  simulated_evidence: "simulated_only",
  needs_human: "needs_human",
  pending_external: "pending_external"
};

function undecidedKind(result: ProbeResult): BlockKind {
  const kinds = result.reasonCodes
    .map((code) => KIND_BY_CODE[code])
    .filter((kind): kind is BlockKind => kind !== undefined);
  return worst(kinds) ?? "evidence_unavailable";
}

/**
 * STEP 0. Untrusted data can neither satisfy nor contradict. A result whose evidence is empty or contains any grade
 * outside {acs_observed, forge_attested} becomes undecided; simulated or fixture evidence says so.
 */
export function normalizeResult(result: ProbeResult): ProbeResult {
  if (result.state === "undecided") return result;
  const grades = result.evidence.map((ref) => ref.grade);
  const trusted = grades.length > 0 && grades.every((grade) => TRUSTED_GRADES.has(grade));
  if (trusted) return result;
  const simulated = grades.some((grade) => grade === "simulated" || grade === "fixture");
  return {
    ...result,
    state: "undecided",
    reasonCodes: [
      ...new Set([...result.reasonCodes, simulated ? "simulated_evidence" : "evidence_unavailable"])
    ].sort(),
    findings: [...result.findings, "verdict_downgraded_untrusted_evidence"]
  };
}

function resultFor(criterion: CriterionRef, results: readonly ProbeResult[]): ProbeResult {
  const found = results.find((entry) => entry.criterionId === criterion.id && entry.kind === criterion.kind);
  return (
    found ?? {
      criterionId: criterion.id,
      kind: criterion.kind,
      state: "undecided",
      reasonCodes: ["evidence_unavailable", "probe_missing"],
      findings: ["no result was recorded for this criterion"],
      evidence: []
    }
  );
}

/**
 * The ONLY producer of a verdict. Pure and total: no I/O, clock or randomness, and it never reads a caller-supplied
 * verdict, status, grade or actor. The reader runs it again over stored inputs to detect a stored/recomputed mismatch.
 *
 * Gates fire first (strict precedence) and always yield BLOCK; FAIL and PARTIAL are never emitted when a gate fired.
 * Aggregation is over REQUIRED criteria only: PASS iff none unsatisfied and none undecided; FAIL iff some unsatisfied and
 * none satisfied; PARTIAL iff some of each; BLOCK iff none unsatisfied but some undecided. A trusted contradiction is
 * never hidden by an undecided item, and absence of evidence is undecided, never satisfied and never unsatisfied.
 */
export function computeVerdict(input: VerdictInput): VerdictResult {
  const normalized = input.criteria.map((criterion) => ({
    criterion,
    result: normalizeResult(resultFor(criterion, input.results))
  }));
  const required = normalized.filter((entry) => entry.criterion.required);
  const satisfied = required.filter((entry) => entry.result.state === "satisfied");
  const unsatisfied = required.filter((entry) => entry.result.state === "unsatisfied");
  const undecided = required.filter((entry) => entry.result.state === "undecided");
  const optionalUnsatisfied = normalized
    .filter((entry) => !entry.criterion.required && entry.result.state === "unsatisfied")
    .map((entry) => entry.criterion.id)
    .sort();

  const criteriaSummary = {
    requiredSatisfied: satisfied.length,
    requiredUnsatisfied: unsatisfied.length,
    requiredUndecided: undecided.length,
    optionalUnsatisfied
  };
  const reasonCodes = new Set<string>();
  const findings: string[] = [];
  for (const entry of required) {
    for (const code of entry.result.reasonCodes) reasonCodes.add(code);
    for (const finding of entry.result.findings) findings.push(`${entry.criterion.id}: ${finding}`);
  }

  const gatePreconditionsHold =
    input.gates.length === 0 &&
    required.length > 0 &&
    hasReadinessFloor(input.criteria) &&
    required.every((entry) => entry.result.state === "satisfied") &&
    input.provenance === "live_github" &&
    input.integrityOk &&
    input.snapshotStable &&
    input.headBound &&
    input.prState === "OPEN";

  if (input.gates.length > 0) {
    for (const gate of input.gates) {
      reasonCodes.add(gate.reasonCode);
      findings.unshift(`${gate.gate}: ${gate.detail}`);
    }
    return {
      verdict: "BLOCK",
      blockKind: worst(input.gates.map((gate) => gate.blockKind)) as BlockKind,
      reasonCodes: [...reasonCodes].sort(),
      findings,
      criteriaSummary,
      passPreconditions: false
    };
  }

  if (unsatisfied.length > 0) {
    return {
      verdict: satisfied.length === 0 ? "FAIL" : "PARTIAL",
      reasonCodes: [...reasonCodes].sort(),
      findings,
      criteriaSummary,
      passPreconditions: false
    };
  }

  if (undecided.length > 0) {
    return {
      verdict: "BLOCK",
      blockKind: worst(undecided.map((entry) => undecidedKind(entry.result))) as BlockKind,
      reasonCodes: [...reasonCodes].sort(),
      findings,
      criteriaSummary,
      passPreconditions: false
    };
  }

  if (!gatePreconditionsHold) {
    // Defence in depth: every required criterion is satisfied but a PASS precondition is not, so say why and refuse.
    const why: Array<[boolean, string, BlockKind]> = [
      [required.length === 0, "no_required_criteria", "integrity"],
      [!hasReadinessFloor(input.criteria), "readiness_floor_missing", "integrity"],
      [input.provenance !== "live_github", "reader_provenance_not_live", "simulated_only"],
      [!input.integrityOk, "integrity_failed", "integrity"],
      [!input.snapshotStable, "snapshot_changed_during_evaluation", "pending_external"],
      [!input.headBound, "checks_not_bound_to_head", "evidence_unavailable"],
      [input.prState !== "OPEN", "pr_not_open", "needs_human"]
    ];
    const fired = why.filter(([condition]) => condition);
    for (const [, code] of fired) reasonCodes.add(code);
    return {
      verdict: "BLOCK",
      blockKind: worst(fired.map(([, , kind]) => kind)) ?? "integrity",
      reasonCodes: [...reasonCodes].sort(),
      findings,
      criteriaSummary,
      passPreconditions: false
    };
  }

  return { verdict: "PASS", reasonCodes: [...reasonCodes].sort(), findings, criteriaSummary, passPreconditions: true };
}

/** A recorded PASS older than STALE_AFTER_MS is rendered STALE; the stored verdict is unchanged and a re-evaluation is needed. */
export function isStale(evaluatedAtMs: number, nowMs: number, staleAfterMs = STALE_AFTER_MS): boolean {
  return nowMs - evaluatedAtMs > staleAfterMs;
}

export interface NextAction {
  action: string;
  requiresHuman: boolean;
  detail: string;
}

/** Data only: nothing here is executed by this package. */
export function nextActions(result: VerdictResult): NextAction[] {
  switch (result.verdict) {
    case "PASS":
      return [
        {
          action: "decide_merge_hold",
          requiresHuman: true,
          detail:
            "PASS is evidence about one head commit, not merge approval. A human decides whether to merge or hold. Marking a draft ready for review can trigger the repository merge workflow."
        }
      ];
    case "PARTIAL":
    case "FAIL":
      return [
        {
          action: "review_unsatisfied_criteria",
          requiresHuman: true,
          detail: "inspect the unsatisfied criteria and findings"
        }
      ];
    case "BLOCK":
      return [
        {
          action: result.blockKind === "pending_external" ? "wait_and_reevaluate" : "resolve_block_reason",
          requiresHuman: result.blockKind !== "pending_external",
          detail:
            result.blockKind === "needs_human"
              ? "a human decision is required; the verifier must not be weakened to clear this block"
              : `blocked (${result.blockKind ?? "unknown"}); see reason codes`
        }
      ];
  }
}
