import type { AuditChainVerification } from "@agent-control-stack/shared";
import type { ReadEventsOptions, StoredAuditEvent, WorkItemStore } from "@agent-control-stack/work-items";
import { z } from "zod";
import { outcomeHash } from "./canonical.js";
import {
  SCHEMA_ACCEPTED,
  SCHEMA_EVALUATION,
  VERDICTS,
  BLOCK_KINDS,
  criterionSchema,
  type VerdictInput
} from "./domain.js";
import { assertRepresentable, sanitizeDeep } from "./persist.js";
import { computeVerdict, nextActions } from "./verdict.js";
import { compilePlan, validatePlan } from "./plan.js";

export const EVENT_ACCEPTED = "outcome.accepted";
export const EVENT_EVALUATION = "outcome.evaluation_recorded";
const ATTR_CHAIN_SLOT = "outcome.chain_slot";
const ATTR_OUTCOME_ID = "outcome.id";
export const MAX_OUTCOME_SCAN_EVENTS = 20_000;
const PAGE = 500;

/**
 * The entire surface of the audit store the engine can reach. Four methods, nothing else: two appends (one of them
 * keyed, so an evaluation can claim its chain slot atomically), one read, one verification.
 */
export interface OutcomeStorePort {
  recordSystemEvent(input: {
    name: string;
    body?: Record<string, unknown>;
    attributes?: Record<string, string | number | boolean>;
  }): StoredAuditEvent;
  recordSystemEventOnce(input: {
    name: string;
    uniqueAttribute: string;
    body?: Record<string, unknown>;
    attributes: Record<string, string | number | boolean>;
  }): { event: StoredAuditEvent; recorded: boolean };
  readEvents(options?: ReadEventsOptions): StoredAuditEvent[];
  verifyAuditChain(): AuditChainVerification;
}

/** Runtime capability, not just a type: callers hand the engine this frozen object, never the store itself. */
export function createOutcomeStorePort(
  store: Pick<WorkItemStore, "recordSystemEvent" | "recordSystemEventOnce" | "readEvents" | "verifyAuditChain">
): OutcomeStorePort {
  const port: OutcomeStorePort = {
    recordSystemEvent: (input) => store.recordSystemEvent(input),
    recordSystemEventOnce: (input) => store.recordSystemEventOnce(input),
    readEvents: (options) => store.readEvents(options),
    verifyAuditChain: () => store.verifyAuditChain()
  };
  return Object.freeze(port);
}

export class OutcomeIntegrityError extends Error {
  constructor(
    public readonly code: string,
    message: string
  ) {
    super(message);
    this.name = "OutcomeIntegrityError";
  }
}

const planSchema = z.object({
  steps: z.array(
    z.object({
      id: z.string(),
      action: z.string(),
      dependsOn: z.array(z.string()),
      criterionId: z.string().optional(),
      kind: z.string().optional(),
      executor: z.string()
    })
  ),
  planHash: z.string()
});

const acceptedSchema = z.object({
  schema: z.literal(SCHEMA_ACCEPTED),
  outcomeId: z.string(),
  acceptanceHash: z.string(),
  goal: z.string(),
  repository: z.string(),
  pullRequest: z.number().int().positive(),
  criteria: z.array(criterionSchema),
  plan: planSchema,
  limits: z.object({ expiresAt: z.string().nullable(), maxEvaluations: z.number().int().positive() }),
  acceptedAt: z.string(),
  authority: z.object({ kind: z.literal("unauthenticated_local_operator"), osUser: z.string() }),
  executionBasis: z.literal("none")
});
export type AcceptedRecord = z.infer<typeof acceptedSchema>;

const evidenceSchema = z.object({ grade: z.string(), source: z.string(), digest: z.string() });
const resultSchema = z.object({
  criterionId: z.string(),
  kind: z.string(),
  state: z.enum(["satisfied", "unsatisfied", "undecided"]),
  reasonCodes: z.array(z.string()),
  findings: z.array(z.string()),
  evidence: z.array(evidenceSchema)
});
const verdictInputSchema = z.object({
  criteria: z.array(z.object({ id: z.string(), kind: z.string(), required: z.boolean() })),
  gates: z.array(
    z.object({
      gate: z.enum(["G1", "G1b", "G2", "G3", "G4"]),
      reasonCode: z.string(),
      blockKind: z.enum(BLOCK_KINDS),
      detail: z.string()
    })
  ),
  results: z.array(resultSchema),
  provenance: z.enum(["live_github", "fixture"]),
  integrityOk: z.boolean(),
  snapshotStable: z.boolean(),
  headBound: z.boolean(),
  prState: z.enum(["OPEN", "CLOSED", "MERGED", "UNKNOWN"])
});

const evaluationSchema = z.object({
  schema: z.literal(SCHEMA_EVALUATION),
  evaluationId: z.string(),
  outcomeId: z.string(),
  sequenceNo: z.number().int().positive(),
  previousChainHash: z.string(),
  contentHash: z.string(),
  chainHash: z.string(),
  evaluatedAt: z.string(),
  planHash: z.string(),
  headSha: z.string().nullable(),
  baseRefOid: z.string().nullable(),
  snapshotHash: z.string().nullable(),
  verdict: z.enum(VERDICTS),
  blockKind: z.enum(BLOCK_KINDS).nullable(),
  reasonCodes: z.array(z.string()),
  findings: z.array(z.string()),
  criteriaSummary: z.object({
    requiredSatisfied: z.number(),
    requiredUnsatisfied: z.number(),
    requiredUndecided: z.number(),
    optionalUnsatisfied: z.array(z.string())
  }),
  verdictInput: verdictInputSchema,
  readerProvenance: z.enum(["live_github", "fixture"]),
  humanControl: z.object({
    exposure: z.enum(["likely", "possible", "unknown"]),
    matchedPaths: z.array(z.string()),
    modelledPaths: z.array(z.string()),
    note: z.string()
  }),
  nextActions: z.array(z.object({ action: z.string(), requiresHuman: z.boolean(), detail: z.string() })),
  merged: z.literal(false),
  verdictIsApproval: z.literal(false),
  causality: z.literal("assessed_only"),
  executionBasis: z.literal("none")
});
export type EvaluationRecord = z.infer<typeof evaluationSchema>;

const CONTENT_EXCLUDED = [
  "evaluationId",
  "sequenceNo",
  "previousChainHash",
  "contentHash",
  "chainHash",
  "evaluatedAt"
] as const;

export function evaluationContentHash(
  record: Omit<EvaluationRecord, "contentHash" | "chainHash" | "evaluationId">
): string {
  const view: Record<string, unknown> = { ...record };
  for (const key of CONTENT_EXCLUDED) delete view[key];
  return outcomeHash("evaluation.content", view);
}

export function evaluationChainHash(fields: {
  outcomeId: string;
  sequenceNo: number;
  previousChainHash: string;
  contentHash: string;
}): string {
  return outcomeHash("evaluation.chain", fields);
}

export interface LoadedOutcome {
  accepted: AcceptedRecord;
  evaluations: EvaluationRecord[];
  /** Everything that does not recompute. Non-empty means the stored record cannot be trusted as written. */
  problems: string[];
}

export class OutcomeLedger {
  constructor(private readonly port: OutcomeStorePort) {}

  auditChainOk(): boolean {
    return this.port.verifyAuditChain().ok;
  }

  /**
   * The outcome records live inside the global audit chain, so a break anywhere in that chain taints every read: show and
   * list must fail closed on the same integrity state evaluate() blocks on.
   */
  private auditChainProblems(): string[] {
    return this.auditChainOk() ? [] : ["audit_chain_invalid"];
  }

  /**
   * Claims the outcome ID and appends in one store transaction, keyed on outcome.id within outcome.accepted events. A
   * concurrent acceptance of the same outcome finds the ID taken and gets the stored record back with `recorded: false`,
   * so two writers can never both append an acceptance for one outcome.
   */
  recordAccepted(record: AcceptedRecord): { record: AcceptedRecord; recorded: boolean } {
    assertRepresentable(record, "outcome.accepted");
    const { event, recorded } = this.port.recordSystemEventOnce({
      name: EVENT_ACCEPTED,
      uniqueAttribute: ATTR_OUTCOME_ID,
      body: record as unknown as Record<string, unknown>,
      attributes: {
        [ATTR_OUTCOME_ID]: record.outcomeId,
        "outcome.repository": record.repository,
        "outcome.pull_request": record.pullRequest
      }
    });
    if (recorded) return { record, recorded };
    const parsed = acceptedSchema.safeParse(event.body);
    if (!parsed.success || parsed.data.outcomeId !== record.outcomeId) {
      throw new OutcomeIntegrityError(
        "accepted_record_invalid",
        `stored acceptance for ${record.outcomeId} does not parse (event ${event.sequence})`
      );
    }
    return { record: parsed.data, recorded };
  }

  /**
   * Claims chain slot (outcomeId, sequenceNo) and appends in one store transaction. A concurrent evaluation that built
   * on the same head finds the slot taken and gets the stored record back with `recorded: false`, so two writers can
   * never fork the chain, duplicate a sequence number, or together exceed the evaluation limit.
   */
  recordEvaluation(record: EvaluationRecord): { event: StoredAuditEvent; recorded: boolean } {
    assertRepresentable(record, "outcome.evaluation_recorded");
    return this.port.recordSystemEventOnce({
      name: EVENT_EVALUATION,
      uniqueAttribute: ATTR_CHAIN_SLOT,
      body: record as unknown as Record<string, unknown>,
      attributes: {
        "outcome.id": record.outcomeId,
        "outcome.verdict": record.verdict,
        "outcome.sequence": record.sequenceNo,
        [ATTR_CHAIN_SLOT]: `${record.outcomeId}#${record.sequenceNo}`
      }
    });
  }

  private scan(name: string): StoredAuditEvent[] {
    const out: StoredAuditEvent[] = [];
    let after = 0;
    for (;;) {
      const page = this.port.readEvents({ name, afterSequence: after, limit: PAGE });
      if (page.length === 0) break;
      out.push(...page);
      if (out.length > MAX_OUTCOME_SCAN_EVENTS) {
        throw new OutcomeIntegrityError(
          "outcome_scan_cap_exceeded",
          `more than ${MAX_OUTCOME_SCAN_EVENTS} ${name} events`
        );
      }
      after = (page[page.length - 1] as StoredAuditEvent).sequence;
      if (page.length < PAGE) break;
    }
    return out;
  }

  private parseAccepted(events: StoredAuditEvent[]): { records: AcceptedRecord[]; problems: string[] } {
    const records: AcceptedRecord[] = [];
    const problems: string[] = [];
    for (const event of events) {
      const parsed = acceptedSchema.safeParse(event.body);
      if (!parsed.success || event.attributes["outcome.id"] !== parsed.data.outcomeId) {
        problems.push(`accepted_record_invalid@${event.sequence}`);
        continue;
      }
      records.push(parsed.data);
    }
    return { records, problems };
  }

  private parseEvaluations(events: StoredAuditEvent[]): { records: EvaluationRecord[]; problems: string[] } {
    const records: EvaluationRecord[] = [];
    const problems: string[] = [];
    for (const event of events) {
      const parsed = evaluationSchema.safeParse(event.body);
      if (!parsed.success || event.attributes["outcome.id"] !== parsed.data.outcomeId) {
        problems.push(`evaluation_record_invalid@${event.sequence}`);
        continue;
      }
      records.push(parsed.data);
    }
    return { records, problems };
  }

  listAccepted(): AcceptedRecord[] {
    const { records } = this.parseAccepted(this.scan(EVENT_ACCEPTED));
    const seen = new Set<string>();
    return records.filter((record) => (seen.has(record.outcomeId) ? false : (seen.add(record.outcomeId), true)));
  }

  load(outcomeId: string): LoadedOutcome | undefined {
    const acceptedScan = this.parseAccepted(this.scan(EVENT_ACCEPTED));
    const accepted = acceptedScan.records.find((record) => record.outcomeId === outcomeId);
    if (accepted === undefined) return undefined;
    const evaluationScan = this.parseEvaluations(this.scan(EVENT_EVALUATION));
    const evaluations = evaluationScan.records
      .filter((record) => record.outcomeId === outcomeId)
      .sort((left, right) => left.sequenceNo - right.sequenceNo);
    const problems = [
      ...this.auditChainProblems(),
      ...acceptedScan.problems,
      ...evaluationScan.problems,
      ...verifyOutcome(accepted, evaluations)
    ];
    return { accepted, evaluations, problems };
  }

  loadAll(): LoadedOutcome[] {
    const acceptedScan = this.parseAccepted(this.scan(EVENT_ACCEPTED));
    const evaluationScan = this.parseEvaluations(this.scan(EVENT_EVALUATION));
    const scanProblems = [...this.auditChainProblems(), ...acceptedScan.problems, ...evaluationScan.problems];
    const seen = new Set<string>();
    return acceptedScan.records
      .filter((record) => (seen.has(record.outcomeId) ? false : (seen.add(record.outcomeId), true)))
      .map((accepted) => {
        const evaluations = evaluationScan.records
          .filter((record) => record.outcomeId === accepted.outcomeId)
          .sort((left, right) => left.sequenceNo - right.sequenceNo);
        // Same rule as load(): a record that does not parse cannot be attributed safely, so it taints every outcome.
        const problems = [...scanProblems, ...verifyOutcome(accepted, evaluations)];
        return { accepted, evaluations, problems };
      });
  }
}

/** Recomputes everything derivable: acceptance hash, plan, the evaluation chain, and each stored verdict. */
export function verifyOutcome(accepted: AcceptedRecord, evaluations: readonly EvaluationRecord[]): string[] {
  const problems: string[] = [];
  const expectedAcceptance = outcomeHash("acceptance", {
    goal: accepted.goal,
    repository: accepted.repository,
    pullRequest: accepted.pullRequest,
    criteria: accepted.criteria,
    maxEvaluations: accepted.limits.maxEvaluations
  });
  if (expectedAcceptance !== accepted.acceptanceHash) problems.push("acceptance_hash_mismatch");
  if (accepted.outcomeId !== `out_${accepted.acceptanceHash.slice(0, 24)}`) problems.push("outcome_id_mismatch");
  try {
    validatePlan(accepted.plan as Parameters<typeof validatePlan>[0]);
  } catch {
    problems.push("plan_invalid");
  }
  // A plan that validates on its own is not enough: it must be the plan these criteria compile to, as evaluate() requires.
  let expectedPlanHash: string | undefined;
  try {
    expectedPlanHash = compilePlan(accepted.criteria).planHash;
  } catch {
    problems.push("plan_recompile_failed");
  }
  if (expectedPlanHash !== undefined && expectedPlanHash !== accepted.plan.planHash)
    problems.push("plan_hash_mismatch");
  let previous = "";
  evaluations.forEach((record, index) => {
    const at = `evaluation#${record.sequenceNo}`;
    if (record.sequenceNo !== index + 1) problems.push(`${at}:sequence_gap`);
    if (record.previousChainHash !== previous) problems.push(`${at}:previous_chain_hash_mismatch`);
    if (record.planHash !== accepted.plan.planHash) problems.push(`${at}:plan_hash_mismatch`);
    const { contentHash, chainHash, evaluationId, ...rest } = record;
    if (evaluationContentHash(rest) !== contentHash) problems.push(`${at}:content_hash_mismatch`);
    if (
      evaluationChainHash({
        outcomeId: record.outcomeId,
        sequenceNo: record.sequenceNo,
        previousChainHash: record.previousChainHash,
        contentHash
      }) !== chainHash
    ) {
      problems.push(`${at}:chain_hash_mismatch`);
    }
    if (evaluationId !== `eval_${chainHash.slice(0, 24)}`) problems.push(`${at}:evaluation_id_mismatch`);
    const recomputed = computeVerdict(record.verdictInput as VerdictInput);
    if (
      recomputed.verdict !== record.verdict ||
      (recomputed.blockKind ?? null) !== record.blockKind ||
      recomputed.reasonCodes.join("|") !== record.reasonCodes.join("|")
    ) {
      problems.push(`${at}:verdict_recompute_mismatch`);
    }
    // Every other field derived from the verdict must also recompute, or a record could carry fabricated guidance.
    const derived = (fields: Pick<EvaluationRecord, "findings" | "criteriaSummary" | "nextActions">): string =>
      outcomeHash("evaluation.derived", sanitizeDeep(fields));
    if (
      derived({
        findings: recomputed.findings,
        criteriaSummary: recomputed.criteriaSummary,
        nextActions: nextActions(recomputed)
      }) !==
      derived({ findings: record.findings, criteriaSummary: record.criteriaSummary, nextActions: record.nextActions })
    ) {
      problems.push(`${at}:derived_fields_recompute_mismatch`);
    }
    if (record.verdict === "PASS" && !recomputed.passPreconditions) problems.push(`${at}:pass_without_preconditions`);
    previous = chainHash;
  });
  return problems;
}
