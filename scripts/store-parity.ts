#!/usr/bin/env -S npx tsx
/**
 * Parity check for the read-only Rust store readers (rust/acs-core, bin acs-store-dump), Phase 1:
 * work items (P1.1, TypeScript `get(id)`) and execution attempts (P1.2, TypeScript `getAttempt(id)`).
 *
 * For each database (copies only; the originals are never opened for writing):
 *   1. opens it once with the TypeScript store (which applies migrations to the copy), then closes it;
 *   2. runs the Rust dump over the copy, read-only;
 *   3. reads every work item with the TypeScript store's `get(id)`;
 *   4. requires, per id, that both sides agree: the same JSON text (key order included; numbers compared after
 *      JSON.parse), or both reject the row.
 *
 * Databases: every path given with --db (e.g. a production copy), plus a generated adversarial fixture that covers
 * the normalization rules (unknown keys, defaults, omitted falsy fields, strict metadata, enum and length limits).
 *
 * Usage: npx tsx scripts/store-parity.ts [--bin <path>] [--db <path>]... [--keep]
 * Exit 0: every row agreed. Exit 1: any disagreement.
 */
import { spawnSync } from "node:child_process";
import { copyFileSync, existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { fileURLToPath } from "node:url";
import { applyControlPlaneMigrations } from "@agent-control-stack/shared";
import { SqliteWorkItemStore, defaultExecutionPlanForWorkItem } from "@agent-control-stack/work-items";

const root = resolve(fileURLToPath(new URL("..", import.meta.url)));
const args = process.argv.slice(2);
const bin = valueOf("--bin") ?? join(root, "rust/acs-core/target/release/acs-store-dump");
const keep = args.includes("--keep");
const databases = args.flatMap((arg, index) => (arg === "--db" ? [args[index + 1]!] : []));

function valueOf(flag: string): string | undefined {
  const index = args.indexOf(flag);
  return index >= 0 ? args[index + 1] : undefined;
}

type Side = { text: string } | { error: string };

type Kind = "work-items" | "attempts";

const KINDS: Record<Kind, { table: string; idColumn: string; read: (store: SqliteWorkItemStore, id: string) => unknown }> = {
  "work-items": { table: "work_items", idColumn: "id", read: (store, id) => store.get(id) },
  attempts: { table: "execution_attempts", idColumn: "attempt_id", read: (store, id) => store.getAttempt(id) }
};

function typescriptSide(store: SqliteWorkItemStore, kind: Kind, id: string): Side {
  try {
    const item = KINDS[kind].read(store, id);
    return item ? { text: JSON.stringify(item) } : { error: "missing" };
  } catch {
    return { error: "invalid" };
  }
}

function rustSides(kind: Kind, path: string): Map<string, Side> {
  const run = spawnSync(bin, [kind, path], { encoding: "utf8", maxBuffer: 1 << 30 });
  if (run.status !== 0) throw new Error(`rust dump failed (${run.status}): ${run.stderr.slice(0, 200)}`);
  const sides = new Map<string, Side>();
  for (const line of run.stdout.split("\n").filter(Boolean)) {
    const record = JSON.parse(line) as { id: string; item?: unknown; error?: string };
    sides.set(record.id, record.item === undefined ? { error: record.error ?? "?" } : { text: JSON.stringify(record.item) });
  }
  return sides;
}

function compare(label: string, path: string): number {
  const opened = new SqliteWorkItemStore(path, { auditShadowVerifier: null });
  opened.close();
  let failures = 0;
  for (const kind of Object.keys(KINDS) as Kind[]) failures += compareKind(label, kind, path);
  return failures;
}

function compareKind(label: string, kind: Kind, path: string): number {
  const rust = rustSides(kind, path);
  const store = new SqliteWorkItemStore(path, { auditShadowVerifier: null });
  const db = new DatabaseSync(path, { readOnly: true });
  const { table, idColumn } = KINDS[kind];
  const ids = (db.prepare(`SELECT ${idColumn} AS id FROM ${table} ORDER BY ${idColumn} ASC`).all() as Array<{ id: string }>).map(
    (r) => r.id
  );
  db.close();
  let failures = 0;
  let items = 0;
  let rejected = 0;
  for (const id of ids) {
    const ts = typescriptSide(store, kind, id);
    const rs = rust.get(id) ?? { error: "absent from rust dump" };
    const agree = "text" in ts && "text" in rs ? ts.text === rs.text : "error" in ts && "error" in rs && ts.error === rs.error;
    if ("text" in ts) items += 1;
    else rejected += 1;
    if (!agree) {
      failures += 1;
      if (failures <= 5) {
        console.log(`MISMATCH ${label} ${kind} ${id}`);
        console.log(`  ts:   ${"text" in ts ? ts.text.slice(0, 400) : `error ${ts.error}`}`);
        console.log(`  rust: ${"text" in rs ? rs.text.slice(0, 400) : `error ${rs.error}`}`);
      }
    }
  }
  store.close();
  console.log(
    `${failures === 0 ? "PASS" : "FAIL"}  ${label}  ${kind}  rows=${ids.length} items=${items} rejectedByBoth=${failures === 0 ? rejected : "-"} mismatches=${failures}`
  );
  return failures;
}

/** Rows that exercise every normalization rule, written directly (as an older or foreign writer could have). */
function adversarialFixture(path: string): void {
  const db = new DatabaseSync(path);
  applyControlPlaneMigrations(db);
  const insert = db.prepare(
    `INSERT INTO work_items (id, title, requester, requester_subject, status, intent, target_json, requested_actions_json,
       risk, result_json, metadata_json, source_work_item_id, lineage_type, retry_reason, retry_sequence,
       root_work_item_id, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
  );
  const base = {
    title: "t",
    requester: "user",
    subject: null as string | null,
    status: "pending_policy",
    intent: "i",
    target: "{}",
    actions: "[]",
    risk: "low",
    result: null as string | null,
    metadata: null as string | null,
    source: null as string | null,
    lineage: null as string | null,
    reason: null as string | null,
    sequence: 0 as number | null,
    root: null as string | null
  };
  const rows: Array<[string, Partial<typeof base>]> = [
    ["wrk_a_plain", {}],
    ["wrk_b_unknown_target_keys", { target: '{"cwd":"/r","extra":1,"files":["a"],"repo":"x","services":["s"]}' }],
    ["wrk_c_action_defaults", { actions: '[{"description":"d","kind":"k","extra":true},{"kind":"k2","description":"d2","params":{"z":1,"a":[1,2.5,null]}}]' }],
    ["wrk_d_falsy_omitted", { subject: "", metadata: "", sequence: 0 }],
    ["wrk_e_all_optional", { subject: "sub", result: '{"b":2,"a":{"n":1e3}}', metadata: '{"correlationId":"c","webhookSource":"Git_Hub-1"}', source: "wrk_a_plain", lineage: "retry", reason: "because", sequence: 3, root: "wrk_a_plain" }],
    ["wrk_e2_clone", { source: "wrk_a_plain", lineage: "clone", sequence: 2, root: "wrk_a_plain" }],
    ["wrk_f_metadata_unknown_key", { metadata: '{"correlationId":"c","sneaky":1}' }],
    ["wrk_g_bad_status", { status: "exploded" }],
    ["wrk_h_result_not_object", { result: "[1,2]" }],
    ["wrk_i_retry_reason_utf16", { source: "wrk_a_plain", lineage: "retry", reason: "😀".repeat(1000) }],
    ["wrk_j_retry_reason_emoji_over_units", { source: "wrk_a_plain", lineage: "retry", reason: "😀".repeat(1001) }],
    ["wrk_j2_retry_reason_too_long", { source: "wrk_a_plain", lineage: "retry", reason: "e\u0301".repeat(1001) }],
    ["wrk_k_empty_title", { title: "" }],
    ["wrk_l_action_params_not_record", { actions: '[{"kind":"k","description":"d","params":[1]}]' }],
    ["wrk_m_target_not_object", { target: "null" }],
    ["wrk_n_webhook_source_bad", { metadata: '{"webhookSource":"has space"}' }],
    ["wrk_o_negative_sequence", { sequence: -1 }],
    ["wrk_p_lineage_bad", { lineage: "fork" }],
    ["wrk_q_unicode_and_numbers", { title: "Ünïcode ✓", target: '{"files":["ä/ö.ts"]}', result: '{"big":12345678901234567890,"f":0.1,"neg":-0}' }]
  ];
  const skipped: string[] = [];
  for (const [id, change] of rows) {
    const r = { ...base, ...change };
    try {
      insert.run(id, r.title, r.requester, r.subject, r.status, r.intent, r.target, r.actions, r.risk, r.result, r.metadata,
      r.source, r.lineage, r.reason, r.sequence, r.root, "2026-11-23T00:00:00.000Z", "2026-11-23T00:00:00.000Z");
    } catch {
      // The schema's own constraints refuse this row, so no reader can meet it.
      skipped.push(id);
    }
  }
  db.close();
  console.log(`adversarial fixture: ${rows.length - skipped.length} rows written; refused by schema constraints: ${skipped.join(", ") || "none"}`);
}

/** Real attempts created through the store, then overwritten with edge-case values a foreign writer could leave. */
function adversarialAttempts(path: string): void {
  const store = new SqliteWorkItemStore(path, { auditShadowVerifier: null });
  const hex = (seed: string) => seed.repeat(64).slice(0, 64);
  const variants: Array<[string, string, string | number | null]> = [
    ["created_at", "created_at", "2026-11-23T08:30:26.123456789+05:30"],
    ["leap_day", "created_at", "2024-02-29T00:00:00Z"],
    ["non_leap_day", "created_at", "2026-02-29T00:00:00Z"],
    ["compact_offset", "updated_at", "2026-11-23T08:30:26+0530"],
    ["no_zone", "updated_at", "2026-11-23T08:30:26"],
    ["hour_24", "started_at", "2026-11-23T24:00:00Z"],
    ["empty_worker", "claimed_by_worker_id", ""],
    ["bad_worker", "claimed_by_worker_id", "_worker"],
    ["protocol", "protocol_version", "acs.worker.v1"],
    ["epoch_negative", "current_fencing_epoch", -1],
    ["upper_hash", "input_hash", "A".repeat(64)],
    ["plain", "status", "pending"]
  ];
  const skipped: string[] = [];
  for (const [label, column, value] of variants) {
    const workItem = store.create({
      title: `attempt fixture ${label}`,
      requester: "user",
      requesterSubject: "actor-user",
      intent: "attempt parity",
      target: { cwd: "/repo", files: [] },
      requestedActions: [{ kind: "fs.read", description: "inspect", params: { paths: ["a"], write: false } }],
      risk: "low"
    });
    const plan = store.createExecutionPlan({
      workItemId: workItem.id,
      definition: defaultExecutionPlanForWorkItem(workItem),
      createdByActorId: "actor-user"
    });
    const attempt = store.createAttempt(
      { workItemId: workItem.id, planHash: plan.planHash, inputHash: hex("b") },
      { via: "domain_service" }
    );
    const db = new DatabaseSync(path);
    try {
      db.prepare(`UPDATE execution_attempts SET ${column} = ? WHERE attempt_id = ?`).run(value, attempt.attemptId);
    } catch {
      skipped.push(label);
    } finally {
      db.close();
    }
  }
  store.close();
  console.log(`adversarial attempts: ${variants.length - skipped.length} edge values written; refused by schema/triggers: ${skipped.join(", ") || "none"}`);
}

if (!existsSync(bin)) {
  console.error(`missing ${bin}; build rust/acs-core first`);
  process.exit(1);
}
const work = mkdtempSync(join(tmpdir(), "acs-work-items-parity-"));
let failures = 0;
try {
  const fixture = join(work, "adversarial.db");
  adversarialFixture(fixture);
  adversarialAttempts(fixture);
  failures += compare("adversarial-fixture", fixture);
  for (const [index, source] of databases.entries()) {
    // Never open the source itself: copy the file and any WAL into scratch first, then compact the copy.
    const raw = join(work, `raw-${index}.db`);
    copyFileSync(source, raw);
    if (existsSync(`${source}-wal`)) copyFileSync(`${source}-wal`, `${raw}-wal`);
    const copy = join(work, `db-${index}.db`);
    const reader = new DatabaseSync(raw);
    reader.exec(`VACUUM INTO '${copy.replaceAll("'", "''")}'`);
    reader.close();
    failures += compare(`db-${index}`, copy);
  }
} finally {
  if (!keep) rmSync(work, { recursive: true, force: true });
}
console.log(JSON.stringify({ failures }));
process.exit(failures === 0 ? 0 : 1);
