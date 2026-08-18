import { execFile } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { describe, expect, it, vi } from "vitest";
import { publishValidatedAttempt, type PublicationRecord } from "./index.js";

const execFileAsync = promisify(execFile);
async function git(cwd: string, ...args: string[]): Promise<string> {
  const result = await execFileAsync("git", args, { cwd });
  return result.stdout.trim();
}

function store() {
  const records = new Map<string, PublicationRecord>();
  return { getByIdempotency: (key: string) => records.get(key), record: (record: PublicationRecord) => { records.set(record.idempotencyKey, record); return record; }, records };
}

describe("Phase A publication E2E", () => {
  it("retries after a crash between push and PR persistence using the real bare remote", async () => {
    const root = mkdtempSync(join(tmpdir(), "acs-publication-e2e-"));
    const repo = join(root, "repo");
    const bare = join(root, "remote.git");
    try {
      await execFileAsync("git", ["init", "--initial-branch=main", repo]);
      await execFileAsync("git", ["init", "--bare", bare]);
      await execFileAsync("git", ["config", "user.email", "test@example.com"], { cwd: repo });
      await execFileAsync("git", ["config", "user.name", "Test"], { cwd: repo });
      writeFileSync(join(repo, "README.md"), "initial\n", "utf8");
      await execFileAsync("git", ["add", "README.md"], { cwd: repo });
      await execFileAsync("git", ["commit", "-m", "initial"], { cwd: repo });
      await execFileAsync("git", ["remote", "add", "origin", bare], { cwd: repo });
      await execFileAsync("git", ["push", "origin", "main"], { cwd: repo });
      await execFileAsync("git", ["checkout", "-b", "acs/attempt/attempt-e2e"], { cwd: repo });
      writeFileSync(join(repo, "change.txt"), "validated change\n", "utf8");

      const firstStore = store();
      const github = { createOrUpdate: vi.fn()
        .mockRejectedValueOnce(new Error("simulated process crash after push"))
        .mockResolvedValue({ url: "https://github.com/acme/repo/pull/42" }) };
      const input = { workItemId: "work-e2e", attemptId: "attempt-e2e", workspacePath: repo, branch: "acs/attempt/attempt-e2e", remote: "origin", title: "Validated change", body: "Evidence", validationPassed: true, leaseIsCurrent: vi.fn(async () => true) };

      await expect(publishValidatedAttempt(input, firstStore, github)).rejects.toThrow("simulated process crash");
      const pushedSha = await git(repo, "rev-parse", "HEAD");
      expect(await git(bare, "show-ref", "--hash", "refs/heads/acs/attempt/attempt-e2e")).toBe(pushedSha);
      expect(firstStore.records.size).toBe(0);

      const secondStore = store();
      const retry = await publishValidatedAttempt(input, secondStore, github);
      expect(retry.commitSha).toBe(pushedSha);
      expect(retry.pullRequestUrl).toContain("/pull/42");
      expect(secondStore.records.size).toBe(1);
      expect(github.createOrUpdate).toHaveBeenCalledTimes(2);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  }, 30_000);
});
