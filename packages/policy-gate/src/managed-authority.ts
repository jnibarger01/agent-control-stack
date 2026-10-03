import { existsSync, readdirSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import type { ManagedAuthorityObservation } from "./execution-mode.js";

export interface LeaseFile {
  pid?: number;
  expiresAt?: number;
  instanceId?: string;
  bootId?: string;
  processStartTicks?: string;
}

export interface AuthorityFiles {
  leaseRaw: string | null;
  breakGlassRaw: string | null;
  leaseExists: boolean;
  breakGlassExists: boolean;
}

export interface AuthorityRuntime {
  nowMs: number;
  bootId?: string;
  /** starttime field from /proc/<pid>/stat for the lease holder, when readable. */
  processStartTicks?: string;
  executionBackend?: string;
  launchArgs: readonly string[];
  pidAlive: (pid: number) => boolean;
  /** Live processes whose command is the managed Desktop Commander executor. */
  managedExecutorPids: readonly number[];
  /** Command line of the lease holder, when readable. */
  holderCommand?: string;
}

const MANAGED_EXECUTOR_MARK = "desktop-commander/dist/index.js";

export function defaultAuthorityStateDir(env: NodeJS.ProcessEnv = process.env): string {
  const override = env.DESKTOP_COMMANDER_EXECUTOR_LOCK_DIR?.trim();
  if (override) return override;
  return join(homedir(), ".desktop-commander");
}

export function observeManagedAuthority(files: AuthorityFiles, runtime: AuthorityRuntime): ManagedAuthorityObservation {
  const launchUnmanaged = runtime.launchArgs.includes("--standalone");
  const backendManaged = runtime.executionBackend?.trim() === "desktop_commander";
  const lease = classifyLease(files, runtime);
  const breakGlass = classifyBreakGlass(files, runtime.pidAlive);
  const multiple = runtime.managedExecutorPids.length > 1;
  const holderUnmanaged =
    typeof runtime.holderCommand === "string" &&
    (runtime.holderCommand.includes("@wonderwhy-er/desktop-commander") ||
      runtime.holderCommand.includes("--standalone") ||
      runtime.holderCommand.includes("break-glass"));
  const holderManaged =
    typeof runtime.holderCommand === "string" && runtime.holderCommand.includes(MANAGED_EXECUTOR_MARK);
  const managedRuntime =
    !launchUnmanaged &&
    !holderUnmanaged &&
    lease.active &&
    !lease.ambiguous &&
    !multiple &&
    (backendManaged || holderManaged);
  const authoritative = lease.active && !lease.ambiguous && !multiple && !breakGlass.active && !breakGlass.ambiguous;
  const owner = lease.active && typeof lease.pid === "number" ? `managed:pid:${lease.pid}` : null;
  const detail = [lease.detail, breakGlass.detail, multiple ? "multiple managed executors" : ""]
    .filter((part) => part.length > 0)
    .join("; ");
  return {
    authorityOwner: authoritative ? owner : owner,
    authoritative,
    leaseActive: lease.active,
    leaseAmbiguous: lease.ambiguous || multiple,
    breakGlassActive: breakGlass.active,
    breakGlassAmbiguous: breakGlass.ambiguous,
    multipleAuthoritativeExecutors: multiple,
    managedRuntime,
    detail
  };
}

function classifyLease(
  files: AuthorityFiles,
  runtime: AuthorityRuntime
): { active: boolean; ambiguous: boolean; pid?: number; detail: string } {
  if (!files.leaseExists) {
    return { active: false, ambiguous: false, detail: "executor lease is absent" };
  }
  if (files.leaseRaw == null) {
    return { active: false, ambiguous: true, detail: "executor lease is unreadable" };
  }
  let parsed: LeaseFile;
  try {
    parsed = JSON.parse(files.leaseRaw) as LeaseFile;
  } catch {
    return { active: false, ambiguous: true, detail: "executor lease is malformed" };
  }
  if (typeof parsed.pid !== "number" || typeof parsed.expiresAt !== "number" || typeof parsed.instanceId !== "string") {
    return { active: false, ambiguous: true, detail: "executor lease schema is incomplete" };
  }
  if (parsed.bootId && runtime.bootId && parsed.bootId !== runtime.bootId) {
    return { active: false, ambiguous: true, pid: parsed.pid, detail: "executor lease boot id does not match" };
  }
  if (leaseProcessWasReplaced(parsed, runtime)) {
    return { active: false, ambiguous: true, pid: parsed.pid, detail: "executor lease holder pid was reused" };
  }
  const alive = runtime.pidAlive(parsed.pid);
  if (!alive) {
    return {
      active: false,
      ambiguous: false,
      pid: parsed.pid,
      detail: `executor lease holder ${parsed.pid} is not alive`
    };
  }
  // The canonical executor lock uses a 10s dead-PID grace and renews every 60s.
  // expiresAt in the past does not invalidate a live, identity-matching holder.
  if (runtime.managedExecutorPids.length > 0 && !runtime.managedExecutorPids.includes(parsed.pid)) {
    return {
      active: false,
      ambiguous: true,
      pid: parsed.pid,
      detail: "executor lease holder is not a managed executor"
    };
  }
  return { active: true, ambiguous: false, pid: parsed.pid, detail: `executor lease held by pid ${parsed.pid}` };
}

function classifyBreakGlass(
  files: AuthorityFiles,
  pidAlive: (pid: number) => boolean
): { active: boolean; ambiguous: boolean; detail: string } {
  if (!files.breakGlassExists) {
    return { active: false, ambiguous: false, detail: "" };
  }
  if (files.breakGlassRaw == null) {
    return { active: true, ambiguous: true, detail: "break-glass marker is unreadable" };
  }
  let parsed: { pid?: number };
  try {
    parsed = JSON.parse(files.breakGlassRaw) as { pid?: number };
  } catch {
    return { active: true, ambiguous: true, detail: "break-glass marker is malformed" };
  }
  if (typeof parsed.pid !== "number") {
    return { active: true, ambiguous: true, detail: "break-glass marker has no pid" };
  }
  if (!pidAlive(parsed.pid)) {
    return { active: false, ambiguous: false, detail: "break-glass marker is stale" };
  }
  return { active: true, ambiguous: false, detail: `break-glass active pid ${parsed.pid}` };
}

export function readAuthorityFiles(stateDir: string): AuthorityFiles {
  const leasePath = join(stateDir, "executor.lock");
  const breakGlassPath = join(stateDir, "break-glass.lock");
  return {
    leaseExists: existsSync(leasePath),
    breakGlassExists: existsSync(breakGlassPath),
    leaseRaw: readOptional(leasePath),
    breakGlassRaw: readOptional(breakGlassPath)
  };
}

function readOptional(path: string): string | null {
  if (!existsSync(path)) return null;
  try {
    return readFileSync(path, "utf8");
  } catch {
    return null;
  }
}

export function pidAlive(pid: number): boolean {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return Boolean(error && typeof error === "object" && "code" in error && error.code === "EPERM");
  }
}

export function readBootId(): string | undefined {
  try {
    return readFileSync("/proc/sys/kernel/random/boot_id", "utf8").trim() || undefined;
  } catch {
    return undefined;
  }
}

function leaseProcessWasReplaced(parsed: LeaseFile, runtime: AuthorityRuntime): boolean {
  if (typeof parsed.processStartTicks !== "string" || !/^\d+$/.test(parsed.processStartTicks)) return false;
  if (!runtime.processStartTicks) return false;
  return runtime.processStartTicks !== parsed.processStartTicks;
}

export function readPidCommand(pid: number): string | undefined {
  try {
    return readFileSync(`/proc/${pid}/cmdline`, "utf8").replaceAll("\u0000", " ").trim();
  } catch {
    return undefined;
  }
}

export function readProcessStartTicks(pid: number): string | undefined {
  try {
    const stat = readFileSync(`/proc/${pid}/stat`, "utf8");
    const ticks = stat
      .slice(stat.lastIndexOf(")") + 2)
      .trim()
      .split(/\s+/)[19];
    return ticks && /^\d+$/.test(ticks) ? ticks : undefined;
  } catch {
    return undefined;
  }
}

export function listManagedExecutorPids(): number[] {
  const pids: number[] = [];
  let names: string[];
  try {
    names = readdirSync("/proc").filter((name) => /^\d+$/.test(name));
  } catch {
    return pids;
  }
  for (const name of names) {
    const pid = Number(name);
    if (!Number.isInteger(pid)) continue;
    const command = readPidCommand(pid);
    if (command?.includes(MANAGED_EXECUTOR_MARK)) pids.push(pid);
  }
  return pids;
}

export function observeLiveManagedAuthority(
  env: NodeJS.ProcessEnv = process.env,
  nowMs = Date.now()
): ManagedAuthorityObservation {
  const stateDir = defaultAuthorityStateDir(env);
  let launchArgs: string[] = [];
  const rawArgs = env.ACS_DESKTOP_COMMANDER_ARGS_JSON;
  if (rawArgs) {
    try {
      const parsed = JSON.parse(rawArgs) as unknown;
      if (Array.isArray(parsed) && parsed.every((part) => typeof part === "string")) {
        launchArgs = parsed;
      } else {
        return {
          authorityOwner: null,
          authoritative: false,
          leaseActive: false,
          leaseAmbiguous: true,
          breakGlassActive: false,
          breakGlassAmbiguous: false,
          multipleAuthoritativeExecutors: false,
          managedRuntime: false,
          detail: "ACS_DESKTOP_COMMANDER_ARGS_JSON is not a string array"
        };
      }
    } catch {
      return {
        authorityOwner: null,
        authoritative: false,
        leaseActive: false,
        leaseAmbiguous: true,
        breakGlassActive: false,
        breakGlassAmbiguous: false,
        multipleAuthoritativeExecutors: false,
        managedRuntime: false,
        detail: "ACS_DESKTOP_COMMANDER_ARGS_JSON is malformed"
      };
    }
  }
  const files = readAuthorityFiles(stateDir);
  const leasePid = leasePidFrom(files);
  return observeManagedAuthority(files, {
    nowMs,
    bootId: readBootId(),
    processStartTicks: typeof leasePid === "number" ? readProcessStartTicks(leasePid) : undefined,
    executionBackend: env.ACS_EXECUTION_BACKEND,
    launchArgs,
    pidAlive,
    managedExecutorPids: listManagedExecutorPids(),
    holderCommand: typeof leasePid === "number" ? readPidCommand(leasePid) : undefined
  });
}

function leasePidFrom(files: AuthorityFiles): number | undefined {
  if (!files.leaseRaw) return undefined;
  try {
    const parsed = JSON.parse(files.leaseRaw) as { pid?: number };
    return typeof parsed.pid === "number" ? parsed.pid : undefined;
  } catch {
    return undefined;
  }
}
