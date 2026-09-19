import { describe, expect, it } from "vitest";
import { canonicalActionEnvelope } from "./action-envelope.js";
import { actionFingerprint } from "./fingerprint.js";

const context = {
  workItemId: "work-1",
  actor: "operator-1",
  operation: "approve" as const,
  requester: "agent-1",
  risk: "high" as const,
  action: {
    kind: "fs.write",
    description: "write source",
    params: { path: "src/index.ts", contents: "safe" }
  },
  cwd: "/repo",
  paths: ["src/index.ts"],
  write: true
};

describe("canonical policy action envelope", () => {
  it("includes the complete argument-bearing action identity", () => {
    expect(canonicalActionEnvelope(context)).toEqual({
      schemaVersion: "acs.policy-action.v1",
      risk: "high",
      action: {
        kind: "fs.write",
        description: "write source",
        arguments: { path: "src/index.ts", contents: "safe" }
      },
      cwd: "/repo",
      paths: ["src/index.ts"],
      write: true
    });
  });

  it("changes the fingerprint when an argument changes", () => {
    const original = actionFingerprint(context);
    const swapped = actionFingerprint({
      ...context,
      action: { ...context.action, params: { ...context.action.params, path: "src/other.ts" } }
    });

    expect(swapped).not.toBe(original);
  });

  it("does not let an omitted optional field become an implicit authorization field", () => {
    const withoutNetwork = actionFingerprint(context);
    const withNetwork = actionFingerprint({ ...context, network: false });

    expect(withNetwork).not.toBe(withoutNetwork);
  });
});
