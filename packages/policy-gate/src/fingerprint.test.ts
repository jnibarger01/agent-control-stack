import { describe, expect, it } from "vitest";
import { actionFingerprint } from "./fingerprint.js";
import type { PolicyContext } from "./policy.js";

const context = (params: Record<string, unknown>): PolicyContext => ({
  workItemId: "work-1",
  actor: "actor-1",
  operation: "create",
  requester: "requester-1",
  risk: "high",
  action: { kind: "shell", description: "run a command", params },
  command: ["node", "-e", "1"],
  cwd: "/tmp",
  paths: ["/tmp/input"],
  network: false,
  write: true,
  destructive: false
});

describe("action fingerprints", () => {
  it("is invariant under nested parameter key ordering", () => {
    expect(actionFingerprint(context({ z: { b: 2, a: 1 }, a: ["x", { d: true, c: false }] }))).toBe(
      actionFingerprint(context({ a: ["x", { c: false, d: true }], z: { a: 1, b: 2 } }))
    );
  });

  it("changes when a security-relevant request field changes", () => {
    expect(actionFingerprint(context({ command: "echo safe" }))).not.toBe(
      actionFingerprint({ ...context({ command: "echo safe" }), write: false })
    );
    expect(actionFingerprint(context({ command: "echo safe" }))).not.toBe(
      actionFingerprint(context({ command: "echo unsafe" }))
    );
  });

  it("is deterministic across repeated evaluations", () => {
    const request = context({ nested: { b: [3, 2, 1], a: "stable" } });
    expect(new Set(Array.from({ length: 100 }, () => actionFingerprint(request))).size).toBe(1);
  });
});
