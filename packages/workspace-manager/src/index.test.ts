import { execFile, execFileSync, spawn } from "node:child_process";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync
} from "node:fs";
import { hostname, tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { ControlStackError } from "@agent-control-stack/shared";
import {
  defaultExecutionPlanForWorkItem,
  SqliteWorkItemStore,
  type WorkspaceAllocation,
  type WorkItemStore
} from "@agent-control-stack/work-items";
import { afterEach, describe, expect, it, vi } from "vitest";
import { WorkspaceManager, type WorkspaceAllocationStore } from "./index.js";

const execFileAsync = promisify(execFile);

const sleep = (ms: number) => new Promise((resolveSleep) => setTimeout(resolveSleep, ms));

async function deadPid(): Promise<number> {
  const dead = spawn(process.execPath, ["-e", ""]);
  await new Promise((resolveExit) => dead.once("exit", resolveExit));
  return dead.pid!;
}

function canUnsharePidNamespace(): boolean {
  try {
    execFileSync("unshare", ["-rpf", "--mount-proc", "true"], { stdio: "ignore", timeout: 5_000 });
    return true;
  } catch {
    return false;
  }
}

interface KernelLockHolder {
  innerPid: number;
  release: () => Promise<void>;
  kill: () => void;
  stillHeld: () => Promise<boolean>;
}

/** Holds flock(2) on lockPath from a separate process (optionally wrapped, e.g. in a new pid namespace). */
async function holdKernelLock(lockPath: string, wrapper: string[] = []): Promise<KernelLockHolder> {
  const argv = [...wrapper, "flock", "--exclusive", lockPath, "sh", "-c", 'echo "held $$"; exec sleep 60'];
  const child = spawn(argv[0]!, argv.slice(1), { detached: true, stdio: ["ignore", "pipe", "inherit"] });
  const exited = new Promise<void>((resolveExit) => child.once("exit", () => resolveExit()));
  const innerPid = await new Promise<number>((resolveHeld, rejectHeld) => {
    let buffered = "";
    child.stdout!.setEncoding("utf8").on("data", (chunk: string) => {
      buffered += chunk;
      const match = /held (\d+)/u.exec(buffered);
      if (match) resolveHeld(Number(match[1]));
    });
    child.once("exit", (code) => rejectHeld(new Error(`lock holder exited early (${code})`)));
  });
  const kill = () => {
    try {
      process.kill(-child.pid!, "SIGKILL");
    } catch {
      // Already gone.
    }
  };
  return {
    innerPid,
    kill,
    release: async () => {
      kill();
      await exited;
    },
    stillHeld: async () => {
      try {
        await execFileAsync("flock", ["--exclusive", "--nonblock", lockPath, "true"]);
        return false;
      } catch {
        return true;
      }
    }
  };
}

interface OverlapShim {
  dir: string;
  gitPath: string;
  realGit: string;
  cleanup: () => void;
}

/** A git shim that records any two overlapping `git worktree` commands (atomic mkdir), across processes. */
async function createOverlapGitShim(): Promise<OverlapShim> {
  const dir = mkdtempSync(join(tmpdir(), "acs-workspace-manager-gitshim-"));
  const realGit = (await execFileAsync("sh", ["-c", "command -v git"])).stdout.trim();
  const gitPath = join(dir, "git");
  writeFileSync(
    gitPath,
    [
      "#!/bin/sh",
      'if [ "$1" != "worktree" ]; then exec "$REAL_GIT" "$@"; fi',
      'if ! mkdir "$SHIM_DIR/in-flight" 2>/dev/null; then touch "$SHIM_DIR/overlap"; fi',
      "sleep 0.05",
      '"$REAL_GIT" "$@"',
      "status=$?",
      'rmdir "$SHIM_DIR/in-flight" 2>/dev/null',
      "exit $status",
      ""
    ].join("\n"),
    { mode: 0o755 }
  );
  return { dir, gitPath, realGit, cleanup: () => rmSync(dir, { recursive: true, force: true }) };
}

const managerModule = fileURLToPath(new URL("./index.ts", import.meta.url));
const workItemsModule = fileURLToPath(new URL("../../work-items/src/index.ts", import.meta.url));
const tsxLoader = new URL("../../../node_modules/tsx/dist/loader.mjs", import.meta.url).href;
const tsxBin = fileURLToPath(new URL("../../../node_modules/.bin/tsx", import.meta.url));

/** Runs a WorkspaceManager in a separate node process that provisions `ids` against the shared repo. */
async function runChildManager(
  fixture: { repoPath: string; rootDir: string; dbPath: string },
  shim: OverlapShim,
  job: { ids: string[] }
): Promise<{ code: number | null; stderr: string }> {
  const script = [
    `import { WorkspaceManager } from ${JSON.stringify(managerModule)};`,
    `import { SqliteWorkItemStore } from ${JSON.stringify(workItemsModule)};`,
    `const store = new SqliteWorkItemStore(${JSON.stringify(fixture.dbPath)});`,
    `const manager = new WorkspaceManager({ repoPath: ${JSON.stringify(fixture.repoPath)}, rootDir: ${JSON.stringify(fixture.rootDir)}, store, gitPath: ${JSON.stringify(shim.gitPath)} });`,
    `for (const id of ${JSON.stringify(job.ids)}) await manager.provision(id);`
  ].join("\n");
  const scriptPath = join(shim.dir, `child-${Math.random().toString(36).slice(2)}.mts`);
  writeFileSync(scriptPath, script, "utf8");
  const child = spawn(tsxBin, [scriptPath], {
    env: { ...process.env, REAL_GIT: shim.realGit, SHIM_DIR: shim.dir },
    stdio: ["ignore", "ignore", "pipe"]
  });
  let stderr = "";
  child.stderr.setEncoding("utf8").on("data", (chunk: string) => (stderr += chunk));
  const code = await new Promise<number | null>((resolveExit) => child.once("exit", resolveExit));
  return { code, stderr };
}

async function createRepoFixture(): Promise<{
  repoPath: string;
  dbPath: string;
  rootDir: string;
  store: WorkItemStore;
  cleanup: () => void;
}> {
  const base = mkdtempSync(join(tmpdir(), "acs-workspace-manager-"));
  const repoPath = join(base, "repo");
  const rootDir = join(base, "workspaces");
  mkdirSync(repoPath, { recursive: true });
  mkdirSync(rootDir, { recursive: true });

  await execFileAsync("git", ["init", "--initial-branch=main"], { cwd: repoPath });
  await execFileAsync("git", ["config", "user.email", "test@example.com"], { cwd: repoPath });
  await execFileAsync("git", ["config", "user.name", "Test"], { cwd: repoPath });
  writeFileSync(join(repoPath, "README.md"), "fixture repo\n", "utf8");
  await execFileAsync("git", ["add", "README.md"], { cwd: repoPath });
  await execFileAsync("git", ["commit", "-m", "initial commit"], { cwd: repoPath });

  const store = new SqliteWorkItemStore(join(base, "control.db"));
  return {
    repoPath,
    rootDir,
    dbPath: join(base, "control.db"),
    store,
    cleanup: () => rmSync(base, { recursive: true, force: true })
  };
}

/** workspace_allocations.work_item_id has a real FK to work_items(id); returns the store-assigned id. */
function seedWorkItemId(store: WorkItemStore, label: string): string {
  const workItem = store.create({
    title: `Fixture ${label}`,
    requester: "user",
    requesterSubject: "actor-user",
    intent: "workspace manager fixture",
    target: { cwd: "/repo", files: [] },
    requestedActions: [{ kind: "fs.read", description: "inspect", params: { paths: [], write: false } }],
    risk: "low"
  });
  return workItem.id;
}

describe("WorkspaceManager", () => {
  let cleanup: (() => void) | undefined;

  afterEach(() => {
    vi.useRealTimers();
    cleanup?.();
    cleanup = undefined;
  });

  it("provisions a real, checked-out worktree scoped under rootDir", async () => {
    const fixture = await createRepoFixture();
    cleanup = fixture.cleanup;
    const manager = new WorkspaceManager({
      repoPath: fixture.repoPath,
      rootDir: fixture.rootDir,
      store: fixture.store
    });
    const workItemId = seedWorkItemId(fixture.store, "one");

    const workspace = await manager.provision(workItemId);

    expect(workspace.workItemId).toBe(workItemId);
    expect(workspace.branch).toBe(`acs/job/${workItemId}`);
    expect(existsSync(join(workspace.hostPath, "README.md"))).toBe(true);
    expect(readFileSync(join(workspace.hostPath, "README.md"), "utf8")).toBe("fixture repo\n");
    expect(workspace.hostPath.startsWith(fixture.rootDir)).toBe(true);
    expect(fixture.store.getActiveWorkspaceAllocationForWorkItem(workItemId)).toMatchObject({
      hostPath: workspace.hostPath,
      status: "active"
    });
  });

  it("is idempotent: re-provisioning the same job returns the existing workspace", async () => {
    const fixture = await createRepoFixture();
    cleanup = fixture.cleanup;
    const manager = new WorkspaceManager({
      repoPath: fixture.repoPath,
      rootDir: fixture.rootDir,
      store: fixture.store
    });
    const workItemId = seedWorkItemId(fixture.store, "one");

    const first = await manager.provision(workItemId);
    const second = await manager.provision(workItemId);

    expect(second).toEqual(first);
  });

  it("never lets two concurrent jobs share a mutable directory", async () => {
    const fixture = await createRepoFixture();
    cleanup = fixture.cleanup;
    const manager = new WorkspaceManager({
      repoPath: fixture.repoPath,
      rootDir: fixture.rootDir,
      store: fixture.store
    });
    const jobA = seedWorkItemId(fixture.store, "a");
    const jobB = seedWorkItemId(fixture.store, "b");

    const [a, b] = await Promise.all([manager.provision(jobA), manager.provision(jobB)]);

    expect(a.hostPath).not.toBe(b.hostPath);
    writeFileSync(join(a.hostPath, "only-in-a.txt"), "a\n", "utf8");
    expect(existsSync(join(b.hostPath, "only-in-a.txt"))).toBe(false);
  });

  it("regression: serializes every git worktree command per repository, across manager instances", async () => {
    // CI run 39508664541 flaked with `fatal: failed to read
    // .git/worktrees/<id>/commondir: Success`: concurrent `git worktree`
    // commands on one repo race on git's admin dirs. A git shim marks a
    // worktree command as in flight (atomic mkdir) and holds it open briefly,
    // so any two overlapping worktree commands are recorded deterministically
    // instead of depending on hitting git's narrow race window.
    const fixture = await createRepoFixture();
    cleanup = fixture.cleanup;
    const shimDir = mkdtempSync(join(tmpdir(), "acs-workspace-manager-gitshim-"));
    const previousCleanup = cleanup;
    cleanup = () => {
      previousCleanup();
      rmSync(shimDir, { recursive: true, force: true });
    };
    const realGit = (await execFileAsync("sh", ["-c", "command -v git"])).stdout.trim();
    const gitShim = join(shimDir, "git");
    writeFileSync(
      gitShim,
      [
        "#!/bin/sh",
        'if [ "$1" != "worktree" ]; then exec "$REAL_GIT" "$@"; fi',
        'if ! mkdir "$SHIM_DIR/in-flight" 2>/dev/null; then touch "$SHIM_DIR/overlap"; fi',
        "sleep 0.05",
        '"$REAL_GIT" "$@"',
        "status=$?",
        'rmdir "$SHIM_DIR/in-flight" 2>/dev/null',
        "exit $status",
        ""
      ].join("\n"),
      { mode: 0o755 }
    );
    vi.stubEnv("REAL_GIT", realGit);
    vi.stubEnv("SHIM_DIR", shimDir);
    try {
      const managers = [0, 1].map(
        () =>
          new WorkspaceManager({
            repoPath: fixture.repoPath,
            rootDir: fixture.rootDir,
            store: fixture.store,
            gitPath: gitShim
          })
      );
      const ids = Array.from({ length: 8 }, (_, index) => seedWorkItemId(fixture.store, `serial-${index}`));
      await Promise.all(ids.map((id, index) => managers[index % 2]!.provision(id)));
      await Promise.all([
        ...ids.slice(0, 4).map((id, index) => managers[index % 2]!.teardown(id)),
        managers[0]!.reconcile(new Set(ids))
      ]);
      expect(existsSync(join(shimDir, "overlap"))).toBe(false);
    } finally {
      vi.unstubAllEnvs();
    }
  });

  describe("cross-process worktree lock (flock(2) on <git common dir>/acs-worktree.lock)", () => {
    it("waits for a lock held by another live process, then proceeds once it is released", async () => {
      const fixture = await createRepoFixture();
      cleanup = fixture.cleanup;
      const lockPath = join(fixture.repoPath, ".git", "acs-worktree.lock");
      const holder = await holdKernelLock(lockPath);
      const manager = new WorkspaceManager({
        repoPath: fixture.repoPath,
        rootDir: fixture.rootDir,
        store: fixture.store
      });
      const workItemId = seedWorkItemId(fixture.store, "locked");
      let settled = false;
      const pending = manager.provision(workItemId).finally(() => {
        settled = true;
      });
      await sleep(400);
      expect(settled).toBe(false);
      expect(existsSync(join(fixture.rootDir, workItemId))).toBe(false);
      await holder.release();
      const workspace = await pending;
      expect(existsSync(join(workspace.hostPath, "README.md"))).toBe(true);
    });

    it("finding 1: never lets a live holder be displaced by 'stale lock breaking', even when the file names a dead pid", async () => {
      // The old pid-file lock broke any lock whose recorded pid was dead,
      // which is exactly what two racing breakers turn a live lock into.
      const fixture = await createRepoFixture();
      cleanup = fixture.cleanup;
      const lockPath = join(fixture.repoPath, ".git", "acs-worktree.lock");
      const holder = await holdKernelLock(lockPath);
      writeFileSync(lockPath, `${await deadPid()}@${hostname()}\n`, "utf8");
      const manager = new WorkspaceManager({
        repoPath: fixture.repoPath,
        rootDir: fixture.rootDir,
        store: fixture.store
      });
      const workItemId = seedWorkItemId(fixture.store, "displace");
      let settled = false;
      const pending = manager.provision(workItemId).finally(() => {
        settled = true;
      });
      await sleep(400);
      expect(settled).toBe(false);
      expect(existsSync(join(fixture.rootDir, workItemId))).toBe(false);
      await holder.release();
      await pending;
    });

    it("finding 1: serializes worktree commands across 4 child processes starting from a dead-pid lock file", async () => {
      const fixture = await createRepoFixture();
      const shim = await createOverlapGitShim();
      cleanup = () => {
        fixture.cleanup();
        shim.cleanup();
      };
      writeFileSync(join(fixture.repoPath, ".git", "acs-worktree.lock"), `${await deadPid()}@${hostname()}\n`, "utf8");
      const children = Array.from({ length: 4 }, (_, child) =>
        runChildManager(fixture, shim, {
          ids: Array.from({ length: 3 }, (_, index) => seedWorkItemId(fixture.store, `proc-${child}-${index}`))
        })
      );
      const results = await Promise.all(children);
      for (const result of results) expect(result).toMatchObject({ code: 0 });
      expect(existsSync(join(shim.dir, "overlap"))).toBe(false);
    }, 60_000);

    it("finding 2: release never deletes the lock path, so it cannot remove another owner's lock", async () => {
      const fixture = await createRepoFixture();
      cleanup = fixture.cleanup;
      const lockPath = join(fixture.repoPath, ".git", "acs-worktree.lock");
      const manager = new WorkspaceManager({
        repoPath: fixture.repoPath,
        rootDir: fixture.rootDir,
        store: fixture.store
      });
      await manager.provision(seedWorkItemId(fixture.store, "first"));
      const inode = statSync(lockPath).ino;
      // Another process takes the lock right after our release; our next
      // release must leave its lock (same inode, still held) untouched.
      const holder = await holdKernelLock(lockPath);
      const quick = new WorkspaceManager({
        repoPath: fixture.repoPath,
        rootDir: fixture.rootDir,
        store: fixture.store,
        lockWaitMs: 200
      });
      await expect(quick.provision(seedWorkItemId(fixture.store, "blocked"))).rejects.toMatchObject({
        code: "workspace_git_lock_timeout"
      });
      expect(statSync(lockPath).ino).toBe(inode);
      expect(await holder.stillHeld()).toBe(true);
      await holder.release();
      await manager.provision(seedWorkItemId(fixture.store, "second"));
      expect(statSync(lockPath).ino).toBe(inode);
    });

    it("finding 3: a lock file naming this very process (e.g. resurrected after release) does not self-block", async () => {
      const fixture = await createRepoFixture();
      cleanup = fixture.cleanup;
      writeFileSync(join(fixture.repoPath, ".git", "acs-worktree.lock"), `${process.pid}@${hostname()}\n`, "utf8");
      const manager = new WorkspaceManager({
        repoPath: fixture.repoPath,
        rootDir: fixture.rootDir,
        store: fixture.store,
        lockWaitMs: 2_000
      });
      const workspace = await manager.provision(seedWorkItemId(fixture.store, "self"));
      expect(existsSync(join(workspace.hostPath, "README.md"))).toBe(true);
    }, 10_000);

    it.skipIf(!canUnsharePidNamespace())(
      "finding 4: respects a holder in a separate pid namespace with the same hostname",
      async () => {
        const fixture = await createRepoFixture();
        cleanup = fixture.cleanup;
        const lockPath = join(fixture.repoPath, ".git", "acs-worktree.lock");
        const holder = await holdKernelLock(lockPath, ["unshare", "-rpf", "--mount-proc"]);
        // What the old code saw: a pid from another namespace => ESRCH => "dead".
        writeFileSync(lockPath, `${holder.innerPid}@${hostname()}\n`, "utf8");
        const manager = new WorkspaceManager({
          repoPath: fixture.repoPath,
          rootDir: fixture.rootDir,
          store: fixture.store
        });
        const workItemId = seedWorkItemId(fixture.store, "pidns");
        let settled = false;
        const pending = manager.provision(workItemId).finally(() => {
          settled = true;
        });
        await sleep(400);
        expect(settled).toBe(false);
        expect(existsSync(join(fixture.rootDir, workItemId))).toBe(false);
        await holder.release();
        await pending;
      }
    );

    it("finding 4: ignores the recorded pid: an unprobeable foreign pid never makes a held lock look dead", async () => {
      // Portable half of finding 4 (no userns needed): the lock is decided by
      // the kernel, so the recorded pid - live, dead or foreign - is ignored.
      const fixture = await createRepoFixture();
      cleanup = fixture.cleanup;
      const lockPath = join(fixture.repoPath, ".git", "acs-worktree.lock");
      const holder = await holdKernelLock(lockPath);
      writeFileSync(lockPath, `999999999@${hostname()}\n`, "utf8");
      const manager = new WorkspaceManager({
        repoPath: fixture.repoPath,
        rootDir: fixture.rootDir,
        store: fixture.store,
        lockWaitMs: 300
      });
      await expect(manager.provision(seedWorkItemId(fixture.store, "foreign"))).rejects.toMatchObject({
        code: "workspace_git_lock_timeout"
      });
      await holder.release();
    });

    it("finding 5: an empty lock file (crash between create and write) never blocks", async () => {
      const fixture = await createRepoFixture();
      cleanup = fixture.cleanup;
      writeFileSync(join(fixture.repoPath, ".git", "acs-worktree.lock"), "", "utf8");
      const manager = new WorkspaceManager({
        repoPath: fixture.repoPath,
        rootDir: fixture.rootDir,
        store: fixture.store,
        lockWaitMs: 2_000
      });
      const workspace = await manager.provision(seedWorkItemId(fixture.store, "empty"));
      expect(existsSync(join(workspace.hostPath, "README.md"))).toBe(true);
    }, 10_000);

    it("finding 5: a holder SIGKILLed mid-operation releases the lock automatically", async () => {
      const fixture = await createRepoFixture();
      cleanup = fixture.cleanup;
      const lockPath = join(fixture.repoPath, ".git", "acs-worktree.lock");
      const holder = await holdKernelLock(lockPath);
      holder.kill();
      const manager = new WorkspaceManager({
        repoPath: fixture.repoPath,
        rootDir: fixture.rootDir,
        store: fixture.store,
        lockWaitMs: 2_000
      });
      await manager.provision(seedWorkItemId(fixture.store, "after-crash"));
    }, 10_000);

    it("finding 6: a hung git is killed (with its process group) and the lock is released", async () => {
      const fixture = await createRepoFixture();
      const shimDir = mkdtempSync(join(tmpdir(), "acs-workspace-manager-hang-"));
      cleanup = () => {
        fixture.cleanup();
        rmSync(shimDir, { recursive: true, force: true });
      };
      const realGit = (await execFileAsync("sh", ["-c", "command -v git"])).stdout.trim();
      const hangGit = join(shimDir, "git");
      writeFileSync(
        hangGit,
        `#!/bin/sh\nif [ "$1" = "worktree" ]; then sleep 30 & wait; exit 0; fi\nexec "${realGit}" "$@"\n`,
        { mode: 0o755 }
      );
      const hung = new WorkspaceManager({
        repoPath: fixture.repoPath,
        rootDir: fixture.rootDir,
        store: fixture.store,
        gitPath: hangGit,
        gitTimeoutMs: 500,
        lockWaitMs: 500
      });
      const started = Date.now();
      await expect(hung.provision(seedWorkItemId(fixture.store, "hung"))).rejects.toMatchObject({
        code: "workspace_git_timeout"
      });
      expect(Date.now() - started).toBeLessThan(5_000);
      const healthy = new WorkspaceManager({
        repoPath: fixture.repoPath,
        rootDir: fixture.rootDir,
        store: fixture.store,
        lockWaitMs: 2_000
      });
      await healthy.provision(seedWorkItemId(fixture.store, "after-hang"));
    }, 15_000);

    it("finding 6: same-process waiters are bounded by lockWaitMs and fail closed", async () => {
      const fixture = await createRepoFixture();
      const shimDir = mkdtempSync(join(tmpdir(), "acs-workspace-manager-slow-"));
      cleanup = () => {
        fixture.cleanup();
        rmSync(shimDir, { recursive: true, force: true });
      };
      const realGit = (await execFileAsync("sh", ["-c", "command -v git"])).stdout.trim();
      const slowGit = join(shimDir, "git");
      writeFileSync(slowGit, `#!/bin/sh\nif [ "$1" = "worktree" ]; then sleep 2; fi\nexec "${realGit}" "$@"\n`, {
        mode: 0o755
      });
      const manager = new WorkspaceManager({
        repoPath: fixture.repoPath,
        rootDir: fixture.rootDir,
        store: fixture.store,
        gitPath: slowGit,
        lockWaitMs: 300
      });
      const first = manager.provision(seedWorkItemId(fixture.store, "slow-first"));
      await sleep(200);
      const started = Date.now();
      await expect(manager.provision(seedWorkItemId(fixture.store, "slow-second"))).rejects.toMatchObject({
        code: "workspace_git_lock_timeout"
      });
      expect(Date.now() - started).toBeLessThan(1_500);
      await first;
    }, 15_000);

    it("R/V HIGH: a post-checkout hook that backgrounds a process does not keep the lock after git exits", async () => {
      const fixture = await createRepoFixture();
      const pidFile = join(fixture.rootDir, "..", "hook-bg.pid");
      cleanup = () => {
        try {
          process.kill(Number(readFileSync(pidFile, "utf8").trim()), "SIGKILL");
        } catch {
          // Already gone / never started.
        }
        fixture.cleanup();
      };
      // Real `git worktree add` runs post-checkout; the hook leaves a long-lived
      // background child behind (stdio detached so only an inherited lock fd
      // could tie it to the lock).
      writeFileSync(
        join(fixture.repoPath, ".git", "hooks", "post-checkout"),
        `#!/bin/sh\nsleep 30 </dev/null >/dev/null 2>&1 &\necho $! > "${pidFile}"\n`,
        { mode: 0o755 }
      );
      const manager = new WorkspaceManager({
        repoPath: fixture.repoPath,
        rootDir: fixture.rootDir,
        store: fixture.store,
        lockWaitMs: 1_000
      });
      await manager.provision(seedWorkItemId(fixture.store, "hook-first"));
      expect(existsSync(pidFile)).toBe(true);
      const started = Date.now();
      await manager.provision(seedWorkItemId(fixture.store, "hook-second"));
      expect(Date.now() - started).toBeLessThan(1_000);
    }, 15_000);

    it("R/V MED: gitTimeoutMs bounds git on its own, not lockWaitMs + gitTimeoutMs", async () => {
      const fixture = await createRepoFixture();
      const shimDir = mkdtempSync(join(tmpdir(), "acs-workspace-manager-gittimeout-"));
      cleanup = () => {
        fixture.cleanup();
        rmSync(shimDir, { recursive: true, force: true });
      };
      const realGit = (await execFileAsync("sh", ["-c", "command -v git"])).stdout.trim();
      const hangGit = join(shimDir, "git");
      writeFileSync(
        hangGit,
        `#!/bin/sh\nif [ "$1" = "worktree" ]; then sleep 30 & wait; exit 0; fi\nexec "${realGit}" "$@"\n`,
        { mode: 0o755 }
      );
      const manager = new WorkspaceManager({
        repoPath: fixture.repoPath,
        rootDir: fixture.rootDir,
        store: fixture.store,
        gitPath: hangGit,
        gitTimeoutMs: 300,
        lockWaitMs: 10_000
      });
      const started = Date.now();
      await expect(manager.provision(seedWorkItemId(fixture.store, "git-budget"))).rejects.toMatchObject({
        code: "workspace_git_timeout"
      });
      expect(Date.now() - started).toBeLessThan(3_000);
    }, 20_000);

    it("R/V MED: time spent waiting for the lock is not charged to git's gitTimeoutMs budget", async () => {
      const fixture = await createRepoFixture();
      cleanup = fixture.cleanup;
      const lockPath = join(fixture.repoPath, ".git", "acs-worktree.lock");
      const holder = await holdKernelLock(lockPath);
      const manager = new WorkspaceManager({
        repoPath: fixture.repoPath,
        rootDir: fixture.rootDir,
        store: fixture.store,
        gitTimeoutMs: 1_500,
        lockWaitMs: 10_000
      });
      const pending = manager.provision(seedWorkItemId(fixture.store, "waited"));
      await sleep(2_000);
      await holder.release();
      await pending;
    }, 20_000);

    it("R/V MED: git (or a hook) exiting 75 is reported as a git failure, not a lock timeout", async () => {
      const fixture = await createRepoFixture();
      const shimDir = mkdtempSync(join(tmpdir(), "acs-workspace-manager-exit75-"));
      cleanup = () => {
        fixture.cleanup();
        rmSync(shimDir, { recursive: true, force: true });
      };
      const realGit = (await execFileAsync("sh", ["-c", "command -v git"])).stdout.trim();
      const exit75Git = join(shimDir, "git");
      writeFileSync(
        exit75Git,
        `#!/bin/sh\nif [ "$1" = "worktree" ]; then echo "tempfail from git" >&2; exit 75; fi\nexec "${realGit}" "$@"\n`,
        { mode: 0o755 }
      );
      const manager = new WorkspaceManager({
        repoPath: fixture.repoPath,
        rootDir: fixture.rootDir,
        store: fixture.store,
        gitPath: exit75Git,
        lockWaitMs: 2_000
      });
      await expect(manager.provision(seedWorkItemId(fixture.store, "exit75"))).rejects.toMatchObject({
        code: "workspace_git_failed",
        message: expect.stringContaining("tempfail from git")
      });
    }, 15_000);

    it("R/V MED: a node process SIGKILLed mid-operation does not orphan a lock-holding flock/git group", async () => {
      const fixture = await createRepoFixture();
      const shimDir = mkdtempSync(join(tmpdir(), "acs-workspace-manager-pdeathsig-"));
      const pidsFile = join(shimDir, "git.pid");
      cleanup = () => {
        try {
          process.kill(Number(readFileSync(pidsFile, "utf8").trim()), "SIGKILL");
        } catch {
          // Already gone (expected).
        }
        fixture.cleanup();
        rmSync(shimDir, { recursive: true, force: true });
      };
      const realGit = (await execFileAsync("sh", ["-c", "command -v git"])).stdout.trim();
      const hangGit = join(shimDir, "git");
      writeFileSync(
        hangGit,
        `#!/bin/sh\nif [ "$1" = "worktree" ]; then echo $$ > "${pidsFile}"; exec sleep 60; fi\nexec "${realGit}" "$@"\n`,
        { mode: 0o755 }
      );
      const script = [
        `import { WorkspaceManager } from ${JSON.stringify(managerModule)};`,
        `import { SqliteWorkItemStore } from ${JSON.stringify(workItemsModule)};`,
        `const store = new SqliteWorkItemStore(${JSON.stringify(fixture.dbPath)});`,
        `const manager = new WorkspaceManager({ repoPath: ${JSON.stringify(fixture.repoPath)}, rootDir: ${JSON.stringify(fixture.rootDir)}, store, gitPath: ${JSON.stringify(hangGit)}, gitTimeoutMs: 60_000 });`,
        `await manager.provision(${JSON.stringify(seedWorkItemId(fixture.store, "pdeathsig"))});`
      ].join("\n");
      const scriptPath = join(shimDir, "child.mts");
      writeFileSync(scriptPath, script, "utf8");
      // node itself (not the tsx CLI wrapper), so the SIGKILL hits the process that spawned flock.
      const child = spawn(process.execPath, ["--import", tsxLoader, scriptPath], { stdio: "ignore" });
      const exited = new Promise<void>((resolveExit) => child.once("exit", () => resolveExit()));
      const lockPath = join(fixture.repoPath, ".git", "acs-worktree.lock");
      const lockHeld = async () => {
        try {
          await execFileAsync("flock", ["--exclusive", "--nonblock", lockPath, "true"]);
          return false;
        } catch {
          return true;
        }
      };
      for (let i = 0; i < 200 && !existsSync(pidsFile); i += 1) await sleep(50);
      expect(existsSync(pidsFile)).toBe(true);
      expect(await lockHeld()).toBe(true);
      child.kill("SIGKILL");
      await exited;
      let held = true;
      for (let i = 0; i < 40 && held; i += 1) {
        held = await lockHeld();
        if (held) await sleep(50);
      }
      expect(held).toBe(false);
    }, 30_000);

    it("fails closed when flock(1) is unavailable instead of running git unlocked", async () => {
      const fixture = await createRepoFixture();
      cleanup = fixture.cleanup;
      const manager = new WorkspaceManager({
        repoPath: fixture.repoPath,
        rootDir: fixture.rootDir,
        store: fixture.store,
        flockPath: join(fixture.rootDir, "no-such-flock")
      });
      const workItemId = seedWorkItemId(fixture.store, "noflock");
      await expect(manager.provision(workItemId)).rejects.toMatchObject({ code: "workspace_git_lock_unavailable" });
      expect(existsSync(join(fixture.rootDir, workItemId))).toBe(false);
    });
  });

  it("refuses to provision over a path with no active allocation record", async () => {
    const fixture = await createRepoFixture();
    cleanup = fixture.cleanup;
    const workItemId = seedWorkItemId(fixture.store, "squatted");
    mkdirSync(join(fixture.rootDir, workItemId), { recursive: true });
    writeFileSync(join(fixture.rootDir, workItemId, "pre-existing.txt"), "do not touch\n", "utf8");
    const manager = new WorkspaceManager({
      repoPath: fixture.repoPath,
      rootDir: fixture.rootDir,
      store: fixture.store
    });

    await expect(manager.provision(workItemId)).rejects.toThrowError(
      expect.objectContaining<Partial<ControlStackError>>({ code: "workspace_path_collision" })
    );
    expect(existsSync(join(fixture.rootDir, workItemId, "pre-existing.txt"))).toBe(true);
  });

  it("tears down idempotently, including for a job that was never provisioned", async () => {
    const fixture = await createRepoFixture();
    cleanup = fixture.cleanup;
    const manager = new WorkspaceManager({
      repoPath: fixture.repoPath,
      rootDir: fixture.rootDir,
      store: fixture.store
    });
    const workItemId = seedWorkItemId(fixture.store, "one");
    const neverExisted = seedWorkItemId(fixture.store, "never");

    const workspace = await manager.provision(workItemId);
    expect(existsSync(workspace.hostPath)).toBe(true);

    await manager.teardown(workItemId);
    expect(existsSync(workspace.hostPath)).toBe(false);
    expect(manager.get(workItemId)).toBeUndefined();
    expect(fixture.store.getActiveWorkspaceAllocationForWorkItem(workItemId)).toBeUndefined();

    await expect(manager.teardown(workItemId)).resolves.toBeUndefined();
    await expect(manager.teardown(neverExisted)).resolves.toBeUndefined();
  });

  it("reconciles orphaned worktrees without deleting or resuming them", async () => {
    const fixture = await createRepoFixture();
    cleanup = fixture.cleanup;
    const first = new WorkspaceManager({ repoPath: fixture.repoPath, rootDir: fixture.rootDir, store: fixture.store });
    const workItemId = seedWorkItemId(fixture.store, "orphan");
    const workspace = await first.provision(workItemId);
    writeFileSync(join(workspace.hostPath, "in-progress.txt"), "unfinished work\n", "utf8");

    // Simulate a crash: a fresh manager instance has no in-memory cache of
    // this job, but the *persisted store* (not just git's own registry)
    // still has the allocation record.
    const recovered = new WorkspaceManager({
      repoPath: fixture.repoPath,
      rootDir: fixture.rootDir,
      store: fixture.store
    });

    const { orphaned: withNoneActive } = await recovered.reconcile(new Set());
    expect(withNoneActive.map((w) => w.workItemId)).toContain(workItemId);
    // Never touched - the crash-recovered work must survive for operator review.
    expect(existsSync(join(workspace.hostPath, "in-progress.txt"))).toBe(true);

    const { orphaned: withJobActive } = await recovered.reconcile(new Set([workItemId]));
    expect(withJobActive.map((w) => w.workItemId)).not.toContain(workItemId);
  });

  it("crash window: a worktree left behind before its allocation was ever persisted is reported as an orphan, not thrown on", async () => {
    const fixture = await createRepoFixture();
    cleanup = fixture.cleanup;

    // Simulate the exact P1-L crash window: `git worktree add` succeeds,
    // then the process dies before recordWorkspaceAllocation ever commits -
    // so the store has *no* allocation record for this worktree at all,
    // unlike the ordinary orphan case where the record survives a crash.
    const orphanPath = join(fixture.rootDir, "crash-window-workitem");
    await execFileAsync("git", ["worktree", "add", "-b", "acs/job/crash-window-workitem", orphanPath, "main"], {
      cwd: fixture.repoPath
    });
    expect(existsSync(orphanPath)).toBe(true);

    const manager = new WorkspaceManager({
      repoPath: fixture.repoPath,
      rootDir: fixture.rootDir,
      store: fixture.store
    });

    // Must not throw a Zod validation error and abort reconciliation.
    const { orphaned } = await manager.reconcile(new Set());

    const found = orphaned.find((w) => w.hostPath === orphanPath);
    expect(found).toBeDefined();
    // No ownership fields exist to report - this must be the distinct
    // orphan shape, not forced through the ownership-required Workspace
    // schema.
    expect(found).not.toHaveProperty("attemptId");
    expect(found).not.toHaveProperty("leaseId");
    expect(found).not.toHaveProperty("workerId");
    expect(found).not.toHaveProperty("fencingEpoch");
    // Never touched - reconciliation only reports, never deletes.
    expect(existsSync(orphanPath)).toBe(true);
  });

  it("rejects work item ids that cannot map to a single safe path segment", async () => {
    const fixture = await createRepoFixture();
    cleanup = fixture.cleanup;
    const manager = new WorkspaceManager({
      repoPath: fixture.repoPath,
      rootDir: fixture.rootDir,
      store: fixture.store
    });

    await expect(manager.provision("../escape")).rejects.toThrow();
    await expect(manager.provision("has/slash")).rejects.toThrow();
  });

  it("throws on non-absolute repoPath or rootDir instead of resolving them ambiguously", async () => {
    const fixture = await createRepoFixture();
    cleanup = fixture.cleanup;
    expect(
      () => new WorkspaceManager({ repoPath: "relative/repo", rootDir: "/tmp/x", store: fixture.store })
    ).toThrowError(expect.objectContaining<Partial<ControlStackError>>({ code: "workspace_manager_invalid_options" }));
  });

  it("adversarial: refuses to tear down a directory at the deterministic path with no allocation record", async () => {
    const fixture = await createRepoFixture();
    cleanup = fixture.cleanup;
    const workItemId = seedWorkItemId(fixture.store, "untracked");
    const manager = new WorkspaceManager({
      repoPath: fixture.repoPath,
      rootDir: fixture.rootDir,
      store: fixture.store
    });
    // A directory shows up at exactly the path this work item would use,
    // but no allocation was ever recorded for it (e.g. planted by something
    // else, or a stale leftover from before this store existed).
    const plantedPath = join(fixture.rootDir, workItemId);
    mkdirSync(plantedPath, { recursive: true });
    writeFileSync(join(plantedPath, "not-ours.txt"), "should survive\n", "utf8");

    await expect(manager.teardown(workItemId)).rejects.toThrowError(
      expect.objectContaining<Partial<ControlStackError>>({ code: "workspace_untracked_teardown_refused" })
    );
    expect(existsSync(join(plantedPath, "not-ours.txt"))).toBe(true);
  });

  it("adversarial: refuses to tear down when the allocation path has been replaced with a symlink", async () => {
    const fixture = await createRepoFixture();
    cleanup = fixture.cleanup;
    const manager = new WorkspaceManager({
      repoPath: fixture.repoPath,
      rootDir: fixture.rootDir,
      store: fixture.store
    });
    const workItemId = seedWorkItemId(fixture.store, "symlinked");
    const workspace = await manager.provision(workItemId);

    // Simulate a TOCTOU/substitution attempt: the real worktree directory is
    // replaced with a symlink pointing somewhere else entirely.
    const outsideSecret = mkdtempSync(join(tmpdir(), "acs-workspace-manager-outside-"));
    writeFileSync(join(outsideSecret, "secret.txt"), "should never be deleted by teardown\n", "utf8");
    rmSync(workspace.hostPath, { recursive: true, force: true });
    symlinkSync(outsideSecret, workspace.hostPath);

    try {
      await expect(manager.teardown(workItemId)).rejects.toThrowError(
        expect.objectContaining<Partial<ControlStackError>>({ code: "workspace_teardown_refused_symlink" })
      );
      expect(existsSync(join(outsideSecret, "secret.txt"))).toBe(true);
      // The store must still show the allocation as active - a refused
      // teardown must not be silently treated as done.
      expect(fixture.store.getActiveWorkspaceAllocationForWorkItem(workItemId)).toBeDefined();
    } finally {
      rmSync(outsideSecret, { recursive: true, force: true });
    }
  });

  it("adversarial: a second process (fresh manager, same store) sees and can tear down what the first provisioned", async () => {
    const fixture = await createRepoFixture();
    cleanup = fixture.cleanup;
    const workItemId = seedWorkItemId(fixture.store, "cross-process");
    const first = new WorkspaceManager({ repoPath: fixture.repoPath, rootDir: fixture.rootDir, store: fixture.store });
    const workspace = await first.provision(workItemId);

    const second = new WorkspaceManager({ repoPath: fixture.repoPath, rootDir: fixture.rootDir, store: fixture.store });
    expect(second.get(workItemId)).toEqual(workspace);

    await second.teardown(workItemId);
    expect(existsSync(workspace.hostPath)).toBe(false);
    expect(first.get(workItemId)).toBeUndefined();
  });

  it("adversarial: the store's unique-active-allocation constraint rejects a duplicate concurrent recording", async () => {
    const fixture = await createRepoFixture();
    cleanup = fixture.cleanup;
    const workItemId = seedWorkItemId(fixture.store, "race");
    const manager = new WorkspaceManager({
      repoPath: fixture.repoPath,
      rootDir: fixture.rootDir,
      store: fixture.store
    });
    const workspace = await manager.provision(workItemId);

    // A second, independent attempt to record an allocation for the same
    // work item (simulating a losing racer in a real concurrent provision)
    // must be rejected by the store itself, not merely by application logic.
    expect(() =>
      fixture.store.recordWorkspaceAllocation(
        {
          allocationId: "workspace_racer",
          workItemId,
          hostPath: "/tmp/attacker-would-be-path",
          branch: "acs/job/racer",
          baseRef: "main"
        },
        { via: "domain_service" }
      )
    ).toThrowError(expect.objectContaining<Partial<ControlStackError>>({ code: "workspace_allocation_conflict" }));
    expect(fixture.store.getActiveWorkspaceAllocationForWorkItem(workItemId)?.hostPath).toBe(workspace.hostPath);
  });

  it("allocates by attempt and fences cleanup so retries never reuse an earlier workspace", async () => {
    const fixture = await createRepoFixture();
    cleanup = fixture.cleanup;
    const workItemId = seedWorkItemId(fixture.store, "retry-isolation");
    const allocations = new Map<string, WorkspaceAllocation>();
    const attemptStore: WorkspaceAllocationStore = {
      recordWorkspaceAllocation(input) {
        const allocation: WorkspaceAllocation = {
          ...input,
          attemptId: input.attemptId ?? input.workItemId,
          leaseId: input.leaseId ?? input.workItemId,
          workerId: input.workerId ?? "legacy",
          fencingEpoch: input.fencingEpoch ?? 0,
          status: "active",
          createdAt: new Date().toISOString()
        };
        allocations.set(allocation.allocationId, allocation);
        return allocation;
      },
      getActiveWorkspaceAllocationForWorkItem(id) {
        return [...allocations.values()].find(
          (allocation) => allocation.workItemId === id && allocation.status === "active"
        );
      },
      getActiveWorkspaceAllocationForAttempt(id) {
        return [...allocations.values()].find(
          (allocation) => allocation.attemptId === id && allocation.status === "active"
        );
      },
      closeWorkspaceAllocation(id) {
        const current = allocations.get(id);
        if (!current) throw new Error("missing allocation " + id);
        const closed = { ...current, status: "torn_down" as const, tornDownAt: new Date().toISOString() };
        allocations.set(id, closed);
        return closed;
      },
      requestWorkspaceCleanup(input) {
        const current = allocations.get(input.allocationId);
        if (!current) throw new Error("missing allocation " + input.allocationId);
        return current;
      }
    };
    const manager = new WorkspaceManager({
      repoPath: fixture.repoPath,
      rootDir: fixture.rootDir,
      store: attemptStore
    });

    const first = await manager.provision(workItemId, {
      attemptId: "attempt-first",
      leaseId: "lease-first",
      workerId: "worker-a",
      fencingEpoch: 1
    });
    const second = await manager.provision(workItemId, {
      attemptId: "attempt-second",
      leaseId: "lease-second",
      workerId: "worker-a",
      fencingEpoch: 2
    });

    expect(second.hostPath).not.toBe(first.hostPath);
    expect(second.allocationId).not.toBe(first.allocationId);
    await expect(
      manager.teardown(workItemId, {
        attemptId: "attempt-second",
        leaseId: "lease-first",
        workerId: "worker-a",
        fencingEpoch: 1
      })
    ).rejects.toThrowError(
      expect.objectContaining<Partial<ControlStackError>>({ code: "workspace_cleanup_fence_stale" })
    );
    expect(existsSync(second.hostPath)).toBe(true);
    await manager.teardown(workItemId, {
      attemptId: "attempt-second",
      leaseId: "lease-second",
      workerId: "worker-a",
      fencingEpoch: 2
    });
    expect(attemptStore.getActiveWorkspaceAllocationForAttempt?.("attempt-second")).toBeUndefined();
  });

  it("adversarial: refuses to tear down once the bound lease has expired, even though the worker/lease/epoch tuple copied onto the allocation still matches exactly", async () => {
    const fixture = await createRepoFixture();
    cleanup = fixture.cleanup;
    const manager = new WorkspaceManager({
      repoPath: fixture.repoPath,
      rootDir: fixture.rootDir,
      store: fixture.store
    });
    const workItemId = seedWorkItemId(fixture.store, "expired-lease-cleanup");

    const definition = defaultExecutionPlanForWorkItem(fixture.store.get(workItemId)!);
    const plan = fixture.store.createExecutionPlan({ workItemId, definition, createdByActorId: "actor-user" });
    const admission = fixture.store.admitExecutionPlan(
      {
        workItemId,
        planHash: plan.planHash,
        policyVersion: "acs.policy.v1",
        policyDecisionHash: "1".repeat(64),
        requiresApproval: false,
        admittedByActorId: "policy-gate"
      },
      { via: "policy_gate" }
    );
    const attempt = fixture.store.createAttempt(
      { workItemId, planHash: plan.planHash, inputHash: "a".repeat(64) },
      { via: "domain_service" }
    );
    // Use a long TTL so provision (git worktree add + record) cannot lose the
    // race against wall-clock expiry under loaded CI - the prior ttlMs:50 +
    // setTimeout(75) flake failed at WorkspaceManager.provision with
    // workspace_allocation_conflict once worktree creation exceeded 50ms.
    const lease = fixture.store.leaseAttempt(
      {
        attemptId: attempt.attemptId,
        workItemId,
        admissionId: admission.admissionId,
        workerId: "worker-a",
        leaseToken: "a".repeat(32),
        policyVersion: "acs.policy.v1",
        policyDecisionHash: "1".repeat(64),
        ttlMs: 60_000
      },
      { via: "domain_service" }
    );

    await manager.provision(workItemId, {
      attemptId: attempt.attemptId,
      leaseId: lease.leaseId,
      workerId: "worker-a",
      fencingEpoch: lease.fencingEpoch
    });
    const workspace = manager.get(workItemId, attempt.attemptId)!;
    expect(existsSync(workspace.hostPath)).toBe(true);

    // Advance past expires_at without calling failExpiredLeases - the lease
    // row stays status='active', and the allocation's copied worker/lease/
    // epoch tuple still matches exactly what the now-stale worker presents.
    // Only the lease's own expires_at has actually passed (same pattern as
    // work-items getWorkspaceCleanupAuthority expired-lease coverage).
    vi.useFakeTimers();
    vi.setSystemTime(new Date(Date.parse(lease.expiresAt) + 1));

    await expect(
      manager.teardown(workItemId, {
        attemptId: attempt.attemptId,
        leaseId: lease.leaseId,
        workerId: "worker-a",
        fencingEpoch: lease.fencingEpoch
      })
    ).rejects.toThrowError(
      expect.objectContaining<Partial<ControlStackError>>({ code: "workspace_cleanup_fence_stale" })
    );
    vi.useRealTimers();
    // Refused before ever touching the filesystem.
    expect(existsSync(workspace.hostPath)).toBe(true);
  });

  it("still authorizes cleanup by the same worker/epoch immediately after the attempt reaches a terminal (succeeded) state", async () => {
    const fixture = await createRepoFixture();
    cleanup = fixture.cleanup;
    const manager = new WorkspaceManager({
      repoPath: fixture.repoPath,
      rootDir: fixture.rootDir,
      store: fixture.store
    });
    const workItemId = seedWorkItemId(fixture.store, "terminal-attempt-cleanup");

    const definition = defaultExecutionPlanForWorkItem(fixture.store.get(workItemId)!);
    const plan = fixture.store.createExecutionPlan({ workItemId, definition, createdByActorId: "actor-user" });
    const admission = fixture.store.admitExecutionPlan(
      {
        workItemId,
        planHash: plan.planHash,
        policyVersion: "acs.policy.v1",
        policyDecisionHash: "1".repeat(64),
        requiresApproval: false,
        admittedByActorId: "policy-gate"
      },
      { via: "policy_gate" }
    );
    const attempt = fixture.store.createAttempt(
      { workItemId, planHash: plan.planHash, inputHash: "a".repeat(64) },
      { via: "domain_service" }
    );
    const lease = fixture.store.leaseAttempt(
      {
        attemptId: attempt.attemptId,
        workItemId,
        admissionId: admission.admissionId,
        workerId: "worker-a",
        leaseToken: "a".repeat(32),
        policyVersion: "acs.policy.v1",
        policyDecisionHash: "1".repeat(64),
        ttlMs: 60_000
      },
      { via: "domain_service" }
    );

    await manager.provision(workItemId, {
      attemptId: attempt.attemptId,
      leaseId: lease.leaseId,
      workerId: "worker-a",
      fencingEpoch: lease.fencingEpoch
    });

    fixture.store.transitionAttempt(
      {
        attemptId: attempt.attemptId,
        workItemId,
        workerId: "worker-a",
        fencingEpoch: lease.fencingEpoch,
        status: "running"
      },
      { via: "domain_service" }
    );
    fixture.store.transitionAttempt(
      {
        attemptId: attempt.attemptId,
        workItemId,
        workerId: "worker-a",
        fencingEpoch: lease.fencingEpoch,
        status: "succeeded"
      },
      { via: "domain_service" }
    );

    // Cleanup right after success, by the exact worker/epoch that completed
    // the attempt, must not be treated as unauthorized just because the
    // attempt is no longer "live" - this is the normal, expected path.
    await manager.teardown(workItemId, {
      attemptId: attempt.attemptId,
      leaseId: lease.leaseId,
      workerId: "worker-a",
      fencingEpoch: lease.fencingEpoch
    });
    expect(fixture.store.getActiveWorkspaceAllocationForAttempt?.(attempt.attemptId)).toBeUndefined();
  });
});
