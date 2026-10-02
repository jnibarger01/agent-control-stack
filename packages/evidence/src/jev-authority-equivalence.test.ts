import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterEach, describe, expect, it } from "vitest";
import { SqliteWorkItemStore, enqueueObservationAfterAuthority } from "@agent-control-stack/work-items";
import { ObservationWorker, type TraceClassifierResult } from "./observation-worker.js";

/**
 * Step 10 acceptance: JEV is telemetry-only. The authoritative ledger must be
 * byte-identical whether the observation classifier answers healthily or is
 * fully degraded. The observation outbox is written strictly after the
 * authoritative transition commits, so the two runs may only differ in
 * `jev_observation_outbox`.
 */
const dirs: string[] = [];

afterEach(() => {
  for (const directory of dirs.splice(0)) rmSync(directory, { recursive: true, force: true });
});

function terminalStore(): { dir: string; path: string; store: SqliteWorkItemStore; workItemId: string } {
  const dir = mkdtempSync(join(tmpdir(), "acs-jev-equivalence-"));
  dirs.push(dir);
  const path = join(dir, "control.db");
  const store = new SqliteWorkItemStore(path, {
    traceInstance: "jev-equivalence",
    releaseSha: "a".repeat(40)
  });
  const item = store.create({
    title: "observational probe",
    intent: "authority must not depend on JEV",
    requester: "agent",
    target: { cwd: "/repo" },
    requestedActions: [{ kind: "manual", description: "probe" }],
    risk: "low"
  });
  // cancelWorkItem records a terminal run.failed trace fact, which is what the
  // observation worker requires before it classifies a trace.
  store.cancelWorkItem(item.id, { actor: "operator", reason: "probe" }, { via: "domain_service" });
  const db = new DatabaseSync(path);
  try {
    enqueueObservationAfterAuthority(
      db,
      { questionSetVersion: "q1", classifierVersion: "jev-advisory-v2", maxQueued: 100, maxAttempts: 1 },
      item.id
    );
  } finally {
    db.close();
  }
  return { dir, path, store, workItemId: item.id };
}

function authoritySnapshot(path: string): string {
  const db = new DatabaseSync(path);
  try {
    const events = db
      .prepare("SELECT sequence, name, body, event_hash FROM audit_events ORDER BY sequence")
      .all() as unknown[];
    const items = db
      .prepare("SELECT id, status FROM work_items ORDER BY id")
      .all() as unknown[];
    return JSON.stringify({ events, items });
  } finally {
    db.close();
  }
}

function observationStatus(path: string): string {
  const db = new DatabaseSync(path);
  try {
    const row = db
      .prepare("SELECT status FROM jev_observation_outbox LIMIT 1")
      .get() as { status: string } | undefined;
    return row?.status ?? "missing";
  } finally {
    db.close();
  }
}

const healthy: TraceClassifierResult = {
  outcome: "OK",
  degraded: false,
  retryable: false,
  telemetryCorrelationId: null
};

const degraded: TraceClassifierResult = {
  outcome: "UNAVAILABLE",
  degraded: true,
  retryable: false,
  telemetryCorrelationId: null
};

describe("JEV authority equivalence (telemetry-only)", () => {
  it("leaves the authoritative ledger byte-identical whether JEV is healthy or degraded", async () => {
    const ctx = terminalStore();
    try {
      const before = authoritySnapshot(ctx.path);

      const healthyWorker = new ObservationWorker(ctx.store, {
        classifier: async () => healthy,
        telemetrySink: () => undefined
      });
      expect(await healthyWorker.runOnce()).toBe(1);
      expect(observationStatus(ctx.path)).toBe("completed");
      const afterHealthy = authoritySnapshot(ctx.path);

      // Reset only the observational outbox, then classify the same ledger with
      // a fully degraded JEV. Authority must not move.
      const db = new DatabaseSync(ctx.path);
      try {
        db.prepare(
          "UPDATE jev_observation_outbox SET status='pending', attempts=0, started_at=NULL, " +
            "completed_at=NULL, classifier_outcome=NULL, telemetry_correlation_id=NULL, error=NULL"
        ).run();
      } finally {
        db.close();
      }

      const degradedWorker = new ObservationWorker(ctx.store, {
        classifier: async () => degraded,
        telemetrySink: () => undefined
      });
      expect(await degradedWorker.runOnce()).toBe(1);
      expect(observationStatus(ctx.path)).toBe("degraded");
      const afterDegraded = authoritySnapshot(ctx.path);

      // Authority is identical before, after a healthy observation, and after a
      // degraded observation: only the observational outbox differs.
      expect(afterHealthy).toBe(before);
      expect(afterDegraded).toBe(before);
      expect(afterDegraded).toBe(afterHealthy);
      expect(ctx.store.verifyAuditChain().ok).toBe(true);
    } finally {
      ctx.store.close();
    }
  });

  it("records malformed and incompatible JEV answers as degraded without touching authority", async () => {
    const ctx = terminalStore();
    try {
      const before = authoritySnapshot(ctx.path);
      const worker = new ObservationWorker(ctx.store, {
        classifier: async () => ({ ...degraded, outcome: "INCOMPATIBLE_MODEL" }),
        telemetrySink: () => undefined
      });
      expect(await worker.runOnce()).toBe(1);
      expect(observationStatus(ctx.path)).toBe("degraded");
      expect(authoritySnapshot(ctx.path)).toBe(before);
    } finally {
      ctx.store.close();
    }
  });
});
