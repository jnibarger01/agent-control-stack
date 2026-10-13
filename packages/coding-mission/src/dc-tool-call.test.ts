import { describe, expect, it } from "vitest";
import { dcArgumentsHash, parseDcToolCall } from "./dc-tool-call.js";
import { parseWorkUnitPayload } from "./mission-model.js";

const args = { path: "/srv/repos/acs/README.md" };
const valid = {
  kind: "tool",
  toolName: "read_file",
  arguments: args,
  argsHash: dcArgumentsHash("read_file", args),
  maxRuntimeMs: 30_000
};

describe("tool payload fields for the Desktop Commander lane", () => {
  it("keeps the legacy tool payload unchanged", () => {
    expect(parseWorkUnitPayload("tool", { toolName: "read_file", argsHash: "h" })).toEqual({
      kind: "tool",
      toolName: "read_file",
      argsHash: "h"
    });
  });

  it("round-trips arguments and the runtime bound", () => {
    expect(parseWorkUnitPayload("tool", valid)).toEqual(valid);
  });

  it.each([
    ["array arguments", { arguments: [1] }],
    ["null arguments", { arguments: null }],
    ["string arguments", { arguments: "x" }],
    ["oversized arguments", { arguments: { blob: "x".repeat(40_000) } }],
    ["a zero runtime", { maxRuntimeMs: 0 }],
    ["a fractional runtime", { maxRuntimeMs: 1.5 }],
    ["a runtime over a day", { maxRuntimeMs: 86_400_001 }]
  ])("rejects %s", (_name, over) => {
    expect(() => parseWorkUnitPayload("tool", { ...valid, ...over })).toThrow(/tool payload/u);
  });

  it("still rejects unknown fields", () => {
    expect(() => parseWorkUnitPayload("tool", { ...valid, grantScope: "root" })).toThrow(/unknown field grantScope/u);
  });
});

describe("dc tool call contract", () => {
  it("accepts a complete call", () => {
    const { kind: _kind, ...call } = valid;
    expect(parseDcToolCall(valid)).toEqual(call);
  });

  it.each(["toolName", "arguments", "argsHash", "maxRuntimeMs"])("requires %s", (field) => {
    const { [field]: _omitted, ...rest } = valid as Record<string, unknown>;
    expect(() => parseDcToolCall(rest)).toThrow(/dc tool call/u);
  });

  it("requires a tool payload", () => {
    expect(() => parseDcToolCall(undefined)).toThrow(/dc tool call/u);
    expect(() => parseDcToolCall({ kind: "coding", instructions: "x" })).toThrow(/dc tool call/u);
  });

  it("rejects arguments that do not match their hash", () => {
    expect(() => parseDcToolCall({ ...valid, arguments: { path: "/etc/passwd" } })).toThrow(/does not match/u);
  });

  it("binds the hash to the tool name", () => {
    expect(dcArgumentsHash("read_file", args)).not.toBe(dcArgumentsHash("list_directory", args));
    expect(() => parseDcToolCall({ ...valid, toolName: "list_directory" })).toThrow(/does not match/u);
  });
});
