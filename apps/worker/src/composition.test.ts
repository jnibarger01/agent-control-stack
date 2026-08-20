import { describe, expect, it } from "vitest";
import { createGovernedExecutionComposition, executionMode } from "./composition.js";

describe("governed execution composition", () => {
  it("registers every P0 provider while keeping the boundary dry-run", () => {
    const composition = createGovernedExecutionComposition({
      store: {} as never,
      workspaceManager: {} as never,
      authorityVerifier: { verify: async () => ({}) } as never
    });

    expect(executionMode).toBe("dry_run");
    expect(["claude", "gemini", "grok", "opencode", "pi"].every((id) => composition.registry.get(id))).toBe(true);
    expect(() => composition.controllerFor("missing", {} as never)).toThrow("no adapter");
  });
});
