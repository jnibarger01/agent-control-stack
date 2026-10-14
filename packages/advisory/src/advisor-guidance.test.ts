import { describe, expect, it } from "vitest";
import { buildAdvisorModelRequest, consultAdvisorModel, type AdvisorModelCaller } from "./advisor-guidance.js";

describe("advisor model request", () => {
  it("sends no tools", () => {
    const request = buildAdvisorModelRequest({
      transportModel: "ollama:advisor",
      checkpoint: "before_approach",
      projectionText: "[]",
      timeoutMs: 1000
    });
    expect(request).not.toHaveProperty("tools");
    expect(Object.keys(request).sort()).toEqual(["maxTokens", "model", "signal", "system", "timeoutMs", "user"].sort());
  });

  it("stores reviewed guidance and token counts", async () => {
    const seen: unknown[] = [];
    const caller: AdvisorModelCaller = {
      async complete(request) {
        seen.push(request);
        return {
          text: JSON.stringify({ disposition: "reviewed", guidance: "narrow the change" }),
          inputTokens: 4,
          outputTokens: 6
        };
      }
    };
    const draft = await consultAdvisorModel({
      caller,
      advisorModelId: "claude-opus-5-5",
      transportModel: "ollama:advisor",
      checkpoint: "recurring_failure",
      projectionText: "[]"
    });
    expect(draft).toMatchObject({
      disposition: "reviewed",
      guidance: "narrow the change",
      declineReason: null,
      errorCode: null,
      inputTokens: 4,
      outputTokens: 6
    });
    expect(seen[0]).not.toHaveProperty("tools");
  });

  it("records an approval-shaped response as unavailable and invents no guidance", async () => {
    const caller: AdvisorModelCaller = {
      async complete() {
        return JSON.stringify({ disposition: "reviewed", guidance: "ship it", approved: true });
      }
    };
    const draft = await consultAdvisorModel({
      caller,
      advisorModelId: "claude-opus-5-5",
      transportModel: "ollama:advisor",
      checkpoint: "before_completion",
      projectionText: "[]"
    });
    expect(draft).toMatchObject({
      disposition: "unavailable",
      guidance: null,
      declineReason: null,
      errorCode: "advisor_output_invalid"
    });
  });

  it("maps transport failure, invalid JSON, and timeout to distinct unavailable codes", async () => {
    const transport: AdvisorModelCaller = {
      async complete() {
        throw new Error("socket down");
      }
    };
    const invalid: AdvisorModelCaller = {
      async complete() {
        return "not-json";
      }
    };
    const slow: AdvisorModelCaller = {
      async complete(request) {
        await new Promise((_resolve, reject) => {
          request.signal?.addEventListener("abort", () => {
            const error = new Error("aborted");
            error.name = "AbortError";
            reject(error);
          });
        });
        return "{}";
      }
    };
    expect(
      (
        await consultAdvisorModel({
          caller: transport,
          advisorModelId: "claude-opus-5-5",
          transportModel: "ollama:advisor",
          checkpoint: "before_approach",
          projectionText: "[]"
        })
      ).errorCode
    ).toBe("advisor_unavailable");
    expect(
      (
        await consultAdvisorModel({
          caller: invalid,
          advisorModelId: "claude-opus-5-5",
          transportModel: "ollama:advisor",
          checkpoint: "before_approach",
          projectionText: "[]"
        })
      ).errorCode
    ).toBe("advisor_output_invalid");
    expect(
      (
        await consultAdvisorModel({
          caller: slow,
          advisorModelId: "claude-opus-5-5",
          transportModel: "ollama:advisor",
          checkpoint: "before_approach",
          projectionText: "[]",
          timeoutMs: 20
        })
      ).errorCode
    ).toBe("advisor_timeout");
  });
});
