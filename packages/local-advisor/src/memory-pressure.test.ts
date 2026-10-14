import { describe, expect, it } from "vitest";
import { runAdvisor } from "./advisor.js";
import { OllamaProvider } from "./ollama-provider.js";
import { ProviderError, type AdvisorProvider, type GenerateInput, type GenerateResult } from "./provider.js";

const request = {
  schemaVersion: "advisor.v1",
  requestId: "req-mem",
  operation: "diagnose_failure",
  mission: { id: "mission-mem", envelopeHash: `sha256:${"a".repeat(64)}` },
  context: {
    objective: "Why did the test fail?",
    constraints: [],
    evidence: [{ id: "log-1", kind: "log", content: "timeout after 30s" }]
  },
  budget: { timeoutMs: 5_000, maxOutputTokens: 128 }
};

describe("memory pressure and provider failure", () => {
  it("does not call Ollama when free memory is below the floor", async () => {
    let calls = 0;
    const provider = new OllamaProvider({
      model: "qwen2.5-coder:7b",
      minFreeMemoryBytes: 100,
      freeMemory: () => 10,
      fetchImpl: (async () => {
        calls += 1;
        return new Response("no", { status: 500 });
      }) as typeof fetch
    });
    await expect(provider.generate({
      system: "s",
      user: "u",
      format: {},
      maxOutputTokens: 64,
      signal: new AbortController().signal
    })).rejects.toMatchObject({ kind: "memory_pressure" });
    expect(calls).toBe(0);
  });

  it("maps memory pressure to a non-verdict status", async () => {
    const failing: AdvisorProvider = {
      providerId: "ollama",
      generate(_input: GenerateInput): Promise<GenerateResult> {
        return Promise.reject(new ProviderError("memory_pressure", "low ram"));
      }
    };
    const response = await runAdvisor(request, failing);
    expect(response.status).toBe("unavailable");
    expect(response.reason).toBe("memory_pressure");
    expect(response.verdict).toBeUndefined();
    expect(response.findings).toEqual([]);
  });
});
