import { ControlStackError } from "@agent-control-stack/shared";
import { describe, expect, it } from "vitest";
import { evaluateContractAdmission } from "./contracts.js";

describe("agentos contract admission", () => {
  it("routes unknown tools to human triage with write-risk approval", () => {
    const admission = evaluateContractAdmission({
      title: "Unknown tool",
      requester: "agent",
      intent: "verify unknown tool routing",
      target: { cwd: "/repo" },
      requestedActions: [{ kind: "quantum_flux_capacitor", description: "unknown tool" }],
      risk: "low"
    });

    expect(admission.envelope.task_type).toBe("unknown");
    expect(admission.route.target).toBe("human-triage");
    expect(admission.route.effective_risk).toBe("write");
    expect(admission.route.queued_for_approval).toBe(true);
  });

  it("forces approval for write tasks before dispatch", () => {
    const admission = evaluateContractAdmission({
      title: "Write source",
      requester: "user",
      intent: "update a source file",
      target: { cwd: "/repo" },
      requestedActions: [{ kind: "fs.write", description: "write", params: { paths: ["src/index.ts"] } }],
      risk: "low"
    });

    expect(admission.route.effective_risk).toBe("write");
    expect(admission.route.approval_required).toBe(true);
    expect(admission.route.queued_for_approval).toBe(true);
  });

  it("rejects undeclared network access", () => {
    expect(() =>
      evaluateContractAdmission({
        title: "Scrape page",
        requester: "agent",
        intent: "fetch remote content",
        target: { cwd: "/repo" },
        requestedActions: [{ kind: "browser_open", description: "open remote page", params: { network: true } }],
        risk: "low"
      })
    ).toThrow(ControlStackError);
  });

  it("requires rollback checkpoint metadata for destructive tasks", () => {
    expect(() =>
      evaluateContractAdmission({
        title: "Delete generated files",
        requester: "user",
        intent: "remove generated output",
        target: { cwd: "/repo" },
        requestedActions: [{ kind: "fs.delete", description: "delete", params: { paths: ["dist"], destructive: true } }],
        risk: "low"
      })
    ).toThrow(ControlStackError);

    const admission = evaluateContractAdmission({
      title: "Delete generated files",
      requester: "user",
      intent: "remove generated output",
      target: { cwd: "/repo" },
      requestedActions: [
        {
          kind: "fs.delete",
          description: "delete",
          params: {
            paths: ["dist"],
            destructive: true,
            rollbackCheckpoint: { kind: "git", ref: "HEAD" }
          }
        }
      ],
      risk: "low"
    });

    expect(admission.route.effective_risk).toBe("destructive");
    expect(admission.route.rollback_required).toBe(true);
    expect(admission.route.queued_for_approval).toBe(true);
  });
});
