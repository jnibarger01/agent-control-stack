import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import type { AdvisorCheckpoint } from "@agent-control-stack/advisory";
import { ControlStackError, stableHash } from "@agent-control-stack/shared";
import { describe, expect, it } from "vitest";
import {
  ADVISOR_COMPLETION_DISPOSITION_SQL,
  advisorCompletionBlockReason,
  copyAdvisorBinding,
  insertAdvisorConsultation
} from "./advisor-consultation.js";
import { SqliteWorkItemStore } from "./store.js";

const transition = { via: "domain_service" as const };
const HASH = "a".repeat(64);

function openStore() {
  const directory = mkdtempSync(join(tmpdir(), "acs-advisor-"));
  const path = join(directory, "control.db");
  const store = new SqliteWorkItemStore(path);
  return { directory, path, store };
}

function claim(store: SqliteWorkItemStore) {
  const workItem = store.create({
    title: "Advisor result",
    requester: "agent",
    intent: "consult then finish",
    target: { cwd: "/repo" },
    requestedActions: [{ kind: "manual", description: "simulate" }],
    risk: "low"
  });
  store.approveWorkItem(workItem.id, transition);
  const claimed = store.claimNextApprovedWorkItem("worker-a", { allowLegacyClaimForTests: true });
  if (!claimed) throw new Error("expected a claim");
  return { workItem, claimed };
}

function resultInput(claimed: ReturnType<typeof claim>["claimed"]) {
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
    summary: "simulated result accepted",
    stdout: "",
    stderr: "",
    structuredOutput: { simulated: true },
    artifacts: [],
    simulationMetadata: { executionMode: "dry_run" as const, simulated: true }
  };
}

function enable(
  store: SqliteWorkItemStore,
  workItemId: string,
  options: {
    requireBeforeCompletion?: boolean;
    executorModelId?: string;
    advisorModelId?: string;
    allowedAdvisorModels?: string[];
  } = {}
) {
  return store.enableAdvisorBinding(
    {
      subjectId: workItemId,
      missionId: workItemId,
      subjectKind: "work_item",
      executorModelId: options.executorModelId ?? "claude-sonnet-5",
      advisorModelId: options.advisorModelId ?? "claude-opus-5-5",
      requireBeforeCompletion: options.requireBeforeCompletion ?? false,
      ...(options.allowedAdvisorModels ? { allowedAdvisorModels: options.allowedAdvisorModels } : {})
    },
    transition
  );
}

function record(
  store: SqliteWorkItemStore,
  claimed: ReturnType<typeof claim>["claimed"],
  checkpoint: AdvisorCheckpoint,
  disposition: "reviewed" | "declined" | "unavailable",
  extra: { leaseToken?: string; createdAt?: string } = {}
) {
  return store.recordAdvisorConsultation(
    {
      subjectId: claimed.id,
      missionId: claimed.id,
      subjectKind: "work_item",
      checkpoint,
      disposition,
      inputSha256: HASH,
      guidanceText: disposition === "reviewed" ? "GUIDANCE-keep-the-diff-small" : null,
      declineReason: disposition === "declined" ? "DECLINE-need-a-smaller-diff" : null,
      errorCode: disposition === "unavailable" ? "advisor_unavailable" : null,
      executorModelId: "claude-sonnet-5",
      advisorModelId: "claude-opus-5-5",
      inputTokens: 2,
      outputTokens: 3,
      ...(extra.createdAt ? { createdAt: extra.createdAt } : {}),
      fence: {
        kind: "work_item",
        workItemId: claimed.id,
        leaseId: claimed.leaseId,
        ...(extra.leaseToken ? { leaseToken: extra.leaseToken } : {}),
        workerId: claimed.workerId,
        fencingEpoch: 0
      }
    },
    transition
  );
}

function rawDb(store: SqliteWorkItemStore): DatabaseSync {
  return (store as unknown as { db: DatabaseSync }).db;
}

function count(path: string, sql: string): number {
  const db = new DatabaseSync(path);
  try {
    return Number((db.prepare(sql).get() as { n: number }).n);
  } finally {
    db.close();
  }
}

describe("advisor consultation persistence", () => {
  it("stores each checkpoint and lets only a reviewed before_completion consultation satisfy completion", () => {
    const { directory, store } = openStore();
    try {
      const { claimed } = claim(store);
      enable(store, claimed.id, { requireBeforeCompletion: true });
      expect(() => store.submitWorkResult(resultInput(claimed))).toThrowError(
        expect.objectContaining<Partial<ControlStackError>>({ code: "advisor_consultation_required" })
      );
      record(store, claimed, "before_approach", "reviewed");
      record(store, claimed, "recurring_failure", "declined");
      record(store, claimed, "before_completion", "unavailable");
      expect(() => store.submitWorkResult(resultInput(claimed))).toThrowError(
        expect.objectContaining<Partial<ControlStackError>>({ code: "advisor_consultation_required" })
      );
      record(store, claimed, "before_completion", "declined");
      expect(() => store.submitWorkResult(resultInput(claimed))).toThrowError(
        expect.objectContaining<Partial<ControlStackError>>({ code: "advisor_consultation_required" })
      );
      record(store, claimed, "before_completion", "reviewed");
      expect(store.submitWorkResult(resultInput(claimed)).status).toBe("succeeded");
    } finally {
      store.close();
      rmSync(directory, { recursive: true, force: true });
    }
  });

  it("leaves completion unchanged when the binding does not require a consultation", () => {
    const { directory, store } = openStore();
    try {
      const { claimed } = claim(store);
      enable(store, claimed.id, { requireBeforeCompletion: false });
      expect(store.submitWorkResult(resultInput(claimed)).status).toBe("succeeded");
    } finally {
      store.close();
      rmSync(directory, { recursive: true, force: true });
    }
  });

  it("does not require a consultation after the binding is disabled", () => {
    const { directory, store } = openStore();
    try {
      const { claimed } = claim(store);
      enable(store, claimed.id, { requireBeforeCompletion: true });
      store.disableAdvisorBinding(claimed.id, claimed.id, transition);
      expect(store.submitWorkResult(resultInput(claimed)).status).toBe("succeeded");
    } finally {
      store.close();
      rmSync(directory, { recursive: true, force: true });
    }
  });

  it("rejects a stale lease and writes no consultation row", () => {
    const { directory, path, store } = openStore();
    try {
      const { claimed } = claim(store);
      enable(store, claimed.id);
      expect(() =>
        store.recordAdvisorConsultation(
          {
            subjectId: claimed.id,
            missionId: claimed.id,
            subjectKind: "work_item",
            checkpoint: "before_approach",
            disposition: "reviewed",
            inputSha256: HASH,
            guidanceText: "GUIDANCE-keep-the-diff-small",
            declineReason: null,
            errorCode: null,
            executorModelId: "claude-sonnet-5",
            advisorModelId: "claude-opus-5-5",
            inputTokens: null,
            outputTokens: null,
            fence: {
              kind: "work_item",
              workItemId: claimed.id,
              leaseId: claimed.leaseId,
              workerId: "worker-b",
              fencingEpoch: 0
            }
          },
          transition
        )
      ).toThrowError(expect.objectContaining<Partial<ControlStackError>>({ code: "advisor_lease_stale" }));
      expect(() =>
        store.recordAdvisorConsultation(
          {
            subjectId: claimed.id,
            missionId: claimed.id,
            subjectKind: "work_item",
            checkpoint: "before_approach",
            disposition: "reviewed",
            inputSha256: HASH,
            guidanceText: "GUIDANCE-keep-the-diff-small",
            declineReason: null,
            errorCode: null,
            executorModelId: "claude-sonnet-5",
            advisorModelId: "claude-opus-5-5",
            inputTokens: null,
            outputTokens: null,
            fence: {
              kind: "work_item",
              workItemId: claimed.id,
              leaseId: claimed.leaseId,
              workerId: claimed.workerId,
              fencingEpoch: 4
            }
          },
          transition
        )
      ).toThrowError(expect.objectContaining<Partial<ControlStackError>>({ code: "advisor_lease_stale" }));
      expect(count(path, "SELECT COUNT(*) AS n FROM advisor_consultations")).toBe(0);
      expect(store.get(claimed.id)?.status).toBe("running");
    } finally {
      store.close();
      rmSync(directory, { recursive: true, force: true });
    }
  });

  it("keeps guidance out of the audit body and out of the completion query", () => {
    const { directory, store } = openStore();
    try {
      const { claimed } = claim(store);
      enable(store, claimed.id);
      record(store, claimed, "before_approach", "reviewed");
      const audit = JSON.stringify(store.readEvents().filter((event) => event.name.startsWith("advisory.advisor_")));
      expect(audit).not.toContain("GUIDANCE-keep-the-diff-small");
      expect(audit).toContain("before_approach");
      expect(ADVISOR_COMPLETION_DISPOSITION_SQL).not.toContain("guidance_text");
      expect(ADVISOR_COMPLETION_DISPOSITION_SQL).not.toContain("decline_reason");
    } finally {
      store.close();
      rmSync(directory, { recursive: true, force: true });
    }
  });

  it("does not change policy, approval, or routing rows when a consultation is recorded", () => {
    const { directory, path, store } = openStore();
    try {
      const { claimed } = claim(store);
      enable(store, claimed.id);
      const before = {
        policy: store.readEvents().filter((event) => event.name === "policy.decision").length,
        approvals: count(path, "SELECT COUNT(*) AS n FROM approval_records"),
        routes: count(path, "SELECT COUNT(*) AS n FROM actor_routing_decisions"),
        status: store.get(claimed.id)?.status
      };
      record(store, claimed, "before_completion", "reviewed");
      expect({
        policy: store.readEvents().filter((event) => event.name === "policy.decision").length,
        approvals: count(path, "SELECT COUNT(*) AS n FROM approval_records"),
        routes: count(path, "SELECT COUNT(*) AS n FROM actor_routing_decisions"),
        status: store.get(claimed.id)?.status
      }).toEqual(before);
    } finally {
      store.close();
      rmSync(directory, { recursive: true, force: true });
    }
  });

  it("refuses a weaker, unknown, or excluded advisor and writes nothing", () => {
    const { directory, path, store } = openStore();
    try {
      const { claimed } = claim(store);
      expect(() => enable(store, claimed.id, { advisorModelId: "claude-haiku-4-5" })).toThrowError(
        expect.objectContaining<Partial<ControlStackError>>({ code: "advisor_pairing_rejected" })
      );
      expect(() => enable(store, claimed.id, { advisorModelId: "mystery-model" })).toThrowError(
        expect.objectContaining<Partial<ControlStackError>>({ code: "advisor_model_unrecognized" })
      );
      expect(() =>
        enable(store, claimed.id, {
          advisorModelId: "claude-fable-5-1",
          allowedAdvisorModels: ["claude-opus-5"]
        })
      ).toThrowError(expect.objectContaining<Partial<ControlStackError>>({ code: "advisor_model_excluded" }));
      expect(count(path, "SELECT COUNT(*) AS n FROM advisor_bindings")).toBe(0);
    } finally {
      store.close();
      rmSync(directory, { recursive: true, force: true });
    }
  });

  it("refuses to update or delete a consultation row", () => {
    const { directory, path, store } = openStore();
    try {
      const { claimed } = claim(store);
      enable(store, claimed.id);
      record(store, claimed, "before_approach", "reviewed");
      const db = new DatabaseSync(path);
      expect(() => db.exec("UPDATE advisor_consultations SET disposition = 'declined'")).toThrow(/append-only/);
      expect(() => db.exec("DELETE FROM advisor_consultations")).toThrow(/append-only/);
      db.close();
    } finally {
      store.close();
      rmSync(directory, { recursive: true, force: true });
    }
  });

  it("does not attach a copied binding when the child executor cannot pair", () => {
    const { directory, path, store } = openStore();
    try {
      const { claimed } = claim(store);
      enable(store, claimed.id, { executorModelId: "claude-opus-4-6", advisorModelId: "claude-sonnet-5" });
      const copied = copyAdvisorBinding((store as unknown as { db: DatabaseSync }).db, {
        parentMissionId: claimed.id,
        parentSubjectId: claimed.id,
        childMissionId: "child-mission",
        childSubjectId: "child-subject",
        childExecutorModelId: "claude-opus-5",
        now: new Date().toISOString()
      });
      expect(copied.status).toBe("not_attached");
      expect(count(path, "SELECT COUNT(*) AS n FROM advisor_bindings WHERE subject_id = 'child-subject'")).toBe(0);
    } finally {
      store.close();
      rmSync(directory, { recursive: true, force: true });
    }
  });
});

describe("advisor consultation follow-up hardening (PR #367 review)", () => {
  it("enforces the gate on transition(id, 'succeeded'), not only on result submission", () => {
    const { directory, store } = openStore();
    try {
      const { claimed } = claim(store);
      enable(store, claimed.id, { requireBeforeCompletion: true });
      expect(() =>
        store.transition(claimed.id, "succeeded", { ...transition, actorId: claimed.workerId })
      ).toThrowError(expect.objectContaining<Partial<ControlStackError>>({ code: "advisor_consultation_required" }));
      expect(store.get(claimed.id)?.status).toBe("running");
    } finally {
      store.close();
      rmSync(directory, { recursive: true, force: true });
    }
  });

  it("does not let a consultation from an earlier lease satisfy the current lease", () => {
    const { directory, store } = openStore();
    try {
      const { claimed } = claim(store);
      enable(store, claimed.id, { requireBeforeCompletion: true });
      record(store, claimed, "before_completion", "reviewed");
      // Simulate a re-lease: the original lease is closed and a new one is active for the same item.
      const db = rawDb(store);
      const lease = db.prepare("SELECT * FROM leases WHERE lease_id = ?").get(claimed.leaseId) as Record<
        string,
        unknown
      >;
      db.prepare("UPDATE leases SET status = 'expired', closed_at = ? WHERE lease_id = ?").run(
        new Date().toISOString(),
        claimed.leaseId
      );
      db.prepare(
        `INSERT INTO leases (lease_id, work_item_id, worker_id, token_hash, action_hash, issued_at, expires_at, status, closed_at)
         VALUES ('lease_second', ?, ?, ?, ?, ?, ?, 'active', NULL)`
      ).run(
        claimed.id,
        claimed.workerId,
        lease.token_hash as string,
        lease.action_hash as string,
        lease.issued_at as string,
        lease.expires_at as string
      );
      expect(advisorCompletionBlockReason(db, claimed.id, claimed.id)).toBe("advisor_consultation_required");
    } finally {
      store.close();
      rmSync(directory, { recursive: true, force: true });
    }
  });

  it("fails closed when a binding is edited to require_before_completion = 0", () => {
    const { directory, path, store } = openStore();
    try {
      const { claimed } = claim(store);
      enable(store, claimed.id, { requireBeforeCompletion: true });
      const db = new DatabaseSync(path);
      db.exec("UPDATE advisor_bindings SET require_before_completion = 0");
      db.close();
      expect(() => store.submitWorkResult(resultInput(claimed))).toThrowError(
        expect.objectContaining<Partial<ControlStackError>>({ code: "advisor_binding_integrity_mismatch" })
      );
    } finally {
      store.close();
      rmSync(directory, { recursive: true, force: true });
    }
  });

  it("fails closed when a consultation row is tampered after it is written", () => {
    const { directory, path, store } = openStore();
    try {
      const { claimed } = claim(store);
      enable(store, claimed.id, { requireBeforeCompletion: true });
      record(store, claimed, "before_completion", "declined");
      const db = new DatabaseSync(path);
      db.exec("DROP TRIGGER advisor_consultations_no_update");
      db.exec(
        "UPDATE advisor_consultations SET disposition = 'reviewed', guidance_text = 'forged', decline_reason = NULL"
      );
      db.close();
      expect(() => store.submitWorkResult(resultInput(claimed))).toThrowError(
        expect.objectContaining<Partial<ControlStackError>>({ code: "advisor_consultation_integrity_mismatch" })
      );
    } finally {
      store.close();
      rmSync(directory, { recursive: true, force: true });
    }
  });

  it("rejects a wrong lease token and accepts the right one", () => {
    const { directory, path, store } = openStore();
    try {
      const { claimed } = claim(store);
      enable(store, claimed.id);
      expect(() => record(store, claimed, "before_approach", "reviewed", { leaseToken: "x".repeat(32) })).toThrowError(
        expect.objectContaining<Partial<ControlStackError>>({ code: "advisor_lease_stale" })
      );
      expect(count(path, "SELECT COUNT(*) AS n FROM advisor_consultations")).toBe(0);
      expect(record(store, claimed, "before_approach", "reviewed", { leaseToken: claimed.leaseToken }).leaseId).toBe(
        claimed.leaseId
      );
    } finally {
      store.close();
      rmSync(directory, { recursive: true, force: true });
    }
  });

  it("treats an unparseable lease expiry as expired", () => {
    const { directory, path, store } = openStore();
    try {
      const { claimed } = claim(store);
      enable(store, claimed.id);
      const db = rawDb(store);
      db.exec("DROP TRIGGER IF EXISTS leases_immutable_identity");
      const triggers = db
        .prepare("SELECT name FROM sqlite_master WHERE type = 'trigger' AND tbl_name = 'leases'")
        .all() as Array<{ name: string }>;
      for (const trigger of triggers) db.exec(`DROP TRIGGER "${trigger.name}"`);
      db.prepare("UPDATE leases SET expires_at = 'not-a-date' WHERE lease_id = ?").run(claimed.leaseId);
      expect(() => record(store, claimed, "before_approach", "reviewed")).toThrowError(
        expect.objectContaining<Partial<ControlStackError>>({ code: "advisor_lease_stale" })
      );
      expect(count(path, "SELECT COUNT(*) AS n FROM advisor_consultations")).toBe(0);
    } finally {
      store.close();
      rmSync(directory, { recursive: true, force: true });
    }
  });

  it("refuses a work-item binding that names another mission", () => {
    const { directory, path, store } = openStore();
    try {
      const { claimed } = claim(store);
      const other = store.create({
        title: "Other mission",
        requester: "agent",
        intent: "unrelated",
        target: { cwd: "/repo" },
        requestedActions: [{ kind: "manual", description: "simulate" }],
        risk: "low"
      });
      expect(() =>
        store.enableAdvisorBinding(
          {
            subjectId: claimed.id,
            missionId: other.id,
            subjectKind: "work_item",
            executorModelId: "claude-sonnet-5",
            advisorModelId: "claude-opus-5-5",
            requireBeforeCompletion: false
          },
          transition
        )
      ).toThrowError(expect.objectContaining<Partial<ControlStackError>>({ code: "advisor_binding_mission_mismatch" }));
      expect(count(path, "SELECT COUNT(*) AS n FROM advisor_bindings")).toBe(0);
    } finally {
      store.close();
      rmSync(directory, { recursive: true, force: true });
    }
  });

  it("audits a binding copied onto a retried work item with actor provenance", () => {
    const { directory, store } = openStore();
    try {
      const { claimed } = claim(store);
      enable(store, claimed.id, { requireBeforeCompletion: false });
      store.transition(claimed.id, "failed", { ...transition, actorId: claimed.workerId });
      const retried = store.retryWorkItem(claimed.id, { actor: "operator-1", reason: "try again" });
      const copied = store.readEvents().filter((event) => event.name === "advisory.advisor_binding_copied");
      expect(copied).toHaveLength(1);
      expect(copied[0]!.body).toMatchObject({
        parentSubjectId: claimed.id,
        childSubjectId: retried.id,
        actorId: "operator-1",
        leaseProvenance: { kind: "retry", sourceWorkItemId: claimed.id }
      });
    } finally {
      store.close();
      rmSync(directory, { recursive: true, force: true });
    }
  });

  it("records fence provenance on the consultation audit event and enable/disable actor", () => {
    const { directory, store } = openStore();
    try {
      const { claimed } = claim(store);
      store.enableAdvisorBinding(
        {
          subjectId: claimed.id,
          missionId: claimed.id,
          subjectKind: "work_item",
          executorModelId: "claude-sonnet-5",
          advisorModelId: "claude-opus-5-5",
          requireBeforeCompletion: false
        },
        { ...transition, actorId: "operator-2" }
      );
      record(store, claimed, "before_approach", "reviewed");
      const enabled = store.readEvents().find((event) => event.name === "advisory.advisor_binding_enabled");
      expect(enabled?.body).toMatchObject({ actorId: "operator-2" });
      const recorded = store.readEvents().find((event) => event.name === "advisory.advisor_consultation_recorded");
      expect(recorded?.body).toMatchObject({ leaseId: claimed.leaseId, workerId: claimed.workerId });
    } finally {
      store.close();
      rmSync(directory, { recursive: true, force: true });
    }
  });

  it("keeps insertAdvisorConsultation callable without a lease token (stable contract for local advisors)", () => {
    const { directory, store } = openStore();
    try {
      const { claimed } = claim(store);
      enable(store, claimed.id);
      const value = insertAdvisorConsultation(rawDb(store), {
        subjectId: claimed.id,
        missionId: claimed.id,
        subjectKind: "work_item",
        checkpoint: "before_approach",
        disposition: "reviewed",
        inputSha256: HASH,
        guidanceText: "GUIDANCE",
        declineReason: null,
        errorCode: null,
        executorModelId: "claude-sonnet-5",
        advisorModelId: "claude-opus-5-5",
        inputTokens: null,
        outputTokens: null,
        fence: {
          kind: "work_item",
          workItemId: claimed.id,
          leaseId: claimed.leaseId,
          workerId: claimed.workerId,
          fencingEpoch: 0
        }
      });
      expect(value.consultationHash).toMatch(/^[a-f0-9]{64}$/);
    } finally {
      store.close();
      rmSync(directory, { recursive: true, force: true });
    }
  });
});
