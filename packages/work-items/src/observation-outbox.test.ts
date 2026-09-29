import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { describe, expect, it } from "vitest";
import { stableHash } from "@agent-control-stack/shared";
import {
  OBSERVATION_OUTBOX_MAX_ATTEMPTS,
  OBSERVATION_OUTBOX_MAX_QUEUE,
  observationalIdentity
} from "./observation-outbox.js";
import { SqliteWorkItemStore } from "./store.js";

const transition = { via: "domain_service" as const };

function fixture(options: { maxQueued?: number } = {}) {
  const directory = mkdtempSync(join(tmpdir(), "acs-jev4-outbox-"));
  const dbPath = join(directory, "control.db");
  const store = new SqliteWorkItemStore(dbPath, { observationMaxQueued: options.maxQueued });
  const workItem = store.create({
    title: "JEV-4 observation",
    requester: "agent",
    intent: "complete authoritative work before observing it",
    target: { cwd: "/repo" },
    requestedActions: [{ kind: "manual", description: "simulate" }],
    risk: "low"
  });
  store.approveWorkItem(workItem.id, transition);
  const claimed = store.claimNextApprovedWorkItem("worker-a", { allowLegacyClaimForTests: true });
  if (!claimed) throw new Error("expected claim");
  const input = {
    workItemId: claimed.id,
    leaseId: claimed.leaseId,
    workerId: claimed.workerId,
    actionHash: claimed.actionHash,
    idempotencyKey: stableHash({ workItemId: claimed.id, leaseId: claimed.leaseId }),
    outcome: "succeeded" as const,
    startedAt: claimed.startedAt,
    finishedAt: new Date(Date.parse(claimed.startedAt) + 10).toISOString(),
    exitCode: 0,
    summary: "done",
    structuredOutput: {},
    artifacts: [],
    simulationMetadata: { executionMode: "dry_run" as const, simulated: true }
  };
  return { directory, dbPath, store, claimed, input };
}

describe("JEV-4 observation outbox", () => {
  it("enqueues one durable job only after authoritative result acceptance", () => {
    const f = fixture();
    try {
      expect(f.store.getObservationCapacity().queued).toBe(0);
      expect(f.store.submitWorkResult(f.input).status).toBe("succeeded");
      const capacity = f.store.getObservationCapacity();
      expect(capacity).toMatchObject({ queued: 1, running: 0, maxQueued: OBSERVATION_OUTBOX_MAX_QUEUE });
      const job = f.store.claimNextObservationJob();
      expect(job).toMatchObject({
        workItemId: f.claimed.id,
        status: "running",
        attempts: 1,
        maxAttempts: OBSERVATION_OUTBOX_MAX_ATTEMPTS
      });
    } finally {
      f.store.close();
      rmSync(f.directory, { recursive: true, force: true });
    }
  });

  it("uses the same canonical trace id and persists a terminal canonical trace event", () => {
    const f = fixture();
    try {
      f.store.submitWorkResult(f.input);
      const job = f.store.claimNextObservationJob();
      if (!job) throw new Error("expected job");
      const trace = f.store.readCanonicalTraceEvents(job.workItemId, job.traceId, 1000);
      expect(trace.length).toBeGreaterThanOrEqual(1);
      expect(trace.every((event) => event.trace_id === job.traceId)).toBe(true);
      expect(trace.at(-1)?.kind).toBe("run.completed");
    } finally {
      f.store.close();
      rmSync(f.directory, { recursive: true, force: true });
    }
  });

  it("does not duplicate scheduling on exact result replay", () => {
    const f = fixture();
    try {
      f.store.submitWorkResult(f.input);
      f.store.submitWorkResult(f.input);
      expect(f.store.getObservationCapacity().queued).toBe(1);
    } finally {
      f.store.close();
      rmSync(f.directory, { recursive: true, force: true });
    }
  });

  it("fails open when the observation queue is saturated", () => {
    const f = fixture({ maxQueued: 0 });
    try {
      expect(f.store.submitWorkResult(f.input).status).toBe("succeeded");
      expect(f.store.getObservationCapacity().queued).toBe(0);
      expect(f.store.getObservationEnqueueSkipCount()).toBe(1);
    } finally {
      f.store.close();
      rmSync(f.directory, { recursive: true, force: true });
    }
  });

  it("claims a job atomically across two store instances", () => {
    const f = fixture();
    const second = new SqliteWorkItemStore(f.dbPath);
    try {
      f.store.submitWorkResult(f.input);
      const firstClaim = f.store.claimNextObservationJob();
      const secondClaim = second.claimNextObservationJob();
      expect(firstClaim).toBeDefined();
      expect(secondClaim).toBeUndefined();
    } finally {
      second.close();
      f.store.close();
      rmSync(f.directory, { recursive: true, force: true });
    }
  });

  it("enforces the concurrent running cap transactionally across store instances", () => {
    const f = fixture();
    const second = new SqliteWorkItemStore(f.dbPath);
    try {
      f.store.submitWorkResult(f.input);
      const db = new DatabaseSync(f.dbPath);
      try {
        const insert = db.prepare(
          `INSERT INTO observation_outbox
           (observation_id, work_item_id, trace_id, question_set_version, classifier_version, created_at)
           VALUES (?, ?, ?, 'jev-trace@1', 'jev-advisory-v2', ?)`
        );
        for (let index = 1; index <= 5; index += 1) {
          insert.run(
            `obs_extra_${index}`,
            f.claimed.id,
            index.toString(16).padStart(32, "0"),
            new Date(Date.parse("2026-09-28T00:00:00.000Z") + index).toISOString()
          );
        }
      } finally {
        db.close();
      }

      for (let index = 0; index < 5; index += 1) {
        const store = index % 2 === 0 ? f.store : second;
        expect(store.claimNextObservationJob(new Date("2026-09-28T00:01:00.000Z"), 5)).toBeDefined();
      }
      expect(f.store.claimNextObservationJob(new Date("2026-09-28T00:01:01.000Z"), 5)).toBeUndefined();
      expect(second.claimNextObservationJob(new Date("2026-09-28T00:01:01.000Z"), 5)).toBeUndefined();
      expect(f.store.getObservationCapacity()).toMatchObject({ queued: 1, running: 5 });
    } finally {
      second.close();
      f.store.close();
      rmSync(f.directory, { recursive: true, force: true });
    }
  });

  it("bounds queued jobs independently from running observations", () => {
    const f = fixture({ maxQueued: 1 });
    try {
      f.store.submitWorkResult(f.input);
      expect(f.store.getObservationCapacity()).toMatchObject({ queued: 1, running: 0, saturated: true });
      expect(f.store.claimNextObservationJob()).toBeDefined();
      expect(f.store.getObservationCapacity()).toMatchObject({ queued: 0, running: 1, saturated: false });
    } finally {
      f.store.close();
      rmSync(f.directory, { recursive: true, force: true });
    }
  });

  it("requeues failures until max attempts then becomes terminal failed", () => {
    const f = fixture();
    try {
      f.store.submitWorkResult(f.input);
      let job = f.store.claimNextObservationJob();
      if (!job) throw new Error("expected job");
      for (let attempt = 1; attempt < OBSERVATION_OUTBOX_MAX_ATTEMPTS; attempt += 1) {
        job = f.store.retryObservationJob(job.observationId, "offline");
        expect(job.status).toBe("pending");
        job = f.store.claimNextObservationJob();
        if (!job) throw new Error("expected retry");
      }
      const terminal = f.store.retryObservationJob(job.observationId, "still offline");
      expect(terminal.status).toBe("failed");
      expect(terminal.completedAt).not.toBeNull();
    } finally {
      f.store.close();
      rmSync(f.directory, { recursive: true, force: true });
    }
  });

  it("recovers a stale running job without exceeding its attempt bound", () => {
    const f = fixture();
    try {
      f.store.submitWorkResult(f.input);
      const job = f.store.claimNextObservationJob(new Date("2026-09-28T00:00:00.000Z"));
      if (!job) throw new Error("expected job");
      expect(f.store.recoverStaleObservationJobs(new Date("2026-09-28T00:00:01.000Z"))).toBe(1);
      expect(f.store.getObservationJob(job.observationId)?.status).toBe("pending");
    } finally {
      f.store.close();
      rmSync(f.directory, { recursive: true, force: true });
    }
  });

  it("completes a claimed job idempotently without changing authoritative work state", () => {
    const f = fixture();
    try {
      const authoritative = f.store.submitWorkResult(f.input);
      const job = f.store.claimNextObservationJob();
      if (!job) throw new Error("expected job");
      const completed = f.store.completeObservationJob({
        observationId: job.observationId,
        status: "degraded",
        classifierOutcome: "INCOMPATIBLE_MODEL",
        error: null
      });
      expect(completed.status).toBe("degraded");
      expect(
        f.store.completeObservationJob({
          observationId: job.observationId,
          status: "degraded",
          classifierOutcome: "INCOMPATIBLE_MODEL",
          error: null
        })
      ).toEqual(completed);
      expect(f.store.get(authoritative.id)?.status).toBe("succeeded");
    } finally {
      f.store.close();
      rmSync(f.directory, { recursive: true, force: true });
    }
  });

  it("derives collision-resistant deterministic observation identity from the version tuple", () => {
    const first = observationalIdentity({
      traceId: "a".repeat(32),
      questionSetVersion: "jev-trace@1",
      classifierVersion: "jev-advisory-v2"
    });
    const second = observationalIdentity({
      traceId: "a".repeat(32),
      questionSetVersion: "jev-trace@1",
      classifierVersion: "jev-advisory-v2"
    });
    expect(first).toBe(second);
    expect(first).toMatch(/^obs_[a-f0-9]{24}$/);
  });

  it("stores no lease, capability, approval token, or raw execution payload in observation_outbox", () => {
    const f = fixture();
    try {
      f.store.submitWorkResult({ ...f.input, stdout: "sensitive stdout", stderr: "sensitive stderr" });
      const db = new DatabaseSync(f.dbPath);
      try {
        const sql = db
          .prepare("SELECT sql FROM sqlite_master WHERE type='table' AND name='observation_outbox'")
          .get() as { sql: string };
        expect(sql.sql).not.toMatch(/lease|capability|approval_token|stdout|stderr/i);
      } finally {
        db.close();
      }
    } finally {
      f.store.close();
      rmSync(f.directory, { recursive: true, force: true });
    }
  });
});
