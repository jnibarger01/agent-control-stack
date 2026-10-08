import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { describe, expect, it } from "vitest";
import { domainHash } from "@agent-control-stack/shared";
import { SqliteWorkItemStore } from "./store.js";
import { readMissionTimeTravel, compareMissionTimeTravel, verifyMissionTimeTravel, MISSION_TIME_TRAVEL_VERSION } from "./mission-time-travel.js";

function fixture() {
  const dir = mkdtempSync(join(tmpdir(), "acs-time-travel-"));
  const file = join(dir, "store.sqlite");
  const store = new SqliteWorkItemStore(file);
  const work = store.create({
    title: "inspect",
    intent: "read-only",
    requester: "agent",
    risk: "low",
    requestedActions: [{ kind: "fs.read", description: "read", params: {} }]
  });
  return {
    file,
    store,
    work,
    close: () => {
      store.close();
      rmSync(dir, { recursive: true, force: true });
    }
  };
}

describe("mission time travel", () => {
  it("builds a deterministic as-of timeline without leaking raw command data", () => {
    const ctx = fixture();
    try {
      ctx.store.recordSystemEvent({
        name: "policy.decided",
        attributes: { "work_item.id": ctx.work.id, "actor.id": "SECRET_IN_EVENT_ATTRIBUTE" },
        body: { sensitive: "SECRET_IN_EVENT_BODY" }
      });
      const earlier = readMissionTimeTravel(ctx.store, ctx.work.id);
      ctx.store.recordSystemEvent({
        name: "execution.completed",
        attributes: { "work_item.id": ctx.work.id },
        body: { command: "SECRET_COMMAND" }
      });
      const current = readMissionTimeTravel(ctx.store, ctx.work.id);
      const past = readMissionTimeTravel(ctx.store, ctx.work.id, {
        asOfSequence: earlier.events.at(-1)!.sequence
      });
      expect(current.events.length).toBe(earlier.events.length + 1);
      expect(past.events.length).toBe(earlier.events.length);
      expect(past.sideEffects).toBe("disabled");
      expect(current.integrity).toBe("full-chain-verified");
      expect(JSON.stringify(current)).not.toMatch(/SECRET_IN_EVENT_BODY|SECRET_COMMAND|SECRET_IN_EVENT_ATTRIBUTE/);
      expect(compareMissionTimeTravel(past, current).reason).toBe("added");
      expect(compareMissionTimeTravel(current, readMissionTimeTravel(ctx.store, ctx.work.id)).equal).toBe(true);
    } finally {
      ctx.close();
    }
  });

  it("traverses multiple pages while preserving order and full ledger integrity", () => {
    const ctx = fixture();
    try {
      ctx.store.withTransaction(() => {
        for (let i = 0; i < 220; i++)
          ctx.store.recordSystemEvent({
            name: "worker.progress",
            attributes: { "work_item.id": ctx.work.id }
          });
      });
      const snapshot = readMissionTimeTravel(ctx.store, ctx.work.id);
      expect(snapshot.events).toHaveLength(221);
      expect(snapshot.auditEventCount).toBe(221);
      expect(verifyMissionTimeTravel(snapshot, ctx.store)).toBe(true);
    } finally {
      ctx.close();
    }
  });

  it("rejects modifications, ordering changes and missing events", () => {
    const ctx = fixture();
    try {
      ctx.store.recordSystemEvent({ name: "lease.claimed", attributes: { "work_item.id": ctx.work.id } });
      const snapshot = readMissionTimeTravel(ctx.store, ctx.work.id);
      expect(verifyMissionTimeTravel({ ...snapshot, events: [...snapshot.events].reverse() }, ctx.store)).toBe(false);
      expect(verifyMissionTimeTravel({ ...snapshot, events: snapshot.events.slice(1) }, ctx.store)).toBe(false);
      expect(verifyMissionTimeTravel({ ...snapshot, auditHeadHash: "f".repeat(64) }, ctx.store)).toBe(false);
    } finally {
      ctx.close();
    }
  });

  it("rejects a recomputed forged snapshot and compares projected actor metadata", () => {
    const ctx = fixture();
    try {
      ctx.store.recordSystemEvent({
        name: "policy.decided",
        attributes: { "work_item.id": ctx.work.id, "actor.id": "PRIVATE_ACTOR_SECRET" }
      });
      const snapshot = readMissionTimeTravel(ctx.store, ctx.work.id);
      expect(verifyMissionTimeTravel(snapshot, ctx.store)).toBe(true);
      expect(JSON.stringify(snapshot)).not.toContain("PRIVATE_ACTOR_SECRET");
      expect(snapshot.events.some((event) => typeof event.actorIdHash === "string")).toBe(true);

      const mutated = {
        ...snapshot,
        events: snapshot.events.map((event, i) =>
          i === snapshot.events.length - 1 ? { ...event, actorIdHash: "f".repeat(64) } : event
        )
      };
      const { snapshotHash: _oldHash, ...body } = mutated;
      const forged = { ...mutated, snapshotHash: domainHash(MISSION_TIME_TRAVEL_VERSION, body) };
      // Recomputing a local hash cannot authenticate a forged projection.
      expect(verifyMissionTimeTravel(forged, ctx.store)).toBe(false);
      expect(compareMissionTimeTravel(snapshot, forged)).toEqual({
        equal: false,
        firstDivergence: snapshot.events.at(-1)!.sequence,
        reason: "changed"
      });
    } finally {
      ctx.close();
    }
  });

  it("fails closed on a tampered canonical audit event", () => {
    const ctx = fixture();
    try {
      ctx.store.recordSystemEvent({ name: "tool.called", attributes: { "work_item.id": ctx.work.id } });
      const db = new DatabaseSync(ctx.file);
      try {
        db.prepare("UPDATE audit_events SET body = ? WHERE name = ?").run('{"changed":true}', "tool.called");
      } finally {
        db.close();
      }
      expect(() => readMissionTimeTravel(ctx.store, ctx.work.id)).toThrow("audit_integrity_failed");
    } finally {
      ctx.close();
    }
  });

  it("refuses unbounded and partial views", () => {
    const ctx = fixture();
    try {
      ctx.store.recordSystemEvent({ name: "worker.started", attributes: { "work_item.id": ctx.work.id } });
      expect(() => readMissionTimeTravel(ctx.store, ctx.work.id, { maxEvents: 1 })).toThrow("resource_limit");
      expect(() => readMissionTimeTravel(ctx.store, ctx.work.id, { asOfSequence: -1 })).toThrow("invalid_limit");
      expect(() => readMissionTimeTravel(ctx.store, "nonexistent")).toThrow("mission not found");
    } finally {
      ctx.close();
    }
  });
});