import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { createHash } from "node:crypto";

const execFileAsync = promisify(execFile);

/**
 * A deterministic digest of a worktree: the committed tree plus a hash of the
 * porcelain working-tree status. Two worktrees with the same committed HEAD and
 * the same uncommitted changes produce the same revision; any material change
 * (a new/edited/deleted tracked-or-untracked file) changes it.
 *
 * This is the value `AdmittedPlan.workspace.baseRevision` binds. Execution
 * authority binds to the revision the plan was authorized against; drift
 * outside the authorized attempt fails closed (TOCTOU).
 */

export interface WorkspaceRevisionResult {
  revision: string;
  head: string;
  dirty: boolean;
}

async function git(cwd: string, args: string[], gitPath = "git"): Promise<string> {
  const { stdout } = await execFileAsync(gitPath, args, { cwd, maxBuffer: 16 * 1024 * 1024 });
  return stdout;
}

export async function computeWorkspaceRevision(
  hostPath: string,
  gitPath = "git"
): Promise<WorkspaceRevisionResult> {
  let head = "0000000000000000000000000000000000000000";
  try {
    head = (await git(hostPath, ["rev-parse", "HEAD"], gitPath)).trim();
  } catch {
    // No commits yet — head stays the zero oid.
  }
  const status = await git(hostPath, ["status", "--porcelain=v1", "-z", "--untracked-files=all"], gitPath);
  const statusHash = createHash("sha256").update(status, "utf8").digest("hex");
  const revision = createHash("sha256")
    .update("acs:workspace-revision:v1\n", "utf8")
    .update(`${head}\n`, "utf8")
    .update(statusHash, "utf8")
    .digest("hex");
  return { revision, head, dirty: status.length > 0 };
}

export interface WorkspaceDriftResult {
  drifted: boolean;
  /** Paths changed relative to the base revision (from `git status`). */
  changedPaths: string[];
  /** Paths changed that are NOT among the attempt's authorized change set. */
  unauthorizedPaths: string[];
}

/**
 * Detect whether a workspace changed relative to the base revision the plan was
 * authorized against. `authorizedChangedPaths` is the set the governed attempt
 * itself is expected to touch (from the admitted plan's `expectedFiles` or a
 * prior evidence manifest); anything else is drift outside the attempt.
 */
export async function detectWorkspaceDrift(
  hostPath: string,
  baseRevision: string,
  authorizedChangedPaths: readonly string[] = [],
  gitPath = "git"
): Promise<WorkspaceDriftResult> {
  const current = await computeWorkspaceRevision(hostPath, gitPath);
  const authorized = new Set(authorizedChangedPaths.map((p) => p.replace(/^\.\//, "")));
  const status = await git(hostPath, ["status", "--porcelain=v1", "-z", "--untracked-files=all"], gitPath);
  const changedPaths = status
    .split("\0")
    .map((entry) => entry.slice(3).trim())
    .filter((p) => p.length > 0);
  const unauthorizedPaths = changedPaths.filter((p) => !authorized.has(p.replace(/^\.\//, "")));
  return {
    drifted: current.revision !== baseRevision,
    changedPaths,
    unauthorizedPaths
  };
}
