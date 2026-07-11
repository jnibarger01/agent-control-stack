import { describe, expect, it } from "vitest";
import { buildOutcomeRequest, defineManagedOutcome, type DefineOutcomeRequest } from "./outcomes.js";

const rubric = [
  { id: "tests", description: "Tests pass", expected: "Output shows exit 0" },
  { id: "score", description: "Score meets baseline", expected: "Printed score is at least baseline" },
  { id: "tasks", description: "Tasks stay fixed", expected: "Corpus hash is unchanged" }
];

describe("managed outcome wiring", () => {
  it("builds the documented user.define_outcome text-rubric event", () => {
    expect(buildOutcomeRequest("Improve eval score", rubric, 5)).toEqual({
      events: [
        {
          type: "user.define_outcome",
          description: "Improve eval score",
          rubric: {
            type: "text",
            content:
              "# Outcome rubric\n\n## tests\n- Criterion: Tests pass\n- Pass when: Output shows exit 0\n\n## score\n- Criterion: Score meets baseline\n- Pass when: Printed score is at least baseline\n\n## tasks\n- Criterion: Tasks stay fixed\n- Pass when: Corpus hash is unchanged"
          },
          max_iterations: 5
        }
      ]
    });
  });

  it("sends through an injected transport without guessing an endpoint", async () => {
    const calls: Array<{ sessionId: string; request: DefineOutcomeRequest }> = [];
    const request = await defineManagedOutcome(
      { sendSessionEvents: async (sessionId, body) => void calls.push({ sessionId, request: body }) },
      "session-1",
      "Improve eval score",
      rubric
    );
    expect(calls).toEqual([{ sessionId: "session-1", request }]);
  });

  it("enforces rubric and documented iteration bounds", () => {
    expect(() => buildOutcomeRequest("x", rubric.slice(0, 2), 3)).toThrow("3-7");
    expect(() => buildOutcomeRequest("x", rubric, 21)).toThrow("1 through 20");
  });
});
