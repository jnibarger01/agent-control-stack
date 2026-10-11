import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { stableHash } from "@agent-control-stack/shared";
import { describe, expect, it } from "vitest";
import {
  appendFlightRecord,
  flightRecordHash,
  readFlightRecords,
  readMissionFlightRecord,
  redactFlightBody,
  verifyFlightRecord
} from "./flight-recorder.js";
import { CodingMissionStore } from "./store.js";

const T0 = "2026-10-10T00:00:00.000Z";

function mission() {
  const store = new CodingMissionStore(":memory:");
  store.createGeneral({ missionId: "m1", summary: "record me", initiatorId: "user-1", now: T0 });
  store.recordMissionEvent("m1", "work_unit.started", { unitId: "u1", worker: "w1" }, T0);
  store.putEvidence("m1", "validation", { passed: true, checks: 3 }, T0);
  store.recordMissionEvent("m1", "work_unit.completed", { unitId: "u1", verified: true }, T0);
  return store;
}

/** Simulates an attacker with write access to the database file: removes the speed-bump triggers first. */
function dropRecorderTriggers(store: CodingMissionStore) {
  store.db.exec("DROP TRIGGER mission_flight_records_no_update");
  store.db.exec("DROP TRIGGER mission_flight_records_no_delete");
}

describe("flight recorder: normal operation", () => {
  it("chains every mission event and evidence insert in order and verifies", () => {
    const store = mission();
    const records = readFlightRecords(store.db, "m1");
    expect(records.map((r) => r.kind)).toEqual([
      "mission.created",
      "work_unit.started",
      "evidence.recorded",
      "work_unit.completed"
    ]);
    expect(records.map((r) => r.seq)).toEqual([1, 2, 3, 4]);
    expect(records[0]!.previousHash).toBe("");
    for (let i = 1; i < records.length; i += 1) expect(records[i]!.previousHash).toBe(records[i - 1]!.recordHash);
    const verdict = verifyFlightRecord(store.db, "m1");
    expect(verdict).toMatchObject({ verdict: "verified", recordCount: 4, legacyEventCount: 0, findings: [] });
    expect(verdict.headHash).toBe(records[3]!.recordHash);
  });

  it("keeps chains independent per mission", () => {
    const store = mission();
    store.createGeneral({ missionId: "m2", summary: "other", initiatorId: "user-1", now: T0 });
    expect(readFlightRecords(store.db, "m2")).toHaveLength(1);
    expect(verifyFlightRecord(store.db, "m2").verdict).toBe("verified");
    expect(verifyFlightRecord(store.db, "m1").verdict).toBe("verified");
  });

  it("does not chain a duplicate evidence insert twice", () => {
    const store = mission();
    store.putEvidence("m1", "validation", { passed: true, checks: 3 }, T0);
    expect(readFlightRecords(store.db, "m1").filter((r) => r.kind === "evidence.recorded")).toHaveLength(1);
  });

  it("verifies an empty mission", () => {
    const store = new CodingMissionStore(":memory:");
    expect(verifyFlightRecord(store.db, "absent")).toMatchObject({ verdict: "verified", recordCount: 0, headHash: "" });
  });
});

describe("flight recorder: tamper evidence", () => {
  it("blocks ordinary UPDATE and DELETE of chained records", () => {
    const store = mission();
    expect(() => store.db.exec("UPDATE mission_flight_records SET kind = 'x'")).toThrow(/append-only/);
    expect(() => store.db.exec("DELETE FROM mission_flight_records")).toThrow(/append-only/);
    expect(() => store.db.exec("UPDATE mission_flight_epoch SET last_legacy_event_id = 999999")).toThrow(/write-once/);
    expect(verifyFlightRecord(store.db, "m1").verdict).toBe("verified");
  });

  it("detects an edited chained record", () => {
    const store = mission();
    dropRecorderTriggers(store);
    store.db.exec(`UPDATE mission_flight_records SET body_json = '{"unitId":"u9"}' WHERE seq = 2`);
    const result = verifyFlightRecord(store.db, "m1");
    expect(result.verdict).toBe("tampered");
    expect(result.findings.map((f) => f.kind)).toContain("record_hash_mismatch");
    expect(result.findings.map((f) => f.kind)).toContain("event_modified");
  });

  it("detects a record deleted from the middle of the chain", () => {
    const store = mission();
    dropRecorderTriggers(store);
    store.db.exec(`DELETE FROM mission_flight_records WHERE seq = 2`);
    const kinds = verifyFlightRecord(store.db, "m1").findings.map((f) => f.kind);
    expect(kinds).toEqual(expect.arrayContaining(["sequence_gap", "previous_hash_mismatch"]));
  });

  it("detects removal of the newest record through the operational cross-check", () => {
    const store = mission();
    dropRecorderTriggers(store);
    store.db.exec(`DELETE FROM mission_flight_records WHERE seq = 4`);
    const result = verifyFlightRecord(store.db, "m1");
    expect(result.verdict).toBe("tampered");
    expect(result.findings.map((f) => f.kind)).toContain("unrecorded_event");
  });

  it("detects a swapped order of records", () => {
    const store = mission();
    dropRecorderTriggers(store);
    store.db.exec(`UPDATE mission_flight_records SET seq = 20 WHERE seq = 2`);
    store.db.exec(`UPDATE mission_flight_records SET seq = 2 WHERE seq = 3`);
    store.db.exec(`UPDATE mission_flight_records SET seq = 3 WHERE seq = 20`);
    expect(verifyFlightRecord(store.db, "m1").verdict).toBe("tampered");
  });

  it("detects an edited operational event row", () => {
    const store = mission();
    store.db.exec(
      `UPDATE coding_events SET body_json = '{"unitId":"u1","verified":false}' WHERE name = 'work_unit.completed'`
    );
    const finding = verifyFlightRecord(store.db, "m1").findings.find((f) => f.kind === "event_modified");
    expect(finding).toBeDefined();
  });

  it("detects a deleted operational event row", () => {
    const store = mission();
    store.db.exec(`DELETE FROM coding_events WHERE name = 'work_unit.started'`);
    expect(verifyFlightRecord(store.db, "m1").findings.map((f) => f.kind)).toContain("event_missing");
  });

  it("detects an event written around the recorder", () => {
    const store = mission();
    store.db
      .prepare(`INSERT INTO coding_events (mission_id, name, body_json, created_at) VALUES ('m1', 'forged', '{}', ?)`)
      .run(T0);
    const finding = verifyFlightRecord(store.db, "m1").findings.find((f) => f.kind === "unrecorded_event");
    expect(finding?.eventId).toBeGreaterThan(0);
  });

  it("detects edited and removed evidence", () => {
    const store = mission();
    store.db.exec(`UPDATE coding_evidence SET payload_json = '{"passed":false,"checks":3}' WHERE kind = 'validation'`);
    expect(verifyFlightRecord(store.db, "m1").findings.map((f) => f.kind)).toContain("evidence_modified");
    store.db.exec(`DELETE FROM coding_evidence WHERE kind = 'validation'`);
    expect(verifyFlightRecord(store.db, "m1").findings.map((f) => f.kind)).toContain("evidence_missing");
  });

  it("detects evidence inserted around the recorder", () => {
    const store = mission();
    store.db
      .prepare(
        `INSERT INTO coding_evidence (mission_id, evidence_id, kind, payload_hash, payload_json, created_at)
         VALUES ('m1', 'forged:1', 'forged', ?, '{}', ?)`
      )
      .run("a".repeat(64), T0);
    expect(verifyFlightRecord(store.db, "m1").findings.map((f) => f.kind)).toContain("unrecorded_evidence");
  });

  it("documents the limit: a full rewrite of the chain is internally consistent and only the head hash exposes it", () => {
    const store = mission();
    const anchoredHead = verifyFlightRecord(store.db, "m1").headHash;
    dropRecorderTriggers(store);
    // An attacker with file write access rewrites record 4 AND its operational row, re-hashing consistently.
    const forgedBody = JSON.stringify({ unitId: "u1", verified: false });
    store.db.prepare(`UPDATE coding_events SET body_json = ? WHERE name = 'work_unit.completed'`).run(forgedBody);
    const row = readFlightRecords(store.db, "m1").find((r) => r.seq === 4)!;
    const forged = { ...row, bodyJson: forgedBody };
    const { recordHash: _old, ...unhashed } = forged;
    store.db
      .prepare(`UPDATE mission_flight_records SET body_json = ?, record_hash = ? WHERE seq = 4`)
      .run(forgedBody, flightRecordHash(unhashed));
    const after = verifyFlightRecord(store.db, "m1");
    expect(after.verdict).toBe("verified");
    expect(after.headHash).not.toBe(anchoredHead);
  });
});

describe("flight recorder: redaction and atomicity", () => {
  it("never persists secrets in the record or the operational row", () => {
    const store = mission();
    store.recordMissionEvent(
      "m1",
      "tool.invoked",
      {
        tool: "git",
        token: "ghp_SUPERSECRETVALUE0000",
        nested: { password: "hunter2", note: "Authorization: Bearer abc.def.ghi-jkl" },
        header: "Bearer abcdefghijklmnop"
      },
      T0
    );
    const stored = JSON.stringify([
      store.db.prepare(`SELECT body_json FROM mission_flight_records`).all(),
      store.db.prepare(`SELECT body_json FROM coding_events`).all()
    ]);
    expect(stored).not.toMatch(/SUPERSECRET|hunter2|abc\.def|abcdefghijklmnop/);
    expect(stored).toContain("git");
    expect(verifyFlightRecord(store.db, "m1").verdict).toBe("verified");
  });

  it("redacts before hashing so a verifier never needs the secret", () => {
    const redacted = redactFlightBody({ apiKey: "sk-aaaaaaaaaaaaaaaaaaaaaaaaaaaa", ok: 1 });
    expect(redacted).not.toContain("sk-aaaa");
    expect(JSON.parse(redacted)).toMatchObject({ ok: 1 });
  });

  it("refuses to append outside a transaction", () => {
    const store = mission();
    expect(() =>
      appendFlightRecord(store.db, { missionId: "m1", eventId: null, kind: "x", bodyJson: "{}", createdAt: T0 })
    ).toThrow(/transaction/);
  });

  it("rolls back the operational event when the chained record cannot be written", () => {
    const store = mission();
    const before = store.db.prepare(`SELECT COUNT(*) AS n FROM coding_events`).get() as { n: number };
    store.db.exec(
      `CREATE TRIGGER fail_chain BEFORE INSERT ON mission_flight_records BEGIN SELECT RAISE(ABORT, 'disk'); END`
    );
    expect(() => store.recordMissionEvent("m1", "work_unit.failed", { unitId: "u1" }, T0)).toThrow(/disk/);
    const after = store.db.prepare(`SELECT COUNT(*) AS n FROM coding_events`).get() as { n: number };
    expect(after.n).toBe(before.n);
    store.db.exec("DROP TRIGGER fail_chain");
    expect(verifyFlightRecord(store.db, "m1").verdict).toBe("verified");
  });
});

describe("flight recorder: legacy rows", () => {
  it("reports events that predate the recorder as partial_legacy, not tampering", () => {
    const store = new CodingMissionStore(":memory:");
    store.db.exec("PRAGMA foreign_keys = OFF");
    store.db
      .prepare(
        `INSERT INTO coding_events (mission_id, name, body_json, created_at) VALUES ('old', 'legacy.event', '{}', ?)`
      )
      .run(T0);
    store.db.exec("DROP TRIGGER mission_flight_epoch_no_change");
    store.db.exec("UPDATE mission_flight_epoch SET last_legacy_event_id = (SELECT MAX(event_id) FROM coding_events)");
    expect(verifyFlightRecord(store.db, "old")).toMatchObject({ verdict: "partial_legacy", legacyEventCount: 1 });
  });
});

describe("flight recorder: mission replay", () => {
  it("reconstructs a mission's state history and unit outcomes from the chain and matches the live row", () => {
    const store = new CodingMissionStore(":memory:");
    store.createGeneral({ missionId: "m1", summary: "replay", initiatorId: "user-1", now: T0 });
    store.transition(store.require("m1"), "PLANNING", T0, { event: "mission.state_changed" });
    store.recordMissionEvent("m1", "work_unit.created", { unitId: "u1" }, T0);
    store.recordMissionEvent("m1", "work_unit.completed", { unitId: "u1" }, T0);
    const replay = readMissionFlightRecord(store.db, "m1");
    expect(replay.trustworthy).toBe(true);
    expect(replay.verification.verdict).toBe("verified");
    expect(replay.reconstruction.stateHistory.map((s) => s.to)).toEqual(["CREATED", "PLANNING"]);
    expect(replay.reconstruction.derivedState).toBe("PLANNING");
    expect(replay.reconstruction.consistentWithLive).toBe(true);
    expect(replay.reconstruction.units).toEqual({ u1: "completed" });
    expect(replay.trustAssumptions.length).toBeGreaterThan(0);
  });

  it("flags a live state that the chain cannot account for", () => {
    const store = new CodingMissionStore(":memory:");
    store.createGeneral({ missionId: "m1", summary: "replay", initiatorId: "user-1", now: T0 });
    store.db.exec(`UPDATE coding_missions SET state = 'COMPLETED' WHERE mission_id = 'm1'`);
    const replay = readMissionFlightRecord(store.db, "m1");
    expect(replay.reconstruction).toMatchObject({
      derivedState: "CREATED",
      liveState: "COMPLETED",
      consistentWithLive: false
    });
  });

  it("marks a tampered mission untrustworthy while still returning the records", () => {
    const store = mission();
    store.db.exec(`UPDATE coding_events SET body_json = '{}' WHERE name = 'work_unit.started'`);
    const replay = readMissionFlightRecord(store.db, "m1");
    expect(replay.trustworthy).toBe(false);
    expect(replay.records.length).toBeGreaterThan(0);
  });

  it("pages records but always verifies the whole chain", () => {
    const store = mission();
    const first = readMissionFlightRecord(store.db, "m1", { limit: 2 });
    expect(first.records.map((r) => r.seq)).toEqual([1, 2]);
    expect(first.nextAfterSeq).toBe(2);
    expect(first.verification.recordCount).toBe(4);
    const rest = readMissionFlightRecord(store.db, "m1", { afterSeq: 2, limit: 10 });
    expect(rest.records.map((r) => r.seq)).toEqual([3, 4]);
    expect(rest.nextAfterSeq).toBeUndefined();
  });
});

describe("flight recorder: review hardening", () => {
  it("verifies and replays one consistent snapshot while another connection commits", () => {
    const directory = mkdtempSync(join(tmpdir(), "acs-flight-snapshot-"));
    try {
      const dbPath = join(directory, "control.db");
      const reader = new CodingMissionStore(dbPath);
      reader.createGeneral({ missionId: "m1", summary: "snapshot", initiatorId: "user-1", now: T0 });
      reader.recordMissionEvent("m1", "work_unit.created", { unitId: "u1" }, T0);
      const writer = new CodingMissionStore(dbPath);
      // Commit a legitimate event (operational row and chained record together) in the middle of the reader's queries.
      const realPrepare = reader.db.prepare.bind(reader.db);
      let calls = 0;
      let injected = false;
      (reader.db as { prepare: unknown }).prepare = (sql: string) => {
        calls += 1;
        if (calls === 3 && !injected) {
          injected = true;
          writer.recordMissionEvent("m1", "work_unit.ready", { unitId: "u1" }, T0);
        }
        return realPrepare(sql);
      };
      const replay = readMissionFlightRecord(reader.db, "m1");
      expect(injected).toBe(true);
      expect(replay.verification.verdict).toBe("verified");
      expect(replay.records.length).toBe(replay.verification.recordCount);
      (reader.db as { prepare: unknown }).prepare = realPrepare;
      // The event committed during the read is visible to the next read.
      expect(readMissionFlightRecord(reader.db, "m1").verification.recordCount).toBe(
        replay.verification.recordCount + 1
      );
      writer.close();
      reader.close();
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });

  it("detects a changed evidence kind or timestamp, not only a changed payload", () => {
    const store = mission();
    store.db.exec(`UPDATE coding_evidence SET kind = 'other' WHERE kind = 'validation'`);
    expect(verifyFlightRecord(store.db, "m1").findings.map((f) => f.kind)).toContain("evidence_modified");
    store.db.exec(`UPDATE coding_evidence SET kind = 'validation', created_at = '2030-01-01T00:00:00.000Z'`);
    expect(verifyFlightRecord(store.db, "m1").findings.map((f) => f.kind)).toContain("evidence_modified");
    store.db.exec(`UPDATE coding_evidence SET created_at = '${T0}'`);
    expect(verifyFlightRecord(store.db, "m1").verdict).toBe("verified");
  });

  it("pages and reconstructs past 5,000 records", () => {
    const store = new CodingMissionStore(":memory:");
    store.createGeneral({ missionId: "m1", summary: "big", initiatorId: "user-1", now: T0 });
    store.transaction(() => {
      for (let i = 0; i < 5100; i += 1) store.recordMissionEvent("m1", "work_unit.created", { unitId: `u${i}` }, T0);
    });
    store.transition(store.require("m1"), "PLANNING", T0, { event: "mission.state_changed" });
    const total = 5100 + 1 + 1;
    const late = readMissionFlightRecord(store.db, "m1", { afterSeq: 5000, limit: 1000 });
    expect(late.verification).toMatchObject({ verdict: "verified", recordCount: total });
    expect(late.records[0]!.seq).toBe(5001);
    expect(late.records.length).toBe(Math.min(1000, total - 5000));
    expect(late.nextAfterSeq).toBeUndefined();
    // Reconstruction sees the transition recorded after the 5,000th record.
    expect(late.reconstruction).toMatchObject({
      derivedState: "PLANNING",
      liveState: "PLANNING",
      consistentWithLive: true
    });
    expect(Object.keys(late.reconstruction.units)).toHaveLength(5100);
    const middle = readMissionFlightRecord(store.db, "m1", { afterSeq: 4500, limit: 400 });
    expect(middle.nextAfterSeq).toBe(4900);
  });

  it("refuses INSERT OR REPLACE of a chained record and of the epoch, and deletion of the epoch", () => {
    const store = mission();
    const row = store.db.prepare(`SELECT * FROM mission_flight_records WHERE seq = 2`).get() as Record<
      string,
      string | number
    >;
    expect(() =>
      store.db
        .prepare(
          `INSERT OR REPLACE INTO mission_flight_records
             (mission_id, seq, event_id, kind, body_json, created_at, previous_hash, record_hash)
           VALUES (?, ?, ?, 'forged', '{}', ?, ?, ?)`
        )
        .run(row.mission_id, row.seq, row.event_id, row.created_at, row.previous_hash, "f".repeat(64))
    ).toThrow(/append-only/);
    // A different seq that reuses an already-chained event is refused too.
    expect(() =>
      store.db
        .prepare(
          `INSERT OR REPLACE INTO mission_flight_records
             (mission_id, seq, event_id, kind, body_json, created_at, previous_hash, record_hash)
           VALUES ('m1', 99, ?, 'forged', '{}', ?, '', ?)`
        )
        .run(row.event_id, row.created_at, "f".repeat(64))
    ).toThrow(/append-only/);
    expect(() =>
      store.db.exec(
        `INSERT OR REPLACE INTO mission_flight_epoch (singleton, last_legacy_event_id, last_legacy_evidence_rowid) VALUES (1, 999999, 999999)`
      )
    ).toThrow(/write-once/);
    expect(() => store.db.exec(`DELETE FROM mission_flight_epoch`)).toThrow(/write-once/);
    expect(verifyFlightRecord(store.db, "m1").verdict).toBe("verified");
  });

  it("reflects claims, verification, cancellation and retryable failures in the replay", () => {
    const store = new CodingMissionStore(":memory:");
    store.createGeneral({ missionId: "m1", summary: "life", initiatorId: "user-1", now: T0 });
    const ev = (name: string, body: Record<string, unknown>) => store.recordMissionEvent("m1", name, body, T0);
    ev("work_unit.created", { unitId: "claimed" });
    ev("work_unit.claimed", { unitId: "claimed", workerId: "w", attempt: 1 });
    ev("work_unit.created", { unitId: "verifying" });
    ev("verification.started", { unitId: "verifying" });
    ev("work_unit.created", { unitId: "cancelled" });
    ev("work_unit.cancelled", { unitId: "cancelled", was: "ready" });
    ev("work_unit.created", { unitId: "retryable" });
    ev("work_unit.failed", { unitId: "retryable", category: "tool_error", next: "retryable" });
    ev("work_unit.created", { unitId: "failed" });
    ev("work_unit.failed", { unitId: "failed", category: "policy", next: "failed" });
    expect(readMissionFlightRecord(store.db, "m1").reconstruction.units).toEqual({
      claimed: "claimed",
      verifying: "verifying",
      cancelled: "cancelled",
      retryable: "retryable",
      failed: "failed"
    });
  });
});

describe("flight recorder: second review hardening", () => {
  it("rejects a correctly hashed record that has no source row and is not an evidence binding", () => {
    const store = mission();
    store.transaction(() => {
      appendFlightRecord(store.db, {
        missionId: "m1",
        eventId: null,
        kind: "mission.state_changed",
        bodyJson: JSON.stringify({ from: "RUNNING", to: "COMPLETED" }),
        createdAt: T0
      });
    });
    const result = verifyFlightRecord(store.db, "m1");
    expect(result.verdict).toBe("tampered");
    expect(result.findings.map((f) => f.kind)).toContain("unlinked_record");
    expect(readMissionFlightRecord(store.db, "m1").trustworthy).toBe(false);
  });

  it("rejects a second record binding the same evidence", () => {
    const store = mission();
    const existing = readFlightRecords(store.db, "m1").find((r) => r.kind === "evidence.recorded")!;
    store.transaction(() => {
      appendFlightRecord(store.db, {
        missionId: "m1",
        eventId: null,
        kind: "evidence.recorded",
        bodyJson: existing.bodyJson,
        createdAt: T0
      });
    });
    expect(verifyFlightRecord(store.db, "m1").findings.map((f) => f.kind)).toContain("unlinked_record");
  });

  it("records every durable status transition: released claims, marked units", () => {
    const store = new CodingMissionStore(":memory:");
    store.createGeneral({ missionId: "m1", summary: "life", initiatorId: "user-1", now: T0 });
    store.addWorkUnits(
      "m1",
      [
        { unitId: "a", kind: "coding", title: "a" },
        { unitId: "b", kind: "coding", title: "b" },
        { unitId: "c", kind: "coding", title: "c" }
      ],
      T0
    );
    const claim = (n: number) => ({ token: `tok-${n}`, workerId: "w", route: {}, claimedAt: T0 });
    store.claimUnit("m1", "a", claim(1));
    store.claimUnit("m1", "b", claim(2));
    store.claimUnit("m1", "c", claim(3));
    store.markOperation("m1", "a", "unknown");
    store.markOperation("m1", "b", "conflict");
    store.markOperation("m1", "c", "failed");
    // Marking a unit that is no longer running changes nothing and records nothing.
    store.markOperation("m1", "a", "failed");
    expect(readMissionFlightRecord(store.db, "m1").reconstruction.units).toMatchObject({
      a: "unknown",
      b: "conflict",
      c: "failed"
    });
    expect(store.events("m1").filter((e) => e.name === "work_unit.marked")).toHaveLength(3);

    store.addWorkUnits("m1", [{ unitId: "d", kind: "coding", title: "d" }], T0);
    store.claimUnit("m1", "d", claim(4));
    store.resetClaim("m1", "d");
    const replay = readMissionFlightRecord(store.db, "m1");
    expect(replay.reconstruction.units.d).toBe("pending");
    expect(replay.verification.verdict).toBe("verified");
  });

  it("verifies evidence whose payload has non-plain JSON behavior", () => {
    const store = mission();
    store.putEvidence(
      "m1",
      "observed",
      { at: new Date(T0), skipped: undefined, n: 1, nested: { toJSON: () => "x" } },
      T0
    );
    const result = verifyFlightRecord(store.db, "m1");
    expect(result.findings).toEqual([]);
    expect(result.verdict).toBe("verified");
  });

  it("reports legacy evidence separately from legacy events", () => {
    const store = new CodingMissionStore(":memory:");
    store.createGeneral({ missionId: "old", summary: "s", initiatorId: "user-1", now: T0 });
    store.db
      .prepare(
        `INSERT INTO coding_evidence (mission_id, evidence_id, kind, payload_hash, payload_json, created_at)
         VALUES ('old', 'legacy:1', 'legacy', ?, '{}', ?)`
      )
      .run(stableHash({}), T0);
    store.db.exec("DROP TRIGGER mission_flight_epoch_no_change");
    store.db.exec(
      "UPDATE mission_flight_epoch SET last_legacy_evidence_rowid = (SELECT MAX(rowid) FROM coding_evidence)"
    );
    expect(verifyFlightRecord(store.db, "old")).toMatchObject({
      verdict: "partial_legacy",
      legacyEventCount: 0,
      legacyEvidenceCount: 1,
      findings: []
    });
  });
});
