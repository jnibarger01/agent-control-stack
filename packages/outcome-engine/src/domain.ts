import { z } from "zod";

export const SCHEMA_ACCEPTED = "acs.outcome.accepted.v1" as const;
export const SCHEMA_EVALUATION = "acs.outcome.evaluation.v1" as const;

export const VERDICTS = ["PASS", "PARTIAL", "BLOCK", "FAIL"] as const;
export type Verdict = (typeof VERDICTS)[number];

/** Most severe first. A BLOCK carries the kind of its most severe undecided or gate reason. */
export const BLOCK_KINDS = [
  "integrity",
  "authority",
  "evidence_unavailable",
  "simulated_only",
  "needs_human",
  "pending_external"
] as const;
export type BlockKind = (typeof BLOCK_KINDS)[number];

export const EVIDENCE_GRADES = ["acs_observed", "forge_attested", "simulated", "fixture", "asserted"] as const;
export type EvidenceGrade = (typeof EVIDENCE_GRADES)[number];
export const TRUSTED_GRADES: ReadonlySet<EvidenceGrade> = new Set<EvidenceGrade>(["acs_observed", "forge_attested"]);

/** The closed set of things the engine can ever do. Nothing here changes a pull request, a branch or a deployment. */
export const READ_ONLY_ACTIONS = [
  "github_read_pr",
  "verify_audit_chain",
  "run_pure_probe",
  "append_outcome_event"
] as const;
export type ReadOnlyAction = (typeof READ_ONLY_ACTIONS)[number];

const criterionId = z.string().regex(/^[a-z][a-z0-9_.-]{0,63}$/u);
const description = z.string().min(1).max(500).optional();
const glob = z.string().min(1).max(200);

export const criterionSchema = z.discriminatedUnion("kind", [
  z.strictObject({ id: criterionId, kind: z.literal("pr_open"), required: z.boolean(), description }),
  z.strictObject({
    id: criterionId,
    kind: z.literal("merge_gate_eligible"),
    required: z.boolean(),
    description,
    policy: z.enum(["repo_default", "assessment"]).default("assessment")
  }),
  z.strictObject({
    id: criterionId,
    kind: z.literal("required_checks_succeeded"),
    required: z.boolean(),
    description,
    checks: z
      .array(z.strictObject({ name: z.string().min(1).max(200), appSlug: z.string().min(1).max(100) }))
      .min(1)
      .max(32),
    docsOnlyAcceptable: z.boolean().default(false)
  }),
  z.strictObject({
    id: criterionId,
    kind: z.literal("files_within_scope"),
    required: z.boolean(),
    description,
    allowGlobs: z.array(glob).max(32).default(["**"]),
    forbidGlobs: z.array(glob).max(32).default([])
  }),
  z.strictObject({
    id: criterionId,
    kind: z.literal("verification_surface_untouched"),
    required: z.boolean(),
    description
  })
]);
export type Criterion = z.infer<typeof criterionSchema>;
export type CriterionKind = Criterion["kind"];

/** Reserved for a later slice: needs a verified binding between a work item and the pull request. Rejected at accept. */
export const RESERVED_CRITERION_KINDS: readonly string[] = ["acs_work_item_real_success"];

/** Every outcome must at least require that the pull request is open and passes the merge gate under some policy. */
export const PR_READINESS_FLOOR: ReadonlyArray<{ kind: CriterionKind }> = [
  { kind: "pr_open" },
  { kind: "merge_gate_eligible" }
];

export const repositorySchema = z
  .string()
  .regex(/^[A-Za-z0-9](?:[A-Za-z0-9]|-(?=[A-Za-z0-9])){0,38}\/[A-Za-z0-9._-]{1,100}$/u)
  // Same rule as the GitHub reader's parseRepository: `.` and `..` are traversal segments, never repository names.
  .refine((value) => {
    const name = value.slice(value.indexOf("/") + 1);
    return name !== "." && name !== "..";
  }, "repository name may not be . or ..");

/** Strict: a caller can never supply a verdict, status, grade, actor, approval or authority field. */
export const acceptInputSchema = z.strictObject({
  goal: z.string().trim().min(1).max(4000),
  repository: repositorySchema,
  pullRequest: z.number().int().positive(),
  criteria: z.array(z.unknown()).min(1).max(32).optional(),
  expiresAt: z.iso.datetime().optional(),
  maxEvaluations: z.number().int().min(1).max(1000).default(100)
});
export type AcceptInput = z.infer<typeof acceptInputSchema>;

export interface PlanStep {
  id: string;
  action: ReadOnlyAction;
  dependsOn: string[];
  criterionId?: string;
  kind?: string;
  executor: string;
}

export interface Plan {
  steps: PlanStep[];
  planHash: string;
}

export interface EvidenceRef {
  grade: EvidenceGrade;
  source: string;
  digest: string;
}

export type ProbeState = "satisfied" | "unsatisfied" | "undecided";

export interface ProbeResult {
  criterionId: string;
  kind: string;
  state: ProbeState;
  reasonCodes: string[];
  findings: string[];
  evidence: EvidenceRef[];
}

export interface Gate {
  gate: "G1" | "G1b" | "G2" | "G3" | "G4";
  reasonCode: string;
  blockKind: BlockKind;
  detail: string;
}

export type ReaderProvenance = "live_github" | "fixture";

export interface CriterionRef {
  id: string;
  kind: string;
  required: boolean;
}

export interface VerdictInput {
  criteria: CriterionRef[];
  gates: Gate[];
  results: ProbeResult[];
  provenance: ReaderProvenance;
  integrityOk: boolean;
  snapshotStable: boolean;
  headBound: boolean;
  prState: "OPEN" | "CLOSED" | "MERGED" | "UNKNOWN";
}

export interface VerdictResult {
  verdict: Verdict;
  blockKind?: BlockKind;
  reasonCodes: string[];
  findings: string[];
  criteriaSummary: {
    requiredSatisfied: number;
    requiredUnsatisfied: number;
    requiredUndecided: number;
    optionalUnsatisfied: string[];
  };
  passPreconditions: boolean;
}
