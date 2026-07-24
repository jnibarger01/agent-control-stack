import { ControlStackError } from "@agent-control-stack/shared";
import type { Verifier, VerificationCriterion, VerificationEvidence, VerificationResult } from "./types.js";

export interface RunIndependentVerificationInput {
  /** engineId of whatever produced the evidence (e.g. CodexEngineAdapter's "codex"). */
  implementerEngineId: string;
  verifier: Verifier;
  criteria: VerificationCriterion[];
  evidence: VerificationEvidence;
}

/**
 * The only sanctioned way to run verification. Enforces that the verifier's
 * declared identity differs from the implementer's before ever calling
 * verify(), and again checks the result's own reported identity afterward -
 * a Verifier implementation that lied about its engineId in the result
 * still gets caught here, not silently trusted.
 *
 * This is a stronger guarantee than harness/maker-verifier.ts's
 * usedVerifierProviders WeakSet check, which only proves "not the literal
 * same JS object" within one process - here the implementer and verifier
 * are architecturally different engines (different CLI binaries, different
 * subprocesses) by construction, not merely different instances of the
 * same provider class.
 */
export async function runIndependentVerification(input: RunIndependentVerificationInput): Promise<VerificationResult> {
  if (input.verifier.engineId === input.implementerEngineId) {
    throw new ControlStackError(
      "verifier_identity_collision",
      `verifier engine (${input.verifier.engineId}) must differ from the implementer engine (${input.implementerEngineId})`
    );
  }

  const result = await input.verifier.verify(input.criteria, input.evidence);

  if (result.verifierEngineId !== input.verifier.engineId) {
    throw new ControlStackError(
      "verifier_identity_mismatch",
      "verification result's reported identity does not match the verifier instance that produced it"
    );
  }

  assertExactlyRequestedCriteria(input.criteria, result);

  return result;
}

/**
 * A verifier that silently drops a criterion, judges one twice, or invents
 * one nobody asked about is not trustworthy evidence a "pass" actually
 * covered what it claims to. Every requested criterion id must appear
 * exactly once in the result; nothing else may appear at all.
 */
function assertExactlyRequestedCriteria(criteria: VerificationCriterion[], result: VerificationResult): void {
  const requested = criteria.map((criterion) => criterion.id);
  const requestedSet = new Set(requested);
  if (requestedSet.size !== requested.length) {
    throw new ControlStackError(
      "verifier_criteria_duplicate_request",
      "the requested criteria list contains a duplicate id"
    );
  }

  const seen = new Set<string>();
  for (const entry of result.criteriaResults) {
    if (!requestedSet.has(entry.criterionId)) {
      throw new ControlStackError(
        "verifier_criteria_unknown",
        `verification result includes an unrequested criterion: ${entry.criterionId}`
      );
    }
    if (seen.has(entry.criterionId)) {
      throw new ControlStackError(
        "verifier_criteria_duplicate_result",
        `verification result judges criterion ${entry.criterionId} more than once`
      );
    }
    seen.add(entry.criterionId);
  }

  const missing = requested.filter((id) => !seen.has(id));
  if (missing.length > 0) {
    throw new ControlStackError(
      "verifier_criteria_missing",
      `verification result is missing a judgment for: ${missing.join(", ")}`
    );
  }
}

export type WorkItemVerificationOutcome = "succeeded" | "failed" | "quarantined";

/**
 * Pure mapping from a verdict to the work-item status transition it
 * authorizes - "inconclusive" never maps to "succeeded". This package has
 * no dependency on packages/work-items (avoiding an unnecessary coupling);
 * callers are expected to feed this into their own store.transition() call.
 */
export function workItemOutcomeForVerdict(verdict: VerificationResult["verdict"]): WorkItemVerificationOutcome {
  if (verdict === "pass") return "succeeded";
  if (verdict === "fail") return "failed";
  return "quarantined";
}
