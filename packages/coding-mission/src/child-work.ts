import { createHash, timingSafeEqual } from "node:crypto";
import type { DatabaseSync } from "node:sqlite";
import { stableHash } from "@agent-control-stack/shared";
import {
  readAutonomousAuthority,
  readAutonomousAuthorityRevocation,
  type AutonomousAuthorityDefinition,
  type AutonomousAuthorityGrant
} from "@agent-control-stack/work-items";
import type { VerificationPolicy, WorkUnitKind } from "./mission-model.js";

/**
 * request_child_work: an agent asks ACS for subordinate work. It never spawns anything and never mints authority.
 * ACS decides inside one IMMEDIATE transaction (see CodingMissionStore.requestChildWork); this file holds the pure
 * pieces: request shape, hashing, and root-grant verification.
 */
export const CHILD_WORK_TYPES = ["research", "coding", "review", "testing", "analysis", "verification"] as const;
export type ChildWorkType = (typeof CHILD_WORK_TYPES)[number];

/** Which work-unit kind each requested work type runs as. */
export const CHILD_WORK_UNIT_KIND: Readonly<Record<ChildWorkType, WorkUnitKind>> = Object.freeze({
  research: "agent",
  coding: "coding",
  review: "agent",
  testing: "shell",
  analysis: "agent",
  verification: "verification"
});

/** A child limit that is unset on the mission budget still gets these caps, so delegation can never be uncapped. */
export const CHILD_WORK_FALLBACK_LIMITS = Object.freeze({
  child_depth: 2,
  parallel_work_units: 4,
  child_work_units: 8
});

/** Child statuses that still occupy a parallel slot: the unit may yet run, or may already have started work. */
export const LIVE_CHILD_STATUSES: readonly string[] = [
  "pending",
  "ready",
  "claimed",
  "running",
  "checkpointed",
  "verifying",
  "retryable",
  "unknown"
];

export interface ChildWorkRequest {
  missionId: string;
  /** The requesting (parent) work unit. It must hold a live claim. */
  parentUnitId: string;
  /** Idempotency key, unique per mission. A retry with the same content replays; different content is refused. */
  requestId: string;
  /** Id of the child unit to create. */
  unitId: string;
  title: string;
  purpose: string;
  workType: ChildWorkType;
  /** Proof that the caller is the current claimant of the parent unit. The token is only ever compared and hashed. */
  claim: { token: string; workerId: string; attempt: number };
  /** The authority the child asks for. Must be a subset of the parent's persisted authority. */
  requestedAuthority: AutonomousAuthorityDefinition;
  /**
   * Required when the child runs under a different actor than the parent: names that actor explicitly. The actor must
   * then claim the child itself, and is verified against the child's persisted authority at that claim.
   */
  assignedActorId?: string;
  verificationPolicy?: VerificationPolicy;
  now: string;
}

export type ChildWorkDenial =
  | "invalid_request"
  | "mission_not_active"
  | "parent_unit_unknown"
  | "stale_claim"
  | "stale_fence"
  | "request_conflict"
  | "unit_conflict"
  | "authority_missing"
  | "authority_integrity"
  | "grant_invalid"
  | "grant_revoked"
  | "authority_expired"
  | "actor_mismatch"
  | "assignment_required"
  | "authority_escalation";

export type AuthorityVerdictFailure = Extract<
  ChildWorkDenial,
  | "authority_missing"
  | "authority_integrity"
  | "grant_invalid"
  | "grant_revoked"
  | "authority_expired"
  | "actor_mismatch"
>;

export interface WorkUnitAuthorityRecord {
  authorityId: string;
  missionId: string;
  unitId: string;
  kind: "root" | "child";
  parentAuthorityId?: string;
  rootGrantId: string;
  definition: AutonomousAuthorityDefinition;
  definitionHash: string;
  executingActorId: string;
  expiresAt: string;
  requestId: string;
  requestHash: string;
  purpose?: string;
  workType?: string;
  requestedByUnitId?: string;
  requestedByWorkerId?: string;
  requestedByAttempt?: number;
  boundByActorId?: string;
  createdAt: string;
}

export function hashClaimToken(token: string): string {
  return createHash("sha256").update(token, "utf8").digest("hex");
}

/** Constant-time claim token comparison (over fixed-length digests, so length is not leaked either). */
export function claimTokensEqual(stored: string | null | undefined, presented: string): boolean {
  if (!stored || !presented) return false;
  return timingSafeEqual(createHash("sha256").update(stored).digest(), createHash("sha256").update(presented).digest());
}

export function authorityDefinitionHash(definition: AutonomousAuthorityDefinition): string {
  return stableHash({ domain: "acs.work-unit-authority.v1", definition });
}

export function childWorkRequestHash(request: ChildWorkRequest, definitionHash: string): string {
  return stableHash({
    domain: "acs.child-work-request.v1",
    missionId: request.missionId,
    parentUnitId: request.parentUnitId,
    unitId: request.unitId,
    title: request.title,
    purpose: request.purpose,
    workType: request.workType,
    verificationPolicy: request.verificationPolicy ?? "none",
    assignedActorId: request.assignedActorId ?? null,
    definitionHash
  });
}

export function authorityIdFor(missionId: string, unitId: string): string {
  return `wua_${createHash("sha256").update(`${missionId}\u0000${unitId}`).digest("hex").slice(0, 40)}`;
}

const ID = /^[A-Za-z0-9._:-]{1,128}$/;

/** Structural validation only; authority content is validated by the narrowing check against the parent. */
export function childWorkRequestProblem(request: ChildWorkRequest): string | undefined {
  if (request.missionId.length < 1 || request.missionId.length > 128) return "missionId is invalid";
  if (!ID.test(request.parentUnitId)) return "parentUnitId is invalid";
  if (!ID.test(request.unitId)) return "unitId is invalid";
  if (request.unitId === request.parentUnitId) return "a unit cannot be its own child";
  if (!ID.test(request.requestId)) return "requestId is invalid";
  if (request.title.length < 1 || request.title.length > 512) return "title must be 1-512 characters";
  if (request.purpose.length < 1 || request.purpose.length > 4000) return "purpose must be 1-4000 characters";
  if (!(CHILD_WORK_TYPES as readonly string[]).includes(request.workType)) return "workType is not allowed";
  if (!request.claim || request.claim.token.length === 0 || request.claim.workerId.length === 0)
    return "claim token and worker are required";
  if (!Number.isSafeInteger(request.claim.attempt) || request.claim.attempt < 1) return "claim attempt is invalid";
  if (request.assignedActorId !== undefined && request.assignedActorId.length === 0) return "assignedActorId is empty";
  if (!Number.isFinite(Date.parse(request.now))) return "now is not a timestamp";
  return undefined;
}

/**
 * Re-verify a root grant against durable state: integrity (hash + audit event), not expired, not revoked. A grant that
 * cannot be read or verified is invalid; nothing here defaults to allow.
 */
export function verifyRootGrant(
  db: DatabaseSync,
  grantId: string,
  nowMs: number
):
  | { ok: true; grant: AutonomousAuthorityGrant }
  | { ok: false; outcome: "grant_invalid" | "grant_revoked" | "authority_expired" } {
  let grant: AutonomousAuthorityGrant | undefined;
  try {
    grant = readAutonomousAuthority(db, grantId);
  } catch {
    return { ok: false, outcome: "grant_invalid" };
  }
  if (!grant) return { ok: false, outcome: "grant_invalid" };
  if (!(Date.parse(grant.definition.expiresAt) > nowMs)) return { ok: false, outcome: "authority_expired" };
  try {
    if (readAutonomousAuthorityRevocation(db, grantId)) return { ok: false, outcome: "grant_revoked" };
  } catch {
    return { ok: false, outcome: "grant_invalid" };
  }
  return { ok: true, grant };
}
