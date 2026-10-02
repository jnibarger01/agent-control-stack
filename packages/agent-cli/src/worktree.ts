import { execFile } from "node:child_process";
import { mkdirSync, realpathSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { isAbsolute, join, resolve, sep } from "node:path";
import { promisify } from "node:util";
import { ControlStackError } from "@agent-control-stack/shared";

const execFileAsync = promisify(execFile);

export interface DispatchWorktree {
  repoRoot: string;
  worktreePath: string;
  branch: string;
  baseCommit: string;
}

/** Where agent worktrees live. Always outside the repository so a run cannot dirty the main checkout. */
export function defaultWorktreeRoot(env: NodeJS.ProcessEnv = process.env): string {
  return resolve(env.ACS_AGENT_WORKTREE_ROOT?.trim() || join(env.HOME ?? homedir(), ".acs", "agent-worktrees"));
}

/** Colon-separated allow-list of directories a run may start in. Unset means no repo is allowed. */
export function allowedRepoRoots(env: NodeJS.ProcessEnv = process.env): string[] {
  return (env.ACS_AGENT_REPO_ROOTS ?? "")
    .split(":")
    .map((entry) => entry.trim())
    .filter(Boolean)
    .map((entry) => {
      try {
        return realpathSync(entry);
      } catch {
        return resolve(entry);
      }
    });
}

function gitRaw(cwd: string, args: string[]): Promise<string> {
  return execFileAsync("git", args, { cwd, timeout: 60_000, maxBuffer: 4 * 1024 * 1024 }).then((r) => r.stdout);
}

function git(cwd: string, args: string[]): Promise<string> {
  return gitRaw(cwd, args).then((out) => out.trim());
}

/** Resolve the repository top level for a requested path and require it to sit inside an allowed root. */
export async function resolveRepoRoot(requested: string, allowedRoots: readonly string[]): Promise<string> {
  if (!isAbsolute(requested)) {
    throw new ControlStackError("agent_repo_invalid", "repo must be an absolute path");
  }
  let real: string;
  try {
    real = realpathSync(requested);
    if (!statSync(real).isDirectory()) throw new Error("not a directory");
  } catch {
    throw new ControlStackError("agent_repo_invalid", "repo does not exist or is not a directory");
  }
  let top: string;
  try {
    top = realpathSync(await git(real, ["rev-parse", "--show-toplevel"]));
  } catch {
    throw new ControlStackError("agent_repo_invalid", "repo is not a git repository");
  }
  const inside = allowedRoots.some((root) => top === root || top.startsWith(root + sep));
  if (!inside) {
    throw new ControlStackError("agent_repo_not_allowed", "repo is outside ACS_AGENT_REPO_ROOTS");
  }
  return top;
}

export async function createDispatchWorktree(input: {
  repoRoot: string;
  runId: string;
  agentId: string;
  worktreeRoot?: string;
}): Promise<DispatchWorktree> {
  if (!/^[A-Za-z0-9._-]+$/u.test(input.runId) || !/^[A-Za-z0-9._-]+$/u.test(input.agentId)) {
    throw new ControlStackError("agent_run_invalid", "run and agent ids must be simple identifiers");
  }
  const root = resolve(input.worktreeRoot ?? defaultWorktreeRoot());
  mkdirSync(root, { recursive: true, mode: 0o700 });
  const worktreePath = join(root, input.runId);
  const branch = `acs/agent/${input.agentId}-${input.runId}`;
  const baseCommit = await git(input.repoRoot, ["rev-parse", "HEAD"]);
  await git(input.repoRoot, ["worktree", "add", "-b", branch, worktreePath, baseCommit]);
  return { repoRoot: input.repoRoot, worktreePath: realpathSync(worktreePath), branch, baseCommit };
}

export interface WorktreeChanges {
  changedFiles: string[];
  diffStat: string;
  commitsAhead: number;
}

/** What the agent left behind. Read-only inspection; nothing is committed, merged or pushed. */
export async function inspectWorktree(worktree: DispatchWorktree): Promise<WorktreeChanges> {
  // Not trimmed: the first status column is a space for unstaged changes.
  const status = await gitRaw(worktree.worktreePath, ["status", "--porcelain"]);
  const changedFiles = status
    .split("\n")
    .filter((line) => line.length > 3)
    .map((line) => line.slice(3).trim())
    .slice(0, 200);
  const diffStat = await git(worktree.worktreePath, ["diff", "--stat", worktree.baseCommit]).catch(() => "");
  const ahead = await git(worktree.worktreePath, ["rev-list", "--count", `${worktree.baseCommit}..HEAD`]).catch(
    () => "0"
  );
  return { changedFiles, diffStat: diffStat.slice(-4_000), commitsAhead: Number.parseInt(ahead, 10) || 0 };
}
