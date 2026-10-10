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
