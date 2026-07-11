import type { BinaryCriterion } from "../evals/graders/independent-grader.js";

export interface DefineOutcomeEvent {
  type: "user.define_outcome";
  description: string;
  rubric: { type: "text"; content: string };
  max_iterations: number;
}

export interface DefineOutcomeRequest {
  events: [DefineOutcomeEvent];
}

export interface ManagedOutcomeTransport {
  sendSessionEvents(sessionId: string, request: DefineOutcomeRequest): Promise<void>;
}

export function buildOutcomeRequest(
  description: string,
  rubric: readonly BinaryCriterion[],
  maxIterations = 3
): DefineOutcomeRequest {
  const normalizedDescription = description.trim();
  if (normalizedDescription.length === 0 || normalizedDescription.length > 4_000) {
    throw new Error("outcome description must contain 1-4000 characters (repository limit)");
  }
  if (rubric.length < 3 || rubric.length > 7) {
    throw new Error("outcome rubric must contain 3-7 criteria");
  }
  if (!Number.isInteger(maxIterations) || maxIterations < 1 || maxIterations > 20) {
    throw new Error("outcome maxIterations must be an integer from 1 through 20");
  }
  const ids = rubric.map((criterion) => criterion.id);
  if (new Set(ids).size !== ids.length) throw new Error("outcome criterion IDs must be unique");

  return {
    events: [
      {
        type: "user.define_outcome",
        description: normalizedDescription,
        rubric: { type: "text", content: renderOutcomeRubric(rubric) },
        max_iterations: maxIterations
      }
    ]
  };
}

export async function defineManagedOutcome(
  transport: ManagedOutcomeTransport,
  sessionId: string,
  description: string,
  rubric: readonly BinaryCriterion[],
  maxIterations = 3
): Promise<DefineOutcomeRequest> {
  if (sessionId.trim().length === 0) throw new Error("managed outcome sessionId is required");
  const request = buildOutcomeRequest(description, rubric, maxIterations);
  await transport.sendSessionEvents(sessionId, request);
  return request;
}

export function renderOutcomeRubric(rubric: readonly BinaryCriterion[]): string {
  return [
    "# Outcome rubric",
    "",
    ...rubric.flatMap((criterion) => [
      `## ${criterion.id}`,
      `- Criterion: ${criterion.description}`,
      `- Pass when: ${criterion.expected}`,
      ""
    ])
  ].join("\n").trimEnd();
}
