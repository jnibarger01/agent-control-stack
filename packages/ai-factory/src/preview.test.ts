import { describe, expect, it } from "vitest";
import { FACTORY_INTENT_VERSION } from "./plan.js";
import {
  previewFactoryIntake,
  type FactoryIntakePolicy,
  type FactoryRepositoryReader,
  type RepositoryResolution
} from "./preview.js";

const SHA = "a".repeat(40);
const REPO = "jnibarger01/agent-control-stack";

function intent(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    schemaVersion: FACTORY_INTENT_VERSION,
    orderId: "factory_001",
    objective: "Implement a bounded endpoint with tests",
    repository: REPO,
    baseSha: SHA,
    acceptanceCriteria: ["Healthy fixture returns HTTP 200"],
    permittedPaths: ["apps/gateway/src"],
    forbiddenPaths: [],
    budget: { maxLanes: 2, maxWallClockMs: 1_200_000, maxSpendMicrousd: 2_000_000 },
    delivery: { mode: "draft_pr" },
    ...overrides
  };
}

const policy: FactoryIntakePolicy = {
  version: "policy-1",
  repositories: [REPO],
  maxLanes: 4,
  maxWallClockMs: 3_600_000,
  maxSpendMicrousd: 10_000_000
};

function reader(resolution: RepositoryResolution | (() => never), calls: string[] = []): FactoryRepositoryReader {
  return {
    async resolve(repository, sha) {
      calls.push(repository + "@" + sha);
      if (typeof resolution === "function") return resolution();
      return resolution;
    }
  };
}

const resolved: RepositoryResolution = {
  status: "resolved",
  repositoryId: 42,
  fullName: REPO,
  commitSha: SHA,
  archived: false
};

describe("AI Factory F1 preview-only intake", () => {
  it("previews an allowlisted intent at an exact commit without admitting anything", async () => {
    const preview = await previewFactoryIntake({ principal: "operator", body: intent(), policy, reader: reader(resolved) });
    expect(preview.outcome).toBe("previewable");
    if (preview.outcome !== "previewable") return;
    expect(preview.previewHash).toMatch(/^[a-f0-9]{64}$/u);
    expect(preview.repository).toEqual({ id: 42, fullName: REPO });
    expect(preview.authority).toBe("none");
    expect(preview.admitted).toBe(false);
    expect(preview.constraints.reduced).toEqual([]);
  });

  it("binds the preview hash to the authenticated principal (two-user isolation)", async () => {
    const a = await previewFactoryIntake({ principal: "alice", body: intent(), policy, reader: reader(resolved) });
    const b = await previewFactoryIntake({ principal: "bob", body: intent(), policy, reader: reader(resolved) });
    expect(a.outcome).toBe("previewable");
    expect(b.outcome).toBe("previewable");
    if (a.outcome !== "previewable" || b.outcome !== "previewable") return;
    expect(a.intentHash).toBe(b.intentHash);
    expect(a.previewHash).not.toBe(b.previewHash);
    expect(a.principal).toBe("alice");
  });

  it("binds the preview hash to the policy version", async () => {
    const a = await previewFactoryIntake({ principal: "alice", body: intent(), policy, reader: reader(resolved) });
    const b = await previewFactoryIntake({
      principal: "alice",
      body: intent(),
      policy: { ...policy, version: "policy-2" },
      reader: reader(resolved)
    });
    if (a.outcome !== "previewable" || b.outcome !== "previewable") throw new Error("expected previews");
    expect(a.previewHash).not.toBe(b.previewHash);
  });

  it("refuses a body that tries to assert an actor or authority", async () => {
    for (const forged of [{ actor: "admin" }, { approvalId: "x" }, { leaseId: "y" }, { autoMerge: true }]) {
      const preview = await previewFactoryIntake({
        principal: "operator",
        body: intent(forged),
        policy,
        reader: reader(resolved)
      });
      expect(preview).toMatchObject({ outcome: "refused", reason: "invalid_intent" });
    }
  });

  it("refuses an invalid principal without consulting the reader", async () => {
    const calls: string[] = [];
    for (const principal of ["", " operator", "a\nb", "x".repeat(201)]) {
      const preview = await previewFactoryIntake({ principal, body: intent(), policy, reader: reader(resolved, calls) });
      expect(preview).toMatchObject({ outcome: "refused", reason: "invalid_principal" });
    }
    expect(calls).toEqual([]);
  });

  it("refuses repositories outside the allowlist before any read, and an empty allowlist refuses everything", async () => {
    const calls: string[] = [];
    const other = await previewFactoryIntake({
      principal: "operator",
      body: intent({ repository: "someone/else" }),
      policy,
      reader: reader(resolved, calls)
    });
    expect(other).toMatchObject({ outcome: "refused", reason: "repository_not_allowed" });
    const empty = await previewFactoryIntake({
      principal: "operator",
      body: intent(),
      policy: { ...policy, repositories: [] },
      reader: reader(resolved, calls)
    });
    expect(empty).toMatchObject({ outcome: "refused", reason: "repository_not_allowed" });
    expect(calls).toEqual([]);
  });

  it.each([
    [{ status: "repository_not_found" }, "repository_not_found"],
    [{ status: "commit_not_found" }, "base_commit_not_found"],
    [{ status: "identity_drift" }, "repository_identity_drift"],
    [{ status: "unavailable" }, "repository_unavailable"],
    [{ ...resolved, fullName: "jnibarger01/renamed" }, "repository_identity_drift"],
    [{ ...resolved, commitSha: "b".repeat(40) }, "base_ref_drift"],
    [{ ...resolved, commitSha: SHA.slice(0, 12) }, "base_ref_drift"],
    [{ ...resolved, archived: true }, "repository_archived"],
    [{ ...resolved, repositoryId: 0 }, "repository_unavailable"],
    [{ status: "something-new" }, "repository_unavailable"]
  ] as [RepositoryResolution, string][])("refuses resolution %j as %s", async (resolution, reason) => {
    const preview = await previewFactoryIntake({ principal: "operator", body: intent(), policy, reader: reader(resolution) });
    expect(preview).toMatchObject({ outcome: "refused", reason, admitted: false, authority: "none" });
  });

  it("fails closed when the reader throws", async () => {
    const preview = await previewFactoryIntake({
      principal: "operator",
      body: intent(),
      policy,
      reader: reader(() => {
        throw new Error("network down");
      })
    });
    expect(preview).toMatchObject({ outcome: "refused", reason: "repository_unavailable" });
  });

  it("reduces an over-budget request to the policy ceiling and never widens it", async () => {
    const preview = await previewFactoryIntake({
      principal: "operator",
      body: intent({ budget: { maxLanes: 8, maxWallClockMs: 1_000, maxSpendMicrousd: 50_000_000 } }),
      policy,
      reader: reader(resolved)
    });
    if (preview.outcome !== "previewable") throw new Error("expected preview");
    expect(preview.constraints).toEqual({
      maxLanes: 4,
      maxWallClockMs: 1_000,
      maxSpendMicrousd: 10_000_000,
      reduced: ["maxLanes", "maxSpendMicrousd"]
    });
  });

  it("matches the allowlist case-insensitively but requires the host's canonical name to match", async () => {
    const preview = await previewFactoryIntake({
      principal: "operator",
      body: intent({ repository: "JNibarger01/Agent-Control-Stack" }),
      policy,
      reader: reader(resolved)
    });
    expect(preview.outcome).toBe("previewable");
  });

  it("rejects a malformed policy instead of silently allowing", async () => {
    await expect(
      previewFactoryIntake({ principal: "operator", body: intent(), policy: { ...policy, maxLanes: -1 }, reader: reader(resolved) })
    ).rejects.toThrow(/maxLanes/u);
  });
});
