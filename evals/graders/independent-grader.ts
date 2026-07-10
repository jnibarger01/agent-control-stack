import type { CompletionResult, ModelProvider } from "../../harness/model-provider.js";
import { route } from "../../harness/routing.js";

export interface BinaryCriterion {
  id: string;
  description: string;
  expected: string;
}

export interface GraderTask {
  id: string;
  input: string;
  context: unknown;
  reference?: unknown;
}

export interface CriterionGrade {
  criterionId: string;
  pass: boolean;
  justification: string;
}

export interface GradeResult {
  pass: boolean;
  criteria: CriterionGrade[];
  receipt: CompletionResult;
}

export interface GradeCandidateInput {
  provider: ModelProvider;
  task: GraderTask;
  rubric: readonly BinaryCriterion[];
  candidateOutput: string;
  maxBudgetUsd: number;
  timeoutMs: number;
}

export const GRADER_SYSTEM_PROMPT = `You are an independent binary rubric grader.

Evaluate only the supplied task, rubric, and candidate output. Do not infer or
request the maker's reasoning, self-assessment, or hidden state. Return one
result for every rubric criterion. Each justification must be one line and
must cite observable candidate-output evidence. JSON only.`;

export const GRADER_JSON_SCHEMA = {
  type: "object",
  additionalProperties: false,
  properties: {
    criteria: {
      type: "array",
      items: {
        type: "object",
        additionalProperties: false,
        properties: {
          criterionId: { type: "string" },
          pass: { type: "boolean" },
          justification: { type: "string" }
        },
        required: ["criterionId", "pass", "justification"]
      }
    }
  },
  required: ["criteria"]
} as const;

export function buildGraderPayload(
  task: GraderTask,
  rubric: readonly BinaryCriterion[],
  candidateOutput: string
): { task: GraderTask; rubric: readonly BinaryCriterion[]; candidateOutput: string } {
  return { task, rubric, candidateOutput };
}

export async function gradeCandidate(input: GradeCandidateInput): Promise<GradeResult> {
  if (input.rubric.length < 3 || input.rubric.length > 7) {
    throw new Error("grader rubric must contain 3-7 binary criteria");
  }

  const model = route("grader", 0, null);
  const payload = buildGraderPayload(input.task, input.rubric, input.candidateOutput);
  const receipt = await input.provider.complete({
    model,
    system: GRADER_SYSTEM_PROMPT,
    prompt: JSON.stringify(payload),
    maxBudgetUsd: input.maxBudgetUsd,
    timeoutMs: input.timeoutMs,
    jsonSchema: GRADER_JSON_SCHEMA
  });

  const criteria = parseCriterionGrades(receipt.text, input.rubric);
  return { pass: criteria.every((criterion) => criterion.pass), criteria, receipt };
}

export function parseCriterionGrades(raw: string, rubric: readonly BinaryCriterion[]): CriterionGrade[] {
  const value = parseJsonObject(raw);
  if (!isRecord(value) || !Array.isArray(value.criteria) || Object.keys(value).some((key) => key !== "criteria")) {
    throw new Error("grader response must contain only a criteria array");
  }

  const expectedIds = new Set(rubric.map((criterion) => criterion.id));
  const seen = new Set<string>();
  const parsed = value.criteria.map((entry): CriterionGrade => {
    if (!isRecord(entry) || !hasExactKeys(entry, ["criterionId", "pass", "justification"])) {
      throw new Error("invalid criterion grade object");
    }
    const { criterionId, pass, justification } = entry;
    if (typeof criterionId !== "string" || !expectedIds.has(criterionId)) {
      throw new Error(`unknown criterion grade: ${String(criterionId)}`);
    }
    if (seen.has(criterionId)) throw new Error(`duplicate criterion grade: ${criterionId}`);
    if (typeof pass !== "boolean") throw new Error(`criterion ${criterionId} pass must be boolean`);
    if (typeof justification !== "string" || justification.trim().length === 0 || /[\r\n]/.test(justification)) {
      throw new Error(`criterion ${criterionId} justification must be one non-empty line`);
    }
    seen.add(criterionId);
    return { criterionId, pass, justification: justification.trim() };
  });

  if (seen.size !== expectedIds.size) {
    const missing = [...expectedIds].filter((id) => !seen.has(id));
    throw new Error(`grader response omitted criteria: ${missing.join(", ")}`);
  }
  return parsed;
}

function parseJsonObject(raw: string): unknown {
  const trimmed = raw.trim();
  const unfenced = trimmed.startsWith("```")
    ? trimmed.replace(/^```(?:json)?\s*/i, "").replace(/\s*```$/, "")
    : trimmed;
  try {
    return JSON.parse(unfenced);
  } catch {
    throw new Error("grader returned invalid JSON");
  }
}

function hasExactKeys(value: Record<string, unknown>, keys: string[]): boolean {
  const actual = Object.keys(value).sort();
  const expected = [...keys].sort();
  return actual.length === expected.length && actual.every((key, index) => key === expected[index]);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
