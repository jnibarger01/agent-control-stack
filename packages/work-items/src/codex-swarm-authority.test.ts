import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { controlPlaneMigrations } from "@agent-control-stack/shared";
import { describe, expect, it } from "vitest";
import { defaultExecutionPlanForWorkItem } from "./execution-plan.js";
import { SqliteWorkItemStore } from "./store.js";

const hash = (value: string) => value.repeat(64).slice(0, 64);

describe("Codex Swarm durable authority migration", () => {
  it("registers and applies migration 023 through the canonical store", () => {
    const directory = mkdtempSync(join(tmpdir(), "acs-codex-swarm-authority-"));
    try {
      expect(controlPlaneMigrations()).toContainEqual(
        expect.objectContaining({ version: 23, name: "codex_swarm_authoritative_store", filename: "023_codex_swarm_authoritative_store.sql" })
      );
      const store = new SqliteWorkItemStore(join(directory, "control.db"));
      expect(store.health().checks.migrations).toEqual({ ok: true });
    } finally {
      rmSync(directory, { force: true, recursive: true });
    }
  });

  it("atomically reserves a current tuple and replays only the identical dispatch", () => {
    const directory = mkdtempSync(join(tmpdir(), "acs-codex-swarm-authority-"));
    try {
      const store = new SqliteWorkItemStore(join(directory, "control.db"));
      const workItem = store.create({ title: "durable authority", requester: "user", requesterSubject: "actor-user", intent: "test", target: { cwd: "/repo", files: ["src/index.ts"] }, requestedActions: [{ kind: "fs.read", description: "inspect", params: { paths: ["src/index.ts"], write: false } }], risk: "low" });
      const plan = store.createExecutionPlan({ workItemId: workItem.id, definition: defaultExecutionPlanForWorkItem(workItem), createdByActorId: "actor-user" });
      const admission = store.admitExecutionPlan({ workItemId: workItem.id, planHash: plan.planHash, policyVersion: "acs.policy.v1", policyDecisionHash: hash("a"), requiresApproval: false, admittedByActorId: "policy-gate" }, { via: "policy_gate" });
      const attempt = store.createAttempt({ workItemId: workItem.id, planHash: plan.planHash, inputHash: hash("b") }, { via: "domain_service" });
      const lease = store.leaseAttempt({ attemptId: attempt.attemptId, workItemId: workItem.id, admissionId: admission.admissionId, workerId: "worker-1", leaseToken: "x".repeat(32), policyVersion: "acs.policy.v1", policyDecisionHash: hash("a"), ttlMs: 60_000 }, { via: "domain_service" });
      store.recordWorkspaceAllocation({ allocationId: "workspace-1", workItemId: workItem.id, attemptId: attempt.attemptId, leaseId: lease.leaseId, workerId: lease.workerId, fencingEpoch: lease.fencingEpoch, hostPath: "/isolated/workspace-1", branch: "acs/test", baseRef: "HEAD" }, { via: "domain_service" });
      const authority = store as unknown as { reserveCodexSwarmDispatch(input: { workItemId: string; attemptId: string; leaseId: string; fencingEpoch: number; envelopeHash: string; idempotencyKey: string }): { kind: string } };
      const input = { workItemId: workItem.id, attemptId: attempt.attemptId, leaseId: lease.leaseId, fencingEpoch: lease.fencingEpoch, envelopeHash: hash("c"), idempotencyKey: "dispatch-1" };
      expect(authority.reserveCodexSwarmDispatch(input)).toEqual({ kind: "reserved" });
      expect(authority.reserveCodexSwarmDispatch(input)).toEqual({ kind: "replay" });
      expect(authority.reserveCodexSwarmDispatch({ ...input, envelopeHash: hash("d") })).toEqual({ kind: "conflict" });
    } finally {
      rmSync(directory, { force: true, recursive: true });
    }
  });

  it("fails closed without a current provider binding", () => {
    const directory = mkdtempSync(join(tmpdir(), "acs-codex-swarm-authority-"));
    try {
      const store = new SqliteWorkItemStore(join(directory, "control.db"));
      store.registerActor({ id: "actor-canceller", actorType: "HUMAN", displayName: "canceller" });
      expect(
        store.cancelCodexSwarmAttempt({
          requestId: "cancel-1",
          workItemId: "work-1",
          attemptId: "attempt-1",
          leaseId: "lease-1",
          fencingEpoch: 1,
          authenticatedPrincipalId: "actor-canceller",
          canonicalIntentHash: hash("a"),
          providerBinding: { contextHash: hash("b"), proofBindingHash: hash("c"), providerGeneration: 1, sessionEpochBindingHash: hash("d") }
        })
      ).toEqual({ kind: "denied", reason: "codex_swarm_cancel_provider_revoked" });
    } finally {
      rmSync(directory, { force: true, recursive: true });
    }
  });
});
