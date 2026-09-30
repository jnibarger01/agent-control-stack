import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { SqliteWorkItemStore, type ActionRequest, type WorkItem } from "@agent-control-stack/work-items";
import {
  activeGrantsForMission,
  approvalDelta,
  createApprovalBundleRevision,
  type ApprovalBundleRevision,
  type ProposedChange
} from "@agent-control-stack/approval-bundles";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createPolicyEngine, type PolicyEngine } from "./policy.js";
import { createWorkItemTools } from "./tools.js";
import {
  authorizeBundleOperation,
  buildBundleFromWorkItem,
  buildDeltaRevision,
  bundleChangeActionHash,
  gateApproveBundle,
  gateReviseBundle,
  resolveStrategy
} from "./approval-bundle-tools.js";

/**
 * Bundle approval, exercised through the real Policy Gate and the real SQLite store.
 *
 * Nothing here is mocked. Action hashes are produced by the same `actionFingerprint`
 * the live policy path uses, and grants are minted through the same
 * `grantExecutionPlanApproval` the per-action route uses, so a pass here means the
 * production authorization path enforces bundle scope.
 */

let dir: string;
let dbPath: string;
let store: SqliteWorkItemStore;
let policy: PolicyEngine;

const policyTransition = { via: "policy_gate" } as const;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "acs-approval-bundle-"));
  dbPath = join(dir, "control.db");
  store = new SqliteWorkItemStore(dbPath);
  policy = createPolicyEngine();
});

afterEach(() => {
  try {
    store.close();
  } catch {
    // The restart test closes the handle itself to simulate a process restart, and
    // `close` is not idempotent. Teardown must not turn that into a second failure.
  }
  rmSync(dir, { recursive: true, force: true });
});

/** A mission that needs exactly the five operations from the acceptance scenario. */
function backendFixMission(): WorkItem {
  const tools = createWorkItemTools(store, policy);
  return tools.create_work_item({
    title: "Fix backend configuration",
    requester: "user",
    intent: "repair the backend auth configuration and restart the affected services",
    target: { cwd: "/repo" },
    requestedActions: [
      { kind: "fs.write", description: "modify file A", params: { paths: ["services/a.ts"] } },
      { kind: "fs.write", description: "modify file B", params: { paths: ["services/b.ts"] } },
      {
        kind: "shell",
        description: "run command C",
        params: { command: ["npm", "run", "build"] }
      },
      {
        kind: "shell",
        description: "restart service D",
        params: { command: ["systemctl", "restart", "auth-proxy"] }
      },
      {
        kind: "fs.read",
        description: "run health check E",
        params: { paths: ["services/a.ts"] }
      }
    ],
    risk: "medium"
  }) as WorkItem;
}

function makeBundle(workItem: WorkItem, bundleId = "A-184") {
  const built = buildBundleFromWorkItem({
    store,
    policy,
    workItem,
    bundleId,
    createdByActorId: "agent:backend-api"
  });
  store.createApprovalBundle({ ...built.revision, status: "pending" });
  return store.getApprovalBundle(bundleId)!;
}

describe("bundle creation from a mission", () => {
  it("covers every policy-required action and omits actions that needed no approval", () => {
    const workItem = backendFixMission();
    const bundle = makeBundle(workItem);
    const descriptions = bundle.changes.map((change) => change.action.description);
    expect(descriptions).toContain("modify file A");
    expect(descriptions).toContain("modify file B");
    expect(descriptions).toContain("run command C");
    expect(descriptions).toContain("restart service D");
    // A plain read is not privileged, so it must not appear in a review artifact.
    expect(descriptions).not.toContain("run health check E");
    for (const change of bundle.changes) {
      expect(change.actionHash).toMatch(/^[a-f0-9]{64}$/);
    }
  });

  it("refuses to build a bundle for a work item that policy denies", () => {
    // Created directly rather than through create_work_item, because contract admission
    // rejects this action before a work item ever exists. What matters here is that
    // bundling a denied mission is refused rather than offered for review.
    const denied = store.create({
      title: "Escalate",
      requester: "user",
      intent: "attempt a forbidden action",
      target: { cwd: "/repo" },
      requestedActions: [{ kind: "shell", description: "rm -rf /", params: { command: ["rm", "-rf", "/"] } }],
      risk: "critical"
    } as never) as WorkItem;
    expect(() =>
      buildBundleFromWorkItem({ store, policy, workItem: denied, bundleId: "A-deny", createdByActorId: "a" })
    ).toThrow(/denied by policy/);
  });
});

describe("one human approval authorizes the whole reviewed set", () => {
  it("mints one authoritative plan approval per covered change", () => {
    const workItem = backendFixMission();
    const bundle = makeBundle(workItem);
    const result = gateApproveBundle(store, policy, {
      bundleId: bundle.bundleId,
      revision: bundle.revision,
      kind: "approve_all",
      approvedBy: "user",
      reason: "reviewed the change set"
    });

    expect(result.deniedChangeIds).toEqual([]);
    expect(Object.keys(result.approvalIdsByChange)).toHaveLength(bundle.changes.length);
    for (const change of bundle.changes) {
      const approvalId = result.approvalIdsByChange[change.id]!;
      const authoritative = store.getExecutionPlanApprovalById(approvalId);
      expect(authoritative).toBeDefined();
      expect(authoritative!.actionHash).toBe(change.actionHash);
      expect(authoritative!.approvedByActorId).toBe("user");
    }
  });

  it("executes every approved operation without a further approval prompt", () => {
    const workItem = backendFixMission();
    const bundle = makeBundle(workItem);
    gateApproveBundle(store, policy, {
      bundleId: bundle.bundleId,
      revision: bundle.revision,
      kind: "approve_all",
      approvedBy: "user",
      reason: "reviewed"
    });

    for (const change of bundle.changes) {
      const verdict = authorizeBundleOperation({
        store,
        policy,
        workItem: store.get(workItem.id)!,
        action: change.action as ActionRequest,
        actor: "agent:backend-api"
      });
      expect(verdict.allowed, `${change.action.description}: ${JSON.stringify(verdict)}`).toBe(true);
    }
  });

  it("unblocks the real multi-action worker claim after the full bundle is approved", () => {
    const workItem = backendFixMission();
    const bundle = makeBundle(workItem, "A-worker-claim");
    gateApproveBundle(store, policy, {
      bundleId: bundle.bundleId,
      revision: bundle.revision,
      kind: "approve_all",
      approvedBy: "user",
      reason: "reviewed the complete change set"
    });

    expect(store.get(workItem.id)?.status).toBe("approved");
    const claimed = createWorkItemTools(store, policy).claim_approved_work_item_by_id({
      id: workItem.id,
      workerId: "agent:backend-api"
    });
    expect(claimed?.status).toBe("running");
    const raw = new DatabaseSync(dbPath, { readOnly: true });
    try {
      const consumed = raw
        .prepare(`SELECT COUNT(*) AS count FROM execution_plan_approvals WHERE work_item_id = ? AND status = 'consumed'`)
        .get(workItem.id) as { count: number };
      expect(consumed.count).toBe(bundle.changes.length);
    } finally {
      raw.close();
    }
  });
});

describe("unapproved and modified operations fail closed", () => {
  function approvedBundle() {
    const workItem = backendFixMission();
    const bundle = makeBundle(workItem);
    gateApproveBundle(store, policy, {
      bundleId: bundle.bundleId,
      revision: bundle.revision,
      kind: "approve_all",
      approvedBy: "user",
      reason: "reviewed"
    });
    return { workItem, bundle };
  }

  function verdictFor(workItemId: string, action: ActionRequest) {
    return authorizeBundleOperation({
      store,
      policy,
      workItem: store.get(workItemId)!,
      action,
      actor: "agent:backend-api"
    });
  }

  it("fails an operation discovered after approval", () => {
    const { workItem } = approvedBundle();
    const verdict = verdictFor(workItem.id, {
      kind: "fs.write",
      description: "modify config file F",
      params: { paths: ["config/gateway.env"] }
    });
    expect(verdict.allowed).toBe(false);
    if (!verdict.allowed) {
      expect(verdict.reason).toBe("delta_approval_required");
      expect(verdict.coverageReason).toBe("no_active_grant");
    }
  });

  it("fails an operation whose command was changed after approval", () => {
    const { workItem } = approvedBundle();
    const verdict = verdictFor(workItem.id, {
      kind: "shell",
      description: "run command C",
      params: { command: ["npm", "run", "build", "--publish"] }
    });
    expect(verdict.allowed).toBe(false);
  });

  it("fails an operation whose file path was changed after approval", () => {
    const { workItem } = approvedBundle();
    const verdict = verdictFor(workItem.id, {
      kind: "fs.write",
      description: "modify file A",
      params: { paths: ["../../etc/passwd"] }
    });
    expect(verdict.allowed).toBe(false);
  });

  it("fails an operation whose service was changed after approval", () => {
    const { workItem } = approvedBundle();
    const verdict = verdictFor(workItem.id, {
      kind: "shell",
      description: "restart service D",
      params: { command: ["systemctl", "restart", "postgres"] }
    });
    expect(verdict.allowed).toBe(false);
  });

  it("fails an operation whose description was changed after approval", () => {
    const { workItem } = approvedBundle();
    const verdict = verdictFor(workItem.id, {
      kind: "fs.write",
      description: "modify file A but also everything else",
      params: { paths: ["services/a.ts"] }
    });
    expect(verdict.allowed).toBe(false);
  });

  it("still refuses a policy-denied operation even with a broad bundle present", () => {
    const { workItem } = approvedBundle();
    const verdict = verdictFor(workItem.id, {
      kind: "shell",
      description: "rm -rf /",
      params: { command: ["rm", "-rf", "/"] }
    });
    expect(verdict.allowed).toBe(false);
    if (!verdict.allowed) {
      expect(verdict.reason).toBe("policy_denied");
    }
  });

  it("cannot be replayed against another work item", () => {
    const { workItem } = approvedBundle();
    // A different mission with byte-identical action content produces the same action
    // hash, because `actionFingerprint` deliberately excludes workItemId. The bundle
    // binding must therefore carry the work-item scoping.
    const tools = createWorkItemTools(store, policy);
    const other = tools.create_work_item({
      title: "Different mission",
      requester: "user",
      intent: "a different mission with the same first action",
      target: { cwd: "/repo" },
      requestedActions: [{ kind: "fs.write", description: "modify file A", params: { paths: ["services/a.ts"] } }],
      risk: "medium"
    }) as WorkItem;
    const verdict = authorizeBundleOperation({
      store,
      policy,
      workItem: other,
      action: { kind: "fs.write", description: "modify file A", params: { paths: ["services/a.ts"] } },
      actor: "agent:backend-api"
    });
    expect(verdict.allowed).toBe(false);
    if (!verdict.allowed) {
      expect(verdict.coverageReason).toBe("no_active_grant");
    }
    void workItem;
  });
});

describe("TOCTOU protection", () => {
  it("refuses to mint gateway execution authority for an unverified base-state pin", () => {
    const workItem = backendFixMission();
    const built = buildBundleFromWorkItem({
      store,
      policy,
      workItem,
      bundleId: "A-toctou",
      baseState: { gitSha: "sha-before" },
      createdByActorId: "agent:backend-api"
    });
    store.createApprovalBundle({ ...built.revision, status: "pending" });
    expect(() =>
      gateApproveBundle(store, policy, {
        bundleId: "A-toctou",
        revision: 1,
        kind: "approve_all",
        approvedBy: "user",
        reason: "reviewed at sha-before"
      })
    ).toThrow(/does not currently provide a live base-state verifier/);
    expect(store.listApprovalBundleGrants({ bundleId: "A-toctou" })).toHaveLength(0);
  });
});

describe("delta approval", () => {
  it("revokes the old authority for removed or changed operations while retaining unchanged grants", () => {
    const workItem = backendFixMission();
    const bundle = makeBundle(workItem, "A-revision-revokes");
    gateApproveBundle(store, policy, {
      bundleId: bundle.bundleId,
      revision: bundle.revision,
      kind: "approve_all",
      approvedBy: "user",
      reason: "reviewed"
    });
    const unchanged = bundle.changes[0]!;
    const removed = bundle.changes[1]!;
    const removedGrant = store.listApprovalBundleGrants({ bundleId: bundle.bundleId }).find(
      (grant) => grant.changeId === removed.id
    )!;

    gateReviseBundle(store, {
      bundleId: bundle.bundleId,
      expectedRevision: 1,
      changes: bundle.changes.filter((change) => change.id !== removed.id),
      createdByActorId: "agent:backend-api"
    });

    expect(store.getExecutionPlanApprovalById(removedGrant.approvalId)?.status).toBe("invalidated");
    expect(
      authorizeBundleOperation({
        store,
        policy,
        workItem: store.get(workItem.id)!,
        action: removed.action as ActionRequest,
        actor: "agent:backend-api"
      }).allowed
    ).toBe(false);
    expect(
      authorizeBundleOperation({
        store,
        policy,
        workItem: store.get(workItem.id)!,
        action: unchanged.action as ActionRequest,
        actor: "agent:backend-api"
      }).allowed
    ).toBe(true);
  });

  it("separates previously approved work from newly discovered work", () => {
    const workItem = backendFixMission();
    const bundle = makeBundle(workItem);
    gateApproveBundle(store, policy, {
      bundleId: bundle.bundleId,
      revision: 1,
      kind: "approve_all",
      approvedBy: "user",
      reason: "reviewed"
    });

    // During execution the agent discovers two more operations.
    const first = buildDeltaRevision(bundle, store.get(workItem.id)!, {
      id: "change-900",
      action: { kind: "fs.write", description: "modify config file F", params: { paths: ["config/gateway.env"] } },
      target: "config/gateway.env",
      summary: "modify config file F",
      risk: "high"
    });
    const second = buildDeltaRevision({ ...first.revision, approvals: [] } as never, store.get(workItem.id)!, {
      id: "change-901",
      action: {
        kind: "shell",
        description: "restart service G",
        params: { command: ["systemctl", "restart", "acs-gateway"] }
      },
      target: "acs-gateway",
      summary: "restart service G",
      risk: "high"
    });

    const delta = approvalDelta(bundle, second.revision);
    expect(delta.unchanged).toHaveLength(bundle.changes.length);
    expect(delta.added.map((entry) => entry.changeId)).toEqual(["change-900", "change-901"]);
    expect(delta.modified).toHaveLength(0);

    const revised = gateReviseBundle(store, {
      bundleId: bundle.bundleId,
      expectedRevision: 1,
      changes: second.revision.changes,
      createdByActorId: "agent:backend-api"
    });
    expect(revised.bundle.revision).toBe(2);

    // The two new operations are refused under the old approval.
    for (const change of second.revision.changes.filter((c) => c.id.startsWith("change-9"))) {
      const verdict = authorizeBundleOperation({
        store,
        policy,
        workItem: store.get(workItem.id)!,
        action: change.action as ActionRequest,
        actor: "agent:backend-api"
      });
      expect(verdict.allowed, change.id).toBe(false);
    }

    // The previously approved operations still execute.
    for (const change of second.revision.changes.filter((c) => !c.id.startsWith("change-9"))) {
      const verdict = authorizeBundleOperation({
        store,
        policy,
        workItem: store.get(workItem.id)!,
        action: change.action as ActionRequest,
        actor: "agent:backend-api"
      });
      expect(verdict.allowed, change.id).toBe(true);
    }

    // Approving only the delta mints grants for exactly the new changes.
    const deltaDecision = gateApproveBundle(store, policy, {
      bundleId: bundle.bundleId,
      revision: 2,
      kind: "approve_selected",
      approvedBy: "user",
      reason: "approve the newly discovered work only",
      changeIds: ["change-900", "change-901"]
    });
    expect(Object.keys(deltaDecision.approvalIdsByChange).sort()).toEqual(["change-900", "change-901"]);

    for (const change of second.revision.changes.filter((c) => c.id.startsWith("change-9"))) {
      const verdict = authorizeBundleOperation({
        store,
        policy,
        workItem: store.get(workItem.id)!,
        action: change.action as ActionRequest,
        actor: "agent:backend-api"
      });
      expect(verdict.allowed, change.id).toBe(true);
    }
  });
});

describe("partial approval and dependencies", () => {
  it("authorizes only the selected operation and keeps the mission unclaimable while work remains unapproved", () => {
    const workItem = backendFixMission();
    const bundle = makeBundle(workItem, "A-partial-only");
    const selected = bundle.changes[0]!;
    gateApproveBundle(store, policy, {
      bundleId: bundle.bundleId,
      revision: bundle.revision,
      kind: "approve_selected",
      approvedBy: "user",
      reason: "approve only the first operation",
      changeIds: [selected.id]
    });

    expect(store.get(workItem.id)?.status).toBe("needs_approval");
    for (const change of bundle.changes) {
      const verdict = authorizeBundleOperation({
        store,
        policy,
        workItem: store.get(workItem.id)!,
        action: change.action as ActionRequest,
        actor: "agent:backend-api"
      });
      expect(verdict.allowed, change.id).toBe(change.id === selected.id);
      expect(store.hasApproval(workItem.id, change.actionHash)).toBe(change.id === selected.id);
    }
  });

  it("refuses to approve a change whose dependency was not selected", () => {
    const workItem = backendFixMission();
    const built = buildBundleFromWorkItem({
      store,
      policy,
      workItem,
      bundleId: "A-dep",
      createdByActorId: "agent:backend-api"
    });
    const baseId = built.revision.changes[0]!.id;
    const dependentId = built.revision.changes[1]!.id;
    // Rebuild through the real constructor so the manifest hash is recomputed over the
    // dependency edge. Mutating `changes` in place would (correctly) be rejected.
    const withDependency = createApprovalBundleRevision({
      ...pickRevisionInput(built.revision),
      changes: built.revision.changes.map((change) =>
        change.id === dependentId ? { ...change, dependsOn: [baseId] } : change
      )
    });
    store.createApprovalBundle({ ...withDependency, status: "pending" });

    expect(() =>
      gateApproveBundle(store, policy, {
        bundleId: "A-dep",
        revision: 1,
        kind: "approve_selected",
        approvedBy: "user",
        reason: "approve only the dependent",
        changeIds: [dependentId]
      })
    ).toThrow(/depends on .*not part of this approval/);
  });

  it("approves a dependent when its dependency is selected too", () => {
    const workItem = backendFixMission();
    const built = buildBundleFromWorkItem({
      store,
      policy,
      workItem,
      bundleId: "A-dep2",
      createdByActorId: "agent:backend-api"
    });
    const baseId = built.revision.changes[0]!.id;
    const dependentId = built.revision.changes[1]!.id;
    const withDependency = createApprovalBundleRevision({
      ...pickRevisionInput(built.revision),
      changes: built.revision.changes.map((change) =>
        change.id === dependentId ? { ...change, dependsOn: [baseId] } : change
      )
    });
    store.createApprovalBundle({ ...withDependency, status: "pending" });
    const result = gateApproveBundle(store, policy, {
      bundleId: "A-dep2",
      revision: 1,
      kind: "approve_selected",
      approvedBy: "user",
      reason: "approve both",
      changeIds: [baseId, dependentId]
    });
    expect(Object.keys(result.approvalIdsByChange).sort()).toEqual([baseId, dependentId].sort());
  });
});

function pickRevisionInput(revision: ApprovalBundleRevision) {
  return {
    bundleId: revision.bundleId,
    missionId: revision.missionId,
    executionId: revision.executionId,
    agentId: revision.agentId,
    title: revision.title,
    rationale: revision.rationale,
    scope: revision.scope,
    baseState: revision.baseState,
    createdByActorId: revision.createdByActorId
  };
}

describe("invalidation, expiry and restart", () => {
  it("stops covering operations once the bundle is invalidated", () => {
    const workItem = backendFixMission();
    const bundle = makeBundle(workItem, "A-invalidate");
    gateApproveBundle(store, policy, {
      bundleId: "A-invalidate",
      revision: 1,
      kind: "approve_all",
      approvedBy: "user",
      reason: "reviewed"
    });
    const action = bundle.changes[0]!.action as ActionRequest;
    expect(
      authorizeBundleOperation({ store, policy, workItem: store.get(workItem.id)!, action, actor: "a" }).allowed
    ).toBe(true);

    store.invalidateApprovalBundle("A-invalidate", "operator revoked", policyTransition);

    const after = authorizeBundleOperation({
      store,
      policy,
      workItem: store.get(workItem.id)!,
      action,
      actor: "a"
    });
    expect(after.allowed).toBe(false);
    if (!after.allowed) {
      expect(after.coverageReason).toBe("grant_invalidated");
    }
  });

  it("revoking a previously approved bundle prevents its plan approvals from being reused", () => {
    const workItem = backendFixMission();
    const bundle = makeBundle(workItem, "A-reject-approved");
    gateApproveBundle(store, policy, {
      bundleId: bundle.bundleId,
      revision: 1,
      kind: "approve_all",
      approvedBy: "user",
      reason: "reviewed"
    });
    const grant = store.listApprovalBundleGrants({ bundleId: bundle.bundleId })[0]!;

    gateApproveBundle(store, policy, {
      bundleId: bundle.bundleId,
      revision: 1,
      kind: "reject",
      approvedBy: "user",
      reason: "withdraw approval"
    });

    expect(store.getExecutionPlanApprovalById(grant.approvalId)?.status).toBe("invalidated");
    expect(store.getApprovalBundle(bundle.bundleId)?.status).toBe("rejected");
    expect(
      authorizeBundleOperation({
        store,
        policy,
        workItem: store.get(workItem.id)!,
        action: bundle.changes[0]!.action as ActionRequest,
        actor: "agent:backend-api"
      }).allowed
    ).toBe(false);
  });

  it("survives a process restart", () => {
    const workItem = backendFixMission();
    const bundle = makeBundle(workItem, "A-restart");
    gateApproveBundle(store, policy, {
      bundleId: "A-restart",
      revision: 1,
      kind: "approve_all",
      approvedBy: "user",
      reason: "reviewed"
    });
    const action = bundle.changes[0]!.action as ActionRequest;
    // Simulate a process restart: the handle is closed and a fresh one is opened on
    // the same file, so anything only living in memory would be lost.
    store.close();
    store = new SqliteWorkItemStore(dbPath);

    const reopened = store;
    try {
      const reloaded = reopened.getApprovalBundle("A-restart");
      expect(reloaded?.revision).toBe(1);
      expect(reloaded?.manifestHash).toBe(bundle.manifestHash);
      expect(reloaded?.approvals).toHaveLength(1);
      expect(reopened.listApprovalBundleGrants({ bundleId: "A-restart" })).toHaveLength(bundle.changes.length);
      const verdict = authorizeBundleOperation({
        store: reopened,
        policy,
        workItem: reopened.get(workItem.id)!,
        action,
        actor: "a"
      });
      expect(verdict.allowed).toBe(true);
    } finally {
      reopened.close();
    }
  });

  it("does not issue a second set of grants when the same approval is retried", () => {
    const workItem = backendFixMission();
    const bundle = makeBundle(workItem, "A-idem");
    const first = gateApproveBundle(store, policy, {
      bundleId: "A-idem",
      revision: 1,
      kind: "approve_all",
      approvedBy: "user",
      reason: "reviewed"
    });
    const second = gateApproveBundle(store, policy, {
      bundleId: "A-idem",
      revision: 1,
      kind: "approve_all",
      approvedBy: "user",
      reason: "reviewed"
    });
    expect(second.decision.id).toBe(first.decision.id);
    expect(store.listApprovalBundleGrants({ bundleId: "A-idem" })).toHaveLength(bundle.changes.length);
    expect(store.readEvents().filter((event) => event.name === "approval_bundle.approved")).toHaveLength(1);
  });

  it("rejects a stale-revision approval", () => {
    const workItem = backendFixMission();
    const bundle = makeBundle(workItem, "A-stale");
    gateReviseBundle(store, {
      bundleId: "A-stale",
      expectedRevision: 1,
      changes: [...bundle.changes],
      createdByActorId: "agent:backend-api"
    });
    expect(() =>
      gateApproveBundle(store, policy, {
        bundleId: "A-stale",
        revision: 1,
        kind: "approve_all",
        approvedBy: "user",
        reason: "stale"
      })
    ).toThrow(/is at revision 2, not 1/);
  });

  it("reports active grants per mission", () => {
    const workItem = backendFixMission();
    const bundle = makeBundle(workItem, "A-query");
    gateApproveBundle(store, policy, {
      bundleId: "A-query",
      revision: 1,
      kind: "approve_all",
      approvedBy: "user",
      reason: "reviewed"
    });
    const grants = store.listApprovalBundleGrants({ bundleId: "A-query" });
    expect(activeGrantsForMission(grants, workItem.id)).toHaveLength(bundle.changes.length);
    expect(activeGrantsForMission(grants, "M-someone-else")).toHaveLength(0);
  });
});

describe("approval strategies", () => {
  it("defaults to PER_ACTION, which is the pre-bundle behaviour", () => {
    expect(store.getApprovalStrategy().strategy).toBe("PER_ACTION");
    expect(resolveStrategy(store)).toBe("PER_ACTION");
  });

  it("fails closed when the strategy store is unreadable", () => {
    expect(
      resolveStrategy({ getApprovalStrategy: () => { throw new Error("database read failed"); } } as never)
    ).toBe("PER_ACTION");
  });

  it("fails closed to PER_ACTION when the stored value is unreadable", () => {
    store.setApprovalStrategy({ strategy: "BUNDLE", updatedBy: "user", reason: "reduce prompt fatigue" });
    expect(resolveStrategy(store)).toBe("BUNDLE");
  });

  it("fails closed when persisted strategy state is corrupt", () => {
    store.setApprovalStrategy({ strategy: "POLICY_AUTONOMOUS", updatedBy: "user", reason: "test" });
    const raw = new DatabaseSync(dbPath);
    try {
      raw.exec("PRAGMA ignore_check_constraints = ON");
      raw.prepare(`UPDATE approval_strategy_state SET strategy = 'UNKNOWN' WHERE id = 1`).run();
    } finally {
      raw.close();
    }
    expect(store.getApprovalStrategy().strategy).toBe("PER_ACTION");
    expect(resolveStrategy(store)).toBe("PER_ACTION");
    const workItem = backendFixMission();
    const verdict = authorizeBundleOperation({
      store,
      policy,
      workItem: store.get(workItem.id)!,
      action: { kind: "fs.write", description: "modify file A", params: { paths: ["services/a.ts"] } },
      actor: "agent:backend-api"
    });
    expect(verdict.allowed).toBe(false);
  });

  it("still requires a human for require_approval under POLICY_AUTONOMOUS", () => {
    const workItem = backendFixMission();
    store.setApprovalStrategy({ strategy: "POLICY_AUTONOMOUS", updatedBy: "user", reason: "policy decides" });
    const verdict = authorizeBundleOperation({
      store,
      policy,
      workItem: store.get(workItem.id)!,
      action: { kind: "fs.write", description: "modify file A", params: { paths: ["services/a.ts"] } },
      actor: "agent:backend-api"
    });
    // POLICY_AUTONOMOUS is "an explicit policy allow suffices", not "allow everything".
    expect(verdict.allowed).toBe(false);
    if (!verdict.allowed) {
      expect(verdict.reason).toBe("approval_not_required");
    }
  });

  it("allows a non-privileged action under any strategy without touching a bundle", () => {
    const workItem = backendFixMission();
    for (const strategy of ["PER_ACTION", "BUNDLE", "POLICY_AUTONOMOUS"] as const) {
      store.setApprovalStrategy({ strategy, updatedBy: "user", reason: "test" });
      const verdict = authorizeBundleOperation({
        store,
        policy,
        workItem: store.get(workItem.id)!,
        action: { kind: "fs.read", description: "read a file", params: { paths: ["services/a.ts"] } },
        actor: "agent:backend-api"
      });
      expect(verdict.allowed, strategy).toBe(true);
      if (verdict.allowed) {
        expect(verdict.reason).toBe("policy_allows_without_approval");
      }
    }
  });
});

describe("a grant is bound to the reviewed action, not to a claimed one", () => {
  /**
   * `change.actionHash` is part of the agent-supplied manifest, while the reviewer only
   * ever sees `change.action` rendered as summary/target/command. If the minted grant
   * trusted the claimed hash, a manifest that *displays* a README write could be used to
   * mint authority for restarting a production service, and the manifest self-hash would
   * stay consistent because it hashes the forged field like any other.
   */
  function forgedManifestBundle(workItem: WorkItem, bundleId: string) {
    const reviewed: ProposedChange = {
      id: "change-001",
      type: "file_write",
      summary: "Update README.md",
      target: "README.md",
      action: { kind: "fs.write", description: "modify file A", params: { paths: ["services/a.ts"] } },
      // Attacker-chosen placeholder that describes no action at all.
      actionHash: "0".repeat(64),
      risk: "low",
      destructive: false,
      network: false,
      dependsOn: []
    };
    // The operation the attacker actually wants authorized.
    const wanted = { kind: "shell", description: "restart service D", params: { command: ["systemctl", "restart", "auth-proxy"] } };
    const wantedHash = bundleChangeActionHash(workItem, { ...reviewed, action: wanted } as ProposedChange);

    const revision = createApprovalBundleRevision(
      {
        bundleId,
        missionId: workItem.id,
        executionId: `${workItem.id}-plan`,
        agentId: "agent:backend-api",
        title: "Update README.md",
        rationale: "just a readme",
        // The manifest shows the README write but claims the restart's fingerprint.
        changes: [{ ...reviewed, actionHash: wantedHash }],
        scope: {},
        baseState: {},
        createdByActorId: "agent:backend-api"
      },
      new Date()
    );
    store.createApprovalBundle({ ...revision, status: "pending" });
    return { revision, wanted, wantedHash };
  }

  it("refuses to mint authority when a change's action hash contradicts its action", () => {
    const workItem = backendFixMission();
    const { wantedHash } = forgedManifestBundle(workItem, "A-forged");

    expect(() =>
      gateApproveBundle(store, policy, {
        bundleId: "A-forged",
        revision: 1,
        kind: "approve_all",
        approvedBy: "user",
        reason: "reviewed"
      })
    ).toThrow(/action hash that does not match its action/);

    // No grant may exist, and therefore no operation may run under this bundle.
    expect(store.listApprovalBundleGrants({ bundleId: "A-forged" })).toHaveLength(0);
    const verdict = authorizeBundleOperation({
      store,
      policy,
      workItem: store.get(workItem.id)!,
      action: { kind: "shell", description: "restart service D", params: { command: ["systemctl", "restart", "auth-proxy"] } },
      actor: "agent:backend-api",
      bundleId: "A-forged"
    });
    expect(verdict.allowed).toBe(false);
    expect(wantedHash).toMatch(/^[a-f0-9]{64}$/);
  });

  it("still approves the genuine manifest produced by policy evaluation", () => {
    // The guard must key off disagreement, not off hand-written bundles in general.
    const workItem = backendFixMission();
    const bundle = makeBundle(workItem, "A-genuine");
    const result = gateApproveBundle(store, policy, {
      bundleId: "A-genuine",
      revision: 1,
      kind: "approve_all",
      approvedBy: "user",
      reason: "reviewed"
    });
    expect(Object.keys(result.approvalIdsByChange)).toHaveLength(bundle.changes.length);
  });

  it("rejects a valid action hash when human-facing fields describe a different operation", () => {
    const workItem = backendFixMission();
    const change: ProposedChange = {
      id: "change-display-forgery",
      type: "command",
      summary: "Update README.md",
      target: "README.md",
      action: {
        kind: "shell",
        description: "restart production auth proxy",
        params: { command: ["systemctl", "restart", "auth-proxy"] }
      },
      actionHash: "0".repeat(64),
      command: ["echo", "safe preview"],
      cwd: "/repo",
      risk: "medium",
      destructive: false,
      network: false,
      dependsOn: []
    };
    change.actionHash = bundleChangeActionHash(workItem, change);
    const revision = createApprovalBundleRevision(
      {
        bundleId: "A-display-forgery",
        missionId: workItem.id,
        executionId: `${workItem.id}-plan`,
        agentId: "agent:backend-api",
        title: "Update README.md",
        rationale: "small documentation change",
        changes: [change],
        scope: {},
        baseState: {},
        createdByActorId: "agent:backend-api"
      },
      new Date()
    );
    store.createApprovalBundle({ ...revision, status: "pending" });

    expect(() =>
      gateApproveBundle(store, policy, {
        bundleId: revision.bundleId,
        revision: 1,
        kind: "approve_all",
        approvedBy: "user",
        reason: "reviewed"
      })
    ).toThrow(/review fields do not match the operation/);
    expect(store.listApprovalBundleGrants({ bundleId: revision.bundleId })).toHaveLength(0);
  });

  it("rejects a bundle replayed against a different execution identity", () => {
    const workItem = backendFixMission();
    const built = buildBundleFromWorkItem({
      store,
      policy,
      workItem,
      bundleId: "A-execution-replay",
      createdByActorId: "agent:backend-api"
    });
    const { revision: _revision, manifestHash: _manifestHash, status: _status, createdAt: _createdAt, ...input } =
      built.revision;
    const replayed = createApprovalBundleRevision({ ...input, executionId: "another-execution" });
    store.createApprovalBundle({ ...replayed, status: "pending" });

    expect(() =>
      gateApproveBundle(store, policy, {
        bundleId: replayed.bundleId,
        revision: 1,
        kind: "approve_all",
        approvedBy: "user",
        reason: "reviewed"
      })
    ).toThrow(/not bound to the current work-item plan execution/);
    expect(store.listApprovalBundleGrants({ bundleId: replayed.bundleId })).toHaveLength(0);
  });

  it("rolls back earlier plan approvals when a later manifest change is forged", () => {
    const workItem = backendFixMission();
    const built = buildBundleFromWorkItem({
      store,
      policy,
      workItem,
      bundleId: "A-atomic-approval",
      createdByActorId: "agent:backend-api"
    });
    const changes = built.revision.changes.map((change, index) =>
      index === 0 ? change : { ...change, actionHash: "0".repeat(64) }
    );
    const { revision: _revision, manifestHash: _manifestHash, status: _status, createdAt: _createdAt, ...input } =
      built.revision;
    const forged = createApprovalBundleRevision({ ...input, changes });
    store.createApprovalBundle({ ...forged, status: "pending" });

    expect(() =>
      gateApproveBundle(store, policy, {
        bundleId: forged.bundleId,
        revision: 1,
        kind: "approve_all",
        approvedBy: "user",
        reason: "reviewed"
      })
    ).toThrow(/action hash that does not match its action/);
    const raw = new DatabaseSync(dbPath, { readOnly: true });
    try {
      const count = raw
        .prepare(`SELECT COUNT(*) AS count FROM execution_plan_approvals WHERE work_item_id = ?`)
        .get(workItem.id) as { count: number };
      expect(count.count).toBe(0);
    } finally {
      raw.close();
    }
    expect(store.listApprovalBundleGrants({ bundleId: forged.bundleId })).toHaveLength(0);
  });
});

describe("the authoritative plan approval is re-verified at the point of use", () => {
  it("stops covering an operation once its execution plan approval is invalidated elsewhere", () => {
    const workItem = backendFixMission();
    const bundle = makeBundle(workItem, "A-revoked");
    gateApproveBundle(store, policy, {
      bundleId: "A-revoked",
      revision: 1,
      kind: "approve_all",
      approvedBy: "user",
      reason: "reviewed"
    });
    const action = bundle.changes[0]!.action as ActionRequest;
    const current = store.get(workItem.id)!;
    expect(authorizeBundleOperation({ store, policy, workItem: current, action, actor: "a" }).allowed).toBe(true);

    // Revoke only the underlying authority, by a path that knows nothing about bundles.
    // The bundle grant row is deliberately left as-is: the bundle is a pointer, and the
    // pointer must not be sufficient on its own.
    const raw = new DatabaseSync(dbPath);
    try {
      for (const grant of store.listApprovalBundleGrants({ bundleId: "A-revoked" })) {
        raw.prepare(
          `UPDATE execution_plan_approvals
           SET status = 'invalidated', invalidated_at = ?, invalidation_reason = ?
           WHERE approval_id = ?`
        ).run(new Date().toISOString(), "revoked by an independent path", grant.approvalId);
      }
    } finally {
      raw.close();
    }
    expect(store.listApprovalBundleGrants({ bundleId: "A-revoked" })[0]!.status).toBe("granted");

    const after = authorizeBundleOperation({ store, policy, workItem: current, action, actor: "a" });
    expect(after.allowed).toBe(false);
    if (!after.allowed) {
      expect(after.code).toBe("bundle_underlying_approval_invalid");
      expect(after.coverageReason).toBe("underlying_approval_not_valid");
    }
  });

  it("stops covering an operation once its execution plan approval has been consumed", () => {
    const workItem = backendFixMission();
    const bundle = makeBundle(workItem, "A-consumed");
    gateApproveBundle(store, policy, {
      bundleId: "A-consumed",
      revision: 1,
      kind: "approve_all",
      approvedBy: "user",
      reason: "reviewed"
    });
    const action = bundle.changes[0]!.action as ActionRequest;
    const current = store.get(workItem.id)!;
    // `granted` -> `consumed` is a legal transition of the underlying approval, and it
    // is what a real attempt consumption does. The bundle row stays `granted`.
    const raw = new DatabaseSync(dbPath);
    try {
      raw.prepare(
        `UPDATE execution_plan_approvals SET status = 'consumed', consumed_at = ? WHERE work_item_id = ?`
      ).run(new Date().toISOString(), workItem.id);
    } finally {
      raw.close();
    }
    expect(store.listApprovalBundleGrants({ bundleId: "A-consumed" })[0]!.status).toBe("granted");

    const after = authorizeBundleOperation({ store, policy, workItem: current, action, actor: "a" });
    expect(after.allowed).toBe(false);
    if (!after.allowed) {
      expect(after.code).toBe("bundle_underlying_approval_invalid");
    }
  });

  it("stops covering an operation once its execution plan approval has expired", () => {
    const workItem = backendFixMission();
    const bundle = makeBundle(workItem, "A-expired");
    gateApproveBundle(store, policy, {
      bundleId: "A-expired",
      revision: 1,
      kind: "approve_all",
      approvedBy: "user",
      reason: "reviewed"
    });
    const action = bundle.changes[0]!.action as ActionRequest;
    const current = store.get(workItem.id)!;
    const raw = new DatabaseSync(dbPath);
    try {
      raw.prepare(`UPDATE execution_plan_approvals SET status = 'expired' WHERE work_item_id = ?`).run(workItem.id);
    } finally {
      raw.close();
    }
    const after = authorizeBundleOperation({ store, policy, workItem: current, action, actor: "a" });
    expect(after.allowed).toBe(false);
    if (!after.allowed) {
      expect(after.code).toBe("bundle_underlying_approval_invalid");
    }
  });

  it("fails closed when a persisted grant plan binding is tampered with", () => {
    const workItem = backendFixMission();
    const bundle = makeBundle(workItem, "A-tampered-grant");
    gateApproveBundle(store, policy, {
      bundleId: bundle.bundleId,
      revision: 1,
      kind: "approve_all",
      approvedBy: "user",
      reason: "reviewed"
    });
    const action = bundle.changes[0]!.action as ActionRequest;
    const raw = new DatabaseSync(dbPath);
    try {
      raw.exec("DROP TRIGGER approval_bundle_grants_binding_guard");
      raw.prepare(`UPDATE approval_bundle_grants SET plan_hash = ? WHERE bundle_id = ?`).run("d".repeat(64), bundle.bundleId);
    } finally {
      raw.close();
    }
    const verdict = authorizeBundleOperation({ store, policy, workItem: store.get(workItem.id)!, action, actor: "a" });
    expect(verdict.allowed).toBe(false);
    if (!verdict.allowed) expect(verdict.code).toBe("bundle_underlying_approval_invalid");
  });

  it("fails closed when the current persisted manifest no longer verifies", () => {
    const workItem = backendFixMission();
    const bundle = makeBundle(workItem, "A-tampered-manifest");
    gateApproveBundle(store, policy, {
      bundleId: bundle.bundleId,
      revision: 1,
      kind: "approve_all",
      approvedBy: "user",
      reason: "reviewed"
    });
    const action = bundle.changes[0]!.action as ActionRequest;
    const raw = new DatabaseSync(dbPath);
    try {
      raw.prepare(`UPDATE approval_bundles SET current_manifest_hash = ? WHERE bundle_id = ?`).run(
        "e".repeat(64),
        bundle.bundleId
      );
    } finally {
      raw.close();
    }
    const verdict = authorizeBundleOperation({ store, policy, workItem: store.get(workItem.id)!, action, actor: "a" });
    expect(verdict.allowed).toBe(false);
    if (!verdict.allowed) expect(verdict.code).toBe("bundle_underlying_approval_invalid");
  });
});

describe("audit trail", () => {
  it("records the requested, approved and hashed facts for the whole flow", () => {
    const workItem = backendFixMission();
    const bundle = makeBundle(workItem, "A-audit");
    gateApproveBundle(store, policy, {
      bundleId: "A-audit",
      revision: 1,
      kind: "approve_all",
      approvedBy: "user",
      reason: "reviewed"
    });
    const events = store.readEvents();
    const names = events.map((event) => event.name);
    expect(names).toContain("approval_bundle.created");
    expect(names).toContain("approval_bundle.approved");
    // The authoritative approval rows are still what carries authority.
    expect(names).toContain("execution_plan_approval.granted");
    const approved = events.find((event) => event.name === "approval_bundle.approved")!;
    expect(approved.body.manifestHash).toBe(bundle.manifestHash);
    expect(approved.body.approvedByActorId).toBe("user");
    expect(approved.attributes["approval_bundle.id"]).toBe("A-audit");
  });
});
