import { readFileSync, renameSync, writeFileSync } from "node:fs";
import type { CodingMissionStore } from "@agent-control-stack/coding-mission";
import { FACTORY_DRAFT_PR_EFFECT, factoryBranch, factoryPublicationIdempotencyKey, type FactoryRemote } from "./publish.js";

/**
 * F9: durable reconciliation, revocation and cancellation.
 *
 * Rules:
 * - A process is signalled only if its pid AND kernel start time match what ACS recorded; a recycled
 *   pid is never killed.
 * - After a crash, an attempt that was running has unknown effects: it becomes `unknown` (never
 *   `pending`), so nothing is replayed without an explicit decision.
 * - An external effect is cleared only when the remote proves it never happened.
 * - Cancellation reports what it stopped and what remains uncertain; it never claims a rollback.
 */
export interface ProcessIdentity {
  pid: number;
  /** Field 22 of /proc/<pid>/stat: start time in clock ticks since boot. */
  startTicks: string;
}

export function processIdentity(pid: number, procRoot = "/proc"): ProcessIdentity | undefined {
  if (!Number.isSafeInteger(pid) || pid <= 1) return undefined;
  try {
    const stat = readFileSync(`${procRoot}/${pid}/stat`, "utf8");
    // comm may contain spaces/parentheses; fields after the last ')' are positional.
    const fields = stat.slice(stat.lastIndexOf(")") + 2).split(" ");
    const startTicks = fields[19];
    if (!startTicks || !/^\d+$/u.test(startTicks)) return undefined;
    return { pid, startTicks };
  } catch {
    return undefined;
  }
}

export type SignalOutcome = "signalled" | "gone" | "identity_mismatch";

export function signalIfSameProcess(identity: ProcessIdentity, signal: NodeJS.Signals = "SIGKILL", procRoot = "/proc"): SignalOutcome {
  const current = processIdentity(identity.pid, procRoot);
  if (!current) return "gone";
  if (current.startTicks !== identity.startTicks) return "identity_mismatch";
  try {
    process.kill(identity.pid, signal);
    return "signalled";
  } catch {
    return "gone";
  }
}

export interface FactoryAttemptRecord {
  missionId: string;
  unitId: string;
  claimToken: string;
  process?: ProcessIdentity;
  /** Containment unit (systemd scope) to stop, if any. */
  unitName?: string;
  startedAt: string;
}

export interface FactoryAttemptRegistry {
  put(record: FactoryAttemptRecord): void;
  remove(missionId: string, unitId: string): void;
  list(): FactoryAttemptRecord[];
}

/** Crash-safe JSON registry (write to temp + rename). Lives on ACS-owned storage. */
export function createFileAttemptRegistry(path: string): FactoryAttemptRegistry {
  const read = (): FactoryAttemptRecord[] => {
    try {
      const parsed = JSON.parse(readFileSync(path, "utf8")) as unknown;
      return Array.isArray(parsed) ? (parsed as FactoryAttemptRecord[]) : [];
    } catch {
      return [];
    }
  };
  const write = (records: FactoryAttemptRecord[]) => {
    const temp = `${path}.${process.pid}.tmp`;
    writeFileSync(temp, JSON.stringify(records), { mode: 0o600 });
    renameSync(temp, path);
  };
  return {
    put(record) {
      write([...read().filter((r) => !(r.missionId === record.missionId && r.unitId === record.unitId)), record]);
    },
    remove(missionId, unitId) {
      write(read().filter((r) => !(r.missionId === missionId && r.unitId === unitId)));
    },
    list: read
  };
}

export type FactoryReconcileStore = Pick<CodingMissionStore, "workUnits" | "workUnitClaim" | "markOperation">;

export interface BootReconcileReport {
  markedUnknown: { missionId: string; unitId: string }[];
  killed: { missionId: string; unitId: string; outcome: SignalOutcome }[];
  stopped: string[];
}

/**
 * Run on ACS start before any dispatch. Every attempt that was running when ACS stopped is orphaned:
 * its socket session is gone and its effects are unknown. Kill what we can prove is ours, stop its
 * containment unit, and mark the unit unknown. Units already terminal or unknown are left as they are.
 */
export async function reconcileFactoryOnBoot(deps: {
  store: FactoryReconcileStore;
  registry: FactoryAttemptRegistry;
  missionIds: readonly string[];
  stopUnit?: (unitName: string) => Promise<boolean>;
}): Promise<BootReconcileReport> {
  const report: BootReconcileReport = { markedUnknown: [], killed: [], stopped: [] };
  const records = deps.registry.list();
  for (const record of records) {
    if (record.process) {
      report.killed.push({ missionId: record.missionId, unitId: record.unitId, outcome: signalIfSameProcess(record.process) });
    }
    if (record.unitName && deps.stopUnit && (await deps.stopUnit(record.unitName))) report.stopped.push(record.unitName);
  }
  for (const missionId of deps.missionIds) {
    for (const unit of deps.store.workUnits(missionId)) {
      if (unit.status !== "running" && unit.status !== "checkpointed") continue;
      deps.store.markOperation(missionId, unit.unitId, "unknown");
      report.markedUnknown.push({ missionId, unitId: unit.unitId });
    }
  }
  for (const record of records) deps.registry.remove(record.missionId, record.unitId);
  return report;
}

/**
 * Revoke a live attempt: move the fence first (the unit leaves `running`, so every fence check and any
 * late result now fails), then kill the process only if its identity still matches.
 */
export function revokeFactoryAttempt(
  deps: { store: FactoryReconcileStore; registry: FactoryAttemptRegistry },
  input: { missionId: string; unitId: string; claimToken: string }
): { fenceMoved: boolean; process: SignalOutcome | "none" } {
  const claim = deps.store.workUnitClaim(input.missionId, input.unitId);
  if (!claim || claim.claimToken !== input.claimToken || claim.status !== "running") {
    return { fenceMoved: false, process: "none" };
  }
  deps.store.markOperation(input.missionId, input.unitId, "unknown");
  const record = deps.registry.list().find((r) => r.missionId === input.missionId && r.unitId === input.unitId && r.claimToken === input.claimToken);
  const outcome = record?.process ? signalIfSameProcess(record.process) : "none";
  if (record) deps.registry.remove(input.missionId, input.unitId);
  return { fenceMoved: true, process: outcome };
}

export type FactoryPublicationReconcile =
  | { status: "none" }
  | { status: "published"; url: string }
  | { status: "reconciled_published"; url: string }
  | { status: "cleared_no_side_effect" }
  | { status: "uncertain"; reason: string };

/**
 * Resolve an `unknown` draft-PR effect from the remote's actual state. Clears it only when neither
 * the factory branch nor a pull request exists (the push never happened). Otherwise it is recorded
 * as published (PR found at the expected head) or left uncertain for an operator.
 */
export async function reconcileFactoryPublication(
  deps: { store: Pick<CodingMissionStore, "effect" | "succeedEffect" | "clearEffect">; remote: Pick<FactoryRemote, "findOpenPull" | "branchHead"> },
  input: { missionId: string; expectedHead: string }
): Promise<FactoryPublicationReconcile> {
  const effect = deps.store.effect(input.missionId, FACTORY_DRAFT_PR_EFFECT);
  if (!effect) return { status: "none" };
  if (effect.outcome === "succeeded") return { status: "published", url: effect.externalId ?? "" };
  const branch = factoryBranch(input.missionId);
  let pull;
  let branchHead;
  try {
    pull = await deps.remote.findOpenPull(branch);
    branchHead = await deps.remote.branchHead(branch);
  } catch {
    return { status: "uncertain", reason: "remote_unavailable" };
  }
  if (pull && pull.headSha === input.expectedHead) {
    // Record the same idempotency key the publisher derives, so a later replay recognises it.
    deps.store.succeedEffect(input.missionId, FACTORY_DRAFT_PR_EFFECT, pull.url, {
      pullRequest: pull,
      idempotencyKey: factoryPublicationIdempotencyKey(input.missionId, input.expectedHead),
      reconciled: true
    });
    return { status: "reconciled_published", url: pull.url };
  }
  if (!pull && branchHead === undefined) {
    deps.store.clearEffect(input.missionId, FACTORY_DRAFT_PR_EFFECT);
    return { status: "cleared_no_side_effect" };
  }
  return { status: "uncertain", reason: pull ? "pull_head_mismatch" : "branch_pushed_without_open_pull" };
}

export interface FactoryCancellationReport {
  cancelledUnits: string[];
  /** In flight when cancelled: local workspace effects are unknown. */
  uncertainUnits: string[];
  publication: "none" | "published_not_rolled_back" | "uncertain";
  killed: SignalOutcome[];
  /** Always false: ACS cannot prove a rollback of effects it does not control. */
  rollbackClaimed: false;
}

export function cancelFactoryMission(
  deps: { store: Pick<CodingMissionStore, "cancelMission" | "effect">; registry: FactoryAttemptRegistry },
  input: { missionId: string; reason: string; now: string }
): FactoryCancellationReport | { refused: string } {
  const killed: SignalOutcome[] = [];
  for (const record of deps.registry.list().filter((r) => r.missionId === input.missionId)) {
    if (record.process) killed.push(signalIfSameProcess(record.process));
    deps.registry.remove(record.missionId, record.unitId);
  }
  const result = deps.store.cancelMission(input.missionId, { reason: input.reason, now: input.now });
  if (!result.ok) return { refused: result.outcome };
  const effect = deps.store.effect(input.missionId, FACTORY_DRAFT_PR_EFFECT);
  return {
    cancelledUnits: result.cancelled,
    uncertainUnits: result.uncertain,
    publication: !effect ? "none" : effect.outcome === "succeeded" ? "published_not_rolled_back" : "uncertain",
    killed,
    rollbackClaimed: false
  };
}
