import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { describe, expect, it } from "vitest";
import { ControlStackError, stableHash } from "@agent-control-stack/shared";
import { SqliteWorkItemStore } from "./store.js";

const transition = { via: "domain_service" as const };

function createClaimedItem(options: { leaseMs?: number } = {}) {
  const directory = mkdtempSync(join(tmpdir(), "acs-wave2-result-"));
  const store = new SqliteWorkItemStore(join(directory, "control.db"), { leaseMs: options.leaseMs });
  const workItem = store.create({
    title: "Wave 2 result",
    requester: "agent",
    intent: "record a simulated result",
    target: { cwd: "/repo" },
    requestedActions: [{ kind: "manual", description: "simulate" }],
    risk: "low"
  });
  store.approveWorkItem(workItem.id, transition);
  const claimed = store.claimNextApprovedWorkItem("worker-a");
  if (!claimed) throw new Error("expected a claim");
  return { directory, store, workItem, claimed };
}

function resultInput(claimed: ReturnType<typeof createClaimedItem>["claimed"]) {
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
    stdout: "no real command ran",
    stderr: "",
    structuredOutput: { simulated: true },
    artifacts: [],
    simulationMetadata: { executionMode: "dry_run" as const, simulated: true }
  };
}

describe("immutable worker result acceptance", () => {
  it("creates a durable lease identity and accepts one result atomically", () => {
    const { directory, store, claimed } = createClaimedItem();
    try {
      expect(claimed.leaseId).toMatch(/^lease_/);
      expect(claimed.actionHash).toMatch(/^[a-f0-9]{64}$/);

      const accepted = store.submitWorkResult(resultInput(claimed));

      expect(accepted.status).toBe("succeeded");
      expect(accepted.result).toMatchObject({ outcome: "succeeded", executionMode: "dry_run" });
      expect(store.readEvents().map((event) => event.name)).toContain("execution_result.accepted");
    } finally {
      store.close();
      rmSync(directory, { recursive: true, force: true });
    }
  });

  it("returns the original result for an exact replay and rejects conflicting reuse", () => {
    const { directory, store, claimed } = createClaimedItem();
    try {
      const input = resultInput(claimed);
      const accepted = store.submitWorkResult(input);
      const replay = store.submitWorkResult(input);

      expect(replay).toEqual(accepted);
      expect(store.readEvents().filter((event) => event.name === "execution_result.accepted")).toHaveLength(1);

      expect(() => store.submitWorkResult({ ...input, summary: "different payload" })).toThrowError(
        expect.objectContaining<Partial<ControlStackError>>({ code: "result_conflict" })
      );
    } finally {
      store.close();
      rmSync(directory, { recursive: true, force: true });
    }
  });

  it("rejects a different idempotency key after the work item already has a result", () => {
    const { directory, store, claimed } = createClaimedItem();
    try {
      const input = resultInput(claimed);
      store.submitWorkResult(input);

      expect(() => store.submitWorkResult({ ...input, idempotencyKey: `${input.idempotencyKey}-other` })).toThrowError(
        expect.objectContaining<Partial<ControlStackError>>({ code: "result_conflict" })
      );
    } finally {
      store.close();
      rmSync(directory, { recursive: true, force: true });
    }
  });

  it("keeps accepted result and terminal work-item history immutable", () => {
    const { directory, store, claimed } = createClaimedItem();
    const dbPath = join(directory, "control.db");
    try {
      const accepted = store.submitWorkResult(resultInput(claimed));
      const resultId = accepted.result?.resultId;
      if (typeof resultId !== "string") throw new Error("expected a stored result ID");
      const db = new DatabaseSync(dbPath);
      try {
        expect(() => db.prepare(`UPDATE work_items SET title = ? WHERE id = ?`).run("rewritten", claimed.id)).toThrow(
          "accepted result is immutable"
        );
        expect(() =>
          db.prepare(`UPDATE execution_results SET summary = ? WHERE result_id = ?`).run("rewritten", resultId)
        ).toThrow("execution_results: append-only");
        expect(() => db.prepare(`DELETE FROM execution_results WHERE result_id = ?`).run(resultId)).toThrow(
          "execution_results: append-only"
        );
      } finally {
        db.close();
      }
    } finally {
      store.close();
      rmSync(directory, { recursive: true, force: true });
    }
  });

  it("rejects unsafe or impossible payloads before the transaction changes state", () => {
    const { directory, store, claimed } = createClaimedItem();
    try {
      const input = resultInput(claimed);
      expect(() => store.submitWorkResult({ ...input, unknownField: true })).toThrow();
      expect(() => store.submitWorkResult({ ...input, finishedAt: "2026-01-01T00:00:00.000Z" })).toThrow();
      expect(() => store.submitWorkResult({ ...input, stdout: "x".repeat(64 * 1024 + 1) })).toThrow();
      expect(() => store.submitWorkResult({ ...input, structuredOutput: { authorization: "secret" } })).toThrow();
      expect(() =>
        store.submitWorkResult({
          ...input,
          artifacts: [{ name: "/tmp/private.txt" }]
        })
      ).toThrow();
      expect(store.get(claimed.id)?.status).toBe("running");
      expect(store.getExecutionResultForIdempotency(claimed.workerId, input.idempotencyKey)).toBeUndefined();
    } finally {
      store.close();
      rmSync(directory, { recursive: true, force: true });
    }
  });

  it("rolls back a result insert when the work-item transition fails", () => {
    const { directory, store, claimed } = createClaimedItem();
    const dbPath = join(directory, "control.db");
    const trigger = new DatabaseSync(dbPath);
    trigger.exec(`
      CREATE TRIGGER wave2_fail_transition
      BEFORE UPDATE ON work_items
      WHEN OLD.status = 'running' AND NEW.status <> OLD.status
      BEGIN
        SELECT RAISE(ABORT, 'wave2 transition failure');
      END;
    `);
    trigger.close();
    try {
      expect(() => store.submitWorkResult(resultInput(claimed))).toThrow("wave2 transition failure");
      expect(store.get(claimed.id)?.status).toBe("running");
      const check = new DatabaseSync(dbPath, { readOnly: true });
      try {
        expect(check.prepare(`SELECT COUNT(*) AS count FROM execution_results`).get()).toEqual({ count: 0 });
        expect(check.prepare(`SELECT status FROM leases WHERE lease_id = ?`).get(claimed.leaseId)).toEqual({
          status: "active"
        });
      } finally {
        check.close();
      }
    } finally {
      store.close();
      rmSync(directory, { recursive: true, force: true });
    }
  });

  it("rolls back result, state, and lease when audit insertion fails", () => {
    const { directory, store, claimed } = createClaimedItem();
    const dbPath = join(directory, "control.db");
    const trigger = new DatabaseSync(dbPath);
    trigger.exec(`
      CREATE TRIGGER wave2_fail_result_audit
      BEFORE INSERT ON audit_events
      WHEN NEW.name = 'execution_result.accepted'
      BEGIN
        SELECT RAISE(ABORT, 'wave2 audit failure');
      END;
    `);
    trigger.close();
    try {
      expect(() => store.submitWorkResult(resultInput(claimed))).toThrow("wave2 audit failure");
      expect(store.get(claimed.id)?.status).toBe("running");
      expect(store.readEvents().some((event) => event.name === "execution_result.accepted")).toBe(false);
      const check = new DatabaseSync(dbPath, { readOnly: true });
      try {
        expect(check.prepare(`SELECT COUNT(*) AS count FROM execution_results`).get()).toEqual({ count: 0 });
        expect(check.prepare(`SELECT status FROM leases WHERE lease_id = ?`).get(claimed.leaseId)).toEqual({
          status: "active"
        });
      } finally {
        check.close();
      }
    } finally {
      store.close();
      rmSync(directory, { recursive: true, force: true });
    }
  });

  it("resolves concurrent identical submissions to one durable result", async () => {
    const directory = mkdtempSync(join(tmpdir(), "acs-wave2-result-concurrent-"));
    const dbPath = join(directory, "control.db");
    const seed = new SqliteWorkItemStore(dbPath);
    const item = seed.create({
      title: "Concurrent result",
      requester: "agent",
      intent: "resolve identical submissions",
      target: { cwd: "/repo" },
      requestedActions: [{ kind: "manual", description: "simulate" }],
      risk: "low"
    });
    seed.approveWorkItem(item.id, transition);
    const claimed = seed.claimNextApprovedWorkItem("worker-a");
    if (!claimed) throw new Error("expected a claim");
    seed.close();
    const first = new SqliteWorkItemStore(dbPath);
    const second = new SqliteWorkItemStore(dbPath);
    try {
      const input = resultInput(claimed);
      const accepted = await Promise.all([
        Promise.resolve().then(() => first.submitWorkResult(input)),
        Promise.resolve().then(() => second.submitWorkResult(input))
      ]);
      expect(accepted[0]).toEqual(accepted[1]);
      expect(first.readEvents().filter((event) => event.name === "execution_result.accepted")).toHaveLength(1);
      expect(first.getExecutionResultForIdempotency("worker-a", input.idempotencyKey)?.resultId).toBe(
        accepted[0]?.result?.resultId
      );
    } finally {
      first.close();
      second.close();
      rmSync(directory, { recursive: true, force: true });
    }
  });

  it("keeps idempotency durable across a store restart", () => {
    const directory = mkdtempSync(join(tmpdir(), "acs-wave2-result-restart-"));
    const dbPath = join(directory, "control.db");
    const first = new SqliteWorkItemStore(dbPath);
    const { claimed } = (() => {
      const workItem = first.create({
        title: "Restart result",
        requester: "agent",
        intent: "replay after restart",
        target: { cwd: "/repo" },
        requestedActions: [{ kind: "manual", description: "simulate" }],
        risk: "low"
      });
      first.approveWorkItem(workItem.id, transition);
      const claim = first.claimNextApprovedWorkItem("worker-a");
      if (!claim) throw new Error("expected a claim");
      return { claimed: claim };
    })();
    const input = resultInput(claimed);
    try {
      const accepted = first.submitWorkResult(input);
      first.close();
      const second = new SqliteWorkItemStore(dbPath);
      try {
        expect(second.submitWorkResult(input)).toEqual(accepted);
        expect(second.getExecutionResultForIdempotency("worker-a", input.idempotencyKey)?.resultId).toBe(
          accepted.result?.resultId
        );
      } finally {
        second.close();
      }
    } finally {
      try {
        first.close();
      } catch {
        // already closed after the restart step
      }
      rmSync(directory, { recursive: true, force: true });
    }
  });
});
