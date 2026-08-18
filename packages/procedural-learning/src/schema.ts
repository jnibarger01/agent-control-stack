import { createHash } from "node:crypto";
import { z } from "zod";

export const FIRST_CLASS_TARGETS = [
  "vite-duplicate-react-debugging",
  "github-pr-conflict-resolution",
  "hermes-mcp-debugging",
  "postgres-migration-validation",
  "systemd-service-debugging",
  "agent-orchestration-safety",
  "react-build-recovery",
  "repo-intake-triage"
] as const;

export type FirstClassTarget = (typeof FIRST_CLASS_TARGETS)[number];

export const candidateStates = [
  "CAPTURED",
  "ELIGIBLE",
  "EXTRACTING",
  "VALIDATING",
  "PROMOTED",
  "REJECTED",
  "QUARANTINED"
] as const;

export type CandidateState = (typeof candidateStates)[number];

export const refinementOutcomes = [
  "NO_CHANGE",
  "CONFIDENCE_INCREASE",
  "SKILL_UPDATE",
  "NEW_VARIANT",
  "DEPRECATE",
  "QUARANTINE"
] as const;

export type RefinementOutcome = (typeof refinementOutcomes)[number];

export const procedureSchema = z.object({
  diagnostic: z.array(z.string().min(1)).min(1),
  repair: z.array(z.string().min(1)).min(1),
  validation: z.array(z.string().min(1)).min(1),
  rollback: z.array(z.string().min(1)).min(1),
  failureModes: z.array(z.string().min(1)).min(1)
});

export const validationEvidenceSchema = z.object({
  passed: z.boolean(),
  commands: z.array(z.string()),
  results: z.array(z.string())
});

export const taskExperienceInputSchema = z.object({
  taskId: z.string().min(1),
  attemptId: z.string().min(1),
  repository: z.string().min(1),
  commitOrDiffId: z.string().optional(),
  agent: z.string().min(1),
  problemSummary: z.string().min(1),
  problemSignals: z.array(z.string().min(1)).min(1),
  errorMessages: z.array(z.string()).default([]),
  taskType: z.string().min(1),
  technologies: z.array(z.string().min(1)).min(1),
  rootCause: z.string().min(1),
  rootCauseKnown: z.boolean(),
  hypothesesFailed: z.number().int().nonnegative(),
  toolCallCount: z.number().int().nonnegative(),
  reasoningStages: z.number().int().nonnegative(),
  materialOutcomeChange: z.boolean(),
  reusableBeyondIncident: z.boolean(),
  trivial: z.boolean(),
  solutionSpecificity: z.number().min(0).max(1),
  uncertainty: z.number().min(0).max(1),
  recurrenceLikelihood: z.number().min(0).max(1),
  crossRepoApplicability: z.number().min(0).max(1),
  operationalRisk: z.number().min(0).max(1),
  timeSavedEstimateMinutes: z.number().nonnegative(),
  completed: z.boolean(),
  contradictoryEvidence: z.boolean(),
  validation: validationEvidenceSchema,
  procedure: procedureSchema,
  proposedSkillName: z.string().min(1),
  explicitSecrets: z.array(z.string()).default([])
});

export type TaskExperienceInput = z.input<typeof taskExperienceInputSchema>;
export type ParsedTaskExperience = z.output<typeof taskExperienceInputSchema>;

export const skillContentSchema = z.object({
  name: z.string().min(1),
  description: z.string().min(1),
  problem_signals: z.array(z.string().min(1)).min(1),
  when_to_use: z.array(z.string().min(1)).min(1),
  when_not_to_use: z.array(z.string().min(1)).min(1),
  prerequisites: z.array(z.string().min(1)).min(1),
  diagnostic_sequence: z.array(z.string().min(1)).min(1),
  repair_sequence: z.array(z.string().min(1)).min(1),
  validation: z.array(z.string().min(1)).min(1),
  rollback: z.array(z.string().min(1)).min(1),
  failure_modes: z.array(z.string().min(1)).min(1),
  evidence_source: z.string().min(1),
  confidence: z.number().min(0).max(1),
  version: z.number().int().positive()
});

export type SkillContent = z.infer<typeof skillContentSchema>;

export interface ScoreBreakdown {
  recurrence_value: number;
  investigation_cost: number;
  generalizability: number;
  validation_strength: number;
  operational_value: number;
  solution_specificity: number;
  uncertainty: number;
  promotion_score: number;
}

export interface GateResult {
  name: string;
  passed: boolean;
  detail: string;
}

export function slugifySkillName(name: string): string {
  const slug = name
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
  if (!slug) {
    throw new Error("skill name must contain a letter or digit");
  }
  return slug;
}

export function stableLearningId(prefix: string, value: unknown): string {
  const digest = createHash("sha256").update(JSON.stringify(value)).digest("hex");
  return `${prefix}_${digest.slice(0, 24)}`;
}

export function tokenize(text: string): Set<string> {
  const stop = new Set(["the", "and", "for", "with", "that", "this", "from", "into", "only", "can", "are"]);
  return new Set(
    text
      .toLowerCase()
      .split(/[^a-z0-9]+/u)
      .filter((token) => token.length > 2 && !stop.has(token))
  );
}

export function jaccard(left: Iterable<string>, right: Iterable<string>): number {
  const a = new Set(left);
  const b = new Set(right);
  if (a.size === 0 && b.size === 0) return 0;
  let intersection = 0;
  for (const token of a) {
    if (b.has(token)) intersection += 1;
  }
  return intersection / (a.size + b.size - intersection);
}

export function scoreExperience(input: ParsedTaskExperience): ScoreBreakdown {
  const recurrence_value = input.recurrenceLikelihood * 20;
  const investigation_cost = Math.min(
    20,
    input.hypothesesFailed * 3 + input.toolCallCount * 0.2 + input.reasoningStages * 2
  );
  const generalizability = input.crossRepoApplicability * 20;
  const validation_strength = input.validation.passed ? 15 + Math.min(5, input.validation.commands.length) : 0;
  const operational_value = input.operationalRisk * 10 + Math.min(10, input.timeSavedEstimateMinutes / 10);
  const solution_specificity = input.solutionSpecificity * 20;
  const uncertainty = input.uncertainty * 20;
  const promotion_score = Number(
    (
      recurrence_value +
      investigation_cost +
      generalizability +
      validation_strength +
      operational_value -
      solution_specificity -
      uncertainty
    ).toFixed(3)
  );
  return {
    recurrence_value,
    investigation_cost,
    generalizability,
    validation_strength,
    operational_value,
    solution_specificity,
    uncertainty,
    promotion_score
  };
}

export function evaluateGates(input: ParsedTaskExperience, score: ScoreBreakdown): GateResult[] {
  return [
    {
      name: "task_completed",
      passed: input.completed,
      detail: input.completed ? "task completed" : "task_not_completed"
    },
    {
      name: "validation_passed",
      passed: input.validation.passed,
      detail: input.validation.passed ? "validation passed" : "validation_failed"
    },
    {
      name: "material_outcome_change",
      passed: input.materialOutcomeChange,
      detail: input.materialOutcomeChange ? "outcome changed" : "no_material_outcome_change"
    },
    {
      name: "reusable_beyond_incident",
      passed: input.reusableBeyondIncident,
      detail: input.reusableBeyondIncident ? "reusable" : "incident_specific"
    },
    {
      name: "not_trivial",
      passed: !input.trivial,
      detail: input.trivial ? "trivial_task" : "nontrivial"
    },
    {
      name: "root_cause_known",
      passed: input.rootCauseKnown && input.rootCause.trim().length > 0 && input.rootCause !== "UNKNOWN",
      detail: input.rootCauseKnown ? "root cause known" : "root_cause_unknown"
    },
    {
      name: "no_contradictory_evidence",
      passed: !input.contradictoryEvidence,
      detail: input.contradictoryEvidence ? "contradictory_evidence" : "consistent"
    },
    {
      name: "procedure_explained",
      passed:
        input.procedure.diagnostic.length > 0 &&
        input.procedure.repair.length > 0 &&
        input.procedure.validation.length > 0,
      detail: "procedure present"
    },
    {
      name: "promotion_score",
      passed: score.promotion_score >= 35,
      detail: `score=${score.promotion_score}`
    }
  ];
}

export function generalizeText(value: string): string {
  return value
    .replace(/\/home\/[^/\s]+/g, "<workspace>")
    .replace(/\/Users\/[^/\s]+/g, "<workspace>")
    .replace(/\bline \d+\b/gi, "the relevant line");
}
