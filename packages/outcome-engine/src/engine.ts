import type { PullRequestReader, PullRequestSnapshot } from "@agent-control-stack/integration-manager";
import { outcomeHash } from "./canonical.js";
import { hasReadinessFloor, parseCriteria, templatePrProductionReady } from "./criteria.js";
import {
  SCHEMA_ACCEPTED,
  SCHEMA_EVALUATION,
  acceptInputSchema,
  type Criterion,
  type EvidenceRef,
  type Gate,
  type ProbeResult,
  type ReaderProvenance,
  type VerdictInput
} from "./domain.js";
import { externalMergeExposure } from "./exposure.js";
import {
  OutcomeIntegrityError,
  OutcomeLedger,
  evaluationChainHash,
  evaluationContentHash,
  type AcceptedRecord,
  type EvaluationRecord,
  type LoadedOutcome,
  type OutcomeStorePort
} from "./ledger.js";
import { sanitizeDeep } from "./persist.js";
import { PlanError, compilePlan, validatePlan } from "./plan.js";
import { runProbe, snapshotHash } from "./probes.js";
import { OutcomeReadError } from "./readonly-gh-runner.js";
import { STALE_AFTER_MS, computeVerdict, isStale, nextActions } from "./verdict.js";

/** Identical re-evaluations inside this window return the last record instead of appending a duplicate. */
export const DEDUPE_WINDOW_MS = 60_000;

export interface OutcomeEngineOptions {
  store: OutcomeStorePort;
  /**
   * Builds the reader for the repository an outcome was accepted against, so one engine can never read a different
   * repository's pull request #N than the one the outcome names.
   */
  readerFor: (repository: string) => PullRequestReader;
  /**
   * Asserted by the composition root: "live_github" only when `readerFor` returns the real `gh` reader. Anything else makes every
   * probe result untrusted, so a PASS is impossible, whatever the reader returned.
   */
  provenance: ReaderProvenance;
  /** The repository the merge-path table was modelled for. */
  acsRepository: string;
  now?: () => Date;
}

export interface AcceptAuthority {
  /** Derived by the CLI composition root from the operating system, never from request input. */
  osUser: string;
}

export interface EvaluationView {
  record: EvaluationRecord;
  /** False when a pre-read gate fired: the BLOCK is reported but nothing is appended. */
  recorded: boolean;
  deduped: boolean;
  stale: boolean;
}

export class OutcomeEngine {
  private readonly ledger: OutcomeLedger;
  private readonly now: () => Date;

  constructor(private readonly options: OutcomeEngineOptions) {
    this.ledger = new OutcomeLedger(options.store);
    this.now = options.now ?? (() => new Date());
  }

  accept(rawInput: unknown, authority: AcceptAuthority): { record: AcceptedRecord; created: boolean } {
    const input = acceptInputSchema.parse(rawInput);
    const criteria: Criterion[] =
      input.criteria === undefined ? templatePrProductionReady() : parseCriteria(input.criteria);
    const planBase = compilePlan(criteria);
    const acceptanceHash = outcomeHash("acceptance", {
      goal: input.goal,
      repository: input.repository,
      pullRequest: input.pullRequest,
      criteria,
      maxEvaluations: input.maxEvaluations
    });
    const outcomeId = `out_${acceptanceHash.slice(0, 24)}`;
    const existing = this.ledger.load(outcomeId);
    if (existing !== undefined) return { record: existing.accepted, created: false };
    const record: AcceptedRecord = {
      schema: SCHEMA_ACCEPTED,
      outcomeId,
      acceptanceHash,
      goal: input.goal,
      repository: input.repository,
      pullRequest: input.pullRequest,
      criteria,
      plan: planBase,
      limits: { expiresAt: input.expiresAt ?? null, maxEvaluations: input.maxEvaluations },
      acceptedAt: this.now().toISOString(),
      authority: { kind: "unauthenticated_local_operator", osUser: authority.osUser },
      executionBasis: "none"
    };
    this.ledger.recordAccepted(record);
    return { record, created: true };
  }

  list(): Array<{
    outcomeId: string;
    repository: string;
    pullRequest: number;
    goal: string;
    evaluations: number;
    latestVerdict: string | null;
    latestEvaluatedAt: string | null;
    problems: number;
  }> {
    return this.ledger.loadAll().map((loaded) => {
      const latest = loaded.evaluations[loaded.evaluations.length - 1];
      return {
        outcomeId: loaded.accepted.outcomeId,
        repository: loaded.accepted.repository,
        pullRequest: loaded.accepted.pullRequest,
        goal: loaded.accepted.goal,
        evaluations: loaded.evaluations.length,
        latestVerdict: latest?.verdict ?? null,
        latestEvaluatedAt: latest?.evaluatedAt ?? null,
        problems: loaded.problems.length
      };
    });
  }

  show(outcomeId: string): (LoadedOutcome & { latestStale: boolean }) | undefined {
    const loaded = this.ledger.load(outcomeId);
    if (loaded === undefined) return undefined;
    const latest = loaded.evaluations[loaded.evaluations.length - 1];
    const latestStale =
      latest !== undefined &&
      latest.verdict === "PASS" &&
      isStale(Date.parse(latest.evaluatedAt), this.now().getTime(), STALE_AFTER_MS);
    return { ...loaded, latestStale };
  }

  async evaluate(outcomeId: string): Promise<EvaluationView> {
    const loaded = this.ledger.load(outcomeId);
    if (loaded === undefined) throw new OutcomeIntegrityError("outcome_not_found", `no accepted outcome ${outcomeId}`);
    const { accepted } = loaded;
    const nowDate = this.now();

    // Pre-read gates: reported, never recorded.
    const pre: Gate[] = [];
    if (loaded.problems.length > 0) {
      pre.push({
        gate: "G1",
        reasonCode: "record_integrity_failed",
        blockKind: "integrity",
        detail: loaded.problems.slice(0, 5).join(", ")
      });
    }
    if (!hasReadinessFloor(accepted.criteria)) {
      pre.push({
        gate: "G1",
        reasonCode: "readiness_floor_missing",
        blockKind: "integrity",
        detail: "persisted criteria lack the readiness floor"
      });
    }
    try {
      validatePlan(accepted.plan as Parameters<typeof validatePlan>[0]);
      if (compilePlan(accepted.criteria).planHash !== accepted.plan.planHash) {
        pre.push({
          gate: "G1",
          reasonCode: "plan_hash_mismatch",
          blockKind: "integrity",
          detail: "persisted plan differs from the plan these criteria compile to"
        });
      }
    } catch (error) {
      pre.push({
        gate: "G1",
        reasonCode: error instanceof PlanError ? error.code : "plan_invalid",
        blockKind: error instanceof PlanError && error.code === "no_eligible_executor" ? "authority" : "integrity",
        detail: "persisted plan failed validation"
      });
    }
    const chain = this.options.store.verifyAuditChain();
    if (!chain.ok)
      pre.push({
        gate: "G1",
        reasonCode: "audit_chain_invalid",
        blockKind: "integrity",
        detail: "the audit chain does not verify"
      });
    if (accepted.limits.expiresAt !== null && Date.parse(accepted.limits.expiresAt) <= nowDate.getTime()) {
      pre.push({
        gate: "G1b",
        reasonCode: "scope_expired",
        blockKind: "authority",
        detail: `outcome expired at ${accepted.limits.expiresAt}`
      });
    }
    if (loaded.evaluations.length >= accepted.limits.maxEvaluations) {
      pre.push({
        gate: "G1b",
        reasonCode: "max_evaluations_exceeded",
        blockKind: "authority",
        detail: `limit of ${accepted.limits.maxEvaluations} evaluations reached`
      });
    }
    const previous = loaded.evaluations[loaded.evaluations.length - 1];
    if (pre.length > 0) {
      const record = this.buildRecord(accepted, previous, nowDate, {
        gates: pre,
        results: [],
        snapshot: undefined,
        snapshot2: undefined,
        integrityOk: false
      });
      return { record, recorded: false, deduped: false, stale: false };
    }

    const reader = this.options.readerFor(accepted.repository);
    // Read #1 drives every probe; read #2 exists only to prove the pull request did not move under us.
    const gates: Gate[] = [];
    let snapshot: PullRequestSnapshot | undefined;
    let snapshot2: PullRequestSnapshot | undefined;
    try {
      snapshot = await reader.getPullRequest(accepted.pullRequest);
    } catch (error) {
      gates.push(this.readGate(error));
    }
    if (
      snapshot !== undefined &&
      (snapshot.truncated.threads || snapshot.truncated.checks || snapshot.truncated.files)
    ) {
      gates.push({
        gate: "G2",
        reasonCode: "github_signals_truncated",
        blockKind: "evidence_unavailable",
        detail: "GitHub returned partial threads, checks or files"
      });
    }
    const grade = this.options.provenance === "live_github" ? "forge_attested" : "fixture";
    const ref = (pr: PullRequestSnapshot): EvidenceRef[] => [
      {
        grade,
        source: `github:${accepted.repository}#${pr.number}@${pr.headSha.slice(0, 12)}`,
        digest: snapshotHash(pr)
      }
    ];
    let results: ProbeResult[] = [];
    if (snapshot !== undefined && gates.length === 0) {
      const first = snapshot;
      results = accepted.criteria.map((criterion) => runProbe(criterion, first, { grade, evidence: ref(first) }));
      try {
        snapshot2 = await reader.getPullRequest(accepted.pullRequest);
      } catch (error) {
        gates.push(this.readGate(error));
      }
      if (snapshot2 !== undefined) {
        if (snapshotHash(snapshot2) !== snapshotHash(snapshot)) {
          gates.push({
            gate: "G3",
            reasonCode:
              snapshot2.headSha !== snapshot.headSha
                ? "head_moved_during_evaluation"
                : "snapshot_changed_during_evaluation",
            blockKind: "pending_external",
            detail: "the pull request changed between two reads"
          });
        }
      }
      if (snapshot.checksCommitSha !== snapshot.headSha) {
        gates.push({
          gate: "G3",
          reasonCode: "checks_not_bound_to_head",
          blockKind: "evidence_unavailable",
          detail: "the check rollup does not belong to the head commit"
        });
      }
      if (snapshot.state !== "OPEN") {
        gates.push({
          gate: "G4",
          reasonCode: "pr_not_open",
          blockKind: "needs_human",
          detail: `pull request is ${snapshot.state}`
        });
        if (snapshot.state === "MERGED")
          gates.push({
            gate: "G4",
            reasonCode: "merged_outside_outcome",
            blockKind: "needs_human",
            detail: "merged by something other than this engine"
          });
      }
    }
    const record = this.buildRecord(accepted, previous, nowDate, {
      gates,
      results,
      snapshot,
      snapshot2,
      integrityOk: true
    });
    if (
      previous !== undefined &&
      previous.contentHash === record.contentHash &&
      nowDate.getTime() - Date.parse(previous.evaluatedAt) < DEDUPE_WINDOW_MS
    ) {
      return { record: previous, recorded: false, deduped: true, stale: false };
    }
    this.ledger.recordEvaluation(record);
    return { record, recorded: true, deduped: false, stale: false };
  }

  private readGate(error: unknown): Gate {
    const code = error instanceof OutcomeReadError ? error.code : undefined;
    const message = error instanceof Error ? error.message : "";
    const reasonCode =
      code ??
      (/not found/u.test(message)
        ? "pr_not_found"
        : /refusing a partial view|unexpected GitHub/u.test(message)
          ? "pr_response_invalid"
          : /unparseable/u.test(message)
            ? "github_response_unparseable"
            : "pr_read_failed");
    return {
      gate: "G2",
      reasonCode,
      blockKind: "evidence_unavailable",
      detail: "the pull request could not be read as a complete, valid snapshot"
    };
  }

  private buildRecord(
    accepted: AcceptedRecord,
    previous: EvaluationRecord | undefined,
    nowDate: Date,
    facts: {
      gates: Gate[];
      results: ProbeResult[];
      snapshot: PullRequestSnapshot | undefined;
      snapshot2: PullRequestSnapshot | undefined;
      integrityOk: boolean;
    }
  ): EvaluationRecord {
    const { snapshot, snapshot2 } = facts;
    const verdictInput: VerdictInput = {
      criteria: accepted.criteria.map((criterion) => ({
        id: criterion.id,
        kind: criterion.kind,
        required: criterion.required
      })),
      gates: facts.gates,
      results: facts.results,
      provenance: this.options.provenance,
      integrityOk: facts.integrityOk,
      snapshotStable:
        snapshot !== undefined && snapshot2 !== undefined && snapshotHash(snapshot) === snapshotHash(snapshot2),
      headBound:
        snapshot !== undefined &&
        snapshot.checksCommitSha === snapshot.headSha &&
        snapshot2?.headSha === snapshot.headSha,
      prState: snapshot?.state ?? "UNKNOWN"
    };
    const sanitizedInput = sanitizeDeep(verdictInput);
    // The verdict is computed from the persisted (sanitized) form, so a reader recomputing it gets the same answer.
    const outcome = computeVerdict(sanitizedInput);
    const sequenceNo = (previous?.sequenceNo ?? 0) + 1;
    const previousChainHash = previous?.chainHash ?? "";
    const base = {
      schema: SCHEMA_EVALUATION,
      outcomeId: accepted.outcomeId,
      sequenceNo,
      previousChainHash,
      evaluatedAt: nowDate.toISOString(),
      planHash: accepted.plan.planHash,
      headSha: snapshot?.headSha ?? null,
      baseRefOid: snapshot?.baseRefOid ?? null,
      snapshotHash: snapshot === undefined ? null : snapshotHash(snapshot),
      verdict: outcome.verdict,
      blockKind: outcome.blockKind ?? null,
      reasonCodes: outcome.reasonCodes,
      findings: sanitizeDeep(outcome.findings),
      criteriaSummary: outcome.criteriaSummary,
      verdictInput: sanitizedInput,
      readerProvenance: this.options.provenance,
      humanControl: externalMergeExposure(snapshot, accepted.repository, this.options.acsRepository),
      nextActions: nextActions(outcome),
      merged: false,
      verdictIsApproval: false,
      causality: "assessed_only",
      executionBasis: "none"
    } as const;
    const contentHash = evaluationContentHash({ ...base } as Parameters<typeof evaluationContentHash>[0]);
    const chainHash = evaluationChainHash({
      outcomeId: accepted.outcomeId,
      sequenceNo,
      previousChainHash,
      contentHash
    });
    return sanitizeDeep({
      ...base,
      contentHash,
      chainHash,
      evaluationId: `eval_${chainHash.slice(0, 24)}`
    }) as EvaluationRecord;
  }
}
