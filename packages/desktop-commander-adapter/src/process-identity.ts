import { readFileSync } from "node:fs";
import { ControlStackError } from "@agent-control-stack/shared";

/**
 * ADR 0016 Slice 5 - live Linux process-identity resolution.
 *
 * The Slice 4 ownership primitive (`verifyProcessSessionOwnership`,
 * `createProcessSession`) is keyed on `(pid, bootId, procStartTicks)`. This
 * module is the ONLY place that resolves that triple from the live OS -
 * every caller must go through here rather than trusting a bare pid, so a
 * reused pid can never be mistaken for the process a session was created for.
 *
 * Both reads are synchronous /proc reads with no fallback: if either file is
 * missing, unreadable, or malformed, resolution throws a `ControlStackError`
 * rather than returning a partial or best-guess identity. Callers must treat
 * that as a denial, never as "identity unknown, proceed anyway".
 */

export interface ProcessIdentity {
  pid: number;
  bootId: string;
  procStartTicks: number;
}

/**
 * The host boot id from `/proc/sys/kernel/random/boot_id`. This value is
 * stable for the lifetime of one boot and changes on every reboot, which is
 * exactly the property `reconcileProcessSessionsForBoot` (Slice 4) depends
 * on: a session recorded under a prior boot id can never be re-affirmed as
 * active after a restart, because the boot id itself will differ.
 */
export function getHostBootId(): string {
  let raw: string;
  try {
    raw = readFileSync("/proc/sys/kernel/random/boot_id", "utf8");
  } catch (error) {
    throw new ControlStackError(
      "desktop_commander_boot_id_unavailable",
      `could not read host boot id: ${error instanceof Error ? error.message : String(error)}`
    );
  }
  const bootId = raw.trim();
  if (bootId.length === 0) {
    throw new ControlStackError("desktop_commander_boot_id_unavailable", "host boot id is empty");
  }
  return bootId;
}

/**
 * The process start time (field 22 of `/proc/<pid>/stat`, in clock ticks
 * since boot) for a live pid. This is the second half of the identity
 * triple: the OS reuses pids, but two different processes that ever held the
 * same pid within one boot cannot share the same start tick count, so
 * (pid, bootId, procStartTicks) never collides across a pid-reuse boundary.
 *
 * `/proc/<pid>/stat`'s second field is the command name wrapped in
 * parentheses and may itself contain spaces, parentheses, or newlines, so the
 * comm field is skipped by finding the LAST ")" rather than naively
 * whitespace-splitting the whole line.
 */
export function getProcessStartTicks(pid: number): number {
  if (!Number.isInteger(pid) || pid <= 0) {
    throw new ControlStackError("desktop_commander_process_identity_invalid", `pid must be a positive integer: ${pid}`);
  }
  let raw: string;
  try {
    raw = readFileSync(`/proc/${pid}/stat`, "utf8");
  } catch (error) {
    throw new ControlStackError(
      "desktop_commander_process_stat_unavailable",
      `could not read /proc/${pid}/stat (process may not exist or may have already exited): ${
        error instanceof Error ? error.message : String(error)
      }`
    );
  }
  const closeParen = raw.lastIndexOf(")");
  if (closeParen === -1) {
    throw new ControlStackError(
      "desktop_commander_process_stat_unparseable",
      `/proc/${pid}/stat did not have the expected "(comm)" field`
    );
  }
  // Fields after "(comm)" are space-separated; starttime is field 22 overall,
  // i.e. the 20th field after the comm field (state=1, ppid=2, ..., starttime=20).
  const rest = raw.slice(closeParen + 1).trim().split(/\s+/);
  const STARTTIME_INDEX_AFTER_COMM = 19; // 0-indexed: state, ppid, pgrp, ... starttime is index 19
  const starttimeRaw = rest[STARTTIME_INDEX_AFTER_COMM];
  const starttime = starttimeRaw === undefined ? NaN : Number(starttimeRaw);
  if (!Number.isFinite(starttime) || starttime < 0) {
    throw new ControlStackError(
      "desktop_commander_process_stat_unparseable",
      `/proc/${pid}/stat starttime field was not a valid non-negative number`
    );
  }
  return starttime;
}

/** Resolve the full live identity triple for a pid. Fails closed on any error. */
export function resolveCurrentProcessIdentity(pid: number): ProcessIdentity {
  const bootId = getHostBootId();
  const procStartTicks = getProcessStartTicks(pid);
  return { pid, bootId, procStartTicks };
}

/**
 * Extract the pid Desktop Commander reports after a successful `start_process`
 * call. The upstream tool's exact wording is not part of ACS's control
 * surface (Desktop Commander is untrusted input once its process boundary is
 * crossed), so this looks for the first "pid"/"PID" followed by a number
 * anywhere in the normalised text output rather than assuming one fixed
 * sentence. Returns `undefined` - never a guessed pid - when no confident
 * match is found; callers must treat that as a resolution failure.
 */
export function parseStartedProcessPid(output: string): number | undefined {
  if (typeof output !== "string" || output.length === 0) return undefined;
  const match = output.match(/\bpid\b[^0-9-]{0,10}(-?\d+)/i);
  if (!match) return undefined;
  const pid = Number(match[1]);
  if (!Number.isInteger(pid) || pid <= 0) return undefined;
  return pid;
}
