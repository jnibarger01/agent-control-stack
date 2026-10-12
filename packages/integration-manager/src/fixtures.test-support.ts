import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import type { PullRequestSnapshot } from "./types.js";

const IDENT = ["-c", "user.name=Test", "-c", "user.email=test@example.test", "-c", "commit.gpgsign=false"];

export function git(cwd: string, ...args: string[]): string {
  return execFileSync("git", [...IDENT, ...args], { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();
}

/** A scratch repository with a `main` branch. Remove `dir` when done. */
export class Scratch {
  readonly dir = mkdtempSync(join(tmpdir(), "acs-integration-"));
  constructor() {
    git(this.dir, "init", "-q", "-b", "main");
  }
  write(path: string, content: string) {
    const full = join(this.dir, path);
    mkdirSync(dirname(full), { recursive: true });
    writeFileSync(full, content);
  }
  commit(message: string, files: Record<string, string>): string {
    for (const [path, content] of Object.entries(files)) this.write(path, content);
    git(this.dir, "add", "-A");
    git(this.dir, "commit", "-q", "-m", message);
    return git(this.dir, "rev-parse", "HEAD");
  }
  /** Create `branch` from `from`, commit `files` on it, and return to main. Returns the branch tip. */
  branch(branch: string, from: string, files: Record<string, string>): string {
    git(this.dir, "checkout", "-q", "-b", branch, from);
    const tip = this.commit(`work on ${branch}`, files);
    git(this.dir, "checkout", "-q", "main");
    return tip;
  }
  /** Fast-forward `main` with a new commit (simulates another PR merging). */
  advanceMain(files: Record<string, string>): string {
    git(this.dir, "checkout", "-q", "main");
    return this.commit("advance main", files);
  }
  refs(): string {
    return git(this.dir, "for-each-ref", "--format=%(refname) %(objectname)");
  }
  status(): string {
    return git(this.dir, "status", "--porcelain");
  }
  dispose() {
    rmSync(this.dir, { recursive: true, force: true });
  }
}

export function pr(overrides: Partial<PullRequestSnapshot> & { number: number }): PullRequestSnapshot {
  return {
    title: `pr ${overrides.number}`,
    author: "jnibarger01",
    state: "OPEN",
    isDraft: false,
    isCrossRepository: false,
    headRef: `branch-${overrides.number}`,
    headSha: "0".repeat(40),
    baseRef: "main",
    mergeable: "MERGEABLE",
    reviewDecision: null,
    unresolvedThreads: 0,
    checks: [{ name: "test", status: "COMPLETED", conclusion: "SUCCESS" }],
    changedFiles: [],
    truncated: { threads: false, checks: false, files: false },
    ...overrides
  };
}
