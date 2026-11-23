#!/usr/bin/env -S npx tsx
/**
 * Filesystem evidence for read-only audit verification, measured on disposable copies.
 *
 * For each fixture it runs every open mode in a fresh directory and records:
 *   - the verdict;
 *   - SHA-256 and metadata (mode, uid, gid, size, mtime, inode) of the database before and after;
 *   - every sibling file that appears (-wal, -shm, journal) and whether its bytes change;
 *   - whether the directory was writable at the time of the open.
 *
 * Modes:
 *   rust-default-cold-writable     acs-audit-verify, SQLITE_OPEN_READ_ONLY, no sidecars, writable dir
 *   rust-default-warm-readonly-dir acs-audit-verify, SQLITE_OPEN_READ_ONLY, sidecars present, dir 0555
 *   rust-default-cold-readonly-dir acs-audit-verify, SQLITE_OPEN_READ_ONLY, no sidecars, dir 0555
 *   rust-immutable-cold-readonly   acs-audit-verify --immutable, no sidecars, dir 0555
 *   ts-cold-writable               verifyAuditChainFromDatabaseFile (node:sqlite readOnly), writable dir
 *
 * This measures the observable effects of each open. It is not a syscall trace. Without strace,
 * the directory-permission experiment is the observable test of whether an open must write.
 *
 * Usage: npx tsx scripts/audit-chain-open-evidence.ts [--bin <path>] [--work <dir>]
 */
import { createHash } from "node:crypto";
import {
  chmodSync,
  copyFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync
} from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { spawnSync } from "node:child_process";
import { verifyAuditChainFromDatabaseFile } from "../packages/shared/src/audit-export.js";

const repoRoot = resolve(import.meta.dirname, "..");
const historicalSource = join(repoRoot, "storage/local.db.bak-20261103-182951");

function arg(name: string): string | undefined {
  const index = process.argv.indexOf(name);
  return index >= 0 ? process.argv[index + 1] : undefined;
}
const binPath = resolve(arg("--bin") ?? join(repoRoot, "rust/acs-core/target/release/acs-audit-verify"));
const work = resolve(arg("--work") ?? mkdtempSync(join(tmpdir(), "acs-open-evidence-")));
mkdirSync(work, { recursive: true });

const sha = (path: string) => createHash("sha256").update(readFileSync(path)).digest("hex").slice(0, 16);

type FileState = { name: string; mode: string; size: number; mtimeMs: number; ino: number; sha: string };

/** State of every file in a directory: the evidence for "what did the open write". */
function snapshotDir(dir: string): Map<string, FileState> {
  const out = new Map<string, FileState>();
  for (const name of readdirSync(dir)) {
    const path = join(dir, name);
    const meta = statSync(path);
    out.set(name, {
      name,
      mode: (meta.mode & 0o777).toString(8),
      size: meta.size,
      mtimeMs: meta.mtimeMs,
      ino: meta.ino,
      sha: sha(path)
    });
  }
  return out;
}

function diffDirs(before: Map<string, FileState>, after: Map<string, FileState>) {
  const created = [...after.keys()].filter((name) => !before.has(name));
  const removed = [...before.keys()].filter((name) => !after.has(name));
  const changed = [...after.keys()].filter((name) => {
    const prior = before.get(name);
    const now = after.get(name)!;
    return prior !== undefined && (prior.sha !== now.sha || prior.size !== now.size);
  });
  return { created, removed, changed };
}

/** Fresh directory with the database copied in and nothing else. */
function freshDir(label: string, fixtureName: string): { dir: string; db: string } {
  const dir = join(work, `${fixtureName}-${label}`);
  mkdirSync(dir, { recursive: true });
  const db = join(dir, "subject.db");
  copyFileSync(historicalSource, db);
  return { dir, db };
}

/** Runs the Rust verifier and returns its verdict line. */
function runRust(db: string, immutable: boolean): string {
  const args = [...(immutable ? ["--immutable"] : []), db];
  const result = spawnSync(binPath, args, { encoding: "utf8" });
  return (result.stdout || result.stderr).trim().slice(0, 140);
}

type Row = {
  mode: string;
  verdict: string;
  dirWritable: boolean;
  dbHashUnchanged: boolean;
  dbMetaUnchanged: boolean;
  created: string[];
  changedSiblings: string[];
  removed: string[];
};

function measure(mode: string, dir: string, db: string, dirWritable: boolean, run: () => string): Row {
  const beforeDir = snapshotDir(dir);
  const beforeDb = statSync(db);
  const beforeHash = sha(db);
  if (!dirWritable) chmodSync(dir, 0o555);
  let verdict: string;
  try {
    verdict = run();
  } finally {
    if (!dirWritable) chmodSync(dir, 0o755);
  }
  const afterDir = snapshotDir(dir);
  const afterDb = statSync(db);
  const delta = diffDirs(beforeDir, afterDir);
  return {
    mode,
    verdict,
    dirWritable,
    dbHashUnchanged: sha(db) === beforeHash,
    dbMetaUnchanged:
      afterDb.mtimeMs === beforeDb.mtimeMs && afterDb.size === beforeDb.size && afterDb.ino === beforeDb.ino,
    created: delta.created,
    changedSiblings: delta.changed.filter((name) => name !== "subject.db"),
    removed: delta.removed
  };
}

const rows: Array<{ fixture: string } & Row> = [];

// Cold, writable directory, default read-only open.
{
  const { dir, db } = freshDir("cold-writable", "subject");
  rows.push({
    fixture: "historical",
    ...measure("rust-default-cold-writable", dir, db, true, () => runRust(db, false))
  });
}
// Cold, read-only directory, default read-only open. Expected to fail if SQLite must create -shm.
{
  const { dir, db } = freshDir("cold-readonly", "subject");
  rows.push({
    fixture: "historical",
    ...measure("rust-default-cold-readonly-dir", dir, db, false, () => runRust(db, false))
  });
}
// Warm: sidecars created by a first open, then the directory made read-only for the second open.
{
  const { dir, db } = freshDir("warm-readonly", "subject");
  runRust(db, false);
  rows.push({
    fixture: "historical",
    ...measure("rust-default-warm-readonly-dir", dir, db, false, () => runRust(db, false))
  });
}
// Cold, read-only directory, immutable open.
{
  const { dir, db } = freshDir("immutable-readonly", "subject");
  rows.push({
    fixture: "historical",
    ...measure("rust-immutable-cold-readonly-dir", dir, db, false, () => runRust(db, true))
  });
}
// Cold, writable directory, TypeScript reference.
{
  const { dir, db } = freshDir("ts-cold", "subject");
  rows.push({
    fixture: "historical",
    ...measure("ts-cold-writable", dir, db, true, () => {
      const verdict = verifyAuditChainFromDatabaseFile(db);
      return JSON.stringify(verdict).slice(0, 140);
    })
  });
}
// Immutable refuses a database whose WAL holds bytes: this is the safety property.
{
  const { dir, db } = freshDir("immutable-with-wal", "subject");
  const wal = `${db}-wal`;
  copyFileSync(historicalSource, wal);
  rows.push({
    fixture: "historical",
    ...measure("rust-immutable-nonempty-wal", dir, db, true, () => runRust(db, true))
  });
}

for (const row of rows) {
  console.log(JSON.stringify(row));
}

// Permissions and ownership of the source file, for the report.
const meta = statSync(historicalSource);
console.log(
  JSON.stringify({
    sourceFile: "storage/local.db.bak-20261103-182951",
    mode: (meta.mode & 0o777).toString(8),
    uid: meta.uid,
    gid: meta.gid,
    sizeBytes: meta.size,
    sha256: sha(historicalSource),
    walSiblingPresentInRepo: existsSync(`${historicalSource}-wal`)
  })
);

rmSync(work, { recursive: true, force: true });
