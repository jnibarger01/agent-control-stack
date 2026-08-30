import { describe, expect, it } from "vitest";
import {
  admittedPlanAuthorityMismatch,
  admittedPlanHash,
  capabilityProfileHash,
  validationProfileHash,
  workspaceIdentityFromContainment,
  type AdmittedPlanBinding
} from "./admitted-plan.js";

const H = (c: string) => c.repeat(64);

const binding: AdmittedPlanBinding = {
  schemaVersion: "acs.admitted-plan.v1",
  workItemId: "wrk_1",
  proposalHash: H("a"),
  executionPlanHash: H("b"),
  requestedActionsHash: H("c"),
  workspace: { workspaceId: "workspace_1", baseRevision: H("d") },
  sandboxProfile: "desktop_commander",
  networkProfile: "none",
  capabilityProfileHash: capabilityProfileHash(["read_file", "write_file"]),
  validationProfileHash: validationProfileHash({ commands: [["npm", "test"]] }),
  policyVersion: "acs.policy.v1"
};

describe("admittedPlanHash — binds all execution authority", () => {
  it("is stable for an identical binding", () => {
    expect(admittedPlanHash(binding)).toBe(admittedPlanHash({ ...binding }));
  });

  it("a change to ANY bound field produces a new hash (plan A != plan B)", () => {
    const original = admittedPlanHash(binding);
    const mutations: Array<Partial<AdmittedPlanBinding>> = [
      { proposalHash: H("f") },
      { executionPlanHash: H("f") },
      { requestedActionsHash: H("f") },
      { workspace: { workspaceId: "workspace_2", baseRevision: H("d") } },
      { workspace: { workspaceId: "workspace_1", baseRevision: H("e") } },
      { sandboxProfile: "bubblewrap-systemd-v1" },
      { networkProfile: `scoped-egress:${H("9")}` },
      { capabilityProfileHash: capabilityProfileHash(["read_file"]) },
      { validationProfileHash: validationProfileHash({ commands: [["npm", "run", "lint"]] }) },
      { policyVersion: "acs.policy.v2" }
    ];
    for (const mutation of mutations) {
      const changed = admittedPlanHash({ ...binding, ...mutation } as AdmittedPlanBinding);
      expect(changed, JSON.stringify(mutation)).not.toBe(original);
    }
  });

  it("authority issued for plan A does not authorize plan B (mismatch is explicit)", () => {
    const planB: AdmittedPlanBinding = { ...binding, sandboxProfile: "dry_run" };
    expect(admittedPlanAuthorityMismatch(binding, binding)).toEqual([]);
    expect(admittedPlanAuthorityMismatch(binding, planB)).toEqual(["sandboxProfile"]);

    const planC: AdmittedPlanBinding = {
      ...binding,
      workspace: { workspaceId: "workspace_1", baseRevision: H("9") },
      policyVersion: "acs.policy.v9"
    };
    expect(admittedPlanAuthorityMismatch(binding, planC).sort()).toEqual(
      ["policyVersion", "workspace.baseRevision"].sort()
    );
  });

  it("networkProfile format is enforced", () => {
    expect(() => admittedPlanHash({ ...binding, networkProfile: "wide-open" })).toThrow();
    expect(() =>
      admittedPlanHash({ ...binding, networkProfile: `scoped-egress:${H("1")}` })
    ).not.toThrow();
  });

  it("rejects a host path as workspaceId and accepts a containment identity", () => {
    const hostPath = "/tmp/acs-verify-enforce/pkg";
    expect(hostPath).toMatch(/\//u);
    expect(() =>
      admittedPlanHash({
        ...binding,
        workspace: { workspaceId: hostPath, baseRevision: H("d") }
      })
    ).toThrow(/Invalid|workspaceId/i);

    const workspaceId = workspaceIdentityFromContainment([hostPath, "/var/acs/other"]);
    expect(workspaceId).toMatch(/^[A-Za-z0-9][A-Za-z0-9._:-]*$/u);
    expect(workspaceId).not.toMatch(/[\\/]/u);
    expect(workspaceId).not.toContain(hostPath);
    expect(workspaceId).toBe(workspaceIdentityFromContainment(["/var/acs/other", hostPath]));
    expect(workspaceId).not.toBe(workspaceIdentityFromContainment([hostPath]));
    expect(() =>
      admittedPlanHash({
        ...binding,
        workspace: { workspaceId, baseRevision: H("d") }
      })
    ).not.toThrow();
  });
});
