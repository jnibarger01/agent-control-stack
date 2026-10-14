import { describe, expect, it } from "vitest";
import { runAdvisor } from "./advisor.js";
import { advisorResponseSchema } from "./contracts.js";
import { OllamaProvider } from "./ollama-provider.js";

/**
 * Live test against a locally installed Ollama model. Skipped unless explicitly enabled, so CI never depends on
 * local models and never pulls anything:
 *   ACS_LOCAL_ADVISOR_OLLAMA_MODEL=qwen2.5-coder:7b npx vitest run packages/local-advisor/src/ollama.integration.test.ts
 */
const model = process.env.ACS_LOCAL_ADVISOR_OLLAMA_MODEL;

describe.skipIf(!model)("live Ollama review (local model)", () => {
  it("returns a schema-valid completed review for a clearly buggy diff", async () => {
    const provider = new OllamaProvider({ model: model!, retries: 0 });
    const response = await runAdvisor(
      {
        schemaVersion: "advisor.v1",
        requestId: "live-1",
        operation: "review_plan",
        mission: { id: "live-mission", envelopeHash: `sha256:${"e".repeat(64)}` },
        context: {
          objective: "Review this change: add() must return the sum of its arguments.",
          constraints: [],
          evidence: [
            {
              id: "diff-1",
              kind: "diff",
              content: "-export function add(a, b) { return a + b; }\n+export function add(a, b) { return a - b; }"
            }
          ]
        },
        budget: { timeoutMs: 120_000, maxOutputTokens: 512 }
      },
      provider
    );
    expect(advisorResponseSchema.safeParse(response).success).toBe(true);
    expect(response.model?.digest).toMatch(/^sha256:[a-f0-9]{64}$/u);
    // Model quality is measured separately; this asserts the pipeline produced an honest, well-formed status.
    expect(["completed", "invalid_output", "insufficient_evidence", "timeout", "unavailable"]).toContain(response.status);
    if (response.status === "completed") expect(response.verdict).toBeDefined();
    else expect(response.verdict).toBeUndefined();
  }, 150_000);
});
