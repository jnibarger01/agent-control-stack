import { describe, expect, it } from "vitest";
import { EnvSecretSource } from "./source.js";

describe("EnvSecretSource", () => {
  it("resolves a configured scope from the injected env source", () => {
    const source = new EnvSecretSource({ openai: "OPENAI_API_KEY" }, { OPENAI_API_KEY: "sk-test-value" });

    expect(source.resolve("openai")).toBe("sk-test-value");
  });

  it("returns undefined for a scope with no mapping entry", () => {
    const source = new EnvSecretSource({ openai: "OPENAI_API_KEY" }, { OPENAI_API_KEY: "sk-test-value" });

    expect(source.resolve("unmapped")).toBeUndefined();
  });

  it("returns undefined when the mapped env var is unset in the source", () => {
    const source = new EnvSecretSource({ openai: "OPENAI_API_KEY" }, {});

    expect(source.resolve("openai")).toBeUndefined();
  });

  it("defaults to process.env when no source is injected", () => {
    process.env.ACS_SECRET_BROKER_TEST_VAR = "from-process-env";
    try {
      const source = new EnvSecretSource({ scope: "ACS_SECRET_BROKER_TEST_VAR" });
      expect(source.resolve("scope")).toBe("from-process-env");
    } finally {
      delete process.env.ACS_SECRET_BROKER_TEST_VAR;
    }
  });
});
