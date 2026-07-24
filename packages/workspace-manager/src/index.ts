import { execFile } from "node:child_process";
import { existsSync, mkdirSync, realpathSync, rmSync } from "node:fs";
import { isAbsolute, join } from "node:path";
import { promisify } from "node:util";
import { ControlStackError, createId } from "@agent-control-stack/shared";
import { z } from "zod";

const execFileAsync = promisify(execFile);

// Mirrors packages/sandbox/src/contracts.ts's identifierSchema and
// absolutePathSchema shape so a Workspace can flow directly into a
// SandboxExecutionRequest's `workspace: { allocationId, hostPath }` field.
const identifierSchema = z
  .string()
  .min(1)
  .max(128)
  .regex(/^[A-Za-z0-9][A-Za-z0-9._:-]*$/u);

export const workspaceSchema = z
  .object({
    allocationId: identifierSchema,
    workItemId: identifierSchema,
    hostPath: z.string().min(1),
    branch: z.string().min(1),
    baseRef: z.string().min(1),
    createdAt: z.string()
  })
  .strict();

export type Workspace = z.infer<typeof workspaceSchema>;

export interface WorkspaceManagerOptions {
  /** Absolute path to the git repository worktrees are created from. */
  repoPath: string;
  /** Absolute path to the directory that holds every provisioned worktree. */
  rootDir: string;
  gitPath?: string;
}

export interface ProvisionOptions {
  /** Ref the new worktree branches from. Defaults to "HEAD". */
  baseRef?: string;
}

interface WorktreeListEntry {
  path: string;
  branch?: string;
}

/**
 * One git worktree per job. Single-repository scope (MVH) - repoPath is
 * fixed per instance, not per call; multi-repo jobs are out of scope until
 * something actually needs them.
 *
 * Invariants this class exists to hold:
 *  - no two concurrent jobs ever observe overlapping paths (workItemId maps
 *    1:1 to a path under rootDir, and provision() refuses to reuse a path
 *    it doesn't already own);
 *  - teardown() and provision() are both idempotent;
 *  - a provisioned workspace's real path is always contained inside rootDir,
 *    checked by realpath after creation, not assumed from the requested path;
 *  - orphan detection never deletes or silently resumes anything - it only
 *    reports, so a crash-recovered job's in-progress work survives for
 *    operator review.
 */
export class WorkspaceManager {
  private readonly repoPath: string;
  private readonly rootDir: string;
  private readonly gitPath: string;
  private readonly allocations = new Map<string, Workspace>();

  constructor(options: WorkspaceManagerOptions) {
    if (!isAbsolute(options.repoPath) || !isAbsolute(options.rootDir)) {
      throw new ControlStackError("workspace_manager_invalid_options", "repoPath and rootDir must be absolute paths");
    }
    this.repoPath = options.repoPath;
    this.rootDir = options.rootDir;
    this.gitPath = options.gitPath ?? "git";
    mkdirSync(this.rootDir, { recursive: true });
  }

  async provision(workItemId: string, options: ProvisionOptions = {}): Promise<Workspace> {
    const parsedId = identifierSchema.parse(workItemId);

    const existing = this.allocations.get(parsedId);
    if (existing) {
      if (existsSync(existing.hostPath)) return existing;
      this.allocations.delete(parsedId);
    }

    const targetPath = join(this.rootDir, parsedId);
    if (existsSync(targetPath)) {
      throw new ControlStackError(
        "workspace_path_collision",
        `workspace path already exists and is not tracked by this manager: ${targetPath}`
      );
    }

    const baseRef = options.baseRef ?? "HEAD";
    const branch = `acs/job/${parsedId}`;
    await this.git(["worktree", "add", "-b", branch, targetPath, baseRef]);

    const rootReal = realpathSync(this.rootDir);
    const hostPath = realpathSync(targetPath);
    if (!isContained(rootReal, hostPath)) {
      await this.git(["worktree", "remove", "--force", targetPath]).catch(() => undefined);
      throw new ControlStackError("workspace_escape", `provisioned workspace resolved outside rootDir: ${hostPath}`);
    }

    const workspace = workspaceSchema.parse({
      allocationId: createId("workspace"),
      workItemId: parsedId,
      hostPath,
      branch,
      baseRef,
      createdAt: new Date().toISOString()
    });
    this.allocations.set(parsedId, workspace);
    return workspace;
  }

  async teardown(workItemId: string): Promise<void> {
    const parsedId = identifierSchema.parse(workItemId);
    const existing = this.allocations.get(parsedId);
    const targetPath = existing?.hostPath ?? join(this.rootDir, parsedId);
    this.allocations.delete(parsedId);

    if (!existsSync(targetPath)) return;

    try {
      await this.git(["worktree", "remove", "--force", targetPath]);
    } catch {
      // Worktree metadata may already be gone (e.g. manually pruned) while the
      // directory remains; fall back to direct removal, still contained-checked.
      const rootReal = realpathSync(this.rootDir);
      const targetReal = realpathSync(targetPath);
      if (isContained(rootReal, targetReal)) {
        rmSync(targetReal, { recursive: true, force: true });
      }
    }
    await this.git(["worktree", "prune"]).catch(() => undefined);
  }

  get(workItemId: string): Workspace | undefined {
    return this.allocations.get(identifierSchema.parse(workItemId));
  }

  async reconcile(activeWorkItemIds: ReadonlySet<string>): Promise<{ orphaned: Workspace[] }> {
    const { stdout } = await this.git(["worktree", "list", "--porcelain"]);
    const rootReal = realpathSync(this.rootDir);
    const orphaned: Workspace[] = [];

    for (const entry of parseWorktreeList(stdout)) {
      if (!isContained(rootReal, entry.path)) continue; // not ours
      const workItemId = entry.path.slice(rootReal.length + 1);
      if (activeWorkItemIds.has(workItemId)) continue;

      orphaned.push(
        this.allocations.get(workItemId) ??
          workspaceSchema.parse({
            allocationId: createId("workspace"),
            workItemId,
            hostPath: entry.path,
            branch: entry.branch ?? "unknown",
            baseRef: "unknown",
            createdAt: new Date(0).toISOString()
          })
      );
    }
    return { orphaned };
  }

  private async git(args: string[]): Promise<{ stdout: string; stderr: string }> {
    try {
      return await execFileAsync(this.gitPath, args, { cwd: this.repoPath });
    } catch (error) {
      const failure = error as Error & { stderr?: string };
      throw new ControlStackError(
        "workspace_git_failed",
        `git ${args.join(" ")} failed: ${failure.stderr ?? failure.message}`
      );
    }
  }
}

function isContained(rootReal: string, candidateReal: string): boolean {
  return candidateReal === rootReal || candidateReal.startsWith(`${rootReal}/`);
}

function parseWorktreeList(porcelain: string): WorktreeListEntry[] {
  const entries: WorktreeListEntry[] = [];
  let current: WorktreeListEntry | undefined;
  for (const line of porcelain.split("\n")) {
    if (line.startsWith("worktree ")) {
      if (current) entries.push(current);
      current = { path: line.slice("worktree ".length) };
    } else if (line.startsWith("branch ") && current) {
      current.branch = line.slice("branch ".length).replace(/^refs\/heads\//u, "");
    }
  }
  if (current) entries.push(current);
  return entries;
}
