import { describe, expect, it } from "vitest";
import { parseCatalog } from "./catalog.js";

const base = { providerId: "p", model: "m:1b", kind: "local", taskTypes: ["summarization"] };

describe("parseCatalog", () => {
  it("applies the documented defaults", () => {
    const [local, hosted] = parseCatalog([base, { ...base, providerId: "h", kind: "hosted" }]);
    expect(local).toMatchObject({ maxPrivacy: "restricted", needsGpu: false });
    expect(hosted).toMatchObject({ maxPrivacy: "internal" });
    expect(local!.priority).toBeLessThan(hosted!.priority);
  });

  it("dedupes and sorts task types and keeps explicit settings", () => {
    const [entry] = parseCatalog([
      { ...base, taskTypes: ["b", "a", "b"], maxPrivacy: "confidential", priority: 3, vramBytes: 1000 }
    ]);
    expect(entry).toMatchObject({ taskTypes: ["a", "b"], maxPrivacy: "confidential", priority: 3, needsGpu: true, vramBytes: 1000 });
  });

  it.each([
    ["an unknown field", [{ ...base, surprise: true }]],
    ["no task types", [{ ...base, taskTypes: [] }]],
    ["a bad task type", [{ ...base, taskTypes: ["Bad Type"] }]],
    ["a bad provider id", [{ ...base, providerId: "../x" }]],
    ["a bad kind", [{ ...base, kind: "cloud" }]],
    ["a bad privacy class", [{ ...base, maxPrivacy: "secret" }]],
    ["a non-positive context window", [{ ...base, contextWindow: 0 }]],
    ["a duplicate entry", [base, base]],
    ["memory on a hosted model", [{ ...base, kind: "hosted", memoryBytes: 1 }]],
    ["vram without a gpu", [{ ...base, vramBytes: 1, needsGpu: false }]]
  ])("rejects %s", (_name, input) => {
    expect(() => parseCatalog(input)).toThrow();
  });

  it("rejects a non-array", () => {
    expect(() => parseCatalog({})).toThrow();
  });
});
