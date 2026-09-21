import { execFile } from "node:child_process";
import { existsSync, lstatSync, mkdtempSync, readlinkSync, readdirSync, rmSync, writeFileSync } from "node:fs";
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

  function temporaryDirectory(): string {
    const directory = mkdtempSync(join(tmpdir(), "acs-sqlite-backup-restore-cli-"));
    temporaryDirectories.push(directory);
    return directory;
  }
});

async function runCli(args: string[]): Promise<Record<string, unknown>> {
  const result = await execFileAsync(process.execPath, [SCRIPT, ...args], { cwd: process.cwd() });
  return JSON.parse(result.stdout) as Record<string, unknown>;
}

async function runCliExpectFailure(args: string[]): Promise<Record<string, unknown>> {
  try {
    const result = await execFileAsync(process.execPath, [SCRIPT, ...args], { cwd: process.cwd() });
    throw new Error(`expected non-zero exit, got stdout: ${result.stdout}`);
  } catch (error) {
    const failure = error as NodeJS.ErrnoException & { stdout?: string; stderr?: string; code?: number };
    if (typeof failure.stdout !== "string") throw error;
    expect(failure.code).toBe(1);
    return JSON.parse(failure.stdout) as Record<string, unknown>;
  }
}
