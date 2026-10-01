import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { SqliteWorkItemStore, type WorkItem } from "@agent-control-stack/work-items";
import { buildBundleFromWorkItem, createPolicyEngine, createWorkItemTools } from "@agent-control-stack/policy-gate";
import type { FastifyInstance } from "fastify";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { buildGateway } from "./server.js";

/**
 * Approval bundle HTTP surface.
 *
 * These tests drive the real routes against a real store. The point of interest is
 * that no bundle route can be made to grant authority: the decision routes require
 * `acs:approve`, the approver identity is derived server-side and is not an accepted
 * body field, and every grant still goes through Policy Gate.
 *
 * The credentials mirror the shapes the gateway already supports: a read-only
 * operator, a writer, and a full approver.
 */

const approverAuth = {
  token: "approver-token",
  actor: "user",
  actorId: "approver",
  credentials: [
    {
      id: "reader",
      token: "reader-token",
      actor: "user",
      actorId: "reader",
      roles: ["operator"],
      scopes: ["acs:read"]
    },
    {
      id: "writer",
      token: "writer-token",
      actor: "user",
      actorId: "writer",
      roles: ["operator"],
      scopes: ["acs:read", "acs:write"]
    },
    {
      id: "approver",
      token: "approver-token",
      actor: "user",
      actorId: "approver",
      roles: ["operator"],
      scopes: ["acs:read", "acs:write", "acs:approve"]
    }
  ]
} as const;

let dir: string;
let dbPath: string;
let app: FastifyInstance;
let policy: ReturnType<typeof createPolicyEngine>;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "acs-bundle-api-"));
  dbPath = join(dir, "control.db");
  const seed = new SqliteWorkItemStore(dbPath);
  try {
    for (const id of ["reader", "writer", "approver"]) {
      seed.registerActor({ id, actorType: "HUMAN", displayName: id, externalRef: `local_bearer:${id}` });
    }
  } finally {
    seed.close();
  }
  policy = createPolicyEngine();
  app = buildGateway({ dbPath, logger: false, auth: approverAuth as never });
});

afterEach(async () => {
  await app.close();
  rmSync(dir, { recursive: true, force: true });
});

function call(
  method: "GET" | "POST",
  url: string,
  token: string,
  payload?: Record<string, unknown>
): Promise<{ statusCode: number; body: string; json<T = unknown>(): T }> {
  return app.inject({
    method,
    url,
    headers: token ? { authorization: `Bearer ${token}` } : {},
    ...(payload === undefined ? {} : { payload })
  });
}

function seedBundle(bundleId = "A-184"): { bundleId: string; workItem: WorkItem } {
  const store = new SqliteWorkItemStore(dbPath);
  try {
    const workItem = createWorkItemTools(store, policy).create_work_item({
      title: "Backend config fix",
      requester: "user",
      intent: "repair the backend auth configuration",
      target: { cwd: "/repo" },
      requestedActions: [
        { kind: "fs.write", description: "modify file A", params: { paths: ["services/a.ts"] } },
        { kind: "fs.write", description: "modify file B", params: { paths: ["services/b.ts"] } }
      ],
      risk: "medium"
    });
    const built = buildBundleFromWorkItem({
      store,
      policy,
      workItem,
      bundleId,
      createdByActorId: "user"
    });
    store.createApprovalBundle({ ...built.revision, status: "pending" });
    return { bundleId, workItem };
  } finally {
    store.close();
  }
}

describe("approval strategy API", () => {
  it("serves the strategy and defaults to PER_ACTION", async () => {
    const response = await call("GET", "/approval-strategy", "reader-token");
    expect(response.statusCode).toBe(200);
    expect((response.json() as { approvalStrategy: string }).approvalStrategy).toBe("PER_ACTION");
  });

  it("requires authentication", async () => {
    expect((await call("GET", "/approval-strategy", "")).statusCode).toBe(401);
  });

  it("requires acs:write to change the strategy", async () => {
    const denied = await call("POST", "/approval-strategy", "reader-token", {
      strategy: "BUNDLE",
      reason: "reduce prompt fatigue"
    });
    expect(denied.statusCode).toBe(403);

    const allowed = await call("POST", "/approval-strategy", "writer-token", {
      strategy: "BUNDLE",
      reason: "reduce prompt fatigue"
    });
    expect(allowed.statusCode).toBe(200);
    expect((allowed.json() as { approvalStrategy: string }).approvalStrategy).toBe("BUNDLE");
  });

  it("refuses an unknown strategy instead of defaulting it", async () => {
    const response = await call("POST", "/approval-strategy", "writer-token", {
      strategy: "ALLOW_EVERYTHING",
      reason: "should never be accepted"
    });
    expect(response.statusCode).toBeGreaterThanOrEqual(400);
    const store = new SqliteWorkItemStore(dbPath);
    try {
      expect(store.getApprovalStrategy().strategy).toBe("PER_ACTION");
    } finally {
      store.close();
    }
  });

  it("records who changed the strategy and why", async () => {
    await call("POST", "/approval-strategy", "writer-token", {
      strategy: "POLICY_AUTONOMOUS",
      reason: "policy already covers these"
    });
    const store = new SqliteWorkItemStore(dbPath);
    try {
      const events = store.readEvents().filter((event) => event.name === "approval_strategy.changed");
      expect(events).toHaveLength(1);
      expect(events[0]!.body.strategy).toBe("POLICY_AUTONOMOUS");
    } finally {
      store.close();
    }
  });

  it.each(["PER_ACTION", "BUNDLE", "POLICY_AUTONOMOUS"] as const)(
    "creates proposals only for BUNDLE strategy when policy requires approval (%s)",
    (strategy) => {
      const store = new SqliteWorkItemStore(dbPath);
      try {
        store.setApprovalStrategy({ strategy, updatedBy: "writer", reason: "strategy coverage" });
        const tools = createWorkItemTools(store, policy);
        const workItem = tools.create_work_item({
          title: "Write an application file",
          requester: "agent",
          requesterSubject: "agent-17",
          intent: "apply a reviewed configuration change",
          target: { cwd: "/repo" },
          requestedActions: [{ kind: "fs.write", description: "write config", params: { paths: ["app/config.ts"] } }],
          risk: "medium"
        });
        const bundles = store.listApprovalBundles({ missionId: workItem.id });
        if (strategy === "BUNDLE") {
          expect(workItem.status).toBe("needs_approval");
          expect(store.getApprovalStrategy().strategy).toBe("BUNDLE");
          expect(bundles).toHaveLength(1);
          expect(bundles[0]).toMatchObject({
            status: "pending",
            missionId: workItem.id,
            executionId: store.getCurrentExecutionPlan(workItem.id)?.planId,
            agentId: "agent-17"
          });
          expect(store.listApprovalBundleGrants({ workItemId: workItem.id })).toHaveLength(0);
          expect(
            store.getExecutionPlanApproval(
              workItem.id,
              store.getCurrentExecutionPlan(workItem.id)!.planHash,
              bundles[0]!.changes[0]!.actionHash
            )
          ).toBeUndefined();
        } else {
          expect(bundles).toHaveLength(0);
        }
      } finally {
        store.close();
      }
    }
  );
});

describe("approval bundle proposal API", () => {
  function createBundleWorkItem(): WorkItem {
    const store = new SqliteWorkItemStore(dbPath);
    try {
      store.setApprovalStrategy({ strategy: "BUNDLE", updatedBy: "writer", reason: "proposal API test" });
      return createWorkItemTools(store, policy).create_work_item({
        title: "Bundle API change",
        requester: "agent",
        requesterSubject: "agent-17",
        intent: "apply a reviewed configuration change",
        target: { cwd: "/repo" },
        requestedActions: [{ kind: "fs.write", description: "write config", params: { paths: ["app/config.ts"] } }],
        risk: "medium"
      });
    } finally {
      store.close();
    }
  }

  it("requires acs:write and rejects spoofed authority fields", async () => {
    const workItem = createBundleWorkItem();
    expect((await call("POST", `/work-items/${workItem.id}/approval-bundles`, "reader-token", {})).statusCode).toBe(
      403
    );
    const spoofed = await call("POST", `/work-items/${workItem.id}/approval-bundles`, "writer-token", {
      missionId: "other-mission",
      executionId: "other-execution",
      manifestHash: "0".repeat(64),
      actionHash: "0".repeat(64),
      grantId: "forged"
    });
    expect(spoofed.statusCode).toBe(400);
  });

  it("creates or reuses the server-bound proposal without minting authority", async () => {
    const workItem = createBundleWorkItem();
    const first = await call("POST", `/work-items/${workItem.id}/approval-bundles`, "writer-token", {
      title: "Reviewed application configuration"
    });
    const second = await call("POST", `/work-items/${workItem.id}/approval-bundles`, "writer-token", {});
    expect(first.statusCode, first.body).toBe(200);
    expect(second.statusCode).toBe(200);
    const firstBundle = (
      first.json() as {
        bundle: {
          bundleId: string;
          missionId: string;
          executionId: string;
          agentId: string;
          revision: number;
          status: string;
        };
      }
    ).bundle;
    const secondBundle = (second.json() as { bundle: { bundleId: string; revision: number } }).bundle;
    expect(secondBundle).toMatchObject({ bundleId: firstBundle.bundleId, revision: 1 });
    expect(firstBundle).toMatchObject({
      missionId: workItem.id,
      executionId: expect.any(String),
      agentId: "agent-17",
      revision: 1,
      status: "pending"
    });
    const store = new SqliteWorkItemStore(dbPath);
    try {
      expect(firstBundle.executionId).toBe(store.getCurrentExecutionPlan(workItem.id)?.planId);
      expect(store.listApprovalBundles({ missionId: workItem.id })).toHaveLength(1);
      expect(store.listApprovalBundleGrants({ workItemId: workItem.id })).toHaveLength(0);
    } finally {
      store.close();
    }
  });

  it("refuses manual proposal creation when BUNDLE strategy is inactive", async () => {
    const store = new SqliteWorkItemStore(dbPath);
    let workItem: WorkItem;
    try {
      workItem = createWorkItemTools(store, policy).create_work_item({
        title: "Per action change",
        requester: "agent",
        intent: "change one file",
        target: { cwd: "/repo" },
        requestedActions: [{ kind: "fs.write", description: "write config", params: { paths: ["app/config.ts"] } }],
        risk: "medium"
      });
    } finally {
      store.close();
    }
    const response = await call("POST", `/work-items/${workItem.id}/approval-bundles`, "writer-token", {});
    expect(response.statusCode).toBe(409);
  });

  it("keeps the legacy per-action approval route closed while a BUNDLE proposal is active", async () => {
    const workItem = createBundleWorkItem();
    const store = new SqliteWorkItemStore(dbPath);
    const bundle = store.listApprovalBundles({ missionId: workItem.id })[0]!;
    const actionHash = bundle.changes[0]!.actionHash;
    store.close();

    const response = await call("POST", `/work-items/${workItem.id}/approve`, "approver-token", {
      actionHash,
      reason: "try to bypass bundle review"
    });
    expect(response.statusCode).toBe(409);
    const check = new SqliteWorkItemStore(dbPath);
    try {
      expect(check.listApprovalBundleGrants({ workItemId: workItem.id })).toHaveLength(0);
    } finally {
      check.close();
    }
  });
});

describe("approval bundle read API", () => {
  it("requires authentication", async () => {
    expect((await call("GET", "/approval-bundles", "")).statusCode).toBe(401);
  });

  it("404s an unknown bundle", async () => {
    expect((await call("GET", "/approval-bundles/A-nope", "reader-token")).statusCode).toBe(404);
  });

  it("returns a bundle with its changes, revisions, delta and grants", async () => {
    const { bundleId } = seedBundle();
    await call("POST", `/approval-bundles/${bundleId}/approve`, "approver-token", {
      revision: 1,
      kind: "approve_all",
      reason: "reviewed the change set"
    });
    const response = await call("GET", `/approval-bundles/${bundleId}`, "reader-token");
    expect(response.statusCode).toBe(200);
    const body = response.json() as {
      bundle: {
        bundleId: string;
        changes: Array<{ actionHash: string }>;
        approvals: unknown[];
        manifestHash: string;
      };
      grants: unknown[];
    };
    expect(body.bundle.bundleId).toBe(bundleId);
    expect(body.bundle.changes).toHaveLength(2);
    expect(body.bundle.changes[0].actionHash).toMatch(/^[a-f0-9]{64}$/);
    expect(body.bundle.approvals).toHaveLength(1);
    expect(body.grants).toHaveLength(2);
    expect(body.bundle.manifestHash).toMatch(/^[a-f0-9]{64}$/);
  });

  it("lists bundles with the active strategy", async () => {
    seedBundle("A-list");
    const response = await call("GET", "/approval-bundles", "reader-token");
    expect(response.statusCode).toBe(200);
    const listed = response.json() as { bundles: unknown[]; approvalStrategy: string };
    expect(listed.bundles).toHaveLength(1);
    expect(listed.approvalStrategy).toBe("PER_ACTION");
  });
});

describe("approval bundle decision API", () => {
  it("refuses a decision without acs:approve", async () => {
    const { bundleId } = seedBundle();
    const response = await call("POST", `/approval-bundles/${bundleId}/approve`, "writer-token", {
      revision: 1,
      kind: "approve_all",
      reason: "looks fine to me"
    });
    expect(response.statusCode).toBe(403);
  });

  it("does not accept a caller-supplied approver identity", async () => {
    const { bundleId } = seedBundle();
    const response = await call("POST", `/approval-bundles/${bundleId}/approve`, "approver-token", {
      revision: 1,
      kind: "approve_all",
      reason: "approve",
      approvedBy: "attacker"
    });
    // The strict body schema has no approvedBy field, so a spoofed identity is a 400
    // rather than a silently-ignored extra.
    expect(response.statusCode).toBe(400);
  });

  it("rejects unknown fields in a decision body", async () => {
    const { bundleId } = seedBundle();
    const response = await call("POST", `/approval-bundles/${bundleId}/approve`, "approver-token", {
      revision: 1,
      kind: "approve_all",
      reason: "approve",
      escalate: true
    });
    expect(response.statusCode).toBe(400);
  });

  it("approves a bundle in one request and records the approver", async () => {
    const { bundleId } = seedBundle();
    const response = await call("POST", `/approval-bundles/${bundleId}/approve`, "approver-token", {
      revision: 1,
      kind: "approve_all",
      reason: "reviewed the change set"
    });
    expect(response.statusCode).toBe(200);
    const body = response.json() as {
      decision: { approvedByActorId: string; kind: string; changeIds: string[] };
      bundle: { status: string };
    };
    expect(body.decision.approvedByActorId).toBe("approver");
    expect(body.decision.kind).toBe("approve_all");
    expect(body.decision.changeIds).toHaveLength(2);
    expect(body.bundle.status).toBe("approved");
  });

  it("refuses a stale revision", async () => {
    const { bundleId } = seedBundle();
    const response = await call("POST", `/approval-bundles/${bundleId}/approve`, "approver-token", {
      revision: 9,
      kind: "approve_all",
      reason: "approve"
    });
    expect(response.statusCode).toBeGreaterThanOrEqual(400);
    expect((response.json() as { code: string }).code).toBe("approval_bundle_revision_conflict");
  });

  it("records a rejection without minting any grant", async () => {
    const { bundleId } = seedBundle();
    const response = await call("POST", `/approval-bundles/${bundleId}/approve`, "approver-token", {
      revision: 1,
      kind: "reject",
      reason: "wrong target repo"
    });
    expect(response.statusCode).toBe(200);
    expect((response.json() as { bundle: { status: string } }).bundle.status).toBe("rejected");
    const store = new SqliteWorkItemStore(dbPath);
    try {
      expect(store.listApprovalBundleGrants({ bundleId })).toHaveLength(0);
      const missionId = store.getApprovalBundle(bundleId)!.missionId;
      expect(store.get(missionId)?.status).toBe("rejected");
    } finally {
      store.close();
    }
  });

  it("is idempotent: a retried approval does not mint a second set of grants", async () => {
    const { bundleId } = seedBundle();
    const body = { revision: 1, kind: "approve_all", reason: "reviewed" };
    const first = await call("POST", `/approval-bundles/${bundleId}/approve`, "approver-token", body);
    const second = await call("POST", `/approval-bundles/${bundleId}/approve`, "approver-token", body);
    const firstDecision = (first.json() as { decision: { id: string } }).decision;
    const secondDecision = (second.json() as { decision: { id: string } }).decision;
    expect(secondDecision.id).toBe(firstDecision.id);
    const store = new SqliteWorkItemStore(dbPath);
    try {
      expect(store.listApprovalBundleGrants({ bundleId })).toHaveLength(2);
    } finally {
      store.close();
    }
  });
});

describe("approval bundle revision API", () => {
  it("requires acs:write to propose a new revision", async () => {
    const { bundleId } = seedBundle();
    const response = await call("POST", `/approval-bundles/${bundleId}/revisions`, "reader-token", {
      expectedRevision: 1,
      changes: [
        {
          id: "change-001",
          type: "file_write",
          summary: "modify file C",
          target: "services/c.ts",
          action: { kind: "fs.write", description: "modify file C", params: { paths: ["services/c.ts"] } },
          actionHash: "c".repeat(64),
          risk: "high",
          destructive: false,
          network: false,
          dependsOn: []
        }
      ]
    });
    expect(response.statusCode).toBe(403);
  });

  it("reports the delta between the approved revision and the proposal", async () => {
    const { bundleId } = seedBundle();
    await call("POST", `/approval-bundles/${bundleId}/approve`, "approver-token", {
      revision: 1,
      kind: "approve_all",
      reason: "reviewed"
    });

    // Reuse the real action hashes from the stored revision. Fabricating them would make
    // the original changes legitimately classify as `modified`, which is a different test.
    const stored = (await call("GET", `/approval-bundles/${bundleId}`, "reader-token")).json() as {
      bundle: { changes: Array<Record<string, unknown>> };
    };
    // Echo the stored changes back verbatim and add one new change. Rebuilding them by
    // hand would omit authorization-relevant fields such as `paths` and the change would
    // correctly classify as `modified` rather than `unchanged`.
    const echoed = stored.bundle.changes.map((change) => ({
      id: change.id,
      type: change.type,
      summary: change.summary,
      target: change.target,
      action: { kind: change.actionKind, description: change.summary, params: { paths: change.paths } },
      actionHash: change.actionHash,
      risk: change.risk,
      destructive: change.destructive,
      network: change.network,
      dependsOn: change.dependsOn,
      ...(change.paths ? { paths: change.paths } : {}),
      ...(change.cwd ? { cwd: change.cwd } : {})
    }));
    const response = await call("POST", `/approval-bundles/${bundleId}/revisions`, "writer-token", {
      expectedRevision: 1,
      reason: "discovered a third file during execution",
      changes: [
        ...echoed,
        {
          id: "change-003",
          type: "config_change",
          summary: "update gateway configuration",
          target: "config/gateway.env",
          action: {
            kind: "fs.write",
            description: "update gateway configuration",
            params: { paths: ["config/gateway.env"] }
          },
          actionHash: "f".repeat(64),
          risk: "high",
          destructive: false,
          network: false,
          dependsOn: []
        }
      ]
    });
    expect(response.statusCode).toBe(201);
    const body = response.json() as {
      bundle: { revision: number };
      delta: {
        unchanged: unknown[];
        added: Array<{ changeId: string }>;
        requiresApproval: unknown[];
      };
    };
    expect(body.bundle.revision).toBe(2);
    // The two already-approved changes are unchanged; only the new one needs approval.
    expect(body.delta.unchanged).toHaveLength(2);
    expect(body.delta.added.map((entry) => entry.changeId)).toEqual(["change-003"]);
    expect(body.delta.requiresApproval).toHaveLength(1);
  });
});

describe("bundle route rate limiting", () => {
  it("rate limits bundle reads", async () => {
    let limited = false;
    for (let index = 0; index < 400 && !limited; index += 1) {
      const response = await call("GET", "/approval-bundles", "reader-token");
      if (response.statusCode === 429) {
        limited = true;
        expect((response.json() as { code: string }).code).toBe("rate_limited");
      }
    }
    expect(limited).toBe(true);
  });
});
