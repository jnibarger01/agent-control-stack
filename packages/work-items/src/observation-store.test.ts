import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { describe, expect, it } from "vitest";
import { stableHash } from "@agent-control-stack/shared";
import { SqliteWorkItemStore } from "./store.js";

const transition = { via: "domain_service" as const };

function fixture(options: { enabled?: boolean; maxQueued?: number; maxAttempts?: number } = {}) {
  const directory = mkdtempSync(join(tmpdir(), "acs-jev4-store-"));
  const dbPath = join(directory, "control.db");
  const store = new SqliteWorkItemStore(dbPath, {
    observationEnabled: options.enabled ?? true,
    observationMaxQueued: options.maxQueued,
    observationMaxAttempts: options.maxAttempts
  });
  const workItem = store.create({
    title: "JEV-4 observation",
    requester: "agent",
    intent: "record an authoritative simulated result",
    target: { cwd: "/repo" },
    requestedActions: [{ kind: "manual", description: "simulate" }],
    risk: "low"
  });
  store.approveWorkItem(workItem.id, transition);
  const claimed = store.claimNextApprovedWorkItem("worker-jev4", { allowLegacyClaimForTests: true });
  if (!claimed) throw new Error("expected claimed work item");
  return { directory, dbPath, store, workItem, claimed };
}

function existingTraceMission(dbPath: string, workItemId: string): string {
  const db = new DatabaseSync(dbPath, { readOnly: true });
  try {
    const row = db.prepare("SELECT trace_id FROM trace_missions WHERE work_item_id = ?").get(workItemId) as
      { trace_id: string } | undefined;
    if (!row) throw new Error("expected lifecycle trace mission");
    return row.trace_id;
  } finally {
    db.close();
  }
}

function input(claimed: ReturnType<typeof fixture>["claimed"]) {
  return {
    workItemId: claimed.id,
    leaseId: claimed.leaseId,
    workerId: claimed.workerId,
    actionHash: claimed.actionHash,
    idempotencyKey: stableHash({ domain: "jev4-test", workItemId: claimed.id, leaseId: claimed.leaseId }),
    outcome: "succeeded" as const,
    startedAt: claimed.startedAt,
    finishedAt: new Date(Date.parse(claimed.startedAt) + 10).toISOString(),
    exitCode: 0,
    summary: "authoritative result",
    stdout: "",
    stderr: "",
    structuredOutput: { simulated: true },
    artifacts: [],
    simulationMetadata: { executionMode: "dry_run" as const, simulated: true }
  };
}

function rowCount(dbPath: string): number {
  const db = new DatabaseSync(dbPath);
  try {
    return Number((db.prepare("SELECT count(*) AS n FROM jev_observation_outbox").get() as { n: number }).n);
  } finally {
    db.close();
  }
}

describe("JEV-4 store-backed observation outbox", () => {
  it("migration 033 creates the bounded outbox", () => {
    const f = fixture();
    try {
      const db = new DatabaseSync(f.dbPath);
      try {
        const table = db
          .prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'jev_observation_outbox'")
          .get() as { name: string } | undefined;
        expect(table?.name).toBe("jev_observation_outbox");
      } finally {
        db.close();
      }
    } finally {
      f.store.close();
      rmSync(f.directory, { recursive: true, force: true });
    }
  });

  it("queues one observation only after authoritative result acceptance", () => {
    const f = fixture();
    try {
      const traceId = existingTraceMission(f.dbPath, f.workItem.id);
      expect(rowCount(f.dbPath)).toBe(0);
      const accepted = f.store.submitWorkResult(input(f.claimed));
      expect(accepted.status).toBe("succeeded");
      expect(rowCount(f.dbPath)).toBe(1);
      const job = f.store.claimNextObservation();
      expect(job).toMatchObject({
        workItemId: f.workItem.id,
        traceId,
        questionSetVersion: "jev-trace@2",
        classifierVersion: "jev-advisory-v2",
        status: "running",
        attempts: 1,
        maxAttempts: 3
      });
    } finally {
      f.store.close();
      rmSync(f.directory, { recursive: true, force: true });
    }
  });

  it("exact result replay cannot duplicate observation scheduling", () => {
    const f = fixture();
    try {
      existingTraceMission(f.dbPath, f.workItem.id);
      const result = input(f.claimed);
      f.store.submitWorkResult(result);
      f.store.submitWorkResult(result);
      expect(rowCount(f.dbPath)).toBe(1);
    } finally {
      f.store.close();
      rmSync(f.directory, { recursive: true, force: true });
    }
  });

  it("remains inert when observation is disabled", () => {
    const f = fixture({ enabled: false });
    try {
      existingTraceMission(f.dbPath, f.workItem.id);
      expect(f.store.submitWorkResult(input(f.claimed)).status).toBe("succeeded");
      expect(rowCount(f.dbPath)).toBe(0);
    } finally {
      f.store.close();
      rmSync(f.directory, { recursive: true, force: true });
    }
  });

  it("reuses the lifecycle trace identity instead of inventing a Jev-only trace", () => {
    const f = fixture();
    try {
      const traceId = existingTraceMission(f.dbPath, f.workItem.id);
      expect(traceId).toMatch(/^[a-f0-9]{32}$/);
      expect(f.store.submitWorkResult(input(f.claimed)).status).toBe("succeeded");
      expect(rowCount(f.dbPath)).toBe(1);
      expect(f.store.claimNextObservation()?.traceId).toBe(traceId);
    } finally {
      f.store.close();
      rmSync(f.directory, { recursive: true, force: true });
    }
  });

  it("queue saturation cannot block authoritative completion", () => {
    const f = fixture({ maxQueued: 1 });
    try {
      const traceId = existingTraceMission(f.dbPath, f.workItem.id);
      const db = new DatabaseSync(f.dbPath);
      try {
        const now = new Date().toISOString();
        db.prepare(
          "INSERT INTO jev_observation_outbox " +
            "(observation_id, work_item_id, trace_id, question_set_version, classifier_version, status, attempts, max_attempts, created_at, available_at) " +
            "VALUES (?, ?, ?, ?, ?, 'pending', 0, 3, ?, ?)"
        ).run("obs_" + "f".repeat(24), f.workItem.id, traceId, "other@1", "other@1", now, now);
      } finally {
        db.close();
      }
      const accepted = f.store.submitWorkResult(input(f.claimed));
      expect(accepted.status).toBe("succeeded");
      expect(rowCount(f.dbPath)).toBe(1);
    } finally {
      f.store.close();
      rmSync(f.directory, { recursive: true, force: true });
    }
  });

  it("outbox insertion failure cannot roll back authoritative completion", () => {
    const f = fixture();
    try {
      existingTraceMission(f.dbPath, f.workItem.id);
      const db = new DatabaseSync(f.dbPath);
      try {
        db.exec(
          "CREATE TRIGGER jev_observation_boom BEFORE INSERT ON jev_observation_outbox " +
            "BEGIN SELECT RAISE(FAIL, 'observer unavailable'); END"
        );
      } finally {
        db.close();
      }
      const accepted = f.store.submitWorkResult(input(f.claimed));
      expect(accepted.status).toBe("succeeded");
      expect(rowCount(f.dbPath)).toBe(0);
      expect(f.store.get(f.workItem.id)?.status).toBe("succeeded");
    } finally {
      f.store.close();
      rmSync(f.directory, { recursive: true, force: true });
    }
  });

  it("claim is single-owner and increments attempts exactly once", () => {
    const f = fixture();
    try {
      existingTraceMission(f.dbPath, f.workItem.id);
      f.store.submitWorkResult(input(f.claimed));
      const first = f.store.claimNextObservation();
      const second = f.store.claimNextObservation();
      expect(first?.attempts).toBe(1);
      expect(first?.status).toBe("running");
      expect(second).toBeUndefined();
    } finally {
      f.store.close();
      rmSync(f.directory, { recursive: true, force: true });
    }
  });

  it("retries are bounded by persisted max_attempts", () => {
    const f = fixture({ maxAttempts: 2 });
    try {
      existingTraceMission(f.dbPath, f.workItem.id);
      f.store.submitWorkResult(input(f.claimed));
      const first = f.store.claimNextObservation();
      if (!first) throw new Error("missing first claim");
      expect(f.store.retryObservation(first.observationId, "offline")).toBe("pending");
      const second = f.store.claimNextObservation();
      if (!second) throw new Error("missing second claim");
      expect(second.attempts).toBe(2);
      expect(f.store.retryObservation(second.observationId, "offline")).toBe("failed");
      expect(f.store.claimNextObservation()).toBeUndefined();
    } finally {
      f.store.close();
      rmSync(f.directory, { recursive: true, force: true });
    }
  });

  it("persists terminal observer result without touching work-item state", () => {
    const f = fixture();
    try {
      existingTraceMission(f.dbPath, f.workItem.id);
      f.store.submitWorkResult(input(f.claimed));
      const claimedObservation = f.store.claimNextObservation();
      if (!claimedObservation) throw new Error("missing observation");
      f.store.completeObservation(claimedObservation.observationId, {
        status: "degraded",
        classifierOutcome: "INCOMPATIBLE_MODEL",
        telemetryCorrelationId: null,
        error: "INCOMPATIBLE_MODEL"
      });
      expect(f.store.get(f.workItem.id)?.status).toBe("succeeded");
      const db = new DatabaseSync(f.dbPath);
      try {
        const row = db
          .prepare("SELECT status, classifier_outcome, error FROM jev_observation_outbox WHERE observation_id = ?")
          .get(claimedObservation.observationId) as { status: string; classifier_outcome: string; error: string };
        expect(row).toEqual({
          status: "degraded",
          classifier_outcome: "INCOMPATIBLE_MODEL",
          error: "INCOMPATIBLE_MODEL"
        });
      } finally {
        db.close();
      }
    } finally {
      f.store.close();
      rmSync(f.directory, { recursive: true, force: true });
    }
  });

  it("loads only canonical rows matching the observation trace", () => {
    const f = fixture();
    try {
      const traceId = existingTraceMission(f.dbPath, f.workItem.id);
      const db = new DatabaseSync(f.dbPath);
      try {
        const now = new Date().toISOString();
        const maxSeq = Number(
          (db.prepare("SELECT coalesce(max(seq), 0) AS seq FROM trace_outbox").get() as { seq: number }).seq
        );
        const matchingSeq = maxSeq + 1;
        const otherSeq = maxSeq + 2;
        const base = {
          schema_version: "trace-event/1",
          event_id: "evt_test_match",
          trace_id: traceId,
          span_id: "1".repeat(16),
          source: { system: "acs", component: "test", instance: "acs-test", release_sha: "unreleased" },
          class: "telemetry",
          kind: "run.completed",
          actor: { id: "system", type: "system" },
          subject: { work_item_id: f.workItem.id },
          seq: matchingSeq,
          prev_hash: "0".repeat(64),
          ts: now,
          payload: {},
          payload_hash: "0".repeat(64)
        };
        db.prepare(
          "INSERT INTO trace_outbox (event_id, work_item_id, seq, canonical_json, created_at) VALUES (?, ?, ?, ?, ?)"
        ).run("evt_test_match", f.workItem.id, matchingSeq, JSON.stringify(base), now);
        db.prepare(
          "INSERT INTO trace_outbox (event_id, work_item_id, seq, canonical_json, created_at) VALUES (?, ?, ?, ?, ?)"
        ).run(
          "evt_test_other",
          f.workItem.id,
          otherSeq,
          JSON.stringify({ ...base, event_id: "evt_test_other", trace_id: "cd".repeat(16), seq: otherSeq }),
          now
        );
      } finally {
        db.close();
      }
      const trace = f.store.loadCanonicalTrace(f.workItem.id, traceId);
      expect(trace).toHaveLength(2);
      expect(trace.map((event) => event.kind)).toEqual(["run.received", "run.completed"]);
      expect(trace.every((event) => event.trace_id === traceId)).toBe(true);
    } finally {
      f.store.close();
      rmSync(f.directory, { recursive: true, force: true });
    }
  });

  it("capacity reports persisted pending/running state and configured queue bound", () => {
    const f = fixture({ maxQueued: 7 });
    try {
      existingTraceMission(f.dbPath, f.workItem.id);
      f.store.submitWorkResult(input(f.claimed));
      expect(f.store.getObservationCapacity()).toEqual({ queued: 1, running: 0, maxQueued: 7, saturated: false });
      f.store.claimNextObservation();
      expect(f.store.getObservationCapacity()).toEqual({ queued: 0, running: 1, maxQueued: 7, saturated: false });
    } finally {
      f.store.close();
      rmSync(f.directory, { recursive: true, force: true });
    }
  });
});
