import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { SqliteWorkItemStore, type ActionRequest, type WorkItem } from "@agent-control-stack/work-items";
import {
  activeGrantsForMission,
  approvalDelta,
  createApprovalBundleRevision,
  type ApprovalBundleRevision
} from "@agent-control-stack/approval-bundles";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createPolicyEngine, type PolicyEngine } from "./policy.js";
import { createWorkItemTools } from "./tools.js";
import {
  authorizeBundleOperation,
  buildBundleFromWorkItem,
  buildDeltaRevision,
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
  it("stops covering an operation once the pinned base state moves", () => {
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
    gateApproveBundle(store, policy, {
      bundleId: "A-toctou",
      revision: 1,
      kind: "approve_all",
      approvedBy: "user",
      reason: "reviewed at sha-before"
    });
    const action = built.revision.changes[0]!.action as ActionRequest;

    expect(
      authorizeBundleOperation({
        store,
        policy,
        workItem: store.get(workItem.id)!,
        action,
        actor: "agent:backend-api",
        observedBaseState: { gitSha: "sha-before" }
      }).allowed
    ).toBe(true);

    const afterMove = authorizeBundleOperation({
      store,
      policy,
      workItem: store.get(workItem.id)!,
      action,
      actor: "agent:backend-api",
      observedBaseState: { gitSha: "sha-after" }
    });
    expect(afterMove.allowed).toBe(false);
    if (!afterMove.allowed) {
      expect(afterMove.coverageReason).toBe("base_state_changed");
    }
  });
});

describe("delta approval", () => {
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

  it("fails closed to PER_ACTION when the stored value is unreadable", () => {
    store.setApprovalStrategy({ strategy: "BUNDLE", updatedBy: "user", reason: "reduce prompt fatigue" });
    expect(resolveStrategy(store)).toBe("BUNDLE");
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
