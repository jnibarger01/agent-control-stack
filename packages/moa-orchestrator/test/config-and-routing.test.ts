import { describe, expect, it } from "vitest";
import { DEFAULT_MOA_CONFIG, isExternalModel, loadMoaConfig } from "../src/index.js";

describe("MoA config", () => {
  it("makes cheap fully local-only", () => {
    const cheap = DEFAULT_MOA_CONFIG.presets.cheap!;
    expect(cheap.local_only).toBe(true);
    expect([...cheap.advisors.map((advisor) => advisor.model), cheap.aggregator.model].every((model) => model.startsWith("ollama:"))).toBe(true);
  });

  it("rejects local-only presets with external providers", () => {
    expect(() =>
      loadMoaConfig({
        default: "cheap",
        presets: {
          cheap: {
            advisors: [{ id: "a", model: "ollama:qwen3:8b", max_tokens: 100 }],
            aggregator: { id: "agg", model: "openrouter:deepseek/deepseek-v4-pro", max_tokens: 512 },
            allow_advisor_tools: false,
            require_acs_for_mutation: true,
            local_only: true
          }
        }
      })
    ).toThrow("CONFIG_INVALID");
  });

  it("rejects advisor tools and unsafe recursive presets", () => {
    expect(() =>
      loadMoaConfig({
        default: "fast",
        presets: {
          fast: {
            advisors: [{ id: "a", model: "fast", max_tokens: 100 }],
            aggregator: { id: "agg", model: "moa:fast", max_tokens: 512 },
            allow_advisor_tools: true,
            require_acs_for_mutation: true
          }
        }
      })
    ).toThrow("CONFIG_INVALID");
  });

  it("keeps security routing externally configurable without hard-coded opus defaults", () => {
    const security = DEFAULT_MOA_CONFIG.presets.security!;
    expect(JSON.stringify(security)).not.toContain("claude-opus");
    expect(security.aggregator.model).toBe("openai-codex:gpt-5.5");
    expect(security.advisors.some((advisor) => isExternalModel(advisor.model))).toBe(true);
  });
});
