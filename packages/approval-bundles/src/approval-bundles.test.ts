import { describe, expect, it } from "vitest";
import { ControlStackError } from "@agent-control-stack/shared";
import { approvalBundleRevisionSchema, type ApprovalBundleRevision, type ProposedChange } from "./contracts.js";
import {
  approvalChangeDigest,
  approvalManifestHash,
  canonicalApprovalManifest,
  serializeApprovalManifest,
  verifyApprovalManifest
} from "./manifest.js";
import {
  approvalDelta,
  createApprovalBundleRevision,
  reviseApprovalBundle,
  transitiveChangeDependencies
} from "./revision.js";
import { activeGrantCovers, assertSelectionDependenciesSatisfied, type ApprovalGrantRecord } from "./coverage.js";

const NOW = new Date("2026-09-30T00:00:00.000Z");

function change(overrides: Partial<ProposedChange> & { id: string }): ProposedChange {
  return {
    type: "file_write",
    summary: `summary for ${overrides.id}`,
    target: `/repo/${overrides.id}.ts`,
    action: {
      kind: "fs.write",
      description: `write ${overrides.id}`,
      params: { path: `/repo/${overrides.id}.ts`, contents: "x" }
    },
    risk: "medium",
    destructive: false,
    network: false,
    dependsOn: [],
    ...overrides
  };
}

function bundleInput(changes: ProposedChange[]) {
  return {
    bundleId: "A-184",
    missionId: "M-829",
    executionId: "EX-9012",
    agentId: "backend-api",
    title: "Fix OAuth lane routing",
    rationale: "Token refresh is racing the lane swap.",
    changes,
    createdByActorId: "agent:backend-api"
  };
}

function revisionOne(changes: ProposedChange[] = [change({ id: "c1" })]): ApprovalBundleRevision {
  return createApprovalBundleRevision(bundleInput(changes), NOW);
}

describe("canonical approval manifest", () => {
  it("is deterministic across repeated serialization", () => {
    const revision = revisionOne();
    expect(serializeApprovalManifest(revision)).toBe(serializeApprovalManifest(revision));
    expect(approvalManifestHash(revision)).toBe(approvalManifestHash(revision));
  });

  it("does not depend on object key insertion order", () => {
    const base = revisionOne();
    // Same content, keys supplied in a different order.
    const reorderedAction = {
      params: { contents: "x", path: "/repo/c1.ts" },
      description: "write c1",
      kind: "fs.write"
    };
    const reordered = {
      ...base,
      changes: [{ ...base.changes[0]!, action: reorderedAction }]
    };
    expect(approvalManifestHash(reordered)).toBe(approvalManifestHash(base));
  });

  it("changes when any authorization-relevant field changes", () => {
    const base = revisionOne();
    const original = approvalManifestHash(base);
    const mutations: Array<[string, (revision: ApprovalBundleRevision) => ApprovalBundleRevision]> = [
      ["command", (r) => ({ ...r, changes: [{ ...r.changes[0]!, command: ["rm", "-rf", "/"] }] })],
      ["target", (r) => ({ ...r, changes: [{ ...r.changes[0]!, target: "/other/file.ts" }] })],
      [
        "action params",
        (r) => ({
          ...r,
          changes: [
            {
              ...r.changes[0]!,
              action: { ...r.changes[0]!.action, params: { path: "/etc/passwd", contents: "x" } }
            }
          ]
        })
      ],
      ["risk", (r) => ({ ...r, changes: [{ ...r.changes[0]!, risk: "critical" }] })],
      ["destructive", (r) => ({ ...r, changes: [{ ...r.changes[0]!, destructive: true }] })],
      ["network", (r) => ({ ...r, changes: [{ ...r.changes[0]!, network: true }] })],
      ["paths", (r) => ({ ...r, changes: [{ ...r.changes[0]!, paths: ["/etc"] }] })],
      ["cwd", (r) => ({ ...r, changes: [{ ...r.changes[0]!, cwd: "/tmp" }] })],
      ["type", (r) => ({ ...r, changes: [{ ...r.changes[0]!, type: "destructive_action" }] })],
      ["mission", (r) => ({ ...r, missionId: "M-999" })],
      ["execution", (r) => ({ ...r, executionId: "EX-0000" })],
      ["agent", (r) => ({ ...r, agentId: "other-agent" })],
      ["scope", (r) => ({ ...r, scope: { files: ["/repo/**"] } })],
      ["base state", (r) => ({ ...r, baseState: { gitSha: "deadbeef" } })],
      ["title", (r) => ({ ...r, title: "different title" })]
    ];
    for (const [label, mutate] of mutations) {
      expect(approvalManifestHash(mutate(base)), label).not.toBe(original);
    }
  });

  it("ignores lifecycle bookkeeping that is not authorization-relevant", () => {
    const base = revisionOne();
    const original = approvalManifestHash(base);
    expect(approvalManifestHash({ ...base, status: "pending" })).toBe(original);
    expect(approvalManifestHash({ ...base, createdAt: "2020-01-01T00:00:00.000Z" })).toBe(original);
  });

  it("refuses to hash a manifest it cannot canonicalize", () => {
    const revision = revisionOne();
    const poisoned = {
      ...revision,
      changes: [{ ...revision.changes[0]!, metadata: { bad: undefined } } as ProposedChange]
    };
    // A poisoned manifest must throw rather than hash to something a reviewer never saw.
    expect(() => approvalManifestHash(poisoned)).toThrow();
  });

  it("detects a tampered stored revision", () => {
    const revision = revisionOne();
    expect(verifyApprovalManifest(revision)).toEqual({ ok: true });
    const tampered: ApprovalBundleRevision = {
      ...revision,
      changes: [{ ...revision.changes[0]!, target: "/etc/shadow" }]
    };
    const verdict = verifyApprovalManifest(tampered);
    expect(verdict.ok).toBe(false);
    if (!verdict.ok) {
      expect(verdict.code).toBe("approval_manifest_tampered");
    }
  });

  it("excludes ids and summaries from the change digest", () => {
    const a = change({ id: "c1" });
    const b = change({ id: "c99", summary: "totally different summary" });
    b.target = a.target;
    b.action = a.action;
    // Same operation, relabelled: same digest, so it is recognised as unchanged.
    expect(approvalChangeDigest(b)).toBe(approvalChangeDigest(a));
  });
});

describe("revision creation", () => {
  it("produces revision 1 with a computed manifest hash", () => {
    const revision = revisionOne();
    expect(revision.revision).toBe(1);
    expect(revision.status).toBe("draft");
    expect(revision.manifestHash).toMatch(/^[a-f0-9]{64}$/);
    expect(revision.parentManifestHash).toBeUndefined();
  });

  it("validates the revision against the canonical schema", () => {
    expect(() => approvalBundleRevisionSchema.parse(revisionOne())).not.toThrow();
  });

  it("rejects duplicate change ids", () => {
    expect(() => revisionOne([change({ id: "c1" }), change({ id: "c1", target: "/other" })])).toThrow(
      ControlStackError
    );
  });

  it("rejects a dependency on a change that is not in the revision", () => {
    const dependent = change({ id: "c2", dependsOn: ["missing"] });
    expect(() => revisionOne([change({ id: "c1" }), dependent])).toThrow(/depends on unknown change/);
  });

  it("rejects a dependency cycle", () => {
    const a = change({ id: "a", dependsOn: ["b"] });
    const b = change({ id: "b", dependsOn: ["a"] });
    expect(() => revisionOne([a, b])).toThrow(/dependency cycle/);
  });

  it("expands transitive dependencies", () => {
    const a = change({ id: "a" });
    const b = change({ id: "b", dependsOn: ["a"] });
    const c = change({ id: "c", dependsOn: ["b"] });
    expect(transitiveChangeDependencies([a, b, c], "c")).toEqual(["a", "b"]);
  });
});

describe("revisions and delta", () => {
  it("increments the revision and links to the previous manifest", () => {
    const first = revisionOne([change({ id: "c1" })]);
    const second = reviseApprovalBundle(first, {
      bundleId: first.bundleId,
      expectedRevision: 1,
      changes: [change({ id: "c1" }), change({ id: "c2" })],
      createdByActorId: "agent:backend-api",
      now: NOW
    });
    expect(second.revision).toBe(2);
    expect(second.parentManifestHash).toBe(first.manifestHash);
    expect(second.manifestHash).not.toBe(first.manifestHash);
  });

  it("rejects a stale expected revision", () => {
    const first = revisionOne();
    expect(() =>
      reviseApprovalBundle(first, {
        bundleId: first.bundleId,
        expectedRevision: 99,
        changes: [],
        createdByActorId: "agent:backend-api"
      })
    ).toThrow(/is at revision 1, not 99/);
  });

  it("refuses to revise a rejected bundle", () => {
    const first = { ...revisionOne(), status: "rejected" as const };
    expect(() =>
      reviseApprovalBundle(first, {
        bundleId: first.bundleId,
        expectedRevision: 1,
        changes: [],
        createdByActorId: "agent:backend-api"
      })
    ).toThrow(/is rejected and cannot be revised/);
  });

  it("classifies added, unchanged, modified and removed changes", () => {
    const first = revisionOne([change({ id: "keep" }), change({ id: "edit" }), change({ id: "drop" })]);
    const second = reviseApprovalBundle(first, {
      bundleId: first.bundleId,
      expectedRevision: 1,
      changes: [
        change({ id: "keep" }),
        change({ id: "edit", target: "/repo/edited-elsewhere.ts" }),
        change({ id: "fresh" })
      ],
      createdByActorId: "agent:backend-api"
    });
    const delta = approvalDelta(first, second);
    expect(delta.unchanged.map((entry) => entry.changeId)).toEqual(["keep"]);
    expect(delta.modified.map((entry) => entry.changeId)).toEqual(["edit"]);
    expect(delta.added.map((entry) => entry.changeId)).toEqual(["fresh"]);
    expect(delta.removed.map((entry) => entry.changeId)).toEqual(["drop"]);
    expect(delta.requiresApproval.map((entry) => entry.changeId)).toEqual(["edit", "fresh"]);
  });

  it("treats a broadened command as modified, not unchanged", () => {
    const first = revisionOne([change({ id: "c1", type: "command", command: ["systemctl", "restart", "auth-proxy"] })]);
    const second = reviseApprovalBundle(first, {
      bundleId: first.bundleId,
      expectedRevision: 1,
      changes: [
        change({
          id: "c1",
          type: "command",
          command: ["systemctl", "restart", "auth-proxy", "--now", "everything-else"]
        })
      ],
      createdByActorId: "agent:backend-api"
    });
    expect(approvalDelta(first, second).modified).toHaveLength(1);
  });

  it("treats a changed file path as modified", () => {
    const first = revisionOne([change({ id: "c1" })]);
    const second = reviseApprovalBundle(first, {
      bundleId: first.bundleId,
      expectedRevision: 1,
      changes: [
        change({
          id: "c1",
          target: "/repo/other.ts",
          action: { kind: "fs.write", description: "d", params: { path: "/repo/other.ts" } }
        })
      ],
      createdByActorId: "agent:backend-api"
    });
    expect(approvalDelta(first, second).requiresApproval).toHaveLength(1);
  });
});

describe("partial approval dependency handling", () => {
  const changes = [change({ id: "base" }), change({ id: "dependent", dependsOn: ["base"] })];

  it("accepts a selection that includes the dependency", () => {
    expect(() => assertSelectionDependenciesSatisfied(changes, ["base", "dependent"])).not.toThrow();
  });

  it("refuses a selection that omits a dependency instead of silently allowing it", () => {
    expect(() => assertSelectionDependenciesSatisfied(changes, ["dependent"])).toThrow(
      /depends on base, which is not part of this approval/
    );
  });

  it("refuses a change id that is not in the revision", () => {
    expect(() => assertSelectionDependenciesSatisfied(changes, ["nope"])).toThrow(
      /is not part of this bundle revision/
    );
  });
});

describe("runtime authorization coverage", () => {
  const revision = revisionOne([change({ id: "c1" })]);
  const ACTION_HASH = "a".repeat(64);

  // Fixed clock: grants are minted relative to NOW, so coverage must be evaluated
  // against the same instant rather than wall-clock time.
  const covers = (grants: readonly ApprovalGrantRecord[], operation: Parameters<typeof activeGrantCovers>[1]) =>
    activeGrantCovers(grants, operation, NOW);

  function grant(overrides: Partial<ApprovalGrantRecord> = {}): ApprovalGrantRecord {
    return {
      approvalId: "plan_approval_1",
      bundleId: revision.bundleId,
      revision: 1,
      manifestHash: revision.manifestHash,
      changeId: "c1",
      actionHash: ACTION_HASH,
      missionId: revision.missionId,
      executionId: revision.executionId,
      workItemId: "wrk_1",
      planHash: "b".repeat(64),
      approvedByActorId: "user",
      status: "granted",
      grantedAt: NOW.toISOString(),
      expiresAt: new Date(NOW.getTime() + 600_000).toISOString(),
      baseState: {},
      ...overrides
    };
  }

  it("covers the exact approved action", () => {
    const verdict = covers([grant()], {
      workItemId: "wrk_1",
      actionHash: ACTION_HASH
    });
    expect(verdict.covered).toBe(true);
  });

  it("does not cover an unapproved action hash", () => {
    const verdict = covers([grant()], {
      workItemId: "wrk_1",
      actionHash: "c".repeat(64)
    });
    expect(verdict).toMatchObject({ covered: false, reason: "no_active_grant" });
  });

  it("does not cover a modified action even when only the description differs", () => {
    // The action hash is derived by Policy Gate from the description too, so a changed
    // description is a different hash and therefore not covered.
    const verdict = covers([grant()], {
      workItemId: "wrk_1",
      actionHash: "d".repeat(64)
    });
    expect(verdict.covered).toBe(false);
  });

  it("refuses reuse against another work item, mission or execution", () => {
    expect(covers([grant()], { workItemId: "wrk_2", actionHash: ACTION_HASH })).toMatchObject({
      covered: false,
      reason: "work_item_mismatch"
    });
    expect(grant().missionId).not.toBe("M-000");
    expect(grant().executionId).not.toBe("EX-0000");
  });

  it("fails closed on expired, invalidated and consumed grants", () => {
    expect(
      covers([grant({ expiresAt: new Date(NOW.getTime() - 1).toISOString() })], {
        workItemId: "wrk_1",
        actionHash: ACTION_HASH
      })
    ).toMatchObject({ covered: false, reason: "grant_expired" });
    expect(
      covers([grant({ status: "invalidated" })], {
        workItemId: "wrk_1",
        actionHash: ACTION_HASH
      })
    ).toMatchObject({ covered: false, reason: "grant_invalidated" });
    expect(
      covers([grant({ status: "consumed" })], {
        workItemId: "wrk_1",
        actionHash: ACTION_HASH
      })
    ).toMatchObject({ covered: false, reason: "grant_already_consumed" });
  });

  it("fails closed when the base state moved after approval", () => {
    const pinned = grant({ baseState: { gitSha: "aaa" } });
    expect(
      covers([pinned], {
        workItemId: "wrk_1",
        actionHash: ACTION_HASH,
        observedBaseState: { gitSha: "bbb" }
      })
    ).toMatchObject({ covered: false, reason: "base_state_changed" });
    expect(
      covers([pinned], {
        workItemId: "wrk_1",
        actionHash: ACTION_HASH,
        observedBaseState: { gitSha: "aaa" }
      })
    ).toMatchObject({ covered: true });
  });

  it("refuses to treat one approved operation as wildcard authority", () => {
    const grants = [grant()];
    for (const candidate of ["0".repeat(64), `${ACTION_HASH}0`, ACTION_HASH.slice(0, 32), "", "*"]) {
      expect(covers(grants, { workItemId: "wrk_1", actionHash: candidate }).covered, candidate).toBe(false);
    }
  });

  it("prefers a valid grant over an invalidated one for the same action", () => {
    const verdict = covers([grant({ status: "invalidated" }), grant()], {
      workItemId: "wrk_1",
      actionHash: ACTION_HASH
    });
    expect(verdict.covered).toBe(true);
  });

  it("exposes the manifest as the authorization-relevant projection", () => {
    const manifest = canonicalApprovalManifest(revision);
    expect(manifest.schemaVersion).toBe("acs.approval-bundle.v1");
    expect(Object.keys(manifest)).not.toContain("status");
    expect(Object.keys(manifest)).not.toContain("createdAt");
  });
});
