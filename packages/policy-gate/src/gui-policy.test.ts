import { describe, it, expect } from "vitest";
import { evaluatePolicy } from "./policy.js";
const base = {
  workItemId: "gui-test",
  actor: "agent",
  operation: "create" as const,
  requester: "alice",
  requesterSubject: "alice",
  risk: "medium" as const,
  cwd: "/tmp",
  action: { kind: "jc.gui.input", description: "click in X11", params: {} }
};
describe("ACS native GUI policy", () => {
  it("permits bounded screenshot observation", () => {
    expect(evaluatePolicy({ ...base, action: { ...base.action, kind: "jc.gui.observe" } }).decision).toBe("allow");
  });
  it("requires human approval for GUI input", () => {
    expect(evaluatePolicy(base).decision).toBe("require_approval");
  });
  it("blocks requester self approval", () => {
    expect(evaluatePolicy({ ...base, actor: "alice", operation: "approve" }).decision).toBe("deny");
  });
  it("blocks ACS admin auto approval", () => {
    const r = evaluatePolicy({ ...base, actor: "acs:admin", operation: "approve" });
    expect(r.decision).toBe("deny");
    expect(r.matchedRules).toContain("deny:gui-admin-approval");
  });
});
