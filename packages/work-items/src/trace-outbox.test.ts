import { createHash } from "node:crypto";
import { spawn, spawnSync } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it, vi } from "vitest";
import { SqliteWorkItemStore, type TraceEnqueueFailure } from "./store.js";
import {
  TRACE_CHAIN_PRODUCER_KEY,
  normalizeTraceActorId,
  relayTraceOutbox,
  resolveTraceProducerConfig,
  utcSpoolDay
} from "./trace-outbox.js";

// sha256 of the source-first LoopTrace capability-evidence trace-event/1 schema
const SCHEMA_PIN = "8b694731594466f5a83d6132df84a07421a472a1d618e34bf74259c9444051a0";
const dirs: string[] = [];

// The end-to-end replay test drives the real LoopTrace CLI, which lives in a
// separate checkout. Point LOOPTRACE_CLI at it, or rely on the sibling
// `looptrace-trace-spine` checkout; the test skips (like the other external-CLI
// interoperability tests in this repo) when neither is present rather than
// failing on a missing external repo.
const LOOPTRACE_CLI =
  process.env.LOOPTRACE_CLI ??
  join(fileURLToPath(new URL(".", import.meta.url)), "../../../../looptrace-trace-spine/packages/cli/src/main.mjs");
const HAS_LOOPTRACE_CLI = existsSync(LOOPTRACE_CLI);

function tempDir(): string {
  const dir = mkdtempSync(join(tmpdir(), "acs-trace-"));
  dirs.push(dir);
  return dir;
}

function workItem(store: SqliteWorkItemStore) {
  return store.create({
    title: "Trace approval",
    requester: "user",
    intent: "record an approval",
    requestedActions: [{ kind: "edit", description: "write", params: { write: true } }],
    risk: "low"
  });
}

afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

describe("trace outbox", () => {
  it("pins the vendored trace-event schema to the LoopTrace publication hash", () => {
    const text = readFileSync(new URL("../contracts/trace-event.v1.schema.json", import.meta.url));
    expect(createHash("sha256").update(text).digest("hex")).toBe(SCHEMA_PIN);
  });

  it("a failed outbox write does not deny the approval; only the trace rows roll back (ADR 0021)", () => {
    const dir = tempDir();
    const dbPath = join(dir, "control.db");
    const store = new SqliteWorkItemStore(dbPath, { traceInstance: "acs-test", releaseSha: "unreleased" });
    const item = workItem(store);
    store.close();
    const side = new DatabaseSync(dbPath);
    side.exec(
      `CREATE TRIGGER trace_outbox_boom BEFORE INSERT ON trace_outbox
       BEGIN SELECT RAISE(ABORT, 'forced outbox failure'); END`
    );
    side.close();
    const failures: TraceEnqueueFailure[] = [];
    const failing = new SqliteWorkItemStore(dbPath, {
      traceInstance: "acs-test",
      releaseSha: "unreleased",
      onTraceFailure: (failure) => failures.push(failure)
    });
    try {
      const grant = failing.recordApproval({
        workItemId: item.id,
        actionHash: "hash_test",
        approvedBy: "user",
        reason: "exact"
      });
      expect(grant.requestHash).toMatch(/\S/);
      failing.consumeApproval(item.id, "hash_test", { requestHash: grant.requestHash });
      expect(failing.getTraceEnqueueFailureCount()).toBe(2);
    } finally {
      failing.close();
    }
    expect(failures.map((failure) => failure.kind)).toEqual(["acs.approval.granted", "acs.approval.consumed"]);
    expect(failures.every((failure) => failure.workItemId === item.id)).toBe(true);
    expect(failures[0]?.message).toMatch(/forced outbox failure/);
    const check = new DatabaseSync(dbPath);
    try {
      const approvals = check.prepare(`SELECT status FROM approval_records`).all() as Array<{ status: string }>;
      const outbox = check.prepare(`SELECT count(*) AS n FROM trace_outbox`).get() as { n: number };
      const missions = check.prepare(`SELECT count(*) AS n FROM trace_missions`).get() as { n: number };
      const chain = check.prepare(`SELECT count(*) AS n FROM trace_chain_state`).get() as { n: number };
      const audit = check
        .prepare(`SELECT count(*) AS n FROM audit_events WHERE name IN ('approval.granted', 'approval.consumed')`)
        .get() as { n: number };
      expect(approvals).toEqual([{ status: "consumed" }]);
      expect(audit.n).toBe(2);
      // The approval savepoint unwinds only the failed approval trace writes.
      // The earlier run.received lifecycle fact remains intact.
      expect(outbox.n).toBe(1);
      expect(missions.n).toBe(1);
      expect(chain.n).toBe(1);
    } finally {
      check.close();
    }
  });

  it("a failing trace-failure reporter still cannot deny the approval", () => {
    const dir = tempDir();
    const dbPath = join(dir, "control.db");
    const seed = new SqliteWorkItemStore(dbPath, { traceInstance: "acs-test", releaseSha: "unreleased" });
    const item = workItem(seed);
    seed.close();
    const side = new DatabaseSync(dbPath);
    side.exec(
      `CREATE TRIGGER trace_outbox_boom BEFORE INSERT ON trace_outbox
       BEGIN SELECT RAISE(ABORT, 'forced outbox failure'); END`
    );
    side.close();
    const store = new SqliteWorkItemStore(dbPath, {
      traceInstance: "acs-test",
      releaseSha: "unreleased",
      onTraceFailure: () => {
        throw new Error("reporter exploded");
      }
    });
    try {
      expect(() =>
        store.recordApproval({ workItemId: item.id, actionHash: "hash_test", approvedBy: "user" })
      ).not.toThrow();
      expect(store.getTraceEnqueueFailureCount()).toBe(1);
    } finally {
      store.close();
    }
  });

  it.each(["jace@example.com", "auth0|123"])(
    "records an approval from %s and traces it under a normalised actor id",
    (approvedBy) => {
      const dir = tempDir();
      const dbPath = join(dir, "control.db");
      const failures: TraceEnqueueFailure[] = [];
      const store = new SqliteWorkItemStore(dbPath, {
        traceInstance: "acs-test",
        releaseSha: "unreleased",
        onTraceFailure: (failure) => failures.push(failure)
      });
      let itemId: string;
      try {
        const item = workItem(store);
        itemId = item.id;
        const grant = store.recordApproval({ workItemId: item.id, actionHash: "hash_test", approvedBy });
        expect(grant.requestHash).toMatch(/\S/);
        expect(store.getTraceEnqueueFailureCount()).toBe(0);
      } finally {
        store.close();
      }
      expect(failures).toEqual([]);
      const expected = `h:${createHash("sha256").update(approvedBy).digest("hex").slice(0, 32)}`;
      expect(normalizeTraceActorId(approvedBy)).toBe(expected);
      const check = new DatabaseSync(dbPath);
      try {
        const approval = check.prepare(`SELECT approved_by FROM approval_records`).get() as { approved_by: string };
        // The canonical approval record keeps the raw approver; only the trace is normalised.
        expect(approval.approved_by).toBe(approvedBy);
        const row = check
          .prepare(
            `SELECT work_item_id, canonical_json FROM trace_outbox WHERE json_extract(canonical_json, '$.kind') = 'acs.approval.granted'`
          )
          .get() as { work_item_id: string; canonical_json: string };
        expect(row.work_item_id).toBe(itemId);
        const event = JSON.parse(row.canonical_json) as { actor: { id: string; type: string }; kind: string };
        expect(event.kind).toBe("acs.approval.granted");
        expect(event.actor).toEqual({ id: expected, type: "human" });
        expect(row.canonical_json).not.toContain(approvedBy);
      } finally {
        check.close();
      }
    }
  );

  it("passes trace-grammar actor ids through unchanged and hashes deterministically", () => {
    expect(normalizeTraceActorId("user")).toBe("user");
    expect(normalizeTraceActorId("worker:local-1")).toBe("worker:local-1");
    expect(normalizeTraceActorId("jace@example.com")).toBe(normalizeTraceActorId("jace@example.com"));
    expect(normalizeTraceActorId("jace@example.com")).toMatch(/^h:[a-f0-9]{32}$/);
    expect(normalizeTraceActorId("")).toMatch(/^h:[a-f0-9]{32}$/);
  });

  it("reserves the h: prefix: a raw id starting with h: is hashed, so it cannot collide with a hashed id", () => {
    const hashed = normalizeTraceActorId("jace@example.com");
    expect(hashed).toMatch(/^h:[a-f0-9]{32}$/);
    // Presenting the hashed form as a raw id does not pass through as that identity.
    expect(normalizeTraceActorId(hashed)).not.toBe(hashed);
    expect(normalizeTraceActorId(hashed)).toMatch(/^h:[a-f0-9]{32}$/);
    expect(normalizeTraceActorId("h:operator")).toBe(
      `h:${createHash("sha256").update("h:operator").digest("hex").slice(0, 32)}`
    );
    // Other grammar-valid ids, including ones merely containing "h:", pass through.
    expect(normalizeTraceActorId("ch:operator")).toBe("ch:operator");
    expect(normalizeTraceActorId("H:operator")).toBe("H:operator");
  });

  it.each([
    [{ releaseSha: "1c8dc83" }, /ACS_RELEASE_SHA/],
    [{ releaseSha: "1C8DC8334972680EE4520F416922AE58D78CBAB8" }, /ACS_RELEASE_SHA/],
    [{ traceInstance: "acs prod" }, /ACS_TRACE_INSTANCE/],
    [{ traceInstance: "" }, /ACS_TRACE_INSTANCE/]
  ])("eager validation (opt-in, used by the gateway) refuses to open with %o", (options, message) => {
    const dir = tempDir();
    const dbPath = join(dir, "control.db");
    let thrown: unknown;
    try {
      new SqliteWorkItemStore(dbPath, {
        traceInstance: "acs-test",
        releaseSha: "unreleased",
        traceConfigValidation: "eager",
        ...options
      }).close();
    } catch (error) {
      thrown = error;
    }
    expect(thrown).toBeInstanceOf(Error);
    expect((thrown as { code?: string }).code).toBe("trace_config_invalid");
    expect((thrown as Error).message).toMatch(message);
    // Refused before opening the database.
    expect(existsSync(dbPath)).toBe(false);
  });

  describe("lazy validation (default): a bad trace env never stops ordinary store use", () => {
    afterEach(() => {
      vi.unstubAllEnvs();
    });

    it.each([
      ["ACS_RELEASE_SHA", "1c8dc83"],
      ["ACS_TRACE_INSTANCE", "acs prod"]
    ])("opens and serves basic operations with %s=%j", (name, value) => {
      vi.stubEnv(name, value);
      const dbPath = join(tempDir(), "control.db");
      const store = new SqliteWorkItemStore(dbPath);
      try {
        const item = workItem(store);
        expect(store.get(item.id)?.title).toBe("Trace approval");
        expect(store.list().map((entry) => entry.id)).toContain(item.id);
        expect(store.readEvents().map((event) => event.name)).toContain("work_item.created");
        expect(store.getTraceEnqueueFailureCount()).toBe(1);
      } finally {
        store.close();
      }
    });

    it.each([
      ["ACS_RELEASE_SHA", "1c8dc83"],
      ["ACS_TRACE_INSTANCE", "acs prod"]
    ])("an approval with %s=%j still commits; the skipped trace is counted and reported", (name, value) => {
      vi.stubEnv(name, value);
      const dbPath = join(tempDir(), "control.db");
      const failures: TraceEnqueueFailure[] = [];
      const store = new SqliteWorkItemStore(dbPath, { onTraceFailure: (failure) => failures.push(failure) });
      try {
        const item = workItem(store);
        const grant = store.recordApproval({ workItemId: item.id, actionHash: "hash_test", approvedBy: "user" });
        store.consumeApproval(item.id, "hash_test", { requestHash: grant.requestHash });
        expect(store.getTraceEnqueueFailureCount()).toBe(3);
      } finally {
        store.close();
      }
      expect(failures.map((failure) => [failure.kind, failure.code])).toEqual([
        ["run.received", "trace_config_invalid"],
        ["acs.approval.granted", "trace_config_invalid"],
        ["acs.approval.consumed", "trace_config_invalid"]
      ]);
      expect(failures[0]?.message).toContain(name);
      const check = new DatabaseSync(dbPath);
      try {
        expect(check.prepare(`SELECT status FROM approval_records`).all()).toEqual([{ status: "consumed" }]);
        expect((check.prepare(`SELECT count(*) AS n FROM trace_outbox`).get() as { n: number }).n).toBe(0);
        expect((check.prepare(`SELECT count(*) AS n FROM trace_missions`).get() as { n: number }).n).toBe(0);
      } finally {
        check.close();
      }
    });

    it("the default reporter logs one JSON warning line to stderr per skipped trace", () => {
      vi.stubEnv("ACS_RELEASE_SHA", "1c8dc83");
      const writes: string[] = [];
      const spy = vi.spyOn(process.stderr, "write").mockImplementation((chunk: string | Uint8Array) => {
        writes.push(String(chunk));
        return true;
      });
      const store = new SqliteWorkItemStore(join(tempDir(), "control.db"));
      try {
        const item = workItem(store);
        store.recordApproval({ workItemId: item.id, actionHash: "hash_test", approvedBy: "user" });
      } finally {
        store.close();
        spy.mockRestore();
      }
      const lines = writes.filter((line) => line.includes("trace_outbox_enqueue_failed"));
      expect(lines).toHaveLength(2);
      expect(lines.map((line) => JSON.parse(line).kind)).toEqual(["run.received", "acs.approval.granted"]);
      expect(JSON.parse(lines[1]!)).toMatchObject({
        level: "warn",
        event: "trace_outbox_enqueue_failed",
        kind: "acs.approval.granted",
        code: "trace_config_invalid"
      });
    });
  });

  it("validates ACS_TRACE_INSTANCE / ACS_RELEASE_SHA from the environment", () => {
    expect(resolveTraceProducerConfig({}, { ACS_TRACE_INSTANCE: "acs-prod", ACS_RELEASE_SHA: "a".repeat(40) })).toEqual(
      {
        instance: "acs-prod",
        releaseSha: "a".repeat(40)
      }
    );
    expect(() => resolveTraceProducerConfig({}, { ACS_RELEASE_SHA: "1c8dc83" })).toThrow(/ACS_RELEASE_SHA/);
    expect(() => resolveTraceProducerConfig({}, { ACS_TRACE_INSTANCE: "acs prod" })).toThrow(/ACS_TRACE_INSTANCE/);
    expect(resolveTraceProducerConfig({}, {}).releaseSha).toBe("unreleased");
  });

  it("writes an outbox row for every approval_records grant and consume", () => {
    const dir = tempDir();
    const dbPath = join(dir, "control.db");
    const store = new SqliteWorkItemStore(dbPath, { traceInstance: "acs-test", releaseSha: "unreleased" });
    try {
      const item = workItem(store);
      const grant = store.recordApproval({
        workItemId: item.id,
        actionHash: "hash_test",
        approvedBy: "user",
        reason: "exact action"
      });
      store.consumeApproval(item.id, "hash_test", { requestHash: grant.requestHash });
    } finally {
      store.close();
    }
    const check = new DatabaseSync(dbPath);
    try {
      const orphans = check
        .prepare(
          `SELECT count(*) AS n FROM approval_records AS approval
           WHERE NOT EXISTS (
             SELECT 1 FROM trace_outbox
             WHERE work_item_id = approval.work_item_id
               AND json_extract(canonical_json, '$.kind') = 'acs.approval.granted'
           )`
        )
        .get() as { n: number };
      const consumed = check
        .prepare(
          `SELECT count(*) AS n FROM approval_records AS approval
           WHERE approval.status = 'consumed'
             AND NOT EXISTS (
               SELECT 1 FROM trace_outbox
               WHERE work_item_id = approval.work_item_id
                 AND json_extract(canonical_json, '$.kind') = 'acs.approval.consumed'
             )`
        )
        .get() as { n: number };
      expect(orphans.n).toBe(0);
      expect(consumed.n).toBe(0);
      expect((check.prepare(`SELECT count(*) AS n FROM trace_outbox`).get() as { n: number }).n).toBe(4);
      expect(
        (
          check
            .prepare(
              `SELECT count(*) AS n FROM trace_outbox WHERE json_extract(canonical_json, '$.kind') = 'approval.decided'`
            )
            .get() as { n: number }
        ).n
      ).toBe(1);
    } finally {
      check.close();
    }
  });

  it.skipIf(!HAS_LOOPTRACE_CLI)("replays a crash between spool fsync and the shipped mark as one stored event", () => {
    const dir = tempDir();
    const dbPath = join(dir, "control.db");
    const spool = join(dir, "spool");
    const store = new SqliteWorkItemStore(dbPath, { traceInstance: "acs-test", releaseSha: "unreleased" });
    const item = workItem(store);
    store.recordApproval({ workItemId: item.id, actionHash: "hash_test", approvedBy: "user" });
    store.close();
    expect(relayTraceOutbox(dbPath, spool, { markShipped: false }).shipped).toBe(0);
    const midway = new DatabaseSync(dbPath);
    expect(
      (midway.prepare(`SELECT count(*) AS n FROM trace_outbox WHERE shipped_at IS NULL`).get() as { n: number }).n
    ).toBe(3);
    midway.close();
    expect(relayTraceOutbox(dbPath, spool).shipped).toBe(3);
    const cli = LOOPTRACE_CLI;
    const storeDir = join(dir, "looptrace");
    const ingested = spawnSync(process.execPath, [cli, "ingest", "--once", "--spool", spool, "--store", storeDir], {
      encoding: "utf8"
    });
    expect(ingested.status, ingested.stderr).toBe(0);
    const traced = spawnSync(process.execPath, [cli, "trace", item.id, "--store", storeDir], { encoding: "utf8" });
    expect(traced.status, traced.stderr).toBe(0);
    expect(traced.stdout).toContain("acs.approval.granted");
    expect(traced.stdout).toContain(item.id);
    const again = spawnSync(process.execPath, [cli, "ingest", "--once", "--spool", spool, "--store", storeDir], {
      encoding: "utf8"
    });
    expect(again.stdout).toContain("accepted=0");
    expect(again.stdout).toContain("deduped=");
  });

  it("names spool files from the UTC timestamp and fsyncs before marking shipped", () => {
    expect(utcSpoolDay("2026-01-01T02:00:00.000Z")).toBe("2026-01-01");
    const dir = tempDir();
    const dbPath = join(dir, "control.db");
    const spool = join(dir, "spool");
    const store = new SqliteWorkItemStore(dbPath, { traceInstance: "acs-test", releaseSha: "unreleased" });
    const item = workItem(store);
    store.close();
    const db = new DatabaseSync(dbPath);
    db.exec("DELETE FROM trace_outbox; DELETE FROM trace_missions; DELETE FROM trace_chain_state;");
    const canonical = JSON.stringify({
      ts: "2026-01-01T02:00:00.000Z",
      source: { system: "acs" }
    });
    db.prepare(
      `INSERT INTO trace_outbox (event_id, work_item_id, seq, canonical_json, created_at)
       VALUES ('01ARZ3NDEKTSV4RRFFQ69G5FAV', ?, 1, ?, '2026-01-01T02:00:00.000Z')`
    ).run(item.id, canonical);
    db.close();
    expect(relayTraceOutbox(dbPath, spool).shipped).toBe(1);
    expect(existsSync(join(spool, "acs", "2026-01-01.ndjson"))).toBe(true);
    expect(existsSync(join(spool, "acs", "2025-12-31.ndjson"))).toBe(false);
    const shipped = new DatabaseSync(dbPath);
    try {
      expect(
        (shipped.prepare(`SELECT count(*) AS n FROM trace_outbox WHERE shipped_at IS NULL`).get() as { n: number }).n
      ).toBe(0);
    } finally {
      shipped.close();
    }
  });

  it("keeps one database chain and one trace id when two processes approve the same work item", async () => {
    const dir = tempDir();
    const dbPath = join(dir, "control.db");
    const store = new SqliteWorkItemStore(dbPath, { traceInstance: "acs-parent", releaseSha: "unreleased" });
    const item = workItem(store);
    store.close();
    const tsx = fileURLToPath(new URL("../../../node_modules/tsx/dist/cli.mjs", import.meta.url));
    const child = fileURLToPath(new URL("./trace-race-child.ts", import.meta.url));
    const run = (actionHash: string, instance: string) =>
      new Promise<void>((resolve, reject) => {
        const proc = spawn(process.execPath, [tsx, child, dbPath, item.id, actionHash, instance]);
        let stderr = "";
        proc.stderr.on("data", (chunk: Buffer) => {
          stderr += chunk.toString();
        });
        proc.on("exit", (code) => {
          if (code === 0) resolve();
          else reject(new Error(stderr || `child exited ${code}`));
        });
      });
    await Promise.all([run("hash_a", "acs-a"), run("hash_b", "acs-b")]);
    const check = new DatabaseSync(dbPath);
    try {
      const missions = check
        .prepare(`SELECT trace_id FROM trace_missions WHERE work_item_id = ?`)
        .all(item.id) as Array<{
        trace_id: string;
      }>;
      expect(missions).toHaveLength(1);
      const rows = check
        .prepare(`SELECT seq, canonical_json FROM trace_outbox WHERE work_item_id = ? ORDER BY seq`)
        .all(item.id) as Array<{ seq: number; canonical_json: string }>;
      expect(rows.map((row) => row.seq)).toEqual([1, 2, 3, 4, 5]);
      const parsed = rows.map(
        (row) =>
          JSON.parse(row.canonical_json) as {
            trace_id: string;
            prev_hash: string;
            kind: string;
            source: { instance: string };
          }
      );
      expect(new Set(parsed.map((event) => event.trace_id))).toEqual(new Set([missions[0].trace_id]));
      expect(parsed.map((event) => event.kind)).toEqual([
        "run.received",
        expect.stringMatching(/^(?:acs\.approval\.granted|approval\.decided)$/),
        expect.stringMatching(/^(?:acs\.approval\.granted|approval\.decided)$/),
        expect.stringMatching(/^(?:acs\.approval\.granted|approval\.decided)$/),
        expect.stringMatching(/^(?:acs\.approval\.granted|approval\.decided)$/)
      ]);
      for (let index = 1; index < rows.length; index += 1) {
        expect(parsed[index]?.prev_hash).toBe(
          createHash("sha256")
            .update(rows[index - 1].canonical_json)
            .digest("hex")
        );
      }
      expect(new Set(parsed.slice(1).map((event) => event.source.instance))).toEqual(new Set(["acs-a", "acs-b"]));
      const chains = check.prepare(`SELECT producer_key, seq FROM trace_chain_state`).all() as Array<{
        producer_key: string;
        seq: number;
      }>;
      expect(chains).toEqual([{ producer_key: TRACE_CHAIN_PRODUCER_KEY, seq: 5 }]);
      const reader = new SqliteWorkItemStore(dbPath, { traceInstance: "observer", releaseSha: "unreleased" });
      try {
        const producers = reader
          .getMissionTrace(item.id)
          .events.filter((entry) => entry.event.name === "approval.granted")
          .map((entry) => entry.producer);
        expect(new Set(producers.map((entry) => entry["acs.process.id"])).size).toBe(2);
        expect(new Set(producers.map((entry) => entry["acs.instance"]))).toEqual(new Set(["acs-a", "acs-b"]));
      } finally {
        reader.close();
      }
    } finally {
      check.close();
    }
  });

  it("leaves rows unshipped when the spool directory is not writable", () => {
    if (typeof process.getuid === "function" && process.getuid() === 0) return;
    const dir = tempDir();
    const dbPath = join(dir, "control.db");
    const spool = join(dir, "spool");
    const store = new SqliteWorkItemStore(dbPath, { traceInstance: "acs-test", releaseSha: "unreleased" });
    const item = workItem(store);
    store.recordApproval({ workItemId: item.id, actionHash: "hash_test", approvedBy: "user" });
    store.close();
    mkdirSync(spool);
    chmodSync(spool, 0o500);
    try {
      expect(() => relayTraceOutbox(dbPath, spool)).toThrow();
    } finally {
      chmodSync(spool, 0o700);
    }
    const check = new DatabaseSync(dbPath);
    try {
      expect(
        (check.prepare(`SELECT count(*) AS n FROM trace_outbox WHERE shipped_at IS NULL`).get() as { n: number }).n
      ).toBe(3);
    } finally {
      check.close();
    }
  });
});
