import { DecisionModelUnavailable, nextOperationQuestion } from "@agent-control-stack/decision-engine";
import type { DecisionState } from "@agent-control-stack/mission-state";
import { describe, expect, it } from "vitest";
import { createNimbleAdapter } from "./adapter.js";

const state = {
  missionId: "mis_123",
  goal: "Deploy gateway release and verify health",
  operations: [{ id: "op_deploy", status: "pending", kind: "git.push" }],
  evidence: ["build:sha256:abc"]
} as DecisionState;

function jsonResponse(body: unknown, status = 200, headers: Record<string, string> = {}): Response {
  return new Response(JSON.stringify(body), { status, headers });
}

describe("nimble adapter", () => {
  it("maps a matching model choice and keeps transport evidence", async () => {
    const adapter = createNimbleAdapter({
      url: "http://127.0.0.1:9/v1/systemone",
      model: "nimble",
      apiKey: "secret",
      requestId: () => "req_1",
      now: () => 1_000,
      fetchImpl: async (_url, init) => {
        const headers = init?.headers as Record<string, string>;
        expect(headers.authorization).toBe("Bearer secret");
        expect(headers["x-request-id"]).toBe("req_1");
        const body = JSON.parse(String(init?.body));
        expect(body.model).toBe("nimble");
        return jsonResponse({
          model: "nimble",
          answers: { next_operation: { type: "choice", choice: "op_deploy", confidence: 0.94, probabilities: { op_deploy: 1 } } }
        });
      }
    });
    await expect(
      adapter.answer({ questions: [nextOperationQuestion("next_operation", ["op_deploy"])], state })
    ).resolves.toEqual({
      answers: [{ id: "next_operation", choice: "op_deploy", confidence: 0.94 }]
    });
    expect(adapter.evidence()).toMatchObject({
      requestId: "req_1",
      modelRequested: "nimble",
      modelReported: "nimble",
      unavailable: false,
      httpStatus: 200
    });
  });

  it("escalates a timeout instead of returning a choice", async () => {
    const adapter = createNimbleAdapter({
      url: "http://127.0.0.1:9/v1/systemone",
      model: "nimble",
      maxRetries: 0,
      sleep: async () => undefined,
      fetchImpl: () => {
        const error = new Error("aborted");
        error.name = "AbortError";
        throw error;
      }
    });
    await expect(
      adapter.answer({ questions: [nextOperationQuestion("next_operation", ["op_deploy"])], state })
    ).rejects.toBeInstanceOf(DecisionModelUnavailable);
    expect(adapter.evidence()).toMatchObject({ unavailable: true, reason: "timeout" });
  });

  it("retries a retryable status and then accepts the model", async () => {
    let calls = 0;
    const adapter = createNimbleAdapter({
      url: "http://127.0.0.1:9/v1/systemone",
      model: "nimble",
      sleep: async () => undefined,
      fetchImpl: async () => {
        calls += 1;
        if (calls === 1) return jsonResponse({ error: "overloaded" }, 529, { "retry-after": "0" });
        return jsonResponse({
          model: "nimble",
          answers: { next_operation: { type: "choice", choice: "op_deploy", confidence: 0.91 } }
        });
      }
    });
    await expect(
      adapter.answer({ questions: [nextOperationQuestion("next_operation", ["op_deploy"])], state })
    ).resolves.toMatchObject({ answers: [{ choice: "op_deploy" }] });
    expect(calls).toBe(2);
    expect(adapter.evidence()?.attempts).toBe(2);
  });

  it("rejects a different reported model", async () => {
    const adapter = createNimbleAdapter({
      url: "http://127.0.0.1:9/v1/systemone",
      model: "nimble",
      maxRetries: 0,
      fetchImpl: async () =>
        jsonResponse({
          model: "jev-1.13.0",
          answers: { next_operation: { type: "choice", choice: "op_deploy", confidence: 0.99 } }
        })
    });
    await expect(
      adapter.answer({ questions: [nextOperationQuestion("next_operation", ["op_deploy"])], state })
    ).rejects.toBeInstanceOf(DecisionModelUnavailable);
    expect(adapter.evidence()).toMatchObject({ reason: "model identity mismatch", modelReported: "jev-1.13.0" });
  });

  it("is unavailable when transport settings are absent", async () => {
    const adapter = createNimbleAdapter({ model: undefined, url: undefined, fetchImpl: async () => jsonResponse({}) });
    await expect(
      adapter.answer({ questions: [nextOperationQuestion("next_operation", ["op_deploy"])], state })
    ).rejects.toBeInstanceOf(DecisionModelUnavailable);
  });
});
