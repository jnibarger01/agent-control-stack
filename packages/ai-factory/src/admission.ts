import { createHash } from "node:crypto";
import type { FactoryPreviewAccepted } from "./preview.js";

/**
 * F2: map an accepted, principal-bound preview onto an existing ACS coding mission.
 *
 * Pure helpers only. The gateway performs the single atomic mission insert. No second
 * `factory_jobs` lease store exists: the ACS mission record *is* the admission.
 *
 * Idempotency: the mission id is a digest of (principal, orderId), so the mission table's
 * primary key enforces "one mission per principal order" atomically. The mission summary
 * embeds the intent hash, so a changed payload under the same order id is an identity
 * conflict, never a silent overwrite.
 */
export const FACTORY_MISSION_PREFIX = "factory-" as const;
export const FACTORY_SUMMARY_PREFIX = "acs.ai-factory.v1" as const;

export function factoryMissionId(principal: string, orderId: string): string {
  const digest = createHash("sha256")
    .update("acs:ai-factory-order:v1\n", "utf8")
    .update(JSON.stringify([principal, orderId]), "utf8")
    .digest("hex");
  return FACTORY_MISSION_PREFIX + digest.slice(0, 48);
}

export function isFactoryMissionId(value: string): boolean {
  return /^factory-[a-f0-9]{48}$/u.test(value);
}

/**
 * The summary is the identity token the mission store compares on replay. It carries only hashes
 * and the order id: never the untrusted objective text.
 */
export function factoryMissionSummary(preview: Pick<FactoryPreviewAccepted, "orderId" | "intentHash">): string {
  return FACTORY_SUMMARY_PREFIX + " order=" + preview.orderId + " intent=" + preview.intentHash;
}

export interface FactoryMissionBudget {
  readonly maxWallClockMs: number;
  readonly maxParallelWorkUnits: number;
  readonly maxSpendUsd: number;
}

/** ACS-reduced constraints become the mission budget; nothing the caller sent can widen them. */
export function factoryMissionBudget(preview: Pick<FactoryPreviewAccepted, "constraints">): FactoryMissionBudget {
  return {
    maxWallClockMs: preview.constraints.maxWallClockMs,
    maxParallelWorkUnits: preview.constraints.maxLanes,
    maxSpendUsd: preview.constraints.maxSpendMicrousd / 1_000_000
  };
}

export interface FactoryMissionPlan {
  readonly missionId: string;
  readonly repository: string;
  /** The immutable commit is the base ref; a branch name could move after admission. */
  readonly baseRef: string;
  readonly baseSha: string;
  readonly summary: string;
  readonly initiatorId: string;
  readonly budget: FactoryMissionBudget;
}

export function factoryMissionPlan(preview: FactoryPreviewAccepted): FactoryMissionPlan {
  return {
    missionId: factoryMissionId(preview.principal, preview.orderId),
    repository: preview.repository.fullName,
    baseRef: preview.baseSha,
    baseSha: preview.baseSha,
    summary: factoryMissionSummary(preview),
    initiatorId: preview.principal,
    budget: factoryMissionBudget(preview)
  };
}
