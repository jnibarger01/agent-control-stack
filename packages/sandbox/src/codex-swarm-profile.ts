import { lstatSync, realpathSync } from "node:fs";
import { isAbsolute } from "node:path";
import { ControlStackError } from "@agent-control-stack/shared";
import type { EngineRuntimeMount } from "./engine.js";
import { isContainedPath } from "./linux.js";

/**
 * F5 / ADR 0017: the `codex-swarm-v1` host isolation profile.
 *
 * The whole Codex Swarm process tree (Swarm plus every lane it starts) runs inside ONE systemd user
 * scope (cgroup: memory, task and CPU quotas, accounted and killable as a unit) and ONE bubblewrap
 * sandbox:
 *  - new user/pid/net/ipc/uts/cgroup namespaces; no network at all (networkPolicy "none" only);
 *  - read-only system and runtime mounts; the attempt workspace is the only writable host path;
 *  - the per-attempt ACS socket directory is the only other host path, at /run/acs-swarm;
 *  - a cleared environment: nothing from the host leaks in, and the MAC secret is never in env
 *    (it arrives on the inherited fd ACS names);
 *  - --die-with-parent and a new session, so the tree cannot outlive ACS's handle on it.
 *
 * Lanes share this sandbox; per-lane separation inside it is Swarm's worktree discipline, not a
 * kernel boundary. Scoped egress is not supported by this version and is refused, not degraded.
 * This module builds argv only; it never spawns.
 */
export const CODEX_SWARM_PROFILE = "codex-swarm-v1" as const;
export const CODEX_SWARM_SOCKET_DIR_IN_SANDBOX = "/run/acs-swarm" as const;
export const CODEX_SWARM_WORKSPACE_IN_SANDBOX = "/workspace" as const;

export interface CodexSwarmProfileLimits {
  memoryBytes: number;
  pids: number;
  cpuQuotaPercent: number;
  tmpfsBytes: number;
  wallClockMs: number;
}

export interface CodexSwarmProfileOptions {
  /** Every workspace must canonically resolve inside this root. Operator configuration. */
  workspaceRoot: string;
  /** Read-only mounts for the Swarm install and its Node runtime. Operator configuration only. */
  runtimeMounts: readonly EngineRuntimeMount[];
  limits: CodexSwarmProfileLimits;
  bwrapPath?: string;
  systemdRunPath?: string;
  systemctlPath?: string;
}

export interface CodexSwarmLaunchContext {
  attemptId: string;
  /** The attempt workspace (host path). Re-resolved here; never trusted from the caller as-is. */
  workspaceHostPath: string;
  networkPolicy: string;
  socketDir: string;
  socketName: string;
  /** argv to run inside the sandbox (paths as seen inside, i.e. under a runtime mount). */
  command: readonly string[];
  /** Non-secret environment to set inside the sandbox. */
  env: Readonly<Record<string, string>>;
}

export interface CodexSwarmLaunch {
  command: string;
  args: string[];
  env: Record<string, string>;
  unitName: string;
  /** Socket path ACS connects to on the host (inside the bound socket dir). */
  hostSocketPath: string;
}

const UNIT_ATTEMPT = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/u;

function positive(name: string, value: number, max: number): number {
  if (!Number.isSafeInteger(value) || value <= 0 || value > max) {
    throw new ControlStackError("codex_swarm_profile_invalid", `${name} must be a positive integer <= ${max}`);
  }
  return value;
}

/** Canonical, non-symlink, inside the configured root. Anything else is refused. */
export function resolveCodexSwarmWorkspace(workspaceRoot: string, hostPath: string): string {
  if (!isAbsolute(hostPath)) throw new ControlStackError("sandbox_workspace_unavailable", "workspace path must be absolute");
  let real: string;
  let root: string;
  try {
    const stat = lstatSync(hostPath);
    if (!stat.isDirectory() || stat.isSymbolicLink()) throw new Error("workspace must be a non-symlink directory");
    real = realpathSync(hostPath);
    root = realpathSync(workspaceRoot);
  } catch (error) {
    throw new ControlStackError("sandbox_workspace_unavailable", (error as Error).message);
  }
  if (real !== hostPath) {
    throw new ControlStackError("sandbox_workspace_mismatch", "workspace path is not canonical (symlink component)");
  }
  if (real === root || !isContainedPath(root, real)) {
    throw new ControlStackError("sandbox_filesystem_escape", "workspace is outside the configured workspace root");
  }
  return real;
}

export function codexSwarmUnitName(attemptId: string): string {
  if (!UNIT_ATTEMPT.test(attemptId)) throw new ControlStackError("codex_swarm_profile_invalid", "attempt id is invalid");
  return "acs-swarm-" + attemptId.replace(/[^A-Za-z0-9]/gu, "_") + ".scope";
}

export function buildCodexSwarmLaunch(options: CodexSwarmProfileOptions, context: CodexSwarmLaunchContext): CodexSwarmLaunch {
  if (context.networkPolicy !== "none") {
    throw new ControlStackError("codex_swarm_egress_unsupported", "codex-swarm-v1 supports networkPolicy 'none' only");
  }
  const limits = options.limits;
  positive("memoryBytes", limits.memoryBytes, 64 * 1024 ** 3);
  positive("pids", limits.pids, 4_096);
  positive("cpuQuotaPercent", limits.cpuQuotaPercent, 6_400);
  positive("tmpfsBytes", limits.tmpfsBytes, 16 * 1024 ** 3);
  positive("wallClockMs", limits.wallClockMs, 24 * 60 * 60 * 1_000);
  if (!/^[A-Za-z0-9._-]{1,64}$/u.test(context.socketName)) {
    throw new ControlStackError("codex_swarm_profile_invalid", "socket name is invalid");
  }
  if (context.command.length === 0 || !isAbsolute(context.command[0]!)) {
    throw new ControlStackError("codex_swarm_profile_invalid", "command must be an absolute argv inside the sandbox");
  }
  const workspace = resolveCodexSwarmWorkspace(options.workspaceRoot, context.workspaceHostPath);
  const socketDir = realpathSync(context.socketDir);
  const unitName = codexSwarmUnitName(context.attemptId);
  const mounts = options.runtimeMounts.map((mount) => {
    if (!isAbsolute(mount.sandboxPath) || mount.sandboxPath.split("/").includes("..")) {
      throw new ControlStackError("codex_swarm_profile_invalid", "runtime mount sandbox path must be absolute");
    }
    return { hostPath: realpathSync(mount.hostPath), sandboxPath: mount.sandboxPath };
  });

  const bwrap = [
    "--unshare-user",
    "--unshare-ipc",
    "--unshare-pid",
    "--unshare-net",
    "--unshare-uts",
    "--unshare-cgroup",
    "--die-with-parent",
    "--new-session",
    "--cap-drop",
    "ALL",
    "--hostname",
    "acs-swarm",
    "--ro-bind", "/usr", "/usr",
    "--ro-bind", "/bin", "/bin",
    "--ro-bind", "/lib", "/lib",
    "--ro-bind-try", "/lib64", "/lib64",
    "--proc", "/proc",
    "--dev", "/dev",
    "--dir", "/etc",
    "--ro-bind-try", "/etc/ld.so.cache", "/etc/ld.so.cache",
    "--ro-bind-try", "/etc/localtime", "/etc/localtime",
    "--size", String(limits.tmpfsBytes),
    "--tmpfs", "/tmp",
    "--dir", "/tmp/home",
    "--chmod", "0700", "/tmp/home",
    "--dir", "/run",
    "--bind", socketDir, CODEX_SWARM_SOCKET_DIR_IN_SANDBOX,
    "--bind", workspace, CODEX_SWARM_WORKSPACE_IN_SANDBOX
  ];
  for (const mount of mounts) bwrap.push("--ro-bind", mount.hostPath, mount.sandboxPath);
  const pathDirs = ["/usr/bin", "/bin", ...mounts.map((mount) => mount.sandboxPath + "/bin")];
  bwrap.push("--clearenv", "--setenv", "HOME", "/tmp/home", "--setenv", "TMPDIR", "/tmp", "--setenv", "PATH", pathDirs.join(":"));
  for (const [key, value] of Object.entries(context.env)) {
    if (!/^[A-Z_][A-Z0-9_]{0,63}$/u.test(key)) throw new ControlStackError("codex_swarm_profile_invalid", "bad env key");
    bwrap.push("--setenv", key, value);
  }
  bwrap.push("--setenv", "ACS_SWARM_SOCKET", `${CODEX_SWARM_SOCKET_DIR_IN_SANDBOX}/${context.socketName}`);
  bwrap.push("--chdir", CODEX_SWARM_WORKSPACE_IN_SANDBOX, "--", ...context.command);

  return {
    command: options.systemdRunPath ?? "/usr/bin/systemd-run",
    args: [
      "--user",
      "--scope",
      "--collect",
      "--quiet",
      `--unit=${unitName}`,
      "--property=CPUAccounting=yes",
      "--property=MemoryAccounting=yes",
      "--property=TasksAccounting=yes",
      `--property=CPUQuota=${limits.cpuQuotaPercent}%`,
      `--property=MemoryMax=${limits.memoryBytes}`,
      "--property=MemorySwapMax=0",
      `--property=TasksMax=${limits.pids}`,
      `--property=RuntimeMaxSec=${limits.wallClockMs}ms`,
      options.bwrapPath ?? "/usr/bin/bwrap",
      ...bwrap
    ],
    // systemd-run itself needs a minimal environment to reach the user manager; bwrap clears it.
    env: {
      PATH: "/usr/bin:/bin",
      ...(process.env.XDG_RUNTIME_DIR ? { XDG_RUNTIME_DIR: process.env.XDG_RUNTIME_DIR } : {}),
      ...(process.env.DBUS_SESSION_BUS_ADDRESS ? { DBUS_SESSION_BUS_ADDRESS: process.env.DBUS_SESSION_BUS_ADDRESS } : {})
    },
    unitName,
    hostSocketPath: `${socketDir}/${context.socketName}`
  };
}

/**
 * Launcher for the ACS Codex Swarm adapter: wraps Swarm in the codex-swarm-v1 profile and, on
 * teardown, stops the scope and confirms the cgroup is gone (no surviving lane processes).
 */
export function createCodexSwarmSandboxLauncher(options: CodexSwarmProfileOptions) {
  const systemctl = options.systemctlPath ?? "/usr/bin/systemctl";
  return {
    profile: CODEX_SWARM_PROFILE,
    launch: (context: CodexSwarmLaunchContext) => buildCodexSwarmLaunch(options, context),
    async teardown(launch: { unitName?: string }): Promise<boolean> {
      if (!launch.unitName) return true;
      const { execFile } = await import("node:child_process");
      const run = (args: string[]) =>
        new Promise<{ code: number; stdout: string }>((resolve) => {
          execFile(systemctl, ["--user", ...args], { timeout: 10_000 }, (error, stdout) => {
            const code = error && typeof (error as { code?: unknown }).code === "number" ? (error as { code: number }).code : error ? 1 : 0;
            resolve({ code, stdout: String(stdout) });
          });
        });
      await run(["kill", "--signal=SIGKILL", launch.unitName]);
      await run(["stop", launch.unitName]);
      // is-active exits non-zero once the unit is gone or inactive.
      const state = await run(["is-active", launch.unitName]);
      return state.code !== 0 && state.stdout.trim() !== "active";
    }
  };
}
