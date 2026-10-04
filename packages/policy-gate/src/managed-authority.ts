import { existsSync, readdirSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
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
  /** Live processes whose command is a managed Desktop Commander executor. */
  managedExecutorPids: readonly number[];
  /** Command line of the lease holder, when readable. */
  holderCommand?: string;
  /**
   * Distinct ACS executor roots observed among managedExecutorPids, i.e. the
   * number of genuinely competing executor topologies. One ACS release normally
   * runs several roles (control plane, Jace Commander bridge, remote) that all
   * share a root and are therefore NOT competing. Supplied by the caller so
   * ambiguity is derived from identity, not from a process count.
   */
  competingExecutorRoots?: readonly string[];
}

/**
 * Recognizes a managed Desktop Commander / Jace Commander executor process.
 *
 * Matching is anchored to the ACS executor SCRIPT SHAPE, never a bare
 * "dist/index.js" substring: OpenClaw, claude-acp, Chrome, Ollama and the node
 * binary all contain a dist/index.js and must never enter the managed set.
 *
 * The identity returned is the release root that contains the script, so the
 * several roles ONE release runs - control plane, Jace Commander bridge, remote -
 * collapse to a single topology identity instead of counting as competitors.
 */
const ACS_EXECUTOR_SCRIPTS: readonly string[] = [
  "dist/index.js",
  "dist/jace-commander/cli.js",
  "dist/control-plane/server.js"
];
const ACS_EXECUTOR_PACKAGE_DIR = "desktop-commander";

/**
 * The release roots ACS actually publishes under. An executor script counts as a
 * managed executor only when it lives inside one of these, so an unrelated program
 * that merely ships a dist/index.js can never enter the managed-executor set.
 */
const ACS_RELEASE_ROOT_PATTERN =
  /(?:^|\/)releases\/(?:acs|dc|dc-mcp-gateway)\/[^/]+\/|(?:^|\/)packages\/(?:[^/]+\/)*desktop-commander\//;

export function acsExecutorRoot(command: string): string | undefined {
  let root: string | undefined;
  for (const token of command.split(/\s+/u)) {
    if (!token.startsWith("/")) {
      continue;
    }
    // Resolve first so a traversal spelling ("<known>/../../evil/dist/index.js")
    // cannot make a different root textually look like a known one.
    const resolved = resolve(token);
    const marker = resolved.lastIndexOf("/");
    if (marker <= 0) {
      continue;
    }
    const script = resolved.slice(marker + 1);
    const parent = resolved.slice(0, marker);

    // An ACS executor script is deployed by ACS, never vendored inside somebody
    // else's package tree. OpenClaw (node_modules/openclaw/dist/index.js) and
    // claude-acp (node_modules/@agentclient/dist/index.js) have the exact same
    // script shape, so "is it under node_modules" is the discriminator that keeps
    // them out of the managed-executor set.
    const vendored = parent.split("/").includes("node_modules");

    if (!vendored) {
      for (const known of ACS_EXECUTOR_SCRIPTS) {
        if (resolved.endsWith(known)) {
          const candidate = resolved.slice(0, resolved.length - known.length);
          // Only trust a script that actually sits under a real ACS release root.
          // An unrelated program that merely ships a dist/index.js
          // (/srv/other, /opt/foo, /usr/local/app) must never be counted as a
          // managed executor: that would manufacture a false competing topology
          // AND could satisfy the lease-holder identity check.
          if (ACS_RELEASE_ROOT_PATTERN.test(candidate)) {
            root = candidate;
            break;
          }
        }
      }
    }
    if (root) {
      break;
    }

    // In-repo dev layouts: .../packages/desktop-commander/... or
    // .../projects/desktop-commander/...
    const segments = parent.split("/");
    const lastSegment = segments[segments.length - 1] ?? "";
    if (lastSegment === ACS_EXECUTOR_PACKAGE_DIR) {
      root = parent;
      break;
    }
    void script;
  }
  return root ? root.replace(/\/+$/u, "") : undefined;
}

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
  // A single ACS release legitimately runs several executor roles (control
  // plane, Jace Commander bridge, remote). Ambiguity is competing executor
  // TOPOLOGIES - distinct ACS roots, or a second lease owner - not a raw process
  // count. When the caller supplies no root analysis, fall back to the count so
  // ambiguity can never be silently suppressed.
  const competingRoots = runtime.competingExecutorRoots;
  const competing = competingRoots === undefined ? runtime.managedExecutorPids.length > 1 : competingRoots.length > 1;
  // An EMPTY discovery set cannot positively identify the lease holder as a managed
  // executor. Treating "found nothing" as "nothing to check" would let an unrecognized
  // (or hostile) executor hold the lease with zero identity verified, which is the
  // original defect. Fail closed instead: no discovered executor means ambiguous.
  const undiscovered = runtime.managedExecutorPids.length === 0;
  const holderUnmanaged =
    typeof runtime.holderCommand === "string" &&
    (runtime.holderCommand.includes("@wonderwhy-er/desktop-commander") ||
      runtime.holderCommand.includes("--standalone") ||
      runtime.holderCommand.includes("break-glass"));
  const holderManaged = typeof runtime.holderCommand === "string" && isManagedExecutorCommand(runtime.holderCommand);
  const managedRuntime =
    !launchUnmanaged &&
    !holderUnmanaged &&
    lease.active &&
    !lease.ambiguous &&
    !competing &&
    !undiscovered &&
    (backendManaged || holderManaged);
  const authoritative =
    lease.active && !lease.ambiguous && !competing && !undiscovered && !breakGlass.active && !breakGlass.ambiguous;
  const owner = lease.active && typeof lease.pid === "number" ? `managed:pid:${lease.pid}` : null;
  const detail = [
    lease.detail,
    breakGlass.detail,
    competing
      ? `competing managed executor topologies: ${(competingRoots ?? []).join(", ") || "multiple"}`
      : undiscovered
        ? "no managed executor discovered to verify the lease holder"
        : ""
  ]
    .filter((part) => part.length > 0)
    .join("; ");
  return {
    authorityOwner: authoritative ? owner : owner,
    authoritative,
    leaseActive: lease.active,
    leaseAmbiguous: lease.ambiguous || competing || undiscovered,
    breakGlassActive: breakGlass.active,
    breakGlassAmbiguous: breakGlass.ambiguous,
    multipleAuthoritativeExecutors: competing,
    managedRuntime,
    managedExecutorDiscovered: !undiscovered,
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

/** True when a command line is a managed DC/JC executor process. */
export function isManagedExecutorCommand(command: string): boolean {
  return acsExecutorRoot(command) !== undefined;
}

export function listManagedExecutorPids(): number[] {
  return listManagedExecutors().pids;
}

/**
 * Managed executor processes plus the distinct ACS executor roots they belong to.
 * Several processes sharing one root are roles of the SAME executor topology;
 * more than one root means genuinely competing executors.
 */
export function listManagedExecutors(): { pids: number[]; roots: string[] } {
  const pids: number[] = [];
  const roots = new Set<string>();
  let names: string[];
  try {
    names = readdirSync("/proc").filter((name) => /^\d+$/.test(name));
  } catch {
    return { pids, roots: [] };
  }
  for (const name of names) {
    const pid = Number(name);
    if (!Number.isInteger(pid)) continue;
    const command = readPidCommand(pid);
    const root = command ? acsExecutorRoot(command) : undefined;
    if (root === undefined) continue;
    pids.push(pid);
    roots.add(root);
  }
  return { pids, roots: [...roots] };
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
  const executors = listManagedExecutors();
  return observeManagedAuthority(files, {
    nowMs,
    bootId: readBootId(),
    processStartTicks: typeof leasePid === "number" ? readProcessStartTicks(leasePid) : undefined,
    executionBackend: env.ACS_EXECUTION_BACKEND,
    launchArgs,
    pidAlive,
    managedExecutorPids: executors.pids,
    competingExecutorRoots: executors.roots,
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
