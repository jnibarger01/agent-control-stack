import { describe, expect, it } from "vitest";
import { parseGeneralCodingTask } from "./general-coding.js";
import { parseWorkUnitPayload } from "./mission-model.js";

const SHA = "a".repeat(40);
const valid = {
  kind: "coding",
  repository: "/srv/repos/acs",
  baseSha: SHA,
  instructions: "rename the helper",
  files: ["packages/a/src/x.ts", "docs"],
  maxRuntimeMs: 60_000,
  maxFiles: 5
};

describe("coding payload fields for general missions", () => {
  it("keeps the legacy payload unchanged", () => {
    expect(parseWorkUnitPayload("coding", { instructions: "x", files: ["a.ts"] })).toEqual({
      kind: "coding",
      instructions: "x",
      files: ["a.ts"]
    });
  });

  it("accepts and round-trips the repository, revision and bounds", () => {
    expect(parseWorkUnitPayload("coding", valid)).toEqual(valid);
  });

  it.each([
    ["a short revision", { baseSha: "abc123" }],
    ["an uppercase revision", { baseSha: "A".repeat(40) }],
    ["a symbolic ref", { baseSha: "main" }],
    ["a fractional runtime", { maxRuntimeMs: 1.5 }],
    ["a zero runtime", { maxRuntimeMs: 0 }],
    ["a runtime over a day", { maxRuntimeMs: 86_400_001 }],
    ["a zero file cap", { maxFiles: 0 }],
    ["a file cap over 1000", { maxFiles: 1001 }],
    ["a non-string repository", { repository: 7 }]
  ])("rejects %s", (_name, over) => {
    expect(() => parseWorkUnitPayload("coding", { ...valid, ...over })).toThrow(
      /work_unit_payload_invalid|coding payload/u
    );
  });

  it("still rejects unknown fields", () => {
    expect(() => parseWorkUnitPayload("coding", { ...valid, grantScope: "root" })).toThrow(/unknown field grantScope/);
  });
});

describe("general coding task contract", () => {
  it("accepts a complete task", () => {
    expect(parseGeneralCodingTask(valid)).toEqual({
      repository: "/srv/repos/acs",
      baseSha: SHA,
      instructions: "rename the helper",
      files: ["packages/a/src/x.ts", "docs"],
      maxRuntimeMs: 60_000,
      maxFiles: 5
    });
  });

  it.each(["repository", "baseSha", "instructions", "files", "maxRuntimeMs", "maxFiles"])("requires %s", (field) => {
    const { [field]: _omitted, ...rest } = valid as Record<string, unknown>;
    expect(() => parseGeneralCodingTask(rest)).toThrow(/general coding task/u);
  });

  it("requires a coding payload at all", () => {
    expect(() => parseGeneralCodingTask(undefined)).toThrow(/general coding task/u);
    expect(() => parseGeneralCodingTask({ kind: "shell", argv: ["ls"] })).toThrow(/general coding task/u);
  });

  it.each([
    ["a relative repository", { repository: "repos/acs" }],
    ["a repository with a trailing slash", { repository: "/srv/repos/acs/" }],
    ["a repository with a parent segment", { repository: "/srv/repos/../acs" }],
    ["a blank instruction", { instructions: "   " }],
    ["no declared files", { files: [] }],
    ["an absolute file", { files: ["/etc/passwd"] }],
    ["a file that climbs out", { files: ["../outside.ts"] }],
    ["a file with a parent segment", { files: ["a/../b.ts"] }],
    ["a file with a dot segment", { files: ["./a.ts"] }],
    ["a file with a doubled slash", { files: ["a//b.ts"] }],
    ["a file with a backslash", { files: ["a\\b.ts"] }],
    ["an empty file entry", { files: [""] }]
  ])("rejects %s", (_name, over) => {
    expect(() => parseGeneralCodingTask({ ...valid, ...over })).toThrow(/general coding task/u);
  });
});
