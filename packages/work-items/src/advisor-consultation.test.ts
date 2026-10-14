import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import type { AdvisorCheckpoint } from "@agent-control-stack/advisory";
import { ControlStackError, stableHash } from "@agent-control-stack/shared";
import { describe, expect, it } from "vitest";
import { ADVISOR_COMPLETION_DISPOSITION_SQL, copyAdvisorBinding } from "./advisor-consultation.js";
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
  disposition: "reviewed" | "declined" | "unavailable"
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
      fence: {
        kind: "work_item",
        workItemId: claimed.id,
        leaseId: claimed.leaseId,
        workerId: claimed.workerId,
        fencingEpoch: 0
      }
    },
    transition
  );
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
  it("stores each checkpoint and lets a reviewed or declined consultation satisfy completion", () => {
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
