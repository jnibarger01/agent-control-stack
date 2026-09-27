import { execFile } from "node:child_process";
import {
  existsSync,
  linkSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readlinkSync,
  readdirSync,
  rmSync,
  symlinkSync,
  writeFileSync
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { afterEach, describe, expect, it } from "vitest";

const execFileAsync = promisify(execFile);
const SCRIPT = join(process.cwd(), "scripts/sqlite-backup-restore.mjs");

describe("sqlite-backup-restore snapshot retain-after-integrity", () => {
  const temporaryDirectories: string[] = [];

  afterEach(() => {
    for (const directory of temporaryDirectories.splice(0)) {
      rmSync(directory, { recursive: true, force: true });
    }
  });

  it("updates latest.db only after a clean integrity_check on the happy path", async () => {
    const root = temporaryDirectory();
    const source = join(root, "sample.db");
    const backups = join(root, "backups");

    const fixture = await runCli(["create-fixture", source]);
    expect(fixture).toMatchObject({ ok: true, operation: "create-fixture" });

    const first = await runCli(["snapshot", source, "--destination-dir", backups]);
    expect(first).toMatchObject({ ok: true, operation: "snapshot", retainHealth: { ok: true } });
    expect(first.latest).toBe(join(backups, "latest.db"));
    expect(lstatSync(join(backups, "latest.db")).isSymbolicLink()).toBe(true);
    const firstTarget = readlinkSync(join(backups, "latest.db"));
    expect(firstTarget).toMatch(/^sample-.+\.db$/);
    expect(existsSync(join(backups, firstTarget))).toBe(true);

    // Second snapshot advances latest to a new timestamped artifact.
    await new Promise((resolve) => setTimeout(resolve, 5));
    const second = await runCli(["snapshot", source, "--destination-dir", backups]);
    expect(second).toMatchObject({ ok: true, operation: "snapshot", retainHealth: { ok: true } });
    const secondTarget = readlinkSync(join(backups, "latest.db"));
    expect(secondTarget).not.toBe(firstTarget);
    expect(second.previousLatest).toBe(join(backups, firstTarget));
  }, 30_000);

  it("refuses to update latest when the source fails integrity_check", async () => {
    const root = temporaryDirectory();
    const goodSource = join(root, "good.db");
    const corruptSource = join(root, "corrupt.db");
    const backups = join(root, "backups");

    await runCli(["create-fixture", goodSource]);
    const good = await runCli(["snapshot", goodSource, "--destination-dir", backups]);
    expect(good).toMatchObject({ ok: true, operation: "snapshot" });
    const goodLatestTarget = readlinkSync(join(backups, "latest.db"));
    const beforeArtifacts = new Set(readdirSync(backups));

    writeFileSync(corruptSource, Buffer.alloc(4_096, 0x61));

    const failed = await runCliExpectFailure(["snapshot", corruptSource, "--destination-dir", backups]);
    expect(failed).toMatchObject({ ok: false, operation: "snapshot" });
    expect(String(failed.error)).toMatch(/integrity|health check|retain refused/i);
    expect(failed.previousLatest).toBe(join(backups, goodLatestTarget));
    expect(readlinkSync(join(backups, "latest.db"))).toBe(goodLatestTarget);
    expect(existsSync(join(backups, goodLatestTarget))).toBe(true);

    // No new timestamped artifact retained from the corrupt attempt.
    const afterArtifacts = readdirSync(backups);
    expect(afterArtifacts.filter((name) => name !== "latest.db").sort()).toEqual(
      [...beforeArtifacts].filter((name) => name !== "latest.db").sort()
    );
  }, 30_000);

  it("restore-dry-run refuses ACS_DB_PATH without touching the live database", async () => {
    const root = temporaryDirectory();
    const source = join(root, "sample.db");
    const live = join(root, "live.db");
    await runCli(["create-fixture", source]);
    const snapshot = await runCli(["snapshot", source, "--destination-dir", join(root, "backups")]);
    expect(snapshot.ok).toBe(true);
    const backup = join(root, "backups", readlinkSync(join(root, "backups", "latest.db")));
    await runCli(["create-fixture", live]);
    const before = readFileSync(live);

    const refused = await runCliExpectFailure(["restore-dry-run", backup, "--into", live, "--runtime-dir", root], {
      ACS_DB_PATH: live,
      ACS_RUNTIME_CONFIG: join(root, "missing.yaml")
    });
    expect(String(refused.error)).toMatch(/refuses to overwrite the live control-plane database/);
    expect(readFileSync(live)).toEqual(before);
  }, 30_000);

  it("protects both raw and trimmed ACS_DB_PATH interpretations", async () => {
    const root = temporaryDirectory();
    const source = join(root, "sample.db");
    const live = join(root, " live.db ");
    await runCli(["create-fixture", source]);
    const snapshot = await runCli(["snapshot", source, "--destination-dir", join(root, "backups")]);
    const backup = join(root, "backups", readlinkSync(join(root, "backups", "latest.db")));
    expect(snapshot.ok).toBe(true);

    const refused = await runCliExpectFailure(["restore-dry-run", backup, "--into", live, "--runtime-dir", root], {
      ACS_DB_PATH: live,
      ACS_RUNTIME_CONFIG: join(root, "missing.yaml")
    });
    expect(String(refused.error)).toMatch(/refuses to overwrite/);
  }, 30_000);

  it("protects runtime.db_path when ACS_DB_PATH is unset", async () => {
    const root = temporaryDirectory();
    const source = join(root, "sample.db");
    const live = join(root, "runtime-live.db");
    const config = join(root, "acs.config.yaml");
    writeFileSync(config, `runtime:\n  db_path: ${live}\n`);
    await runCli(["create-fixture", source]);
    const snapshot = await runCli(["snapshot", source, "--destination-dir", join(root, "backups")]);
    const backup = join(root, "backups", readlinkSync(join(root, "backups", "latest.db")));
    expect(snapshot.ok).toBe(true);

    const refused = await runCliExpectFailure(["restore-dry-run", backup, "--into", live, "--runtime-dir", root], {
      ACS_DB_PATH: "",
      ACS_RUNTIME_CONFIG: config
    });
    expect(String(refused.error)).toMatch(/refuses to overwrite/);
  }, 30_000);

  it("canonicalizes a missing destination through a symlinked parent", async () => {
    const root = temporaryDirectory();
    const source = join(root, "sample.db");
    const realDir = join(root, "real");
    const aliasDir = join(root, "alias");
    const live = join(realDir, "future.db");
    mkdirSync(realDir);
    symlinkSync(realDir, aliasDir, "dir");
    await runCli(["create-fixture", source]);
    const snapshot = await runCli(["snapshot", source, "--destination-dir", join(root, "backups")]);
    const backup = join(root, "backups", readlinkSync(join(root, "backups", "latest.db")));
    expect(snapshot.ok).toBe(true);

    const refused = await runCliExpectFailure(
      ["restore-dry-run", backup, "--into", join(aliasDir, "future.db"), "--runtime-dir", root],
      { ACS_DB_PATH: live, ACS_RUNTIME_CONFIG: join(root, "missing.yaml") }
    );
    expect(String(refused.error)).toMatch(/refuses to overwrite/);
    expect(existsSync(live)).toBe(false);
  }, 30_000);

  it("rejects an existing filesystem-identity alias of the live DB", async () => {
    const root = temporaryDirectory();
    const source = join(root, "sample.db");
    const live = join(root, "live.db");
    const alias = join(root, "hardlink.db");
    await runCli(["create-fixture", source]);
    await runCli(["create-fixture", live]);
    linkSync(live, alias);
    const snapshot = await runCli(["snapshot", source, "--destination-dir", join(root, "backups")]);
    const backup = join(root, "backups", readlinkSync(join(root, "backups", "latest.db")));
    expect(snapshot.ok).toBe(true);

    const refused = await runCliExpectFailure(["restore-dry-run", backup, "--into", alias, "--runtime-dir", root], {
      ACS_DB_PATH: live,
      ACS_RUNTIME_CONFIG: join(root, "missing.yaml")
    });
    expect(String(refused.error)).toMatch(/refuses to overwrite/);
  }, 30_000);

  it("still restores to a non-live scratch destination", async () => {
    const root = temporaryDirectory();
    const source = join(root, "sample.db");
    const scratch = join(root, "scratch", "rehearsal.db");
    await runCli(["create-fixture", source]);
    const snapshot = await runCli(["snapshot", source, "--destination-dir", join(root, "backups")]);
    const backup = join(root, "backups", readlinkSync(join(root, "backups", "latest.db")));
    expect(snapshot.ok).toBe(true);

    const kept = await runCli(["restore-dry-run", backup, "--into", scratch, "--runtime-dir", root], {
      ACS_DB_PATH: join(root, "live.db"),
      ACS_RUNTIME_CONFIG: join(root, "missing.yaml")
    });
    expect(kept).toMatchObject({ ok: true, operation: "restore-dry-run", replacedLiveDatabase: false });
    expect(readFileSync(scratch)).toEqual(readFileSync(backup));
  }, 30_000);

  it("refuses --into storage/local.db when no live path is configured", async () => {
    const root = temporaryDirectory();
    const source = join(root, "sample.db");
    await runCli(["create-fixture", source]);
    const snapshot = await runCli(["snapshot", source, "--destination-dir", join(root, "backups")]);
    expect(snapshot.ok).toBe(true);
    const backup = join(root, "backups", readlinkSync(join(root, "backups", "latest.db")));

    // No ACS_DB_PATH, no runtime config, no --runtime-dir: the default
    // storage/local.db cannot be anchored to the runtime's working directory,
    // so --into fails closed instead of being compared against this cwd.
    const refused = await runCliExpectFailure(["restore-dry-run", backup, "--into", "storage/local.db"], {
      ACS_DB_PATH: "",
      ACS_RUNTIME_CONFIG: join(root, "missing.yaml")
    });
    expect(String(refused.error)).toMatch(/runtime working directory is unknown/);
  }, 30_000);

  it("refuses --into when a relative live path cannot be anchored to the runtime cwd", async () => {
    const root = temporaryDirectory();
    const runtimeDir = join(root, "runtime-a");
    const operatorDir = join(root, "operator-b");
    mkdirSync(join(runtimeDir, "storage"), { recursive: true });
    mkdirSync(operatorDir, { recursive: true });
    const live = join(runtimeDir, "storage", "local.db");
    const source = join(root, "sample.db");
    await runCli(["create-fixture", source]);
    const snapshot = await runCli(["snapshot", source, "--destination-dir", join(root, "backups")]);
    expect(snapshot.ok).toBe(true);
    const backup = join(root, "backups", readlinkSync(join(root, "backups", "latest.db")));
    await runCli(["create-fixture", live]);
    const before = readFileSync(live);

    // The runtime was launched from runtime-a with a relative ACS_DB_PATH, but the
    // rehearsal runs from operator-b. Without an explicit runtime directory the
    // relative live path cannot be anchored, so --into fails closed and the live
    // database is untouched.
    const unanchored = await runCliExpectFailure(
      ["restore-dry-run", backup, "--into", live],
      {
        ACS_DB_PATH: "storage/local.db",
        ACS_RUNTIME_CONFIG: join(root, "missing.yaml")
      },
      { cwd: operatorDir }
    );
    expect(String(unanchored.error)).toMatch(/runtime working directory is unknown/);
    expect(readFileSync(live)).toEqual(before);

    // With the runtime directory provided (via env here), the relative live path
    // anchors to runtime-a/storage/local.db and --into is refused as the live DB.
    const anchored = await runCliExpectFailure(
      ["restore-dry-run", backup, "--into", live],
      {
        ACS_DB_PATH: "storage/local.db",
        ACS_RUNTIME_CONFIG: join(root, "missing.yaml"),
        ACS_RUNTIME_DIR: runtimeDir
      },
      { cwd: operatorDir }
    );
    expect(String(anchored.error)).toMatch(/refuses to overwrite the live control-plane database/);
    expect(readFileSync(live)).toEqual(before);
  }, 30_000);

  it("parses SQLite file: URIs before comparing live paths", async () => {
    const root = temporaryDirectory();
    const source = join(root, "sample.db");
    const live = join(root, "live.db");
    await runCli(["create-fixture", source]);
    const snapshot = await runCli(["snapshot", source, "--destination-dir", join(root, "backups")]);
    expect(snapshot.ok).toBe(true);
    const backup = join(root, "backups", readlinkSync(join(root, "backups", "latest.db")));
    await runCli(["create-fixture", live]);
    const before = readFileSync(live);

    for (const uri of [`file:${live}`, `file://${live}?mode=ro`, `file://localhost${live}#fragment`]) {
      const refused = await runCliExpectFailure(
        ["restore-dry-run", backup, "--into", live, "--runtime-dir", root],
        { ACS_DB_PATH: uri, ACS_RUNTIME_CONFIG: join(root, "missing.yaml") }
      );
      expect(String(refused.error)).toMatch(/refuses to overwrite the live control-plane database/);
      expect(readFileSync(live)).toEqual(before);
    }
  }, 60_000);

  it("refuses --into when the live path is an unresolvable SQLite file: URI", async () => {
    const root = temporaryDirectory();
    const source = join(root, "sample.db");
    await runCli(["create-fixture", source]);
    const snapshot = await runCli(["snapshot", source, "--destination-dir", join(root, "backups")]);
    expect(snapshot.ok).toBe(true);
    const backup = join(root, "backups", readlinkSync(join(root, "backups", "latest.db")));
    const scratch = join(root, "scratch.db");

    const refused = await runCliExpectFailure(
      ["restore-dry-run", backup, "--into", scratch, "--runtime-dir", root],
      { ACS_DB_PATH: "file://remotehost/var/lib/acs/control.db", ACS_RUNTIME_CONFIG: join(root, "missing.yaml") }
    );
    expect(String(refused.error)).toMatch(/remote host "remotehost" has no local filesystem path/);
    expect(existsSync(scratch)).toBe(false);
  }, 30_000);

  function temporaryDirectory(): string {
    const directory = mkdtempSync(join(tmpdir(), "acs-sqlite-backup-restore-cli-"));
    temporaryDirectories.push(directory);
    return directory;
  }
});

async function runCli(
  args: string[],
  env?: NodeJS.ProcessEnv,
  options?: { cwd?: string }
): Promise<Record<string, unknown>> {
  const result = await execFileAsync(process.execPath, [SCRIPT, ...args], {
    cwd: options?.cwd ?? process.cwd(),
    env: { ...process.env, ACS_DB_PATH: "", ACS_RUNTIME_CONFIG: "__acs_test_missing__.yaml", ...env }
  });
  return JSON.parse(result.stdout) as Record<string, unknown>;
}

async function runCliExpectFailure(
  args: string[],
  env?: NodeJS.ProcessEnv,
  options?: { cwd?: string }
): Promise<Record<string, unknown>> {
  try {
    const result = await execFileAsync(process.execPath, [SCRIPT, ...args], {
      cwd: options?.cwd ?? process.cwd(),
      env: { ...process.env, ACS_DB_PATH: "", ACS_RUNTIME_CONFIG: "__acs_test_missing__.yaml", ...env }
    });
    throw new Error(`expected non-zero exit, got stdout: ${result.stdout}`);
  } catch (error) {
    const failure = error as NodeJS.ErrnoException & { stdout?: string; stderr?: string; code?: number };
    if (typeof failure.stdout !== "string") throw error;
    expect(failure.code).toBe(1);
    return JSON.parse(failure.stdout) as Record<string, unknown>;
  }
}
