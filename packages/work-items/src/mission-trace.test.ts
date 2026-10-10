import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { describe, expect, it } from "vitest";
import { auditEventHash } from "@agent-control-stack/shared";
import { SqliteWorkItemStore } from "./store.js";
import { executionPlanSubjectInputHash, type ChangeSetDefinition } from "./index.js";

function fixture() {
  const dir = mkdtempSync(join(tmpdir(), "acs-mission-trace-"));
  const path = join(dir, "db.sqlite");
  const store = new SqliteWorkItemStore(path, { traceInstance: "trace-test", releaseSha: "a".repeat(40) });
  const mission = store.create({
    title: "Trace",
    intent: "inspect",
    requester: "agent",
    risk: "low",
    requestedActions: [{ kind: "fs.read", description: "read", params: {} }]
  });
  return {
    dir,
    path,
    store,
    mission,
    close: () => {
      store.close();
      rmSync(dir, { recursive: true, force: true });
    }
  };
}

describe("mission audit projection", () => {
  it("pages oldest-first without losing evidence amid unrelated traffic or inventing global verification", () => {
    const ctx = fixture();
    try {
      const unrelated = ctx.store.create({ ...ctx.mission, title: "unrelated" });
      ctx.store.withTransaction(() => {
        for (let index = 0; index < 220; index++) {
          ctx.store.recordSystemEvent({ name: "test.unrelated", attributes: { "work_item.id": unrelated.id } });
          ctx.store.recordSystemEvent({ name: "test.mission", attributes: { "work_item.id": ctx.mission.id } });
        }
      });
      const ids: string[] = [];
      let cursor = 0;
      do {
        const page = ctx.store.getMissionTrace(ctx.mission.id, { afterSequence: cursor, limit: 7 });
        expect(page.globalChainVerified).toBe(false);
        expect(page.events.every((entry) => entry.correlation.missionId === ctx.mission.id)).toBe(true);
        expect(page.events.some((entry) => entry.event.name === "test.unrelated")).toBe(false);
        ids.push(...page.events.map((entry) => entry.event.id));
        cursor = page.nextAfterSequence ?? 0;
      } while (cursor);
      expect(ids).toHaveLength(221);
      expect(new Set(ids).size).toBe(ids.length);
      expect(ctx.store.verifyAuditChain().ok).toBe(true);
    } finally {
      ctx.close();
    }
  });

  it("injects producer identity rather than trusting caller metadata and retains old release attribution on reopen", () => {
    const ctx = fixture();
    try {
      ctx.store.recordSystemEvent({
        name: "test.producer",
        attributes: { "work_item.id": ctx.mission.id, "acs.process.id": "forged", "acs.release_sha": "forged" }
      });
      const before = ctx.store.getMissionTrace(ctx.mission.id).events;
      expect(before[1]!.producer["acs.process.id"]).not.toBe("forged");
      expect(before[1]!.producer["acs.release_sha"]).toBe("a".repeat(40));
      const reopened = new SqliteWorkItemStore(ctx.path, { traceInstance: "new-instance", releaseSha: "b".repeat(40) });
      try {
        reopened.recordSystemEvent({ name: "test.new-release", attributes: { "work_item.id": ctx.mission.id } });
        const events = reopened.getMissionTrace(ctx.mission.id).events;
        expect(events.slice(0, 2)).toEqual(before);
        expect(events[2]!.producer["acs.release_sha"]).toBe("b".repeat(40));
        expect(events[2]!.producer["acs.instance"]).toBe("new-instance");
      } finally {
        reopened.close();
      }
    } finally {
      ctx.close();
    }
  });

  it.each(["selected event", "predecessor"])("fails closed on %s audit tampering", (scenario) => {
    const ctx = fixture();
    try {
      ctx.store.recordSystemEvent({ name: "test.unrelated", attributes: {} });
      ctx.store.recordSystemEvent({ name: "test.mission", attributes: { "work_item.id": ctx.mission.id } });
      const db = new DatabaseSync(ctx.path);
      try {
        db.prepare("UPDATE audit_events SET body = ? WHERE name = ?").run(
          '{"tampered":true}',
          scenario === "selected event" ? "test.mission" : "test.unrelated"
        );
      } finally {
        db.close();
      }
      expect(() => ctx.store.getMissionTrace(ctx.mission.id, { afterSequence: 1 })).toThrow("audit event invalid");
    } finally {
      ctx.close();
    }
  });

  it("reports legacy producer metadata as unknown without rewriting historical events", () => {
    const ctx = fixture();
    try {
      const original = ctx.store.readEvents()[0]!;
      const attributes = { ...original.attributes };
      for (const key of Object.keys(attributes).filter((key) => key.startsWith("acs."))) delete attributes[key];
      const historical = { ...original, attributes };
      const db = new DatabaseSync(ctx.path);
      try {
        db.prepare("UPDATE audit_events SET attributes = ?, event_hash = ? WHERE id = ?").run(
          JSON.stringify(attributes),
          auditEventHash(historical),
          original.id
        );
      } finally {
        db.close();
      }
      const trace = ctx.store.getMissionTrace(ctx.mission.id);
      expect(Object.values(trace.events[0]!.producer)).toEqual(["unknown", "unknown", "unknown", "unknown"]);
      expect(trace.events[0]!.event.attributes).toEqual(attributes);
      expect(ctx.store.verifyAuditChain().ok).toBe(true);
    } finally {
      ctx.close();
    }
  });

  it("coerces HTTP as-of query parameters and excludes future trace projections", () => {
    const ctx = fixture();
    try {
      ctx.store.recordSystemEvent({ name: "test.before", attributes: { "work_item.id": ctx.mission.id } });
      const cutoff = ctx.store.getMissionTrace(ctx.mission.id).events.at(-1)!.event.sequence;
      ctx.store.recordSystemEvent({ name: "test.after", attributes: { "work_item.id": ctx.mission.id } });
      const historical = ctx.store.getMissionTrace(ctx.mission.id, { asOfSequence: String(cutoff) });
      expect(historical.events.length).toBeGreaterThan(0);
      expect(historical.events.every(({ event }) => event.sequence <= cutoff)).toBe(true);
      expect(historical.events.some(({ event }) => event.name === "test.after")).toBe(false);
      // These current-state projections lack audit-sequence anchors.
      expect(historical.traceIds).toEqual([]);
      expect(historical.observations).toEqual([]);
    } finally {
      ctx.close();
    }
  });

  it("bounds input and rejects unknown missions", () => {
    const ctx = fixture();
    try {
      expect(() => ctx.store.getMissionTrace(ctx.mission.id, { limit: 201 })).toThrow();
      expect(() => ctx.store.getMissionTrace(ctx.mission.id, { afterSequence: -1 })).toThrow();
      expect(() => ctx.store.getMissionTrace("missing")).toThrow("mission not found");
    } finally {
      ctx.close();
    }
  });

  it("verifies the revision ancestry once and still fails closed on tampered history", async () => {
    const ctx = fixture();
    try {
      // Amend repeatedly so the revision chain is deep. Each amendment must be
      // verified, but the cost must stay linear rather than quadratic.
      const mission = ctx.mission;
      const build = (revision: number) => {
        const definition: ChangeSetDefinition = {
          schemaVersion: "acs.change-set.v1",
          missionId: mission.id,
          subjectInputHash: executionPlanSubjectInputHash(mission),
          executingActorId: "planner",
          objective: `revision ${revision}`,
          scope: [{ kind: "path", id: "/repo" }],
          maximumPrivileges: ["fs.read"],
          expiresAt: new Date(Date.now() + 3_600_000).toISOString(),
          constraints: { maxRuntimeMs: 1_000, maxParallelOperations: 1, failureBehavior: "stop" },
          verification: [],
          operations: [
            {
              operationId: "inspect",
              runtime: "desktop_commander",
              toolName: "read_file",
              action: { kind: "fs.read", description: "inspect", params: { path: "/repo/a.ts" } },
              resources: [{ kind: "path", id: "/repo" }],
              requestedPrivileges: ["fs.read"],
              effect: "read_only",
              expectedSideEffects: [],
              dependsOn: [],
              retry: { maxAttempts: 1, idempotencyKey: "inspect" }
            }
          ]
        };
        return definition;
      };
      let head: string | null = null;
      for (let revision = 1; revision <= 12; revision++)
        head = ctx.store.submitChangeSet({
          definition: build(revision),
          submissionId: `revision-${revision}`,
          expectedHeadHash: head,
          createdByActorId: "planner"
        }).manifestHash;

      const start = Date.now();
      const trace = ctx.store.getMissionTrace(mission.id);
      const elapsedMs = Date.now() - start;
      expect(trace.events.length).toBeGreaterThan(0);
      expect(trace.events.every((entry) => entry.correlation.missionId === mission.id)).toBe(true);
      // A deep chain must remain cheap; a quadratic pass cannot stay this small.
      expect(elapsedMs, `mission trace took ${elapsedMs}ms for 12 revisions`).toBeLessThan(2_000);
      expect(ctx.store.verifyAuditChain().ok).toBe(true);

      // Integrity is not weakened: tampering with any historical revision still
      // fails the trace closed.
      const db = new DatabaseSync(ctx.path);
      try {
        db.exec("DROP TRIGGER change_set_revisions_no_update");
        db.prepare("UPDATE change_set_revisions SET snapshot_json = ? WHERE mission_id = ? AND revision = 1").run(
          JSON.stringify({ revision: 1, parentManifestHash: null, definition: build(999) }),
          mission.id
        );
      } finally {
        db.close();
      }
      expect(() => ctx.store.getMissionTrace(mission.id)).toThrow(/integrity|failed/u);
    } finally {
      ctx.close();
    }
  }, 20_000);
});