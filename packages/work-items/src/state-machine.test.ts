import { copyFileSync, existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import {
  ControlStackError,
  applyControlPlaneMigrations,
  controlPlaneMigrations,
  stableHash
} from "@agent-control-stack/shared";
import { describe, expect, it } from "vitest";
import { DEFAULT_EVENT_LIMIT, SqliteWorkItemStore, WorkItemEvent, transitionWorkItem } from "./index.js";

const domainTransition = { via: "domain_service" } as const;

function resultInput(
  claimed: { id: string; leaseId: string; workerId: string; actionHash: string; startedAt: string },
  overrides: Record<string, unknown> = {}
) {
  return {
    workItemId: claimed.id,
    leaseId: claimed.leaseId,
    workerId: claimed.workerId,
    actionHash: claimed.actionHash,
    idempotencyKey: stableHash({ workItemId: claimed.id, leaseId: claimed.leaseId, attempt: 1 }),
    outcome: "succeeded" as const,
    startedAt: claimed.startedAt,
    finishedAt: new Date(Date.parse(claimed.startedAt) + 10).toISOString(),
    exitCode: 0,
    summary: "simulated result",
    stdout: "no real command ran",
    stderr: "",
    structuredOutput: { simulated: true },
    artifacts: [],
    simulationMetadata: { executionMode: "dry_run" as const, simulated: true },
    ...overrides
  };
}

describe("work item state machine", () => {
  it("reads audit events with bounded pagination filters", () => {
    const dir = mkdtempSync(join(tmpdir(), "acs-event-pagination-"));
    const store = new SqliteWorkItemStore(join(dir, "control.db"));

    try {
      for (let index = 0; index < 3; index += 1) {
        store.recordConnectorRequest({
          actor: "user",
          source: "test",
          route: "/mcp",
          toolName: `tool-${index}`
        });
      }

      const limited = store.readEvents({ limit: 2 });
      expect(limited).toHaveLength(2);
      expect(limited.map((event) => event.sequence)).toEqual([2, 3]);
      expect(store.readEvents({ afterSequence: 1 }).map((event) => event.sequence)).toEqual([2, 3]);
    } finally {
      store.close();
    }
  });

  it("applies a default audit event limit", () => {
    const dir = mkdtempSync(join(tmpdir(), "acs-event-default-limit-"));
    const store = new SqliteWorkItemStore(join(dir, "control.db"));

    try {
      for (let index = 0; index < DEFAULT_EVENT_LIMIT + 5; index += 1) {
        store.recordConnectorRequest({
          actor: "user",
          source: "test",
          route: "/mcp",
          toolName: `tool-${index}`
        });
      }

      const events = store.readEvents();
      expect(events).toHaveLength(DEFAULT_EVENT_LIMIT);
      expect(events[0]?.sequence).toBe(6);
      expect(events.at(-1)?.sequence).toBe(DEFAULT_EVENT_LIMIT + 5);
    } finally {
      store.close();
    }
  }, 30_000);

  it("reads only events for the requested work item or agent", () => {
    const dir = mkdtempSync(join(tmpdir(), "acs-event-filter-"));
    const store = new SqliteWorkItemStore(join(dir, "control.db"));

    try {
      store.registerActor({ id: "user", actorType: "HUMAN", displayName: "Jace" });
      const first = store.create({
        title: "First filtered item",
        requester: "user",
        intent: "verify item filtering",
        requestedActions: [{ kind: "manual", description: "filter" }],
        risk: "low"
      });
      const second = store.create({
        title: "Second filtered item",
        requester: "user",
        intent: "verify item filtering",
        requestedActions: [{ kind: "manual", description: "filter" }],
        risk: "low"
      });
      store.recordPolicyDecision({
        workItemId: first.id,
        actionHash: "hash-first",
        decision: "allow",
        reason: "test",
        matchedRules: [],
        context: {}
      });
      store.recordPolicyDecision({
        workItemId: second.id,
        actionHash: "hash-second",
        decision: "allow",
        reason: "test",
        matchedRules: [],
        context: {}
      });

      store.createRegistryAgent({
        id: "agent-one",
        name: "Agent One",
        kind: "cli",
        acpRole: "IMPLEMENTATION_AGENT",
        actorId: "user"
      });
      store.createRegistryAgent({
        id: "agent-two",
        name: "Agent Two",
        kind: "cli",
        acpRole: "IMPLEMENTATION_AGENT",
        actorId: "user"
      });
      store.recordAgentHeartbeat("agent-one", { status: "AVAILABLE", actorId: "user" });
      store.recordAgentHeartbeat("agent-two", { status: "AVAILABLE", actorId: "user" });

      const workItemEvents = store.readEvents({ workItemId: first.id, limit: 10 });
      expect(workItemEvents).toHaveLength(2);
      expect(workItemEvents.every((event) => event.attributes["work_item.id"] === first.id)).toBe(true);

      const agentEvents = store.readEvents({ agentId: "agent-one", limit: 10 });
      expect(agentEvents).toHaveLength(2);
      expect(agentEvents.every((event) => event.attributes["agent.id"] === "agent-one")).toBe(true);
    } finally {
      store.close();
    }
  });

  it("rejects invalid transitions", () => {
    const draft = {
      id: "wrk_test",
      title: "Draft item",
      requester: "user" as const,
      status: "draft" as const,
      intent: "prove transition enforcement",
      target: {},
      requestedActions: [],
      risk: "low" as const,
      createdAt: "2026-07-05T00:00:00.000Z",
      updatedAt: "2026-07-05T00:00:00.000Z"
    };

    expect(() => transitionWorkItem(draft, "running")).toThrow(ControlStackError);
  });

  it("requires worker claim path before running persisted work", () => {
    const dir = mkdtempSync(join(tmpdir(), "acs-running-claim-"));
    const store = new SqliteWorkItemStore(join(dir, "control.db"));

    try {
      const workItem = store.create({
        title: "Claim-only running item",
        requester: "agent",
        intent: "verify running transition gate",
        requestedActions: [{ kind: "manual", description: "claim" }],
        risk: "low"
      });
      store.approveWorkItem(workItem.id, domainTransition);

      expectControlError(() => store.transition(workItem.id, "running"), "worker_claim_required");
      expect(store.claimNextApprovedWorkItem("worker-a", { allowLegacyClaimForTests: true })?.status).toBe("running");
    } finally {
      store.close();
    }
  });

  it("rejects direct privileged transitions without a domain guard", () => {
    const dir = mkdtempSync(join(tmpdir(), "acs-privileged-transition-"));
    const store = new SqliteWorkItemStore(join(dir, "control.db"));

    try {
      const workItem = store.create({
        title: "Direct transition",
        requester: "user",
        intent: "verify policy bypass guard",
        requestedActions: [{ kind: "manual", description: "guard" }],
        risk: "low"
      });
      store.blockWorkItem(workItem.id);

      expectControlError(() => store.approveWorkItem(workItem.id), "policy_gate_required");
      expectControlError(() => store.unblockWorkItem(workItem.id), "policy_gate_required");
      expectControlError(() => store.cancelWorkItem(workItem.id, { actor: "user" }), "policy_gate_required");
      expectControlError(() => store.rejectWorkItem(workItem.id, { actor: "user" }), "policy_gate_required");
      expectControlError(() => store.transition(workItem.id, "approved"), "policy_gate_required");
    } finally {
      store.close();
    }
  });

  it("rejects approval-requested work with a distinct terminal state and event", () => {
    const dir = mkdtempSync(join(tmpdir(), "acs-reject-state-"));
    const store = new SqliteWorkItemStore(join(dir, "control.db"));

    try {
      const workItem = store.create({
        title: "Reject item",
        requester: "user",
        intent: "verify rejection is not cancellation",
        requestedActions: [{ kind: "manual", description: "reject" }],
        risk: "high"
      });

      const rejected = store.rejectWorkItem(workItem.id, { actor: "operator", reason: "denied" }, domainTransition);

      expect(rejected.status).toBe("rejected");
      expect(store.get(workItem.id)?.status).toBe("rejected");
      expect(store.readEvents().map((event) => event.name)).toContain(WorkItemEvent.Rejected);
      expect(store.readEvents().map((event) => event.name)).not.toContain(WorkItemEvent.Cancelled);
      expectControlError(() => store.approveWorkItem(workItem.id, domainTransition), "invalid_work_item_transition");
      expect(store.claimNextApprovedWorkItem("worker-a")).toBeUndefined();
    } finally {
      store.close();
    }
  });

  it("requires explicit actors for cancel and reject store transitions", () => {
    const dir = mkdtempSync(join(tmpdir(), "acs-terminal-actor-"));
    const store = new SqliteWorkItemStore(join(dir, "control.db"));

    try {
      const cancelled = store.create({
        title: "Cancel requires actor",
        requester: "user",
        intent: "verify explicit cancel actor",
        requestedActions: [{ kind: "manual", description: "cancel" }],
        risk: "low"
      });
      const rejected = store.create({
        title: "Reject requires actor",
        requester: "user",
        intent: "verify explicit reject actor",
        requestedActions: [{ kind: "manual", description: "reject" }],
        risk: "high"
      });

      expect(() => store.cancelWorkItem(cancelled.id, {}, domainTransition)).toThrow();
      expect(() => store.rejectWorkItem(rejected.id, {}, domainTransition)).toThrow();
      expect(store.get(cancelled.id)?.status).toBe("pending_policy");
      expect(store.get(rejected.id)?.status).toBe("needs_approval");
    } finally {
      store.close();
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("stores work items and blocks execution before approval", () => {
    const dir = mkdtempSync(join(tmpdir(), "acs-work-"));
    const store = new SqliteWorkItemStore(join(dir, "control.db"));

    try {
      const workItem = store.create({
        title: "SQLite backed item",
        requester: "agent",
        intent: "verify table storage",
        requestedActions: [{ kind: "manual", description: "check storage" }],
        risk: "medium"
      });

      expect(store.get(workItem.id)?.status).toBe("pending_policy");
      expect(store.readEvents().map((event) => event.name)).toEqual([WorkItemEvent.Created]);
      expect(() => store.startWorkItem(workItem.id)).toThrow(ControlStackError);
      expect(store.approveWorkItem(workItem.id, domainTransition).status).toBe("approved");
      expectControlError(() => store.startWorkItem(workItem.id), "worker_claim_required");
      expect(store.startWorkItem(workItem.id, "test-worker", { allowDirectStartForTests: true }).status).toBe(
        "running"
      );
    } finally {
      store.close();
    }
  });

  it("moves high-risk work to needs_approval", () => {
    const dir = mkdtempSync(join(tmpdir(), "acs-risk-"));
    const store = new SqliteWorkItemStore(join(dir, "control.db"));

    try {
      const workItem = store.create({
        title: "High risk item",
        requester: "user",
        intent: "verify approval trigger",
        requestedActions: [{ kind: "manual", description: "inspect" }],
        risk: "high"
      });

      expect(workItem.status).toBe("needs_approval");
    } finally {
      store.close();
    }
  });

  it("claims approved work once across store connections", () => {
    const dir = mkdtempSync(join(tmpdir(), "acs-claim-"));
    const dbPath = join(dir, "control.db");
    const first = new SqliteWorkItemStore(dbPath);
    const second = new SqliteWorkItemStore(dbPath);

    try {
      const workItem = first.create({
        title: "Claim once",
        requester: "agent",
        intent: "verify SQL compare-and-swap",
        requestedActions: [{ kind: "manual", description: "claim" }],
        risk: "low"
      });
      first.approveWorkItem(workItem.id, domainTransition);

      const claimed = first.claimNextApprovedWorkItem("worker-a", { allowLegacyClaimForTests: true });
      expect(claimed?.id).toBe(workItem.id);
      expect(claimed?.workerId).toBe("worker-a");
      expect(claimed?.leaseToken).toEqual(expect.any(String));
      expect(claimed?.leaseExpiresAt).toEqual(expect.any(String));
      expect(second.claimNextApprovedWorkItem("worker-b")).toBeUndefined();
      expect(first.readEvents().filter((event) => event.name === WorkItemEvent.Running)).toHaveLength(1);
    } finally {
      first.close();
      second.close();
    }
  });

  it("stores only a lease token hash and hides lease material from reads and audit", () => {
    const dir = mkdtempSync(join(tmpdir(), "acs-claim-hash-"));
    const dbPath = join(dir, "control.db");
    const store = new SqliteWorkItemStore(dbPath);

    try {
      const workItem = store.create({
        title: "Hash-only lease",
        requester: "agent",
        intent: "verify raw lease token is one-time material",
        requestedActions: [{ kind: "manual", description: "claim" }],
        risk: "low"
      });
      store.approveWorkItem(workItem.id, domainTransition);

      const claimed = store.claimNextApprovedWorkItem("worker-a", { allowLegacyClaimForTests: true });
      expect(claimed?.leaseToken).toEqual(expect.any(String));

      const row = readLeaseRow(dbPath, workItem.id);
      expect(row.worker_id).toBe("worker-a");
      expect(row.lease_token_hash).toMatch(/^[a-f0-9]{64}$/);
      expect(row.lease_token_hash).not.toBe(claimed!.leaseToken);
      expect(row.lease_expires_at).toEqual(expect.any(String));

      const publicSurface = JSON.stringify({
        get: store.get(workItem.id),
        list: store.list(),
        events: store.readEvents()
      });
      expect(publicSurface).not.toContain(claimed!.leaseToken);
      expect(publicSurface).not.toContain(row.lease_token_hash);
      expect(publicSurface).not.toContain("lease_token_hash");
    } finally {
      store.close();
    }
  });

  it("fails stale running leases", () => {
    const dir = mkdtempSync(join(tmpdir(), "acs-lease-"));
    const store = new SqliteWorkItemStore(join(dir, "control.db"));

    try {
      const workItem = store.create({
        title: "Lease item",
        requester: "agent",
        intent: "verify reaper",
        requestedActions: [{ kind: "manual", description: "lease" }],
        risk: "low"
      });
      store.approveWorkItem(workItem.id, domainTransition);
      store.claimNextApprovedWorkItem("worker-a", { leaseMs: 1, allowLegacyClaimForTests: true });

      const failed = store.failExpiredLeases(new Date(Date.now() + 1000));

      expect(failed).toHaveLength(1);
      expect(store.get(workItem.id)?.status).toBe("failed");
      expect(store.readEvents().at(-1)?.name).toBe(WorkItemEvent.Failed);
    } finally {
      store.close();
    }
  });

  it("binds result submission to the claimed worker lease", () => {
    const dir = mkdtempSync(join(tmpdir(), "acs-result-lease-"));
    const store = new SqliteWorkItemStore(join(dir, "control.db"));

    try {
      const workItem = store.create({
        title: "Lease-bound result",
        requester: "agent",
        intent: "verify worker lease",
        requestedActions: [{ kind: "manual", description: "result" }],
        risk: "low"
      });
      store.approveWorkItem(workItem.id, domainTransition);
      const claimed = store.claimNextApprovedWorkItem("worker-a", { allowLegacyClaimForTests: true });

      expectControlError(
        () =>
          store.submitWorkResult({
            ...resultInput(claimed!, { workerId: "worker-b" })
          }),
        "worker_lease_mismatch"
      );
      expectControlError(
        () =>
          store.submitWorkResult({
            ...resultInput(claimed!, { actionHash: "0".repeat(64) })
          }),
        "worker_action_hash_mismatch"
      );

      expect(store.submitWorkResult(resultInput(claimed!, { stdout: "ok" })).status).toBe("succeeded");
      expect(JSON.stringify(store.readEvents())).not.toContain(claimed!.leaseToken);
    } finally {
      store.close();
    }
  });

  it("rejects a privileged transition asserted by a non-owner while a worker lease is active", () => {
    const dir = mkdtempSync(join(tmpdir(), "acs-privileged-lease-owner-"));
    const store = new SqliteWorkItemStore(join(dir, "control.db"));

    try {
      const workItem = store.create({
        title: "Lease-owned cancellation",
        requester: "agent",
        intent: "prevent a stale actor from cancelling running work",
        requestedActions: [{ kind: "manual", description: "cancel" }],
        risk: "low"
      });
      store.approveWorkItem(workItem.id, domainTransition);
      store.claimNextApprovedWorkItem("worker-a", { allowLegacyClaimForTests: true });

      expectControlError(
        () => store.cancelWorkItem(workItem.id, { actor: "worker-b" }, { via: "domain_service", actorId: "worker-b" }),
        "worker_lease_actor_mismatch"
      );
      expect(store.get(workItem.id)?.status).toBe("running");

      const cancelled = store.cancelWorkItem(
        workItem.id,
        { actor: "worker-a" },
        { via: "domain_service", actorId: "worker-a" }
      );
      expect(cancelled.status).toBe("cancelled");
      expect(store.readEvents().at(-1)?.attributes["actor.id"]).toBe("worker-a");
    } finally {
      store.close();
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("rejects result submission when request omits worker lease fields", () => {
    const dir = mkdtempSync(join(tmpdir(), "acs-result-lease-fields-"));
    const store = new SqliteWorkItemStore(join(dir, "control.db"));

    try {
      const workItem = store.create({
        title: "Lease field result",
        requester: "agent",
        intent: "verify required worker lease fields",
        requestedActions: [{ kind: "manual", description: "result" }],
        risk: "low"
      });
      store.approveWorkItem(workItem.id, domainTransition);
      const claimed = store.claimNextApprovedWorkItem("worker-a", { allowLegacyClaimForTests: true });

      expect(() =>
        store.submitWorkResult({
          workItemId: workItem.id
        })
      ).toThrow();
      expect(() =>
        store.submitWorkResult({
          workItemId: workItem.id,
          leaseId: claimed!.leaseId
        })
      ).toThrow();
    } finally {
      store.close();
    }
  });

  it("rejects result submission when stored lease hash is missing or malformed", () => {
    const dir = mkdtempSync(join(tmpdir(), "acs-result-lease-hash-"));
    const dbPath = join(dir, "control.db");
    const store = new SqliteWorkItemStore(dbPath);

    try {
      const workItem = store.create({
        title: "Stored lease hash result",
        requester: "agent",
        intent: "verify stored lease hash gate",
        requestedActions: [{ kind: "manual", description: "result" }],
        risk: "low"
      });
      store.approveWorkItem(workItem.id, domainTransition);
      const claimed = store.claimNextApprovedWorkItem("worker-a", { allowLegacyClaimForTests: true });

      updateWorkItemColumn(dbPath, workItem.id, "lease_token_hash", null);
      expectControlError(() => store.submitWorkResult(resultInput(claimed!)), "worker_lease_missing");

      updateWorkItemColumn(dbPath, workItem.id, "lease_token_hash", "not-a-sha256-hex-digest");
      expectControlError(() => store.submitWorkResult(resultInput(claimed!)), "worker_lease_missing");
    } finally {
      store.close();
    }
  });

  it("rejects result submission when lease expiry is malformed", () => {
    const dir = mkdtempSync(join(tmpdir(), "acs-result-lease-expiry-"));
    const dbPath = join(dir, "control.db");
    const store = new SqliteWorkItemStore(dbPath);

    try {
      const workItem = store.create({
        title: "Malformed lease expiry result",
        requester: "agent",
        intent: "verify malformed lease expiry gate",
        requestedActions: [{ kind: "manual", description: "result" }],
        risk: "low"
      });
      store.approveWorkItem(workItem.id, domainTransition);
      const claimed = store.claimNextApprovedWorkItem("worker-a", { allowLegacyClaimForTests: true });
      updateLeaseColumn(dbPath, claimed!.leaseId, "expires_at", "not-an-iso-date");

      expectControlError(() => store.submitWorkResult(resultInput(claimed!)), "lease_state_inconsistent");
    } finally {
      store.close();
    }
  });

  it("rejects result submission for missing work items", () => {
    const dir = mkdtempSync(join(tmpdir(), "acs-result-missing-"));
    const store = new SqliteWorkItemStore(join(dir, "control.db"));

    try {
      expectControlError(
        () =>
          store.submitWorkResult({
            workItemId: "wrk_missing",
            leaseId: "lease_missing",
            workerId: "worker-a",
            actionHash: "0".repeat(64),
            idempotencyKey: "result-missing",
            outcome: "succeeded",
            startedAt: "2026-07-20T00:00:00.000Z",
            finishedAt: "2026-07-20T00:00:01.000Z",
            summary: "missing",
            simulationMetadata: { executionMode: "dry_run", simulated: true }
          }),
        "work_item_not_found"
      );
    } finally {
      store.close();
    }
  });

  it("rejects expired lease result submission", async () => {
    const dir = mkdtempSync(join(tmpdir(), "acs-result-expired-"));
    const store = new SqliteWorkItemStore(join(dir, "control.db"));

    try {
      const workItem = store.create({
        title: "Expired result",
        requester: "agent",
        intent: "verify expired result gate",
        requestedActions: [{ kind: "manual", description: "result" }],
        risk: "low"
      });
      store.approveWorkItem(workItem.id, domainTransition);
      const claimed = store.claimNextApprovedWorkItem("worker-a", {
        leaseMs: 1,
        allowLegacyClaimForTests: true
      });
      await new Promise((resolve) => setTimeout(resolve, 10));

      expectControlError(() => store.submitWorkResult(resultInput(claimed!)), "worker_lease_expired");
    } finally {
      store.close();
    }
  });

  it("rejects result submission before running", () => {
    const dir = mkdtempSync(join(tmpdir(), "acs-result-"));
    const store = new SqliteWorkItemStore(join(dir, "control.db"));

    try {
      const workItem = store.create({
        title: "Premature result",
        requester: "agent",
        intent: "verify result gate",
        requestedActions: [{ kind: "manual", description: "result" }],
        risk: "low"
      });

      expectControlError(
        () =>
          store.submitWorkResult({
            workItemId: workItem.id,
            leaseId: "lease-not-running",
            workerId: "worker-a",
            actionHash: "0".repeat(64),
            idempotencyKey: "result-not-running",
            outcome: "succeeded",
            startedAt: "2026-07-20T00:00:00.000Z",
            finishedAt: "2026-07-20T00:00:01.000Z",
            summary: "premature",
            simulationMetadata: { executionMode: "dry_run", simulated: true }
          }),
        "work_item_not_running"
      );
    } finally {
      store.close();
    }
  });

  it("stores approvals by work item and action hash", () => {
    const dir = mkdtempSync(join(tmpdir(), "acs-approval-"));
    const store = new SqliteWorkItemStore(join(dir, "control.db"));

    try {
      const workItem = store.create({
        title: "Approval item",
        requester: "user",
        intent: "verify approval records",
        requestedActions: [{ kind: "edit", description: "write", params: { write: true } }],
        risk: "low"
      });

      const grant = store.recordApproval({
        workItemId: workItem.id,
        actionHash: "hash_test",
        approvedBy: "user",
        reason: "exact action"
      });

      expect(grant).not.toHaveProperty("approvalToken");
      expect(grant.requestHash).toEqual(expect.any(String));
      expect(store.hasApproval(workItem.id, "hash_test")).toBe(true);
      expect(store.hasApproval(workItem.id, "other_hash")).toBe(false);
      expect(store.readEvents().at(-1)?.name).toBe("approval.granted");
      expect(store.readEvents().at(-1)?.body).not.toHaveProperty("approvalToken");
      expect(() => store.consumeApproval(workItem.id, "hash_test", { requestHash: "wrong" })).toThrow(
        ControlStackError
      );
      store.consumeApproval(workItem.id, "hash_test", {
        requestHash: grant.requestHash
      });
      expect(store.hasApproval(workItem.id, "hash_test")).toBe(false);
      expect(() => store.consumeApproval(workItem.id, "hash_test")).toThrow(ControlStackError);
    } finally {
      store.close();
    }
  });

  it("refuses to silently regrant a consumed approval", () => {
    const dir = mkdtempSync(join(tmpdir(), "acs-approval-replay-"));
    const store = new SqliteWorkItemStore(join(dir, "control.db"));

    try {
      const workItem = store.create({
        title: "Replay item",
        requester: "user",
        intent: "verify consumed approvals stay consumed",
        requestedActions: [{ kind: "edit", description: "write", params: { write: true } }],
        risk: "low"
      });

      const grant = store.recordApproval({
        workItemId: workItem.id,
        actionHash: "hash_replay",
        approvedBy: "user",
        reason: "first grant"
      });
      store.consumeApproval(workItem.id, "hash_replay", {
        requestHash: grant.requestHash
      });

      expect(() =>
        store.recordApproval({
          workItemId: workItem.id,
          actionHash: "hash_replay",
          approvedBy: "user",
          reason: "replay attempt"
        })
      ).toThrow(ControlStackError);
      expect(store.hasApproval(workItem.id, "hash_replay")).toBe(false);
      expect(store.readEvents().filter((event) => event.name === "approval.granted")).toHaveLength(1);
    } finally {
      store.close();
    }
  });

  it("rolls back nested writes inside a failed transaction", () => {
    const dir = mkdtempSync(join(tmpdir(), "acs-approval-atomic-"));
    const store = new SqliteWorkItemStore(join(dir, "control.db"));

    try {
      const workItem = store.create({
        title: "Atomic item",
        requester: "user",
        intent: "verify transactional gates",
        requestedActions: [{ kind: "edit", description: "write", params: { write: true } }],
        risk: "low"
      });
      const eventCount = store.readEvents().length;

      expect(() =>
        store.withTransaction(() => {
          store.recordApproval({
            workItemId: workItem.id,
            actionHash: "hash_atomic",
            approvedBy: "user",
            reason: "must roll back"
          });
          throw new Error("boom");
        })
      ).toThrow("boom");

      expect(store.hasApproval(workItem.id, "hash_atomic")).toBe(false);
      expect(store.readEvents()).toHaveLength(eventCount);
    } finally {
      store.close();
    }
  });

  it("rejects expired approval records", () => {
    const dir = mkdtempSync(join(tmpdir(), "acs-approval-expired-"));
    const store = new SqliteWorkItemStore(join(dir, "control.db"));

    try {
      const workItem = store.create({
        title: "Expired approval item",
        requester: "user",
        intent: "verify approval expiry",
        requestedActions: [{ kind: "edit", description: "write", params: { write: true } }],
        risk: "low"
      });

      store.recordApproval({
        workItemId: workItem.id,
        actionHash: "hash_test",
        approvedBy: "user",
        reason: "expired",
        createdAt: "2026-07-05T00:00:00.000Z",
        expiresAt: "2026-07-05T00:00:01.000Z"
      });

      expect(store.hasApproval(workItem.id, "hash_test")).toBe(false);
      expect(() => store.consumeApproval(workItem.id, "hash_test", new Date("2026-07-05T00:00:02.000Z"))).toThrow(
        ControlStackError
      );
    } finally {
      store.close();
    }
  });

  it("bootstraps the registry schema and canonical roster through migrations", () => {
    const dir = mkdtempSync(join(tmpdir(), "acs-agent-registry-"));
    const dbPath = join(dir, "control.db");
    const store = new SqliteWorkItemStore(dbPath);

    try {
      const canonical = [
        ["codex-cli", "Codex CLI", "IMPLEMENTATION_AGENT"],
        ["claude-code", "Claude Code / Claude adapter", "REVIEW_PLANNING_AGENT"],
        ["gemini-cli", "Gemini CLI", "RESEARCH_BROAD_SCAN_AGENT"],
        ["opencode-local", "OpenCode", "LOCAL_CODING_AGENT"],
        ["hermes-local", "Hermes Agent", "ORCHESTRATION_LAYER"],
        ["openclaw-bridge", "OpenClaw", "DESKTOP_LOCAL_AGENT_BRIDGE"]
      ] as const;

      expect(tableNames(dbPath)).toEqual(expect.arrayContaining(["actors", "agents", "capabilities", "heartbeats"]));
      expect(migrationRows(dbPath)).toEqual([
        { version: 1, name: "audit_log", filename: "001_audit_log.sql" },
        { version: 2, name: "agent_registry", filename: "002_agent_registry.sql" },
        { version: 3, name: "event_indexes", filename: "003_event_indexes.sql" },
        { version: 4, name: "state_constraints", filename: "004_state_constraints.sql" },
        { version: 5, name: "execution_results_and_lineage", filename: "005_execution_results_and_lineage.sql" },
        { version: 6, name: "execution_plans_and_attempts", filename: "006_execution_plans_and_attempts.sql" },
        { version: 7, name: "workspace_allocations", filename: "007_workspace_allocations.sql" },
        { version: 8, name: "scheduler_firings", filename: "008_scheduler_firings.sql" },
        { version: 9, name: "attempt_workspace_ownership", filename: "009_attempt_workspace_ownership.sql" }
      ]);
      expect(store.listActors()).toEqual(
        expect.arrayContaining([expect.objectContaining({ id: "actor_system_bootstrap", actorType: "SYSTEM" })])
      );
      expect(store.listRegistryAgents()).toEqual(
        expect.arrayContaining(
          canonical.map(([id, name, acpRole]) => expect.objectContaining({ id, name, acpRole, status: "UNKNOWN" }))
        )
      );
      expect(
        store.listRegistryAgents().every((agent) => agent.capabilities.length === 0 && !agent.latestHeartbeat)
      ).toBe(true);
    } finally {
      store.close();
    }
  });

  it("applies runtime-required columns from migrations before store construction", () => {
    const dir = mkdtempSync(join(tmpdir(), "acs-migration-columns-"));
    const dbPath = join(dir, "control.db");
    const db = new DatabaseSync(dbPath);

    try {
      applyControlPlaneMigrations(db);
    } finally {
      db.close();
    }

    expect(tableColumns(dbPath, "work_items")).toEqual(
      expect.arrayContaining([
        "requester_subject",
        "worker_id",
        "started_at",
        "lease_expires_at",
        "lease_token_hash",
        "source_work_item_id",
        "lineage_type",
        "retry_reason",
        "retry_sequence",
        "root_work_item_id"
      ])
    );
    expect(tableColumns(dbPath, "audit_events")).toEqual(expect.arrayContaining(["previous_hash", "event_hash"]));
    expect(tableColumns(dbPath, "approval_records")).toEqual(
      expect.arrayContaining(["request_hash", "approval_token_hash", "status", "expires_at", "consumed_at"])
    );
  });

  it("records migration checksums and refuses drifted migration history", () => {
    const dir = mkdtempSync(join(tmpdir(), "acs-migration-checksum-"));
    const dbPath = join(dir, "control.db");
    const store = new SqliteWorkItemStore(dbPath);
    store.close();
    const db = new DatabaseSync(dbPath);
    try {
      const rows = db.prepare(`SELECT checksum FROM schema_migrations ORDER BY version`).all() as Array<{
        checksum: string;
      }>;
      expect(rows).toHaveLength(controlPlaneMigrations().length);
      expect(rows.every((row) => /^[a-f0-9]{64}$/.test(row.checksum))).toBe(true);
      db.prepare(`UPDATE schema_migrations SET checksum = ? WHERE version = 1`).run("0".repeat(64));
    } finally {
      db.close();
    }

    expect(() => new SqliteWorkItemStore(dbPath)).toThrow("migration checksum mismatch for version 1");
  });

  it("enforces persisted state and JSON constraints without rewriting existing rows", () => {
    const dir = mkdtempSync(join(tmpdir(), "acs-state-constraints-"));
    const dbPath = join(dir, "control.db");
    const store = new SqliteWorkItemStore(dbPath);
    const workItem = store.create({
      title: "Constraint fixture",
      requester: "user",
      intent: "verify state constraints",
      requestedActions: [{ kind: "manual", description: "constraint" }],
      risk: "low"
    });
    store.close();
    const db = new DatabaseSync(dbPath);

    try {
      expect(() => db.prepare(`UPDATE work_items SET risk = 'invalid' WHERE id = ?`).run(workItem.id)).toThrow(
        "work_items: invalid risk"
      );
      expect(() => db.prepare(`UPDATE work_items SET target_json = 'not-json' WHERE id = ?`).run(workItem.id)).toThrow(
        "work_items: target_json must be valid JSON"
      );
      expect(db.prepare(`SELECT version FROM schema_migrations ORDER BY version`).all()).toEqual([
        { version: 1 },
        { version: 2 },
        { version: 3 },
        { version: 4 },
        { version: 5 },
        { version: 6 },
        { version: 7 },
        { version: 8 }
      ]);
    } finally {
      db.close();
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("rejects invalid existing state before applying the constraints migration", () => {
    const dir = mkdtempSync(join(tmpdir(), "acs-state-constraints-invalid-"));
    const dbPath = join(dir, "control.db");
    const db = new DatabaseSync(dbPath);

    try {
      for (const migration of controlPlaneMigrations().slice(0, 3)) {
        db.exec(migration.sql);
      }
      db.prepare(
        `INSERT INTO work_items
         (id, title, requester, status, intent, target_json, requested_actions_json, risk, result_json, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, NULL, ?, ?)`
      ).run(
        "bad-work-item",
        "Invalid persisted state",
        "user",
        "not-a-work-item-status",
        "migration preflight",
        "{}",
        "[]",
        "low",
        "2026-07-20T00:00:00.000Z",
        "2026-07-20T00:00:00.000Z"
      );
    } finally {
      db.close();
    }

    expect(() => new SqliteWorkItemStore(dbPath)).toThrow(/bad-work-item/);
    const unchanged = new DatabaseSync(dbPath);
    try {
      expect(unchanged.prepare(`SELECT status FROM work_items WHERE id = 'bad-work-item'`).get()).toEqual({
        status: "not-a-work-item-status"
      });
      expect(unchanged.prepare(`SELECT MAX(version) AS version FROM schema_migrations`).get()).toEqual({ version: 3 });
    } finally {
      unchanged.close();
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("rejects NULL persisted state values before applying the constraints migration", () => {
    const dir = mkdtempSync(join(tmpdir(), "acs-state-constraints-null-"));
    const dbPath = join(dir, "control.db");
    const db = new DatabaseSync(dbPath);

    try {
      db.exec(`
        CREATE TABLE schema_migrations (
          version INTEGER PRIMARY KEY,
          name TEXT NOT NULL,
          filename TEXT NOT NULL,
          checksum TEXT NOT NULL,
          applied_at TEXT NOT NULL
        );
        CREATE TABLE work_items (id TEXT, status TEXT, risk TEXT, target_json TEXT, requested_actions_json TEXT, result_json TEXT);
        CREATE TABLE approval_records (work_item_id TEXT, action_hash TEXT, status TEXT);
        CREATE TABLE connector_records (id TEXT, status TEXT, allowed_scopes_json TEXT);
        CREATE TABLE tunnel_sessions (session_id TEXT, status TEXT);
        CREATE TABLE actors (id TEXT, actor_type TEXT);
        CREATE TABLE agents (id TEXT, status TEXT);
        CREATE TABLE heartbeats (id INTEGER, status TEXT);
        CREATE TABLE capabilities (id TEXT, input_schema TEXT);
        CREATE TABLE audit_events (id TEXT, attributes TEXT, body TEXT);
      `);
      for (const migration of controlPlaneMigrations().slice(0, 3)) {
        db.prepare(
          `INSERT INTO schema_migrations (version, name, filename, checksum, applied_at)
             VALUES (?, ?, ?, ?, ?)`
        ).run(migration.version, migration.name, migration.filename, migration.checksum, "2026-07-20T00:00:00.000Z");
      }
      db.prepare(
        `INSERT INTO work_items (id, status, risk, target_json, requested_actions_json, result_json)
         VALUES (?, NULL, ?, ?, ?, NULL)`
      ).run("null-work-item", "low", "{}", "[]");

      expect(() => applyControlPlaneMigrations(db)).toThrow(/null-work-item/);
      expect(db.prepare(`SELECT MAX(version) AS version FROM schema_migrations`).get()).toEqual({ version: 3 });
      expect(
        db
          .prepare(`SELECT name FROM sqlite_master WHERE type = 'trigger' AND name = 'work_items_state_guard_insert'`)
          .get()
      ).toBeUndefined();
    } finally {
      db.close();
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("migrates a copied version-three database without mutating the source", () => {
    const dir = mkdtempSync(join(tmpdir(), "acs-migration-copy-"));
    const sourcePath = join(dir, "source.db");
    const copiedPath = join(dir, "copied.db");
    createVersionThreeDatabase(sourcePath);
    const sourceBefore = readFileSync(sourcePath);
    copyFileSync(sourcePath, copiedPath);

    const store = new SqliteWorkItemStore(copiedPath);
    try {
      expect(migrationRows(copiedPath).map((row) => row.version)).toEqual([1, 2, 3, 4, 5, 6, 7, 8]);
      expect(store.verifyAuditChain()).toMatchObject({ ok: true });
    } finally {
      store.close();
    }

    expect(readFileSync(sourcePath)).toEqual(sourceBefore);
    expect(migrationRows(sourcePath).map((row) => row.version)).toEqual([1, 2, 3]);
    rmSync(dir, { recursive: true, force: true });
  });

  it("refuses Wave 2 migration when a legacy active lease needs explicit reconciliation", () => {
    const dir = mkdtempSync(join(tmpdir(), "acs-migration-active-lease-"));
    const dbPath = join(dir, "active.db");
    createVersionThreeDatabase(dbPath);
    const db = new DatabaseSync(dbPath);
    try {
      db.prepare(
        `INSERT INTO work_items
         (id, title, requester, requester_subject, status, intent, target_json, requested_actions_json, risk,
          result_json, worker_id, lease_token_hash, started_at, lease_expires_at, created_at, updated_at)
         VALUES (?, ?, ?, ?, 'running', ?, ?, ?, 'low', NULL, ?, ?, ?, ?, ?, ?)`
      ).run(
        "legacy-running",
        "Legacy running item",
        "agent",
        null,
        "migration safety",
        "{}",
        "[]",
        "legacy-worker",
        "legacy-hash",
        "2026-07-20T00:00:00.000Z",
        "2026-07-20T00:05:00.000Z",
        "2026-07-20T00:00:00.000Z",
        "2026-07-20T00:00:00.000Z"
      );
    } finally {
      db.close();
    }

    expect(() => new SqliteWorkItemStore(dbPath)).toThrow(/legacy active lease state/);
    const unchanged = new DatabaseSync(dbPath);
    try {
      expect(unchanged.prepare(`SELECT MAX(version) AS version FROM schema_migrations`).get()).toEqual({ version: 4 });
      expect(
        unchanged.prepare(`SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'leases'`).get()
      ).toBeUndefined();
      expect(
        unchanged.prepare(`SELECT status, lease_token_hash FROM work_items WHERE id = 'legacy-running'`).get()
      ).toEqual({
        status: "running",
        lease_token_hash: "legacy-hash"
      });
    } finally {
      unchanged.close();
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("migrates a previous control-plane schema without reloading SQL blindly", () => {
    const dir = mkdtempSync(join(tmpdir(), "acs-migration-previous-"));
    const dbPath = join(dir, "control.db");
    const db = new DatabaseSync(dbPath);
    try {
      db.exec(controlPlaneMigrations()[0].sql);
    } finally {
      db.close();
    }

    const store = new SqliteWorkItemStore(dbPath);
    try {
      expect(tableNames(dbPath)).toEqual(expect.arrayContaining(["schema_migrations", "actors", "agents"]));
      expect(migrationRows(dbPath).map((row) => row.version)).toEqual([1, 2, 3, 4, 5, 6, 7, 8]);
      expect(store.listRegistryAgents()).toEqual(
        expect.arrayContaining([expect.objectContaining({ id: "codex-cli", acpRole: "IMPLEMENTATION_AGENT" })])
      );
    } finally {
      store.close();
    }
  });

  it("records agent create and update actor attribution", () => {
    const dir = mkdtempSync(join(tmpdir(), "acs-agent-attribution-"));
    const store = new SqliteWorkItemStore(join(dir, "control.db"));

    try {
      store.registerActor({ id: "user", actorType: "HUMAN", displayName: "Jace" });
      store.registerActor({ id: "service", actorType: "SERVICE", displayName: "Registry Service" });
      const agent = store.createRegistryAgent({
        id: "test-agent",
        name: "Test Agent",
        kind: "service",
        acpRole: "ORCHESTRATION_LAYER",
        status: "OFFLINE",
        actorId: "service"
      });
      const updated = store.updateRegistryAgent("test-agent", {
        status: "AVAILABLE",
        actorId: "user"
      });

      expect(agent).toMatchObject({ createdByActorId: "service", updatedByActorId: "service" });
      expect(updated).toMatchObject({ status: "AVAILABLE", updatedByActorId: "user" });
      expectControlError(
        () =>
          store.createRegistryAgent({
            id: "missing-actor-agent",
            name: "Missing Actor Agent",
            kind: "cli",
            acpRole: "IMPLEMENTATION_AGENT",
            actorId: "missing"
          }),
        "actor_not_found"
      );
      expectControlError(
        () =>
          store.createRegistryAgent({
            id: "bad-status-agent",
            name: "Bad Status Agent",
            kind: "cli",
            acpRole: "IMPLEMENTATION_AGENT",
            status: "GREAT",
            actorId: "user"
          } as never),
        "invalid_agent_registration"
      );
      expectControlError(
        () => store.updateRegistryAgent("test-agent", { status: "GREAT", actorId: "user" } as never),
        "invalid_agent_registration"
      );
      expectControlError(() => store.updateRegistryAgent("missing-agent", { actorId: "user" }), "agent_not_found");
    } finally {
      store.close();
    }
  });

  it("requires explicit actors for connector and tunnel session registry mutations", () => {
    const dir = mkdtempSync(join(tmpdir(), "acs-connector-attribution-"));
    const store = new SqliteWorkItemStore(join(dir, "control.db"));

    try {
      store.registerActor({ id: "user", actorType: "HUMAN", displayName: "Jace" });
      expectControlError(
        () =>
          store.registerConnector({
            id: "chatgpt-prod",
            publicKeyPem: "public-key",
            allowedScopes: ["acs:work:create"]
          } as never),
        "actor_required"
      );

      store.registerConnector({
        id: "chatgpt-prod",
        publicKeyPem: "public-key",
        allowedScopes: ["acs:work:create"],
        actorId: "user"
      });
      expectControlError(
        () =>
          store.registerTunnelSession({
            connectorId: "chatgpt-prod",
            tunnelId: "tunnel_1",
            sessionId: "session_1",
            expiresAt: new Date(Date.now() + 60_000).toISOString()
          } as never),
        "actor_required"
      );

      store.registerTunnelSession({
        connectorId: "chatgpt-prod",
        tunnelId: "tunnel_1",
        sessionId: "session_1",
        expiresAt: new Date(Date.now() + 60_000).toISOString(),
        actorId: "user"
      });
      expectControlError(
        () =>
          store.revokeTunnelSession({
            connectorId: "chatgpt-prod",
            tunnelId: "tunnel_1",
            sessionId: "session_1"
          } as never),
        "actor_required"
      );
      store.revokeTunnelSession({
        connectorId: "chatgpt-prod",
        tunnelId: "tunnel_1",
        sessionId: "session_1",
        actorId: "user"
      });

      expect(store.readEvents()).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            name: "connector.registered",
            attributes: expect.objectContaining({ "actor.id": "user" })
          }),
          expect.objectContaining({
            name: "tunnel_session.registered",
            attributes: expect.objectContaining({ "actor.id": "user" })
          }),
          expect.objectContaining({
            name: "tunnel_session.revoked",
            attributes: expect.objectContaining({ "actor.id": "user" })
          })
        ])
      );
    } finally {
      store.close();
    }
  });

  it("replaces capabilities atomically with actor attribution", () => {
    const dir = mkdtempSync(join(tmpdir(), "acs-agent-capabilities-"));
    const store = new SqliteWorkItemStore(join(dir, "control.db"));

    try {
      store.registerActor({ id: "user", actorType: "HUMAN", displayName: "Jace" });
      store.createRegistryAgent({
        id: "test-agent",
        name: "Test Agent",
        kind: "cli",
        acpRole: "IMPLEMENTATION_AGENT",
        actorId: "user"
      });

      const capabilities = store.replaceAgentCapabilities(
        "test-agent",
        [{ name: "repo:inspect", description: "Inspect repository", inputSchema: { type: "object" } }],
        "user"
      );

      expect(capabilities).toEqual([
        expect.objectContaining({ name: "repo:inspect", createdByActorId: "user", updatedByActorId: "user" })
      ]);
      expectControlError(
        () => store.replaceAgentCapabilities("test-agent", [{ name: "bad", inputSchema: [] as never }], "user"),
        "invalid_agent_registration"
      );
      expect(store.listAgentCapabilities("test-agent")).toEqual([expect.objectContaining({ name: "repo:inspect" })]);
      expectControlError(
        () => store.replaceAgentCapabilities("test-agent", [{ name: "repo:write" }], "missing"),
        "actor_not_found"
      );
      expectControlError(
        () => store.replaceAgentCapabilities("missing-agent", [{ name: "repo:write" }], "user"),
        "agent_not_found"
      );
    } finally {
      store.close();
    }
  });

  it("appends heartbeats and updates latest registry state", () => {
    const dir = mkdtempSync(join(tmpdir(), "acs-agent-heartbeat-"));
    const dbPath = join(dir, "control.db");
    const store = new SqliteWorkItemStore(dbPath);

    try {
      store.registerActor({ id: "user", actorType: "HUMAN", displayName: "Jace" });
      store.createRegistryAgent({
        id: "test-agent",
        name: "Test Agent",
        kind: "cli",
        acpRole: "IMPLEMENTATION_AGENT",
        actorId: "user"
      });

      store.recordAgentHeartbeat("test-agent", {
        actorId: "user",
        status: "DEGRADED",
        lastError: "warming"
      });
      const heartbeat = store.recordAgentHeartbeat("test-agent", {
        actorId: "user",
        status: "AVAILABLE",
        currentTask: "idle"
      });

      expect(countRows(dbPath, "heartbeats")).toBe(2);
      expect(heartbeat.agent).toMatchObject({
        id: "test-agent",
        status: "AVAILABLE",
        lastError: "warming",
        updatedByActorId: "user",
        latestHeartbeat: { actorId: "user", status: "AVAILABLE", currentTask: "idle" }
      });
      expectControlError(
        () =>
          store.recordAgentHeartbeat("test-agent", {
            actorId: "missing",
            status: "AVAILABLE"
          }),
        "actor_not_found"
      );
      expectControlError(
        () =>
          store.recordAgentHeartbeat("test-agent", {
            actorId: "user",
            status: "GREAT"
          } as never),
        "invalid_agent_registration"
      );
      expectControlError(
        () =>
          store.recordAgentHeartbeat("missing-agent", {
            actorId: "user",
            status: "AVAILABLE"
          }),
        "agent_not_found"
      );
      expect(store.readEvents().map((event) => event.name)).toEqual(
        expect.arrayContaining(["actor.registered", "agent.created", "agent.heartbeat"])
      );
      expect(store.verifyAuditChain()).toMatchObject({ ok: true });
    } finally {
      store.close();
    }
  });

  it("reconciles stale tunnel sessions transactionally and prevents heartbeat resurrection", async () => {
    const dir = mkdtempSync(join(tmpdir(), "acs-tunnel-liveness-"));
    const dbPath = join(dir, "control.db");
    const base = new Date("2026-07-20T00:00:00.000Z");
    const store = new SqliteWorkItemStore(dbPath, { heartbeatTtlMs: 1_000 });
    const concurrentStore = new SqliteWorkItemStore(dbPath, { heartbeatTtlMs: 1_000 });

    try {
      store.registerActor({ id: "user", actorType: "HUMAN", displayName: "Jace" });
      store.registerConnector({
        id: "connector",
        publicKeyPem: "public-key",
        allowedScopes: ["acs:work:read"],
        actorId: "user",
        now: base
      });
      store.registerTunnelSession({
        connectorId: "connector",
        tunnelId: "tunnel",
        sessionId: "session",
        expiresAt: new Date(base.getTime() + 60_000).toISOString(),
        actorId: "user",
        now: base
      });

      expect(store.reconcileStaleTunnelSessions({ now: new Date(base.getTime() + 1_000) })).toEqual([]);
      store.heartbeatTunnelSession({
        connectorId: "connector",
        tunnelId: "tunnel",
        sessionId: "session",
        actorId: "user",
        now: new Date(base.getTime() + 500)
      });

      const [first, second] = await Promise.all([
        Promise.resolve(store.reconcileStaleTunnelSessions({ now: new Date(base.getTime() + 1_501) })),
        Promise.resolve(concurrentStore.reconcileStaleTunnelSessions({ now: new Date(base.getTime() + 1_501) }))
      ]);
      expect([first, second].flat()).toHaveLength(1);
      expect(
        store.getTunnelSession({ connectorId: "connector", tunnelId: "tunnel", sessionId: "session" })
      ).toMatchObject({
        status: "revoked"
      });
      expect(store.readEvents().filter((event) => event.name === "tunnel_session.reconciled")).toHaveLength(1);
      expect(store.readEvents().at(-1)).toMatchObject({
        name: "tunnel_session.reconciled",
        attributes: expect.objectContaining({
          "tunnel.session_status": "revoked",
          "actor.id": "actor_system_bootstrap"
        }),
        body: expect.objectContaining({ reason: "heartbeat_expired" })
      });
      expect(store.reconcileStaleTunnelSessions({ now: new Date(base.getTime() + 2_000) })).toEqual([]);
      expectControlError(
        () =>
          store.heartbeatTunnelSession({
            connectorId: "connector",
            tunnelId: "tunnel",
            sessionId: "session",
            actorId: "user",
            now: new Date(base.getTime() + 2_000)
          }),
        "tunnel_session_not_active"
      );
    } finally {
      store.close();
      concurrentStore.close();
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("reconciles stale agents only on an actual transition and permits recovery", async () => {
    const dir = mkdtempSync(join(tmpdir(), "acs-agent-liveness-"));
    const dbPath = join(dir, "control.db");
    const base = new Date("2026-07-20T00:00:00.000Z");
    const store = new SqliteWorkItemStore(dbPath, { heartbeatTtlMs: 1_000 });
    const concurrentStore = new SqliteWorkItemStore(dbPath, { heartbeatTtlMs: 1_000 });

    try {
      store.registerActor({ id: "user", actorType: "HUMAN", displayName: "Jace" });
      store.createRegistryAgent({
        id: "agent",
        name: "Agent",
        kind: "service",
        acpRole: "ORCHESTRATION_LAYER",
        actorId: "user"
      });
      store.recordAgentHeartbeat("agent", { status: "AVAILABLE", actorId: "user", now: base });

      expect(store.reconcileStaleAgents({ now: new Date(base.getTime() + 1_000) })).toEqual([]);
      const [first, second] = await Promise.all([
        Promise.resolve(store.reconcileStaleAgents({ now: new Date(base.getTime() + 1_001) })),
        Promise.resolve(concurrentStore.reconcileStaleAgents({ now: new Date(base.getTime() + 1_001) }))
      ]);
      expect([first, second].flat()).toHaveLength(1);
      expect(store.getRegistryAgent("agent")).toMatchObject({ status: "OFFLINE", lastError: "heartbeat expired" });
      expect(store.readEvents().filter((event) => event.name === "agent.reconciled")).toHaveLength(1);
      expect(store.readEvents().at(-1)).toMatchObject({
        name: "agent.reconciled",
        attributes: expect.objectContaining({ "agent.status": "OFFLINE", "actor.id": "actor_system_bootstrap" }),
        body: expect.objectContaining({ previousStatus: "AVAILABLE", status: "OFFLINE", reason: "heartbeat_expired" })
      });
      expect(store.reconcileStaleAgents({ now: new Date(base.getTime() + 2_000) })).toEqual([]);

      const recovered = store.recordAgentHeartbeat("agent", {
        status: "AVAILABLE",
        actorId: "user",
        now: new Date(base.getTime() + 2_001)
      });
      expect(recovered.agent.status).toBe("AVAILABLE");
      expect(store.reconcileStaleAgents({ now: new Date(base.getTime() + 2_500) })).toEqual([]);
    } finally {
      store.close();
      concurrentStore.close();
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("redacts secrets from heartbeat and agent lastError before storage", () => {
    const dir = mkdtempSync(join(tmpdir(), "acs-heartbeat-redact-"));
    const store = new SqliteWorkItemStore(join(dir, "control.db"));
    const secretError = "Error calling API with Bearer sk-proj-abc123token";

    try {
      const { agent, heartbeat } = store.recordAgentHeartbeat("codex-cli", {
        status: "ERROR",
        lastError: secretError,
        actorId: "actor_system_bootstrap"
      });

      expect(heartbeat.lastError).not.toContain("sk-proj");
      expect(agent.lastError).not.toContain("sk-proj");

      const updated = store.updateRegistryAgent("codex-cli", {
        lastError: secretError,
        actorId: "actor_system_bootstrap"
      });
      expect(updated.lastError).not.toContain("sk-proj");

      expect(JSON.stringify(store.readEvents())).not.toContain("sk-proj");
      expect(JSON.stringify(store.getRegistryAgent("codex-cli"))).not.toContain("sk-proj");
    } finally {
      store.close();
    }
  });

  it("detects audit event tampering", () => {
    const dir = mkdtempSync(join(tmpdir(), "acs-audit-chain-"));
    const dbPath = join(dir, "control.db");
    const store = new SqliteWorkItemStore(dbPath);

    try {
      store.create({
        title: "Audited item",
        requester: "agent",
        intent: "verify tamper evidence",
        requestedActions: [{ kind: "manual", description: "audit" }],
        risk: "low"
      });
      expect(store.verifyAuditChain()).toMatchObject({ ok: true, eventCount: 1 });
      store.close();

      const db = new DatabaseSync(dbPath);
      try {
        db.prepare(`UPDATE audit_events SET body = ? WHERE sequence = 1`).run(JSON.stringify({ tampered: true }));
      } finally {
        db.close();
      }

      const reopened = new SqliteWorkItemStore(dbPath);
      try {
        expect(reopened.verifyAuditChain()).toMatchObject({
          ok: false,
          failure: { sequence: 1, reason: "event_hash_mismatch" }
        });
      } finally {
        reopened.close();
      }
    } finally {
      try {
        store.close();
      } catch {
        // already closed in the tamper path
      }
    }
  });

  it("keeps the work item store as the only active audit chain implementation", () => {
    const repoRoot = process.cwd();
    const duplicateAuditPackageName = "@agent-control-stack/" + "audit-log";
    const staleReferenceFiles = [
      "package-lock.json",
      "tsconfig.json",
      "apps/gateway/package.json",
      "apps/gateway/tsconfig.json",
      "apps/worker/package.json",
      "apps/worker/tsconfig.json",
      "packages/eval-harness/package.json",
      "packages/eval-harness/tsconfig.json"
    ];
    const dir = mkdtempSync(join(tmpdir(), "acs-work-items-audit-only-"));
    const store = new SqliteWorkItemStore(join(dir, "control.db"));

    try {
      const workItem = store.create({
        title: "Audit owner",
        requester: "user",
        intent: "prove audit events append through the real store",
        requestedActions: [{ kind: "fs.read", description: "read repo", params: { paths: ["src/index.ts"] } }],
        risk: "low"
      });

      expect(existsSync(join(repoRoot, "packages/audit-log"))).toBe(false);
      for (const file of staleReferenceFiles) {
        expect(readFileSync(join(repoRoot, file), "utf8")).not.toContain(duplicateAuditPackageName);
      }
      expect(store.readEvents()).toEqual([expect.objectContaining({ name: WorkItemEvent.Created })]);
      expect(store.verifyAuditChain()).toMatchObject({ ok: true, eventCount: 1 });
      expect(store.get(workItem.id)?.id).toBe(workItem.id);
    } finally {
      store.close();
    }
  });
});

function expectControlError(run: () => unknown, code: string): void {
  try {
    run();
  } catch (error) {
    expect(error).toBeInstanceOf(ControlStackError);
    expect((error as ControlStackError).code).toBe(code);
    return;
  }
  throw new Error(`expected ControlStackError: ${code}`);
}

function tableNames(dbPath: string): string[] {
  const db = new DatabaseSync(dbPath);
  try {
    return (db.prepare(`SELECT name FROM sqlite_master WHERE type = 'table'`).all() as Array<{ name: string }>).map(
      (row) => row.name
    );
  } finally {
    db.close();
  }
}

function tableColumns(dbPath: string, table: string): string[] {
  const db = new DatabaseSync(dbPath);
  try {
    return (db.prepare(`PRAGMA table_info(${table})`).all() as Array<{ name: string }>).map((row) => row.name);
  } finally {
    db.close();
  }
}

function migrationRows(dbPath: string): Array<{ version: number; name: string; filename: string }> {
  const db = new DatabaseSync(dbPath);
  try {
    return db.prepare(`SELECT version, name, filename FROM schema_migrations ORDER BY version ASC`).all() as Array<{
      version: number;
      name: string;
      filename: string;
    }>;
  } finally {
    db.close();
  }
}

function createVersionThreeDatabase(dbPath: string): void {
  const db = new DatabaseSync(dbPath);
  try {
    db.exec(`
      CREATE TABLE schema_migrations (
        version INTEGER PRIMARY KEY,
        name TEXT NOT NULL,
        filename TEXT NOT NULL,
        checksum TEXT NOT NULL,
        applied_at TEXT NOT NULL
      );
    `);
    for (const migration of controlPlaneMigrations().slice(0, 3)) {
      db.exec(migration.sql);
      db.prepare(
        `INSERT INTO schema_migrations (version, name, filename, checksum, applied_at)
           VALUES (?, ?, ?, ?, ?)`
      ).run(migration.version, migration.name, migration.filename, migration.checksum, "2026-07-20T00:00:00.000Z");
    }
  } finally {
    db.close();
  }
}

function countRows(dbPath: string, table: "heartbeats"): number {
  const db = new DatabaseSync(dbPath);
  try {
    return (db.prepare(`SELECT COUNT(*) AS count FROM ${table}`).get() as { count: number }).count;
  } finally {
    db.close();
  }
}

function readLeaseRow(
  dbPath: string,
  workItemId: string
): { worker_id: string | null; lease_token_hash: string | null; lease_expires_at: string | null } {
  const db = new DatabaseSync(dbPath);
  try {
    return db
      .prepare(`SELECT worker_id, lease_token_hash, lease_expires_at FROM work_items WHERE id = ?`)
      .get(workItemId) as {
      worker_id: string | null;
      lease_token_hash: string | null;
      lease_expires_at: string | null;
    };
  } finally {
    db.close();
  }
}

function updateWorkItemColumn(
  dbPath: string,
  workItemId: string,
  column: "lease_expires_at" | "lease_token_hash",
  value: string | null
): void {
  const db = new DatabaseSync(dbPath);
  try {
    db.prepare(`UPDATE work_items SET ${column} = ? WHERE id = ?`).run(value, workItemId);
  } finally {
    db.close();
  }
}

function updateLeaseColumn(
  dbPath: string,
  leaseId: string,
  column: "expires_at" | "token_hash",
  value: string | null
): void {
  const db = new DatabaseSync(dbPath);
  try {
    db.exec(`DROP TRIGGER IF EXISTS leases_immutable_fields_guard`);
    db.prepare(`UPDATE leases SET ${column} = ? WHERE lease_id = ?`).run(value, leaseId);
  } finally {
    db.close();
  }
}
