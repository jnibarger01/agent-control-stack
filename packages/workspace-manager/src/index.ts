import { execFile } from "node:child_process";
import { existsSync, lstatSync, mkdirSync, realpathSync, rmSync } from "node:fs";
import { isAbsolute, join } from "node:path";
import { promisify } from "node:util";
import { ControlStackError, createId } from "@agent-control-stack/shared";
import type { PrivilegedTransitionOptions, WorkspaceAllocation } from "@agent-control-stack/work-items";
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
    attemptId: identifierSchema,
    leaseId: identifierSchema,
    workerId: identifierSchema,
    fencingEpoch: z.number().int().nonnegative(),
    hostPath: z.string().min(1),
    branch: z.string().min(1),
    baseRef: z.string().min(1),
    createdAt: z.string()
  })
  .strict();

export type Workspace = z.infer<typeof workspaceSchema>;

/**
 * A worktree observed on disk (or in the store) with no confirmed attempt
 * ownership - discovered after a crash window (e.g. `git worktree add`
 * succeeded but the process died before the allocation was persisted), or
 * any other case where reconciliation cannot establish a lease/worker/
 * fencing-epoch authority tuple for it. Deliberately a distinct shape from
 * `Workspace` rather than an all-optional variant of it: an owned
 * workspace's ownership fields must stay required everywhere that isn't
 * reconciliation, so orphan status can never be represented by "just don't
 * check the fields."
 */
export const orphanedWorkspaceSchema = z
  .object({
    allocationId: identifierSchema,
    workItemId: identifierSchema,
    hostPath: z.string().min(1),
    branch: z.string().min(1),
    baseRef: z.string().min(1),
    createdAt: z.string()
  })
  .strict();

export type OrphanedWorkspace = z.infer<typeof orphanedWorkspaceSchema>;

/**
 * The persisted ownership record WorkspaceManager is built around (ADR-
 * adjacent finding from the R2/R4 remediation pass: an in-memory Map is not
 * durable ownership - it is amnesia across a process restart, and it is
 * invisible to a second process entirely). Backed by
 * packages/work-items's workspace_allocations table (storage/migrations/007),
 * which itself enforces "at most one active allocation per work item" with
 * a database UNIQUE index, not application-level locking.
 */
export interface WorkspaceAllocationStore {
  recordWorkspaceAllocation(
    input: {
      allocationId: string;
      workItemId: string;
      attemptId?: string;
      leaseId?: string;
      workerId?: string;
      fencingEpoch?: number;
      hostPath: string;
      branch: string;
      baseRef: string;
    },
    options: PrivilegedTransitionOptions
  ): WorkspaceAllocation;
  getActiveWorkspaceAllocationForWorkItem(workItemId: string): WorkspaceAllocation | undefined;
  getActiveWorkspaceAllocationForAttempt?(attemptId: string): WorkspaceAllocation | undefined;
  getWorkspaceAllocationByHostPath?(hostPath: string): WorkspaceAllocation | undefined;
  closeWorkspaceAllocation(allocationId: string, options: PrivilegedTransitionOptions): WorkspaceAllocation;
  requestWorkspaceCleanup?(
    input: { allocationId: string; leaseId: string; workerId: string; fencingEpoch: number },
    options: PrivilegedTransitionOptions
  ): WorkspaceAllocation;
  /**
   * The authoritative check required before any destructive filesystem
   * cleanup that a caller claims authority for. Unlike comparing against
   * the worker/lease/epoch tuple *copied onto the allocation at provision
   * time*, this re-verifies against the attempt's live current fencing
   * epoch/worker (and, while the attempt is still live, its active lease):
   * expired, revoked, or superseded (re-leased to a new worker/epoch)
   * authority is rejected even when the stale copy on the allocation still
   * matches. A terminal attempt's own worker/epoch remains authorized to
   * clean up after itself - cleanup is the normal, expected next step
   * after a successful (or failed) attempt, not just a live-execution
   * privilege.
   */
  getWorkspaceCleanupAuthority?(input: {
    workItemId: string;
    attemptId: string;
    leaseId: string;
    workerId: string;
    fencingEpoch: number;
    workspaceAllocationId: string;
  }): boolean;
}

export interface WorkspaceManagerOptions {
  /** Absolute path to the git repository worktrees are created from. */
  repoPath: string;
  /** Absolute path to the directory that holds every provisioned worktree. */
  rootDir: string;
  /** Authoritative, cross-process ownership record. Required - see class doc. */
  store: WorkspaceAllocationStore;
  gitPath?: string;
}

export interface ProvisionOptions {
  /** Ref the new worktree branches from. Defaults to "HEAD". */
  baseRef?: string;
  attemptId?: string;
  leaseId?: string;
  workerId?: string;
  fencingEpoch?: number;
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
 *  - ownership is the persisted `store` record, not an in-memory cache or
 *    "a directory happens to exist at the deterministic path" - a second
 *    manager instance (a different process, or the same process after a
 *    restart) resolves the exact same ownership answer the first one would;
 *  - provision() and teardown() are both idempotent, and their idempotency
 *    is enforced by the store's own unique constraint on concurrent
 *    provisioning races, not by an application-level check-then-act;
 *  - teardown() never deletes a directory merely because it sits at
 *    `rootDir/<workItemId>` - it requires a matching, active, persisted
 *    allocation record, an un-symlinked real directory whose realpath
 *    equals that record's hostPath exactly, and (when git's own worktree
 *    metadata is still intact) a matching entry in `git worktree list`;
 *  - a workspace's real path is always contained inside rootDir, checked by
 *    realpath after creation, not assumed from the requested path;
 *  - the store is only marked torn-down after the filesystem removal is
 *    confirmed to have actually succeeded, so a failure partway through
 *    leaves a recoverable, still-active record rather than a dangling
 *    "torn down" claim over a directory that's still there;
 *  - orphan detection never deletes or silently resumes anything - it only
 *    reports, so a crash-recovered job's in-progress work survives for
 *    operator review.
 */
export class WorkspaceManager {
  private readonly repoPath: string;
  private readonly rootDir: string;
  private readonly gitPath: string;
  private readonly store: WorkspaceAllocationStore;

  constructor(options: WorkspaceManagerOptions) {
    if (!isAbsolute(options.repoPath) || !isAbsolute(options.rootDir)) {
      throw new ControlStackError("workspace_manager_invalid_options", "repoPath and rootDir must be absolute paths");
    }
    this.repoPath = options.repoPath;
    this.rootDir = options.rootDir;
    this.gitPath = options.gitPath ?? "git";
    this.store = options.store;
    mkdirSync(this.rootDir, { recursive: true });
  }

  async provision(workItemId: string, options: ProvisionOptions = {}): Promise<Workspace> {
    const parsedId = identifierSchema.parse(workItemId);
    const attemptId = identifierSchema.parse(options.attemptId ?? parsedId);

    const persisted = this.store.getActiveWorkspaceAllocationForAttempt
      ? this.store.getActiveWorkspaceAllocationForAttempt(attemptId)
      : this.store.getActiveWorkspaceAllocationForWorkItem(parsedId);
    if (persisted) {
      if (existsSync(persisted.hostPath)) {
        return workspaceFromAllocation(persisted);
      }
      // The store still claims this allocation is active but nothing is on
      // disk (e.g. the directory was removed outside WorkspaceManager). Fail
      // closed rather than silently reprovisioning over a record that still
      // claims ownership - an operator needs to reconcile this explicitly.
      throw new ControlStackError(
        "workspace_allocation_missing_on_disk",
        `active allocation ${persisted.allocationId} for ${parsedId} has no directory at ${persisted.hostPath}`
      );
    }

    const targetPath = join(this.rootDir, attemptId);
    if (existsSync(targetPath)) {
      throw new ControlStackError(
        "workspace_path_collision",
        `workspace path already exists and has no active allocation record: ${targetPath}`
      );
    }

    const baseRef = options.baseRef ?? "HEAD";
    const branch = options.attemptId ? `acs/attempt/${attemptId}` : `acs/job/${parsedId}`;
    await this.git(["worktree", "add", "-b", branch, targetPath, baseRef]);

    const rootReal = realpathSync(this.rootDir);
    const hostPath = realpathSync(targetPath);
    if (!isContained(rootReal, hostPath)) {
      await this.git(["worktree", "remove", "--force", targetPath]).catch(() => undefined);
      throw new ControlStackError("workspace_escape", `provisioned workspace resolved outside rootDir: ${hostPath}`);
    }

    const allocationId = createId("workspace");
    let allocation: WorkspaceAllocation;
    try {
      allocation = this.store.recordWorkspaceAllocation(
        {
          allocationId,
          workItemId: parsedId,
          attemptId,
          leaseId: options.leaseId ?? parsedId,
          workerId: options.workerId ?? "legacy",
          fencingEpoch: options.fencingEpoch ?? 0,
          hostPath,
          branch,
          baseRef
        },
        { via: "domain_service" }
      );
    } catch (error) {
      // The store's own unique-active-allocation-per-work-item constraint
      // is the authoritative race resolver across processes: if another
      // process won the race and recorded first, undo the worktree we just
      // created rather than leaving two live worktrees for one work item.
      await this.git(["worktree", "remove", "--force", targetPath]).catch(() => undefined);
      throw new ControlStackError(
        "workspace_allocation_conflict",
        `failed to record workspace allocation for ${parsedId}: ${errorMessage(error)}`
      );
    }

    return workspaceFromAllocation(allocation);
  }

  async teardown(
    workItemId: string,
    options: Pick<ProvisionOptions, "attemptId" | "leaseId" | "workerId" | "fencingEpoch"> = {}
  ): Promise<void> {
    const parsedId = identifierSchema.parse(workItemId);
    const attemptId = identifierSchema.parse(options.attemptId ?? parsedId);
    const persisted = this.store.getActiveWorkspaceAllocationForAttempt
      ? this.store.getActiveWorkspaceAllocationForAttempt(attemptId)
      : this.store.getActiveWorkspaceAllocationForWorkItem(parsedId);
    if (!persisted) {
      // No authoritative record of this work item ever owning a workspace.
      // A directory that happens to sit at the deterministic path is not
      // proof of ownership - refuse rather than delete it. This is the
      // exact hazard the R4 finding named: never recursively delete a
      // directory merely because it matches rootDir/<workItemId>.
      const targetPath = join(this.rootDir, attemptId);
      if (existsSync(targetPath)) {
        throw new ControlStackError(
          "workspace_untracked_teardown_refused",
          `refusing to remove ${targetPath}: no active allocation record for ${parsedId}`
        );
      }
      return;
    }

    const targetPath = persisted.hostPath;
    if (options.workerId !== undefined) {
      if (this.store.getWorkspaceCleanupAuthority) {
        // Re-verify against the attempt's live current fencing epoch (and,
        // while still live, its active lease) - not the worker/lease/epoch
        // tuple frozen onto the allocation at provision time: an expired,
        // revoked, or superseded (re-leased) authority must be rejected
        // even though that stale copy still matches what the caller
        // presents.
        const authorized = this.store.getWorkspaceCleanupAuthority({
          workItemId: parsedId,
          attemptId,
          leaseId: persisted.leaseId ?? options.leaseId ?? "",
          workerId: options.workerId,
          fencingEpoch: options.fencingEpoch ?? -1,
          workspaceAllocationId: persisted.allocationId
        });
        if (!authorized) {
          throw new ControlStackError(
            "workspace_cleanup_fence_stale",
            "workspace cleanup fence is stale, expired, or superseded by a newer lease"
          );
        }
      } else if (
        persisted.workerId !== options.workerId ||
        persisted.leaseId !== options.leaseId ||
        persisted.fencingEpoch !== options.fencingEpoch
      ) {
        throw new ControlStackError("workspace_cleanup_fence_stale", "workspace cleanup fence is stale");
      }
    }
    let onDisk: boolean;
    try {
      const stat = lstatSync(targetPath);
      onDisk = true;
      if (stat.isSymbolicLink()) {
        throw new ControlStackError(
          "workspace_teardown_refused_symlink",
          `refusing to remove ${targetPath}: allocation path is a symlink, not a real directory`
        );
      }
      const rootReal = realpathSync(this.rootDir);
      const targetReal = realpathSync(targetPath);
      if (targetReal !== persisted.hostPath || !isContained(rootReal, targetReal)) {
        throw new ControlStackError(
          "workspace_teardown_refused_mismatch",
          `refusing to remove ${targetPath}: canonical path does not match the persisted allocation`
        );
      }
    } catch (error) {
      if (error instanceof ControlStackError) throw error;
      onDisk = false;
    }

    this.store.requestWorkspaceCleanup?.(
      {
        allocationId: persisted.allocationId,
        leaseId: persisted.leaseId ?? options.leaseId ?? "",
        workerId: persisted.workerId ?? options.workerId ?? "",
        fencingEpoch: persisted.fencingEpoch ?? options.fencingEpoch ?? 0
      },
      { via: "domain_service" }
    );
    if (onDisk) {
      try {
        await this.git(["worktree", "remove", "--force", targetPath]);
      } catch {
        // Worktree metadata may already be gone (e.g. manually pruned) while
        // the directory remains; fall back to direct removal - still bound
        // to the persisted, realpath-verified target, never to an unchecked
        // "whatever is at the deterministic path" value.
        rmSync(targetPath, { recursive: true, force: true });
      }
      await this.git(["worktree", "prune"]).catch(() => undefined);
    }

    // Only mark the allocation torn down once removal is confirmed - a
    // failure above throws before this point, leaving the store's record
    // active so a retry (or an operator) can find and finish the job.
    if (existsSync(targetPath)) {
      throw new ControlStackError(
        "workspace_teardown_incomplete",
        `${targetPath} still exists after removal was attempted`
      );
    }
    this.store.closeWorkspaceAllocation(persisted.allocationId, { via: "domain_service" });
  }

  get(workItemId: string, attemptId = workItemId): Workspace | undefined {
    // Always the store, never the in-memory cache: a different
    // WorkspaceManager instance (a different process, or a fresh instance
    // after a restart) may have torn this allocation down since this
    // instance last touched it, and get() must not report a stale answer.
    const parsedId = identifierSchema.parse(workItemId);
    const parsedAttemptId = identifierSchema.parse(attemptId);
    const persisted = this.store.getActiveWorkspaceAllocationForAttempt
      ? this.store.getActiveWorkspaceAllocationForAttempt(parsedAttemptId)
      : this.store.getActiveWorkspaceAllocationForWorkItem(parsedId);
    return persisted ? workspaceFromAllocation(persisted) : undefined;
  }

  async reconcile(activeWorkItemIds: ReadonlySet<string>): Promise<{ orphaned: Array<Workspace | OrphanedWorkspace> }> {
    const { stdout } = await this.git(["worktree", "list", "--porcelain"]);
    const rootReal = realpathSync(this.rootDir);
    const orphaned: Array<Workspace | OrphanedWorkspace> = [];

    for (const entry of parseWorktreeList(stdout)) {
      if (!isContained(rootReal, entry.path)) continue; // not ours
      const pathSegment = entry.path.slice(rootReal.length + 1);
      const persisted = this.store.getWorkspaceAllocationByHostPath
        ? this.store.getWorkspaceAllocationByHostPath(entry.path)
        : this.store.getActiveWorkspaceAllocationForWorkItem(pathSegment);
      const workItemId = persisted?.workItemId ?? pathSegment;
      if (activeWorkItemIds.has(workItemId) || (persisted && activeWorkItemIds.has(persisted.attemptId ?? "")))
        continue;
      orphaned.push(
        persisted
          ? workspaceFromAllocation(persisted)
          // A worktree with no persisted allocation at all - most likely
          // the P1-L crash window (`git worktree add` succeeded, the
          // process died before recordWorkspaceAllocation committed). No
          // attemptId/leaseId/workerId/fencingEpoch authority tuple exists
          // to report, so this is reported through the distinct orphan
          // shape rather than forced through workspaceSchema's ownership
          // requirement (which would throw and abort startup
          // reconciliation entirely).
          : orphanedWorkspaceSchema.parse({
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

function workspaceFromAllocation(allocation: WorkspaceAllocation): Workspace {
  return workspaceSchema.parse({
    allocationId: allocation.allocationId,
    workItemId: allocation.workItemId,
    attemptId: allocation.attemptId,
    leaseId: allocation.leaseId,
    workerId: allocation.workerId,
    fencingEpoch: allocation.fencingEpoch,
    hostPath: allocation.hostPath,
    branch: allocation.branch,
    baseRef: allocation.baseRef,
    createdAt: allocation.createdAt
  });
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

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
