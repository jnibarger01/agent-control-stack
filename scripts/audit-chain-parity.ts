#!/usr/bin/env -S npx tsx
/**
 * Parity check for the read-only Rust audit verifier (rust/acs-core, bin acs-audit-verify).
 *
 * For each fixture database it:
 *   1. warms the SQLite sidecars once, then records SHA-256 of the database, -wal and -shm;
 *   2. computes the TypeScript verdict (readAuditChainEvents + verifyAuditChain);
 *   3. runs the Rust verifier binary on the same file;
 *   4. re-checks the three file hashes, which must be unchanged across both reads;
 *   5. requires each verdict to meet its declared expectation, and requires the two to agree.
 *
 * Agreement means equal ok/failed verdicts. A Rust `indeterminate` verdict agrees with TypeScript
 * only where the fixture declares a divergence. The declared divergence is that TypeScript reports
 * `failed` while the stored data is locale-dependent, and Rust declines to assert corruption.
 *
 * TypeScript verification runs under LANG=C.UTF-8 in a child process, so the reference verdict
 * does not depend on the caller's locale. Locale-written fixtures are hashed under their named
 * locale by the TypeScript hash implementation.
 *
 * Fixture writes happen only on copies made here. The verifier never writes.
 *
 * Usage: npx tsx scripts/audit-chain-parity.ts [--bin <path>] [--work <dir>] [--keep]
 * Exit 0: every fixture matched. Exit 1: any mismatch, expectation miss, or fixture build failure.
 */
import { createHash, randomUUID } from "node:crypto";
import { mkdirSync, copyFileSync, existsSync, mkdtempSync, readdirSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";
import { isDeepStrictEqual } from "node:util";
import { DatabaseSync } from "node:sqlite";
import { auditEventHash, verifyAuditChain, type AuditChainEvent } from "../packages/shared/src/audit-chain.js";
import { readAuditChainEvents } from "../packages/shared/src/audit-export.js";
import { controlPlaneMigrations } from "../packages/shared/src/migration.js";

// Re-run once under a fixed root locale, so the TypeScript reference is locale-independent.
if (process.env.ACS_PARITY_CHILD !== "1") {
  const child = spawnSync("npx", ["tsx", fileURLToPath(import.meta.url), ...process.argv.slice(2)], {
    stdio: "inherit",
    env: { ...process.env, LANG: "C.UTF-8", LC_ALL: "C.UTF-8", ACS_PARITY_CHILD: "1" }
  });
  process.exit(child.status ?? 1);
}

const repoRoot = resolve(import.meta.dirname, "..");
const historicalSource = join(repoRoot, "storage/local.db.bak-20261103-182951");
const hashModule = join(repoRoot, "packages/shared/src/hash.ts");

type Expectation =
  { kind: "ok" } | { kind: "failed"; reason: string } | { kind: "indeterminate"; reason: string } | { kind: "error" };
type Fixture = {
  name: string;
  path: string;
  expect: Expectation;
  tsExpect?: Expectation;
  divergence?: string;
};
type TsVerdict =
  | { ok: true; eventCount: number; headHash: string }
  | { ok: false; eventCount: number; headHash: string; failure: { reason: string } }
  | { error: string };
type RustVerdict =
  | { ok: true; eventCount: number; headHash: string }
  | { ok: false; eventCount: number; headHash: string; failure: { reason: string } }
  | { ok: null; eventCount: number; headHash: string; indeterminate: { reason: string } }
  | { error: string };

function arg(name: string): string | undefined {
  const index = process.argv.indexOf(name);
  return index >= 0 ? process.argv[index + 1] : undefined;
}

const binPath = resolve(arg("--bin") ?? join(repoRoot, "rust/acs-core/target/release/acs-audit-verify"));
const work = resolve(arg("--work") ?? mkdtempSync(join(tmpdir(), "acs-audit-parity-")));
mkdirSync(work, { recursive: true });

function fileDigest(path: string): string {
  return existsSync(path) ? createHash("sha256").update(readFileSync(path)).digest("hex") : "absent";
}

function siblingDigests(path: string): Record<string, string> {
  return Object.fromEntries(["", "-wal", "-shm"].map((suffix) => [suffix || "db", fileDigest(path + suffix)]));
}

/** Builds an event with a valid hash, linked to `previous`. Attributes and body are stored as JSON text. */
function buildEvent(
  sequence: number,
  previous: AuditChainEvent | undefined,
  attributes: Record<string, unknown>,
  body: unknown
): AuditChainEvent {
  const partial = {
    sequence,
    id: `evt-${sequence}-${randomUUID()}`,
    name: `fixture.event.${sequence}`,
    timeUnixNano: String(1_790_000_000_000_000_000n + BigInt(sequence)),
    attributes: attributes as AuditChainEvent["attributes"],
    body: body as AuditChainEvent["body"],
    previousHash: previous?.eventHash ?? ""
  };
  return { ...partial, eventHash: auditEventHash(partial) };
}

function createAuditSchema(db: DatabaseSync): void {
  // Migration 001 creates audit_events (and other tables). Only the audit table matters here.
  db.exec(controlPlaneMigrations()[0]!.sql);
}

function writeChain(db: DatabaseSync, events: AuditChainEvent[]): void {
  const insert = db.prepare(
    "INSERT INTO audit_events (sequence, id, name, time_unix_nano, attributes, body, previous_hash, event_hash) VALUES (?, ?, ?, ?, ?, ?, ?, ?)"
  );
  for (const event of events) {
    insert.run(
      event.sequence,
      event.id,
      event.name,
      event.timeUnixNano,
      JSON.stringify(event.attributes),
      JSON.stringify(event.body),
      event.previousHash,
      event.eventHash
    );
  }
}

function chainOf(specs: Array<[Record<string, unknown>, unknown]>, start = 1): AuditChainEvent[] {
  const events: AuditChainEvent[] = [];
  specs.forEach(([attributes, body], index) => {
    events.push(buildEvent(start + index, events[events.length - 1], attributes, body));
  });
  return events;
}

/**
 * Hashes one event under an explicit process locale. The covered fields and the stableHash call are
 * the same as auditEventHash in audit-chain.ts. The child process is needed because the collation
 * is fixed when the process starts.
 */
function localeWriterEvent(locale: string, attributes: unknown, body: unknown): AuditChainEvent {
  const partial = {
    sequence: 1,
    id: `locale-writer-${locale}`,
    name: "fixture.locale",
    timeUnixNano: "1790000000000000000",
    attributes,
    body,
    previousHash: ""
  };
  const script = `
    import { stableHash } from ${JSON.stringify(new URL(`file://${hashModule}`).href)};
    const p = JSON.parse(process.argv[1]);
    process.stdout.write(JSON.stringify({ ...p, eventHash: stableHash({
      sequence: p.sequence, id: p.id, name: p.name, timeUnixNano: p.timeUnixNano,
      attributes: p.attributes, body: p.body, previousHash: p.previousHash }) }));`;
  const result = spawnSync(process.execPath, ["--input-type=module", "-e", script, JSON.stringify(partial)], {
    env: { ...process.env, LANG: locale, LC_ALL: locale },
    encoding: "utf8"
  });
  if (result.status !== 0) throw new Error(`locale writer ${locale} failed: ${result.stderr}`);
  return JSON.parse(result.stdout) as AuditChainEvent;
}

const fixtures: Fixture[] = [];

// 1. Real historical chain. Its records are root-written and verify under root.
const historical = join(work, "historical.db");
copyFileSync(historicalSource, historical);
fixtures.push({ name: "historical-backup-4846", path: historical, expect: { kind: "ok" } });

// The second tracked database predates the audit table (one page, empty schema).
const preAuditSource = join(repoRoot, "storage/local.db.pre-a3da700-20261003T125516Z");
const preAudit = join(work, "pre-audit-table.db");
copyFileSync(preAuditSource, preAudit);
fixtures.push({ name: "tracked-pre-audit-schema", path: preAudit, expect: { kind: "error" } });

// 2. Tampered copies of the historical chain. Each mutates one copy with TypeScript tooling.
function tamperedCopy(name: string, sql: string, expect: Expectation): void {
  const path = join(work, `${name}.db`);
  copyFileSync(historicalSource, path);
  const db = new DatabaseSync(path);
  try {
    db.exec(sql);
  } finally {
    db.close();
  }
  fixtures.push({ name, path, expect });
}
const nth = (offset: number) => `(SELECT sequence FROM audit_events ORDER BY sequence LIMIT 1 OFFSET ${offset})`;
tamperedCopy(
  "tamper-body-middle",
  `UPDATE audit_events SET body = '{"tampered":true}' WHERE sequence = ${nth(2000)};`,
  { kind: "failed", reason: "event_hash_mismatch" }
);
tamperedCopy(
  "tamper-previous-hash",
  `UPDATE audit_events SET previous_hash = 'deadbeef' WHERE sequence = ${nth(100)};`,
  { kind: "failed", reason: "previous_hash_mismatch" }
);
tamperedCopy("delete-middle-row", `DELETE FROM audit_events WHERE sequence = ${nth(3000)};`, {
  kind: "failed",
  reason: "previous_hash_mismatch"
});
tamperedCopy(
  "tamper-head-event-hash",
  `UPDATE audit_events SET event_hash = '${"0".repeat(64)}' WHERE sequence = (SELECT MAX(sequence) FROM audit_events);`,
  { kind: "failed", reason: "event_hash_mismatch" }
);
// Malformed JSON cannot be written: the schema has a json_valid CHECK on attributes and body.
tamperedCopy("emptied-chain", "DELETE FROM audit_events;", { kind: "ok" });

// 3. Crafted chains covering the edge-case keys the historical data does not contain.
const edgeKeys = {
  "10": 1,
  "2": 2,
  "9": 3,
  x: 4,
  é: "precomposed",
  é: "decomposed",
  A: 5,
  a: 6,
  "a.b": 7,
  a_b: 8,
  ß: 9,
  "": 10,
  "\u{1F600}": 11,
  "": 12
};
const reversedTies = { é: "decomposed", é: "precomposed" };
const weirdBody = {
  nested: [null, true, false, [], {}, [[1, 2], { z: 1, y: [0, -0, 9007199254740991] }]],
  text: 'quote" back\\ tab\t nl\n ctl\u0001 del\u007f sep  emoji\u{1F600}',
  zero: 0,
  negative: -17,
  empty: ""
};
const crafted = chainOf([
  [edgeKeys, weirdBody],
  [reversedTies, { a: 1 }],
  [{ ünï: "é", Zebra: 1, apple: 2, "work_item.id": "x", "work.item": "y" }, null],
  [{}, []]
]);
const craftedPath = join(work, "crafted-edge-keys.db");
{
  const db = new DatabaseSync(craftedPath);
  createAuditSchema(db);
  writeChain(db, crafted);
  db.close();
}
fixtures.push({ name: "crafted-edge-keys", path: craftedPath, expect: { kind: "ok" } });

const craftedTamperPath = join(work, "crafted-tampered-attributes.db");
copyFileSync(craftedPath, craftedTamperPath);
{
  const db = new DatabaseSync(craftedTamperPath);
  db.exec(`UPDATE audit_events SET attributes = '{"10":1,"2":2,"9":3,"x":5}' WHERE sequence = 1;`);
  db.close();
}
fixtures.push({
  name: "crafted-tampered-attributes",
  path: craftedTamperPath,
  expect: { kind: "failed", reason: "event_hash_mismatch" }
});

// 4. Locale-written single-record chains. Each is hashed by the TypeScript implementation under the
// named locale. Under root, TypeScript reports these as corrupt, which is a false claim. Rust
// classifies them by reproduction. Floats are outside the Rust legacy domain.
type LocaleCase = { name: string; locale: string; attributes: unknown; body: unknown };
const localeCases: LocaleCase[] = [
  { name: "locale-tr-writer", locale: "tr_TR.UTF-8", attributes: { I: 1, i: 2 }, body: { note: "tr" } },
  { name: "locale-sv-writer", locale: "sv_SE.UTF-8", attributes: { ä: 1, z: 2 }, body: { note: "sv" } },
  {
    name: "locale-hu-writer",
    locale: "hu_HU.UTF-8",
    attributes: { "acs.instance": "x", "actor.id": "y" },
    body: { note: "hu" }
  }
];
for (const c of localeCases) {
  const path = join(work, `${c.name}.db`);
  const event = localeWriterEvent(c.locale, c.attributes, c.body);
  const db = new DatabaseSync(path);
  createAuditSchema(db);
  writeChain(db, [event]);
  db.close();
  fixtures.push({
    name: c.name,
    path,
    expect: { kind: "indeterminate", reason: "locale_dependent" },
    tsExpect: { kind: "failed", reason: "event_hash_mismatch" },
    divergence: "ts-root-claims-corruption"
  });
}

// A locale-written record whose stored hash has been corrupted. Keys I and i order differently
// under tr, so no conclusion about the writer is possible from this record alone.
{
  const path = join(work, "locale-tr-writer-corrupt-hash.db");
  const event = localeWriterEvent("tr_TR.UTF-8", { I: 1, i: 2 }, { note: "tr" });
  const db = new DatabaseSync(path);
  createAuditSchema(db);
  writeChain(db, [{ ...event, eventHash: "0".repeat(64) }]);
  db.close();
  fixtures.push({
    name: "locale-tr-writer-corrupt-hash",
    path,
    expect: { kind: "indeterminate", reason: "locale_sensitive_mismatch" },
    tsExpect: { kind: "failed", reason: "event_hash_mismatch" },
    divergence: "ts-root-claims-corruption"
  });
}

// A locale-invariant record with a corrupt hash is corruption under any writer locale.
{
  const path = join(work, "invariant-corrupt-hash.db");
  const [event] = chainOf([[{ tampered: true, b: 1 }, { note: "ascii" }]]);
  const db = new DatabaseSync(path);
  createAuditSchema(db);
  writeChain(db, [{ ...event!, eventHash: "0".repeat(64) }]);
  db.close();
  fixtures.push({ name: "invariant-corrupt-hash", path, expect: { kind: "failed", reason: "event_hash_mismatch" } });
}

// A float is outside the Rust legacy domain. TypeScript hashes it, so the two verifiers differ.
{
  const path = join(work, "float-writer.db");
  const [event] = chainOf([[{ f: 0.5 }, { note: "float" }]]);
  const db = new DatabaseSync(path);
  createAuditSchema(db);
  writeChain(db, [event!]);
  db.close();
  fixtures.push({
    name: "float-writer-unsupported",
    path,
    expect: { kind: "indeterminate", reason: "unsupported_canonicalization" },
    tsExpect: { kind: "ok" },
    divergence: "rust-unsupported-ts-verifies"
  });
}

// An integer beyond 2^53 - 1 stored as text. TypeScript parses it to the rounded double and verifies
// the hash that was computed over that double. Rust refuses to canonicalize it: unsupported, not corrupt.
{
  const path = join(work, "unsafe-integer-text.db");
  const [event] = chainOf([[{ big: 9007199254740992 }, { note: "unsafe" }]]);
  const db = new DatabaseSync(path);
  createAuditSchema(db);
  writeChain(db, [event!]);
  db.exec(`UPDATE audit_events SET attributes = '{"big":9007199254740993}';`);
  db.close();
  fixtures.push({
    name: "unsafe-integer-text",
    path,
    expect: { kind: "indeterminate", reason: "unsupported_canonicalization" },
    tsExpect: { kind: "ok" },
    divergence: "rust-unsupported-ts-verifies"
  });
}

const emptyPath = join(work, "empty-chain.db");
{
  const db = new DatabaseSync(emptyPath);
  createAuditSchema(db);
  db.close();
}
fixtures.push({ name: "empty-chain", path: emptyPath, expect: { kind: "ok" } });

const noTablePath = join(work, "no-audit-table.db");
{
  const db = new DatabaseSync(noTablePath);
  db.exec("CREATE TABLE unrelated (id INTEGER PRIMARY KEY);");
  db.close();
}
fixtures.push({ name: "no-audit-table", path: noTablePath, expect: { kind: "error" } });

// 5. One database per historical migration version, applied in shipped order, each with a chain.
const schemaDir = join(work, "schema");
mkdirSync(schemaDir, { recursive: true });
const schemaLive = join(schemaDir, "live.db");
const schemaDb = new DatabaseSync(schemaLive);
let migrationFailure: string | undefined;
for (const migration of controlPlaneMigrations()) {
  try {
    schemaDb.exec(migration.sql);
  } catch (error) {
    migrationFailure = `${migration.filename}: ${(error as Error).message}`;
    break;
  }
  const snapshot = join(schemaDir, `v${migration.version}-${migration.filename.replace(/\.sql$/, "")}.db`);
  schemaDb.exec(`VACUUM INTO '${snapshot}'`);
  const hasAudit = schemaDb
    .prepare("SELECT 1 AS present FROM sqlite_master WHERE type = 'table' AND name = 'audit_events'")
    .get();
  if (hasAudit) {
    const snapshotDb = new DatabaseSync(snapshot);
    writeChain(
      snapshotDb,
      chainOf([
        [{ version: migration.version }, { step: "seed" }],
        [{ n: 2 }, null]
      ])
    );
    snapshotDb.close();
    fixtures.push({ name: `schema-${migration.filename}`, path: snapshot, expect: { kind: "ok" } });
  } else {
    fixtures.push({ name: `schema-${migration.filename}`, path: snapshot, expect: { kind: "error" } });
  }
}
schemaDb.close();
if (migrationFailure) {
  console.error(`migration replay stopped: ${migrationFailure}`);
}

function tsVerdict(path: string): TsVerdict {
  let db: DatabaseSync | undefined;
  try {
    db = new DatabaseSync(path, { readOnly: true });
    return verifyAuditChain(readAuditChainEvents(db)) as TsVerdict;
  } catch (error) {
    return { error: (error as Error).message.slice(0, 120) };
  } finally {
    db?.close();
  }
}

function rustVerdict(path: string): { verdict?: RustVerdict; exit: number | null; stderr: string } {
  const result = spawnSync(binPath, [path], { encoding: "utf8" });
  if (result.error) return { exit: null, stderr: result.error.message };
  let verdict: RustVerdict | undefined;
  try {
    verdict = JSON.parse(result.stdout) as RustVerdict;
  } catch {
    verdict = undefined;
  }
  return { verdict, exit: result.status, stderr: result.stderr };
}

function satisfies(verdict: TsVerdict | RustVerdict, expect: Expectation): boolean {
  if (expect.kind === "error") return "error" in verdict;
  if ("error" in verdict) return false;
  if (expect.kind === "ok") return verdict.ok === true;
  if (expect.kind === "indeterminate") {
    return verdict.ok === null && "indeterminate" in verdict && verdict.indeterminate.reason === expect.reason;
  }
  return verdict.ok === false && verdict.failure.reason === expect.reason;
}

/**
 * SQLite creates an empty -wal and a -shm on the first read-only open of a WAL-mode database.
 * That is WAL bookkeeping, not a data write. Open once here so the sidecars exist, then require
 * all three files to stay byte-identical across the verifier reads. This is NOT a zero-write proof.
 * See docs/migrations/rust-core-runbook.md for the cold-open measurements.
 */
function warmSidecars(path: string): void {
  const db = new DatabaseSync(path, { readOnly: true });
  try {
    db.prepare("SELECT COUNT(*) AS n FROM sqlite_master").get();
  } finally {
    db.close();
  }
}

/**
 * Cold opens. Copies only the main database file, so no sidecars exist, and opens that copy with
 * the default read-only mode and with --immutable. Must run before the warm-up for the same file.
 */
function coldOpens(
  path: string,
  name: string
): {
  defaultVerdict: string;
  immutableVerdict: string;
  defaultCreated: string[];
  immutableCreated: string[];
} {
  const runOnFreshCopy = (mode: "default" | "immutable") => {
    const dir = join(work, "cold", `${name}-${mode}`);
    mkdirSync(dir, { recursive: true });
    const db = join(dir, "subject.db");
    copyFileSync(path, db);
    const result = spawnSync(binPath, [...(mode === "immutable" ? ["--immutable"] : []), db], { encoding: "utf8" });
    const created = readdirSync(dir)
      .filter((entry) => entry !== "subject.db")
      .sort();
    return { verdict: (result.stdout || result.stderr).trim(), created };
  };
  const defaultRun = runOnFreshCopy("default");
  const immutableRun = runOnFreshCopy("immutable");
  return {
    defaultVerdict: defaultRun.verdict,
    immutableVerdict: immutableRun.verdict,
    defaultCreated: defaultRun.created,
    immutableCreated: immutableRun.created
  };
}

let failures = 0;
const rows: string[] = [];
for (const fixture of fixtures) {
  const cold = coldOpens(fixture.path, fixture.name);
  warmSidecars(fixture.path);
  const before = siblingDigests(fixture.path);
  const ts = tsVerdict(fixture.path);
  const rust = rustVerdict(fixture.path);
  const after = siblingDigests(fixture.path);

  const readOnly = isDeepStrictEqual(before, after);
  const rustVerdictValue = rust.verdict;
  let agrees: boolean;
  if (rustVerdictValue === undefined) {
    agrees = false;
  } else if ("error" in ts) {
    agrees = "error" in rustVerdictValue && rust.exit === 1;
  } else if (rustVerdictValue.ok === null) {
    agrees = fixture.divergence !== undefined && rust.exit === 0;
  } else {
    agrees = rust.exit === 0 && isDeepStrictEqual(rustVerdictValue, ts);
  }
  const rustMeets = rustVerdictValue !== undefined && satisfies(rustVerdictValue, fixture.expect);
  const tsMeets = satisfies(ts, fixture.tsExpect ?? fixture.expect);
  // Cold opens: both cold modes must reproduce the warm Rust verdict. Immutable opens must create no
  // sidecars. The default cold open is recorded, not asserted, because SQLite creates them there.
  const parseCold = (text: string): unknown => {
    try {
      return JSON.parse(text);
    } catch {
      return undefined;
    }
  };
  const coldMatches =
    rustVerdictValue !== undefined &&
    isDeepStrictEqual(parseCold(cold.defaultVerdict), rustVerdictValue) &&
    isDeepStrictEqual(parseCold(cold.immutableVerdict), rustVerdictValue);
  const immutableCreatedNothing = cold.immutableCreated.length === 0;
  const pass = readOnly && agrees && rustMeets && tsMeets && coldMatches && immutableCreatedNothing;
  if (!pass) failures++;
  const tsSummary = "error" in ts ? "error" : ts.ok ? `ok n=${ts.eventCount}` : `failed ${ts.failure.reason}`;
  const rustSummary =
    rustVerdictValue === undefined
      ? "no-verdict"
      : "error" in rustVerdictValue
        ? "error"
        : rustVerdictValue.ok === null
          ? `indeterminate ${rustVerdictValue.indeterminate.reason}`
          : rustVerdictValue.ok
            ? `ok n=${rustVerdictValue.eventCount}`
            : `failed ${rustVerdictValue.failure.reason}`;
  rows.push(
    `${pass ? "PASS" : "FAIL"}  ${fixture.name.padEnd(36)} ts=${tsSummary.padEnd(30)} rust=${rustSummary.padEnd(44)} readOnly=${readOnly} agree=${agrees} cold=${coldMatches}/immutableNoSidecars=${immutableCreatedNothing} coldDefaultSidecars=${cold.defaultCreated.length} divergence=${fixture.divergence ?? "-"}`
  );
  if (!pass && rust.stderr) rows.push(`      rust stderr: ${rust.stderr.slice(0, 200)}`);
}

console.log(rows.join("\n"));
console.log(
  JSON.stringify({
    fixtures: fixtures.length,
    failures,
    binary: binPath.replace(`${repoRoot}/`, ""),
    tsLocale: "C.UTF-8",
    migrationReplayStopped: migrationFailure ?? null
  })
);
if (!process.argv.includes("--keep")) rmSync(work, { recursive: true, force: true });
process.exit(failures === 0 && !migrationFailure ? 0 : 1);
