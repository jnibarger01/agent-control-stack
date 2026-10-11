/**
 * Bounded child work (`request_child_work`), authority derivation and result reduction.
 *
 * An agent never spawns anything. It asks ACS, holding the claim of a running unit, and ACS decides. Everything here
 * runs inside one IMMEDIATE transaction on the durable store, so depth, fan-out, total-children and parallel caps
 * (budget.ts) and the authority narrowing (authority.ts, on the migration-047 grant model) cannot be bypassed by
 * concurrency or a restart. Time comes from ACS's own clock; nothing a worker sends can set it.
 */
import { ControlStackError, redactValue, stableHash } from "@agent-control-stack/shared";
import {
  autonomousAuthorityCoreSchema,
  autonomousAuthorityHash,
  changeSetPrivilegeSchema,
  readAutonomousAuthorityRevocation,
  type AutonomousAuthorityGrant
} from "@agent-control-stack/work-items";
import {
  PRIVILEGED_PRIVILEGES,
  definitionHash,
  isSubset,
  narrowDefinition,
  type AutonomousAuthorityDefinition,
  type MissionAuthorityPolicy
} from "./authority.js";
import { budgetToLimits, type BudgetDecision, type BudgetLimits, type MissionBudget } from "./budget.js";
import {
  IN_FLIGHT_WORK_UNIT_STATUSES,
  NON_RETRYABLE_FAILURES,
  TERMINAL_MISSION_STATES,
  VERIFICATION_POLICIES,
  parseWorkUnitPayload,
  type VerificationPolicy,
  type WorkUnitKind,
  type WorkUnitStatus
} from "./mission-model.js";
import type { CodingMissionStore } from "./store.js";
import type { DispatchAuthorityVerdict, ExecutorLane } from "./worker-execution.js";

export const CHILD_WORK_TYPES = ["research", "coding", "review", "testing", "analysis", "verification"] as const;
export type ChildWorkType = (typeof CHILD_WORK_TYPES)[number];

const KIND_FOR_WORK_TYPE: Readonly<Record<ChildWorkType, WorkUnitKind>> = {
  research: "agent",
  coding: "coding",
  review: "agent",
  testing: "shell",
  analysis: "agent",
  verification: "verification"
};

export interface ChildWorkItem {
  unitId: string;
  workType: ChildWorkType;
  purpose: string;
  title?: string;
  payload?: unknown;
  dependsOn?: string[];
  verificationPolicy?: VerificationPolicy;
  /** A complete candidate definition. It must be a subset of the parent's or the whole request is denied. */
  requestedAuthority?: AutonomousAuthorityDefinition;
  /** Recorded with the request. It can only ask for less than the mission budget, never more. */
  requestedBudget?: Partial<MissionBudget>;
}

export interface ChildWorkRequest {
  missionId: string;
  parentUnitId: string;
  /** Proof that the caller holds the parent's live claim. */
  workerId: string;
  claimToken: string;
  children: ChildWorkItem[];
}

export type ChildWorkResult =
  | { ok: true; created: string[]; authorities: Record<string, AutonomousAuthorityDefinition> }
  | { ok: false; outcome: "denied"; reasons: string[] }
  | { ok: false; outcome: "budget_exhausted"; decision: BudgetDecision };

export interface MissionAuthorityRecord {
  missionId: string;
  definition: AutonomousAuthorityDefinition;
  definitionHash: string;
  grantId: string;
  grantHash: string;
  policy: MissionAuthorityPolicy;
  /** Taken from the verified grant (`issuedByActorId`), never asserted by the caller. */
  approverId: string;
  reason: string;
  policyApprovedBy?: string;
  createdAt: string;
}

export interface UnitAuthorityRecord {
  missionId: string;
  unitId: string;
  parentUnitId?: string;
  definition: AutonomousAuthorityDefinition;
  definitionHash: string;
  derivedFromHash: string;
  grantId: string;
  purpose?: string;
  createdAt: string;
}

const UNIT_ID = /^[A-Za-z0-9._:-]{1,128}$/u;
const SAFE_REASON = /^[A-Za-z0-9_.:/#-]{1,120}$/u;

/** The existing human-issued grant store (`SqliteWorkItemStore` satisfies this). Read-only. */
export interface GrantReader {
  getAutonomousAuthority(grantId: string): AutonomousAuthorityGrant | undefined;
  /**
   * The current subject-input hash of the mission's execution inputs (`executionPlanSubjectInputHash`), or undefined if it
   * cannot be determined. A grant is only honored while it still equals the grant's `subjectInputHash`, so approval of
   * one set of inputs cannot authorize child work after those inputs changed. Unavailable means refused.
   */
  currentSubjectInputHash(missionId: string): string | undefined;
}

export interface LedgerOptions {
  grants: GrantReader;
  /** True only for an authenticated operator. Gates loosened mission policy and cancelling work one does not own. */
  verifyOperator(operatorId: string): boolean;
  /** ACS's own clock. */
  clock?: () => string;
  /**
   * Maps a worker id to the actor id its authority is issued to. The default is the identity, so a deployment must
   * wire a real mapping before a worker whose id differs from its actor can exercise a grant (fail closed).
   */
  resolveActor?: (workerId: string) => string | undefined;
  /**
   * How long after it was taken a claim still counts as live for child-work operations. Default 5 minutes. A parent
   * that has been silent longer must be re-claimed first, so an owner the controller would already recover is not
   * treated as live.
   */
  claimTtlMs?: number;
}

export const DEFAULT_CLAIM_TTL_MS = 300_000;

/** How far ahead of ACS's clock a claim timestamp may be and still count as live. */
const MAX_CLAIM_CLOCK_SKEW_MS = 5_000;

/**
 * The tool runtime an executor lane drives. The coder and mcp lanes have no single runtime, so their tool classes are
 * enforced where each tool is invoked, not at dispatch.
 */
const LANE_RUNTIME: Partial<Record<ExecutorLane, string>> = { jc: "jace_commander", dc: "desktop_commander" };

const MAX_CHILD_TTL_MS = 86_400_000;
const KNOWN_PRIVILEGES = new Set<string>(changeSetPrivilegeSchema.options);

/** Strictly parse mission policy: unknown keys, wrong types and unknown privileges are rejected, not stored. */
export function parseMissionPolicy(raw: unknown): MissionAuthorityPolicy {
  const bad = (why: string): never => {
    throw new ControlStackError("mission_authority_invalid", `mission policy ${why}`);
  };
  if (raw === undefined) return {};
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) return bad("must be an object");
  const input = raw as Record<string, unknown>;
  for (const key of Object.keys(input)) {
    if (!["allowPrivilegedChildren", "deniedPrivileges", "maxChildTtlMs"].includes(key))
      bad(`has unknown field ${key}`);
  }
  const policy: MissionAuthorityPolicy = {};
  if (input.allowPrivilegedChildren !== undefined) {
    if (typeof input.allowPrivilegedChildren !== "boolean") bad("allowPrivilegedChildren must be a boolean");
    policy.allowPrivilegedChildren = input.allowPrivilegedChildren as boolean;
  }
  if (input.deniedPrivileges !== undefined) {
    const list = input.deniedPrivileges;
    if (
      !Array.isArray(list) ||
      list.length > 32 ||
      list.some((entry) => typeof entry !== "string" || !KNOWN_PRIVILEGES.has(entry))
    ) {
      bad("deniedPrivileges must list known privileges");
    }
    policy.deniedPrivileges = [...new Set(list as string[])].sort();
  }
  if (input.maxChildTtlMs !== undefined) {
    const ttl = input.maxChildTtlMs;
    if (typeof ttl !== "number" || !Number.isSafeInteger(ttl) || ttl < 1 || ttl > MAX_CHILD_TTL_MS) {
      bad("maxChildTtlMs must be an integer between 1 and 86400000");
    }
    policy.maxChildTtlMs = ttl as number;
  }
  return policy;
}

export type ParentAuthorization =
  { kind: "parent_claim"; workerId: string; claimToken: string } | { kind: "operator"; operatorId: string };

/** Denial reasons echo caller input, so they are redacted and bounded before they become durable evidence. */
function durableReasons(reasons: readonly string[]): string[] {
  return reasons.slice(0, 32).map((reason) => {
    const redacted = (redactValue({ reason }) as { reason: string }).reason;
    return SAFE_REASON.test(redacted) && redacted === reason
      ? reason
      : `${redacted.replace(/[^A-Za-z0-9_.:/#[\]-]/gu, "?").slice(0, 80)}#${stableHash(reason).slice(0, 8)}`;
  });
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

/** Untyped callers: every field that is later used as a string, array or enum is checked before it is relied on. */
function childShapeProblems(item: unknown, index: number): string[] {
  const tag = `child[${index}]`;
  if (!isRecord(item)) return [`${tag}:not_an_object`];
  const problems: string[] = [];
  if (typeof item.unitId !== "string") problems.push(`${tag}:unit_id_not_a_string`);
  if (typeof item.workType !== "string") problems.push(`${tag}:work_type_not_a_string`);
  if (typeof item.purpose !== "string") problems.push(`${tag}:purpose_not_a_string`);
  if (item.title !== undefined && typeof item.title !== "string") problems.push(`${tag}:title_not_a_string`);
  if (item.verificationPolicy !== undefined && typeof item.verificationPolicy !== "string") {
    problems.push(`${tag}:verification_policy_not_a_string`);
  }
  if (item.dependsOn !== undefined) {
    const list = item.dependsOn;
    if (!Array.isArray(list) || list.length > 32 || list.some((entry) => typeof entry !== "string")) {
      problems.push(`${tag}:depends_on_not_a_string_array`);
    }
  }
  if (item.requestedBudget !== undefined && !isRecord(item.requestedBudget))
    problems.push(`${tag}:budget_not_an_object`);
  return problems;
}

/** A non-reusable identity for one claim: attempt numbers can repeat after a released claim, a token cannot. */
const claimFenceOf = (claimToken: string): string => stableHash(claimToken).slice(0, 16);

/** Code-unit ordering. Locale collation differs across hosts, and reductions must hash identically everywhere. */
const byCodeUnit = (left: string, right: string): number => (left < right ? -1 : left > right ? 1 : 0);

export class MissionAuthorityLedger {
  private readonly clock: () => string;

  constructor(
    private readonly store: CodingMissionStore,
    private readonly options: LedgerOptions
  ) {
    this.clock = options.clock ?? (() => new Date().toISOString());
  }

  /**
   * Bind a mission to a human-issued autonomous authority grant (migration 047). The grant is loaded from the control
   * plane and verified: it must exist, name this mission, recompute to its own hash, and be unexpired. The approver is
   * the grant's issuer, so nothing here trusts an identity or reason asserted by the caller. Loosening mission policy
   * (privileged children) additionally needs an authenticated operator. Write-once.
   */
  grantMissionAuthority(input: {
    missionId: string;
    grantId: string;
    policy?: MissionAuthorityPolicy;
    /** Required, and verified, when the policy allows privileged children. */
    policyApprovedBy?: string;
  }): MissionAuthorityRecord {
    let refusal: ControlStackError | undefined;
    const record = this.store.transaction((): MissionAuthorityRecord | undefined => {
      const now = this.clock();
      const mission = this.store.require(input.missionId);
      if (TERMINAL_MISSION_STATES.has(mission.state)) {
        throw new ControlStackError("mission_not_active", `mission is ${mission.state}`);
      }
      const refuse = (code: string, message: string, reason: string): undefined => {
        // The refusal is evidence, so it is committed first and thrown after the transaction.
        this.store.recordMissionEvent(
          input.missionId,
          "authority.denied",
          { reason, grantId: durableReasons([String(input.grantId)])[0] },
          now
        );
        refusal = new ControlStackError(code, message);
        return undefined;
      };
      let grant: AutonomousAuthorityGrant | undefined;
      try {
        grant = this.readGrant(input.grantId);
      } catch {
        return refuse("mission_authority_unverified", "the grant failed verification", "grant_integrity_failure");
      }
      if (!grant) return refuse("mission_authority_unverified", "no such authority grant", "grant_not_found");
      if (grant.missionId !== input.missionId) {
        return refuse("mission_authority_unverified", "the grant belongs to another mission", "grant_wrong_mission");
      }
      const { grantHash, auditEventId, ...core } = grant;
      void auditEventId;
      let recomputed: string | undefined;
      try {
        recomputed = autonomousAuthorityHash(autonomousAuthorityCoreSchema.parse(core));
      } catch {
        recomputed = undefined;
      }
      if (recomputed !== grantHash) {
        return refuse(
          "mission_authority_unverified",
          "the grant does not match its recorded hash",
          "grant_hash_mismatch"
        );
      }
      if (this.grantRevoked(grant.grantId)) {
        return refuse("mission_authority_unverified", "the grant has been revoked", "grant_revoked");
      }
      if (this.currentSubjectHash(input.missionId) !== grant.subjectInputHash) {
        return refuse(
          "mission_authority_unverified",
          "the grant no longer matches the mission's execution inputs",
          "grant_subject_changed"
        );
      }
      if (!(Date.parse(grant.definition.expiresAt) > Date.parse(now))) {
        return refuse("mission_authority_unverified", "the grant has expired", "authority_expired");
      }
      let policy: MissionAuthorityPolicy;
      try {
        policy = parseMissionPolicy(input.policy);
      } catch {
        return refuse("mission_authority_invalid", "mission policy is not valid", "policy_invalid");
      }
      // An approver identity is only ever stored once it has been verified, whether or not the policy needs one.
      if (input.policyApprovedBy !== undefined && !this.options.verifyOperator(input.policyApprovedBy)) {
        return refuse(
          "mission_authority_unverified",
          "the policy approver is not a verified operator",
          "policy_not_approved"
        );
      }
      if (policy.allowPrivilegedChildren === true) {
        if (!input.policyApprovedBy || !this.options.verifyOperator(input.policyApprovedBy)) {
          return refuse(
            "mission_authority_unverified",
            "allowing privileged children needs a verified operator",
            "policy_not_approved"
          );
        }
      }
      const hash = definitionHash(grant.definition);
      const existing = this.missionAuthority(input.missionId);
      if (existing) {
        if (
          existing.grantId === grant.grantId &&
          existing.grantHash === grant.grantHash &&
          stableHash(existing.policy) === stableHash(policy)
        ) {
          return existing;
        }
        return refuse(
          "mission_authority_exists",
          "mission authority is write-once and cannot be widened",
          "rebind_refused"
        );
      }
      this.store.db
        .prepare(
          `INSERT INTO mission_authority (mission_id, envelope_json, envelope_hash, policy_json, policy_hash, approver_id, reason, grant_id, grant_hash, policy_approved_by, created_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
        )
        .run(
          input.missionId,
          JSON.stringify(grant.definition),
          hash,
          JSON.stringify(policy),
          stableHash({ domain: "acs.mission-authority-policy.v1", policy }),
          grant.issuedByActorId,
          grant.reason,
          grant.grantId,
          grant.grantHash,
          input.policyApprovedBy ?? null,
          now
        );
      this.store.recordMissionEvent(
        input.missionId,
        "authority.granted",
        {
          definitionHash: hash,
          grantId: grant.grantId,
          grantHash: grant.grantHash,
          privileged: grant.definition.maximumPrivileges.filter((privilege) => PRIVILEGED_PRIVILEGES.has(privilege)),
          expiresAt: grant.definition.expiresAt,
          issuedBy: grant.issuedByActorId,
          policyApprovedBy: input.policyApprovedBy ?? null
        },
        now
      );
      return this.missionAuthority(input.missionId)!;
    });
    if (refusal) throw refusal;
    return record!;
  }

  /** True if `auth` is the parent's live claim: matching token and worker, a live status, and not past its TTL. */
  private claimLive(
    parent: { claimToken?: string; workerId?: string; status: string; claimedAt?: string },
    auth: { workerId: string; claimToken: string },
    now: string,
    statuses: readonly string[] = ["running", "checkpointed"]
  ): boolean {
    if (
      parent.claimToken !== auth.claimToken ||
      parent.workerId !== auth.workerId ||
      !statuses.includes(parent.status)
    ) {
      return false;
    }
    const ttl = this.options.claimTtlMs ?? DEFAULT_CLAIM_TTL_MS;
    if (parent.claimedAt === undefined) return false;
    // A claim stamped in the future has a negative age and would pass `<= ttl` forever, so the owner could never be
    // recovered. A small skew is tolerated; anything further ahead of ACS's clock is not a live claim.
    const age = Date.parse(now) - Date.parse(parent.claimedAt);
    return age >= -MAX_CLAIM_CLOCK_SKEW_MS && age <= ttl;
  }

  /** Uses the canonical revocation reader, which checks the projection against its audit event. A mismatch counts as revoked. */
  private grantRevoked(grantId: string): boolean {
    try {
      return readAutonomousAuthorityRevocation(this.store.db, grantId);
    } catch {
      return true;
    }
  }

  /**
   * The grant store can throw when a grant fails its own integrity checks (hash, audit anchor). That is a verification
   * failure, not a crash: map it to the integrity error the callers already turn into a durable denial.
   */
  private readGrant(grantId: string): AutonomousAuthorityGrant | undefined {
    try {
      return this.options.grants.getAutonomousAuthority(grantId);
    } catch {
      throw new ControlStackError("authority_integrity", "the authority grant failed verification");
    }
  }

  /** Unavailable (or throwing) means undefined, which never equals a grant's hash, so the caller refuses. */
  private currentSubjectHash(missionId: string): string | undefined {
    try {
      return this.options.grants.currentSubjectInputHash(missionId);
    } catch {
      return undefined;
    }
  }

  private integrity(what: string, ok: boolean): void {
    if (!ok) throw new ControlStackError("authority_integrity", `${what} failed its integrity check`);
  }

  private parseDefinition(json: unknown, what: string): AutonomousAuthorityDefinition {
    try {
      const parsed = JSON.parse(String(json)) as AutonomousAuthorityDefinition;
      definitionHash(parsed);
      return parsed;
    } catch {
      throw new ControlStackError("authority_integrity", `${what} is not a valid authority definition`);
    }
  }

  /**
   * Reads fail closed: the definition must parse, recompute to its stored hash, and still match the live grant it was
   * bound to (same hash, same definition), so neither a tampered row nor a swapped grant is trusted.
   */
  missionAuthority(missionId: string): MissionAuthorityRecord | undefined {
    const row = this.store.db.prepare("SELECT * FROM mission_authority WHERE mission_id = ?").get(missionId) as
      Record<string, string | null> | undefined;
    if (!row) return undefined;
    const definition = this.parseDefinition(row.envelope_json, "mission authority");
    this.integrity("mission authority", definitionHash(definition) === row.envelope_hash);
    const grant = this.readGrant(String(row.grant_id));
    this.integrity(
      "mission authority grant binding",
      grant !== undefined &&
        grant.missionId === missionId &&
        grant.grantHash === row.grant_hash &&
        definitionHash(grant.definition) === row.envelope_hash
    );
    let policy: MissionAuthorityPolicy;
    try {
      policy = JSON.parse(String(row.policy_json)) as MissionAuthorityPolicy;
    } catch {
      throw new ControlStackError("authority_integrity", "mission authority policy is not valid JSON");
    }
    // The policy controls delegation (privileged children, denials, TTL) but is not part of the grant, so it is
    // fingerprinted on its own and any change after approval is detected.
    this.integrity(
      "mission authority policy",
      stableHash({ domain: "acs.mission-authority-policy.v1", policy }) === row.policy_hash
    );
    return {
      missionId,
      definition,
      definitionHash: String(row.envelope_hash),
      grantId: String(row.grant_id),
      grantHash: String(row.grant_hash),
      policy,
      approverId: String(row.approver_id),
      reason: String(row.reason),
      ...(row.policy_approved_by ? { policyApprovedBy: String(row.policy_approved_by) } : {}),
      createdAt: String(row.created_at)
    };
  }

  /**
   * The authority a derived unit runs under. Fails closed unless the definition recomputes to its stored hash, is a
   * subset of its parent's (evaluated at the instant it was created), and is bound to the parent hash and grant it claims.
   */
  unitAuthority(missionId: string, unitId: string): UnitAuthorityRecord | undefined {
    const row = this.store.db
      .prepare("SELECT * FROM work_unit_authority WHERE mission_id = ? AND unit_id = ?")
      .get(missionId, unitId) as Record<string, string | null> | undefined;
    if (!row) return undefined;
    const definition = this.parseDefinition(row.envelope_json, "unit authority");
    this.integrity("unit authority", definitionHash(definition) === row.envelope_hash);
    const parentUnitId = row.parent_unit_id ? String(row.parent_unit_id) : undefined;
    const parent = parentUnitId ? this.unitAuthority(missionId, parentUnitId) : undefined;
    if (parentUnitId && !parent) {
      // The mission grant stands in only for a verified root. A missing intermediate record is corruption, not a root.
      const grandparent = this.store.db
        .prepare("SELECT parent_unit_id FROM coding_operations WHERE mission_id = ? AND operation_id = ?")
        .get(missionId, parentUnitId) as { parent_unit_id: string | null } | undefined;
      this.integrity("unit authority ancestry", grandparent !== undefined && grandparent.parent_unit_id === null);
    }
    const mission = this.missionAuthority(missionId);
    const parentDefinition = parent?.definition ?? mission?.definition;
    const parentHash = parent?.definitionHash ?? mission?.definitionHash;
    this.integrity(
      "unit authority derivation",
      parentDefinition !== undefined &&
        parentHash === row.derived_from_hash &&
        mission?.grantId === row.grant_id &&
        isSubset(definition, parentDefinition, new Date(String(row.created_at)))
    );
    return {
      missionId,
      unitId,
      ...(parentUnitId ? { parentUnitId } : {}),
      definition,
      definitionHash: String(row.envelope_hash),
      derivedFromHash: String(row.derived_from_hash),
      grantId: String(row.grant_id),
      ...(row.purpose ? { purpose: String(row.purpose) } : {}),
      createdAt: String(row.created_at)
    };
  }

  /**
   * ACS-owned `request_child_work`. All-or-nothing: if any child is denied nothing is created. A denial is durable
   * evidence (`child.denied`, `authority.denied`) so an escalation attempt can be reconstructed afterwards.
   */
  requestChildWork(request: ChildWorkRequest): ChildWorkResult {
    return this.store.transaction(() => {
      const { missionId, parentUnitId } = request;
      const nowIso = this.clock();
      const now = new Date(nowIso);
      // The requester is recorded as claimed until the durable claim confirms it.
      let requester: Record<string, unknown> = { workerId: String(request.workerId).slice(0, 64), verified: false };
      let requested = false;
      const emitRequested = () => {
        if (requested) return;
        requested = true;
        this.store.recordMissionEvent(
          missionId,
          "child.requested",
          {
            parentUnitId,
            requester,
            // Untyped callers: the audit entry itself must never throw on a malformed child.
            children: (Array.isArray(request.children) ? request.children : []).slice(0, 16).map((child) => ({
              unitId: isRecord(child) ? durableReasons([String(child.unitId).slice(0, 64)])[0] : "invalid",
              workType: isRecord(child) ? durableReasons([String(child.workType).slice(0, 32)])[0] : "invalid"
            }))
          },
          nowIso
        );
      };
      const deny = (reasons: string[]): ChildWorkResult => {
        emitRequested();
        const safe = durableReasons(reasons);
        this.store.recordMissionEvent(missionId, "child.denied", { parentUnitId, requester, reasons: safe }, nowIso);
        if (reasons.some((reason) => /authority|escalation|privilege|expiry|integrity|policy/u.test(reason))) {
          this.store.recordMissionEvent(
            missionId,
            "authority.denied",
            { parentUnitId, requester, reasons: safe },
            nowIso
          );
        }
        return { ok: false, outcome: "denied", reasons };
      };

      const mission = this.store.get(missionId);
      // Nothing is written for a mission that does not exist: the event sink is mission-scoped and unauthenticated callers
      // must not be able to grow it under invented ids.
      if (!mission) return { ok: false, outcome: "denied", reasons: ["mission_not_active"] };
      if (TERMINAL_MISSION_STATES.has(mission.state)) return deny(["mission_not_active"]);
      const units = this.store.workUnits(missionId);
      const parent = units.find((unit) => unit.unitId === parentUnitId);
      if (!parent) return deny(["parent_unit_not_found"]);
      // Only the worker holding the parent's live claim may ask. A stale, wrong or forged identity is refused.
      if (!this.claimLive(parent, request, nowIso)) {
        const expired =
          parent.claimToken === request.claimToken &&
          parent.workerId === request.workerId &&
          ["running", "checkpointed"].includes(parent.status);
        return deny([expired ? "claim_expired" : "claim_mismatch"]);
      }
      // A recorded reduction is final: admitting more children afterwards would leave them out of the result for good.
      if (
        this.store.db
          .prepare("SELECT 1 FROM work_unit_reductions WHERE mission_id = ? AND parent_unit_id = ?")
          .get(missionId, parentUnitId)
      ) {
        return deny(["reduction_recorded"]);
      }
      requester = {
        workerId: request.workerId,
        verified: true,
        parentAttempt: parent.attempt,
        claimFence: claimFenceOf(request.claimToken)
      };
      emitRequested();
      if (!Array.isArray(request.children) || request.children.length === 0 || request.children.length > 16) {
        return deny(["child_count_invalid"]);
      }
      const shapeProblems = request.children.flatMap((item, index) => childShapeProblems(item, index));
      if (shapeProblems.length > 0) return deny(shapeProblems);

      let missionAuthority: MissionAuthorityRecord | undefined;
      let parentDefinition: AutonomousAuthorityDefinition;
      let parentHash: string;
      try {
        missionAuthority = this.missionAuthority(missionId);
        if (!missionAuthority) return deny(["mission_has_no_authority"]);
        // A root unit runs under the mission grant. A derived unit must have its own verified definition: a missing row
        // is never treated as a root, or a unit created outside request_child_work would inherit the whole mission.
        const parentRecord = parent.parentUnitId ? this.unitAuthority(missionId, parentUnitId) : undefined;
        if (parent.parentUnitId && !parentRecord) return deny(["parent_authority_missing"]);
        parentDefinition = parentRecord?.definition ?? missionAuthority.definition;
        parentHash = parentRecord?.definitionHash ?? missionAuthority.definitionHash;
        // The grant is re-checked on every request: revoking it stops new descendants immediately.
        if (this.grantRevoked(missionAuthority.grantId)) return deny(["grant_revoked"]);
        if (this.currentSubjectHash(missionId) !== this.readGrant(missionAuthority.grantId)?.subjectInputHash) {
          return deny(["grant_subject_changed"]);
        }
        // A valid claim is not enough: the claimant must be the actor this authority was issued to.
        const actor = (this.options.resolveActor ?? ((workerId: string) => workerId))(request.workerId);
        if (actor !== parentDefinition.executingActorId) return deny(["worker_not_authorized_for_authority"]);
      } catch (error) {
        if (error instanceof ControlStackError && error.code === "authority_integrity") {
          return deny(["authority_integrity_failure"]);
        }
        throw error;
      }

      const existingIds = new Set(units.map((unit) => unit.unitId));
      const batchIds = new Set(request.children.map((child) => String(child.unitId)));
      const seen = new Set<string>();
      const derived: Array<{ item: ChildWorkItem; definition: AutonomousAuthorityDefinition }> = [];
      const reasons: string[] = [];
      const missionBudget = this.store.budget(missionId);
      for (const item of request.children) {
        const prefix = UNIT_ID.test(String(item.unitId)) ? item.unitId : "invalid_unit_id";
        if (!UNIT_ID.test(String(item.unitId)) || seen.has(item.unitId) || existingIds.has(item.unitId)) {
          reasons.push(`${prefix}:child_id_invalid_or_duplicate`);
        }
        seen.add(item.unitId);
        if (!(CHILD_WORK_TYPES as readonly string[]).includes(item.workType))
          reasons.push(`${prefix}:work_type_invalid`);
        if (typeof item.purpose !== "string" || !item.purpose || item.purpose.length > 512) {
          reasons.push(`${prefix}:purpose_invalid`);
        }
        if (
          item.title !== undefined &&
          (typeof item.title !== "string" || item.title.length === 0 || item.title.length > 160)
        ) {
          reasons.push(`${prefix}:title_invalid`);
        }
        if (
          item.verificationPolicy !== undefined &&
          !(VERIFICATION_POLICIES as readonly string[]).includes(item.verificationPolicy)
        ) {
          reasons.push(`${prefix}:verification_policy_invalid`);
        }
        // Everything addWorkUnits would reject is checked here, so a bad payload or graph is a durable denial.
        if (item.workType in KIND_FOR_WORK_TYPE) {
          try {
            parseWorkUnitPayload(KIND_FOR_WORK_TYPE[item.workType], item.payload ?? {});
          } catch {
            if (item.payload !== undefined || KIND_FOR_WORK_TYPE[item.workType] !== "coding") {
              reasons.push(`${prefix}:payload_invalid`);
            }
          }
        }
        for (const dependency of item.dependsOn ?? []) {
          if (dependency === item.unitId || !(existingIds.has(dependency) || batchIds.has(dependency))) {
            reasons.push(`${prefix}:dependency_invalid`);
          }
        }
        if (item.requestedBudget) {
          let asked: BudgetLimits | undefined;
          try {
            asked = budgetToLimits(item.requestedBudget);
          } catch {
            reasons.push(`${prefix}:budget_invalid`);
          }
          if (asked && missionBudget) {
            for (const [metric, value] of Object.entries(asked) as Array<[keyof BudgetLimits, number]>) {
              const cap = missionBudget.limits[metric];
              if (cap !== undefined && value > cap) reasons.push(`${prefix}:budget_exceeds_mission:${metric}`);
            }
          }
        }
        const narrowed = narrowDefinition({
          parent: parentDefinition,
          policy: missionAuthority.policy,
          ...(item.requestedAuthority === undefined ? {} : { requested: item.requestedAuthority }),
          now
        });
        if (!narrowed.ok) {
          for (const reason of narrowed.reasons) reasons.push(`${prefix}:${reason}`);
          continue;
        }
        derived.push({ item, definition: narrowed.definition });
      }
      if (reasons.length > 0) return deny(reasons);

      // The parent's operation and parallelism limits are shared by all its children, not copied into each. Explicit
      // requests are charged first; children that inherit split what is left, so the aggregate never exceeds the parent.
      let usedOperations = 0;
      let usedParallel = 0;
      for (const unit of units) {
        if (unit.parentUnitId !== parentUnitId) continue;
        const sibling = this.unitAuthority(missionId, unit.unitId);
        if (!sibling || ["cancelled"].includes(unit.status)) continue;
        usedOperations += sibling.definition.limits.maxOperations;
        usedParallel += sibling.definition.limits.maxParallelOperations;
      }
      const budgetFor = (key: "maxOperations" | "maxParallelOperations", used: number) =>
        parentDefinition.limits[key] - used;
      for (const entry of derived.filter(({ item }) => item.requestedAuthority !== undefined)) {
        usedOperations += entry.definition.limits.maxOperations;
        usedParallel += entry.definition.limits.maxParallelOperations;
      }
      const inheriting = derived.filter(({ item }) => item.requestedAuthority === undefined);
      if (inheriting.length > 0) {
        const opsEach = Math.floor(budgetFor("maxOperations", usedOperations) / inheriting.length);
        const parEach = Math.floor(budgetFor("maxParallelOperations", usedParallel) / inheriting.length);
        for (const entry of inheriting) {
          entry.definition = {
            ...entry.definition,
            limits: {
              ...entry.definition.limits,
              maxOperations: Math.min(entry.definition.limits.maxOperations, opsEach),
              maxParallelOperations: Math.min(entry.definition.limits.maxParallelOperations, parEach)
            }
          };
          usedOperations += entry.definition.limits.maxOperations;
          usedParallel += entry.definition.limits.maxParallelOperations;
          if (opsEach < 1) reasons.push(`${entry.item.unitId}:parent_limit_exhausted:maxOperations`);
          if (parEach < 1) reasons.push(`${entry.item.unitId}:parent_limit_exhausted:maxParallelOperations`);
        }
      }
      if (usedOperations > parentDefinition.limits.maxOperations) reasons.push("parent_limit_exhausted:maxOperations");
      if (usedParallel > parentDefinition.limits.maxParallelOperations)
        reasons.push("parent_limit_exhausted:maxParallelOperations");
      if (reasons.length > 0) return deny(reasons);

      let created: ReturnType<CodingMissionStore["addWorkUnits"]>;
      try {
        created = this.store.addWorkUnits(
          missionId,
          derived.map(({ item }) => ({
            unitId: item.unitId,
            kind: KIND_FOR_WORK_TYPE[item.workType],
            title: item.title ?? item.purpose.slice(0, 120),
            parentUnitId,
            ...(item.dependsOn ? { dependsOn: item.dependsOn } : {}),
            ...(item.payload === undefined ? {} : { payload: item.payload }),
            ...(item.verificationPolicy ? { verificationPolicy: item.verificationPolicy } : {})
          })),
          nowIso
        );
      } catch (error) {
        // addWorkUnits validates its whole batch before it writes anything, so these codes never leave a partial insert.
        if (error instanceof ControlStackError && /^work_unit_/u.test(error.code)) return deny([error.code]);
        throw error;
      }
      if (!created.ok) {
        this.store.recordMissionEvent(
          missionId,
          "child.denied",
          { parentUnitId, requester, reasons: durableReasons(["budget_exhausted"]) },
          nowIso
        );
        return { ok: false, outcome: "budget_exhausted", decision: created.decision };
      }
      const insert = this.store.db.prepare(
        `INSERT INTO work_unit_authority (mission_id, unit_id, parent_unit_id, envelope_json, envelope_hash, derived_from_hash, grant_id, parent_attempt, parent_claim_fence, requested_json, purpose, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
      );
      const authorities: Record<string, AutonomousAuthorityDefinition> = {};
      for (const { item, definition } of derived) {
        const hash = definitionHash(definition);
        insert.run(
          missionId,
          item.unitId,
          parentUnitId,
          JSON.stringify(definition),
          hash,
          parentHash,
          missionAuthority.grantId,
          parent.attempt,
          claimFenceOf(request.claimToken),
          JSON.stringify({ authority: item.requestedAuthority ?? null, budget: item.requestedBudget ?? null }),
          item.purpose,
          nowIso
        );
        authorities[item.unitId] = definition;
        this.store.recordMissionEvent(
          missionId,
          "child.admitted",
          {
            parentUnitId,
            unitId: item.unitId,
            workType: item.workType,
            requester,
            definitionHash: hash,
            derivedFrom: parentHash,
            grantId: missionAuthority.grantId
          },
          nowIso
        );
      }
      return { ok: true, created: created.created, authorities };
    });
  }

  /**
   * The dispatch gate: may this worker run this unit now, on this lane? Everything is read from durable state and ACS's
   * own clock, and every doubt is a refusal. A unit runs under its own derived authority; only a root unit runs under
   * the mission's. A unit that should have derived authority but has none is refused, never promoted to the mission's.
   * Returns a reason instead of throwing so the dispatcher can record it as durable evidence.
   */
  verifyDispatch(input: {
    missionId: string;
    unitId: string;
    workerId: string;
    lane: ExecutorLane;
    attempt: number;
  }): DispatchAuthorityVerdict {
    const refuse = (reason: string): DispatchAuthorityVerdict => ({ ok: false, reason });
    try {
      const now = Date.parse(this.clock());
      const mission = this.store.get(input.missionId);
      if (!mission || TERMINAL_MISSION_STATES.has(mission.state)) return refuse("mission_not_active");
      const missionAuthority = this.missionAuthority(input.missionId);
      if (!missionAuthority) return refuse("mission_has_no_authority");
      const unit = this.store.workUnits(input.missionId).find((candidate) => candidate.unitId === input.unitId);
      if (!unit) return refuse("unit_not_found");
      const record = unit.parentUnitId ? this.unitAuthority(input.missionId, input.unitId) : undefined;
      if (unit.parentUnitId && !record) return refuse("unit_authority_missing");
      const superseded = this.store.db
        .prepare("SELECT 1 FROM work_unit_child_supersessions WHERE mission_id = ? AND child_unit_id = ?")
        .get(input.missionId, input.unitId);
      if (superseded) return refuse("unit_superseded");
      const definition = record?.definition ?? missionAuthority.definition;
      const definitionHashValue = record?.definitionHash ?? missionAuthority.definitionHash;
      const grantId = record?.grantId ?? missionAuthority.grantId;
      if (this.grantRevoked(grantId)) return refuse("grant_revoked");
      if (this.currentSubjectHash(input.missionId) !== this.readGrant(grantId)?.subjectInputHash) {
        return refuse("grant_subject_changed");
      }
      if (!(Date.parse(definition.expiresAt) > now)) return refuse("authority_expired");
      const actor = (this.options.resolveActor ?? ((workerId: string) => workerId))(input.workerId);
      if (actor !== definition.executingActorId) return refuse("worker_not_authorized_for_authority");
      if (!(input.attempt <= definition.limits.maxAttemptsPerOperation)) return refuse("attempt_limit_exceeded");
      const runtime = LANE_RUNTIME[input.lane];
      if (runtime && !definition.toolClasses.some((tool) => tool.runtime === runtime)) {
        return refuse("lane_not_permitted");
      }
      return {
        ok: true,
        grantId,
        unitAuthorityHash: definitionHashValue,
        executingActorId: definition.executingActorId
      };
    } catch (error) {
      if (error instanceof ControlStackError && error.code === "authority_integrity") {
        return refuse("authority_integrity_failure");
      }
      throw error;
    }
  }

  /**
   * Cancel every unfinished descendant of a unit. The caller must either hold the parent's live claim or be an
   * authenticated operator, so a stale worker cannot cancel work owned by a newer claimant. In-flight children are
   * reported as uncertain, not rolled back.
   */
  cancelChildren(
    missionId: string,
    parentUnitId: string,
    input: { reason: string; authorization: ParentAuthorization }
  ): { cancelled: string[]; uncertain: string[] } {
    let refusal: ControlStackError | undefined;
    const result = this.store.transaction((): { cancelled: string[]; uncertain: string[] } | undefined => {
      const now = this.clock();
      const units = this.store.workUnits(missionId);
      const parent = units.find((unit) => unit.unitId === parentUnitId);
      if (!parent) throw new ControlStackError("parent_unit_not_found", "parent unit does not exist");
      const auth = input.authorization;
      const authorized =
        auth.kind === "operator"
          ? this.options.verifyOperator(auth.operatorId)
          : this.claimLive(parent, auth, now, ["running", "checkpointed", "verifying"]);
      if (!authorized) {
        this.store.recordMissionEvent(
          missionId,
          "authority.denied",
          { parentUnitId, reason: "cancel_not_authorized", kind: auth.kind },
          now
        );
        refusal = new ControlStackError(
          "cancel_not_authorized",
          "cancellation requires the parent's live claim or a verified operator"
        );
        return undefined;
      }
      const descendants = new Set<string>();
      let grew = true;
      while (grew) {
        grew = false;
        for (const unit of units) {
          if (
            unit.parentUnitId &&
            (unit.parentUnitId === parentUnitId || descendants.has(unit.parentUnitId)) &&
            !descendants.has(unit.unitId)
          ) {
            descendants.add(unit.unitId);
            grew = true;
          }
        }
      }
      const cancelled: string[] = [];
      const uncertain: string[] = [];
      for (const unit of units) {
        if (!descendants.has(unit.unitId) || unit.status === "succeeded" || unit.status === "cancelled") continue;
        // A failed child that retryUnit could still revive is cancelled too; only a final failure is left as it was.
        if (unit.status === "failed" && unit.failureCategory && NON_RETRYABLE_FAILURES.has(unit.failureCategory))
          continue;
        const inFlight = (IN_FLIGHT_WORK_UNIT_STATUSES as readonly WorkUnitStatus[]).includes(unit.status);
        this.store.db
          .prepare(
            `UPDATE coding_operations SET status = 'cancelled', cancel_external_state = ?, failure_category = 'cancelled'
             WHERE mission_id = ? AND operation_id = ?`
          )
          .run(inFlight ? "uncertain" : "none", missionId, unit.unitId);
        cancelled.push(unit.unitId);
        if (inFlight) uncertain.push(unit.unitId);
        this.store.recordMissionEvent(
          missionId,
          "work_unit.cancelled",
          {
            unitId: unit.unitId,
            was: unit.status,
            externalState: inFlight ? "uncertain" : "none",
            reason: durableReasons([input.reason])[0],
            by: auth.kind === "operator" ? { operatorId: auth.operatorId } : { workerId: auth.workerId }
          },
          now
        );
      }
      return { cancelled, uncertain };
    });
    if (refusal) throw refusal;
    return result!;
  }
  /**
   * The explicit reduction step over a unit's direct children. It is deterministic (children are ordered by id, never by
   * finish time), recorded once, and never partial: while any child is unfinished nothing is written. Recording is a
   * permanent decision, so the caller must hold the parent's live claim or be an authenticated operator. It waits for any
   * child still awaiting a retry, and once recorded `retryUnit` refuses further retries beneath the parent.
   */
  reduceChildren(input: {
    missionId: string;
    parentUnitId: string;
    strategy: "all_succeeded" | "select" | "majority_result";
    selectedUnitId?: string;
    authorization: ParentAuthorization;
  }):
    | { status: "incomplete"; waitingOn: string[] }
    | {
        status: "reduced" | "failed" | "inconclusive";
        resultHash?: string;
        selectedUnitId?: string;
        recorded: boolean;
      } {
    let refusal: ControlStackError | undefined;
    const result = this.store.transaction(() => {
      const now = this.clock();
      const allUnits = this.store.workUnits(input.missionId);
      const parent = allUnits.find((unit) => unit.unitId === input.parentUnitId);
      if (!parent) throw new ControlStackError("parent_unit_not_found", "parent unit does not exist");
      const reducingMission = this.store.get(input.missionId);
      if (!reducingMission || TERMINAL_MISSION_STATES.has(reducingMission.state)) {
        // A terminal mission's history is closed: nothing, including an operator's reduction, may be appended to it.
        throw new ControlStackError("mission_not_active", "mission is no longer active");
      }
      const auth = input.authorization;
      const authorized =
        auth.kind === "operator"
          ? this.options.verifyOperator(auth.operatorId)
          : this.claimLive(parent, auth, now, ["running", "checkpointed", "verifying"]);
      if (!authorized) {
        this.store.recordMissionEvent(
          input.missionId,
          "authority.denied",
          { parentUnitId: input.parentUnitId, reason: "reduce_not_authorized", kind: auth.kind },
          now
        );
        refusal = new ControlStackError(
          "reduce_not_authorized",
          "reduction requires the parent's live claim or a verified operator"
        );
        return undefined;
      }
      if (!(["all_succeeded", "select", "majority_result"] as const).includes(input.strategy)) {
        throw new ControlStackError("reduction_invalid", "unknown reduction strategy");
      }
      const existing = this.store.db
        .prepare("SELECT * FROM work_unit_reductions WHERE mission_id = ? AND parent_unit_id = ?")
        .get(input.missionId, input.parentUnitId) as Record<string, string | null> | undefined;
      if (existing) {
        // A persisted reduction is only returned if it still matches its fingerprint.
        const fingerprint = reductionFingerprint({
          strategy: String(existing.strategy),
          outcome: String(existing.outcome),
          selected: existing.selected_unit_id,
          resultHash: existing.result_hash,
          children: String(existing.children_json)
        });
        if (fingerprint !== existing.reduction_hash) {
          throw new ControlStackError("authority_integrity", "recorded reduction failed its integrity check");
        }
        return {
          status: String(existing.outcome) as "reduced" | "failed" | "inconclusive",
          ...(existing.result_hash ? { resultHash: String(existing.result_hash) } : {}),
          ...(existing.selected_unit_id ? { selectedUnitId: String(existing.selected_unit_id) } : {}),
          recorded: false
        };
      }
      // Only children admitted under the parent's current claim count; work from an earlier claim was cancelled when
      // ownership advanced and must not feed this result. A claim token is never reused, unlike an attempt number.
      const currentFence = new Map(
        (
          this.store.db
            .prepare(
              "SELECT unit_id, parent_claim_fence FROM work_unit_authority WHERE mission_id = ? AND parent_unit_id = ?"
            )
            .all(input.missionId, input.parentUnitId) as Array<{ unit_id: string; parent_claim_fence: string }>
        ).map((row) => [row.unit_id, row.parent_claim_fence])
      );
      const superseded = new Set(
        (
          this.store.db
            .prepare("SELECT child_unit_id FROM work_unit_child_supersessions WHERE mission_id = ?")
            .all(input.missionId) as Array<{ child_unit_id: string }>
        ).map((row) => row.child_unit_id)
      );
      const children = allUnits
        .filter(
          (unit) =>
            unit.parentUnitId === input.parentUnitId &&
            !superseded.has(unit.unitId) &&
            currentFence.get(unit.unitId) === (parent.claimToken ? claimFenceOf(parent.claimToken) : undefined)
        )
        .sort((left, right) => byCodeUnit(left.unitId, right.unitId));
      if (children.length === 0)
        throw new ControlStackError("reduction_no_children", "unit has no child work to reduce");
      // A child that is `retryable` is still awaiting its retry, so the outcome is not settled yet. A `failed` child is
      // settled because recording the reduction makes retryUnit refuse any further retry beneath this parent.
      const waitingOn = children
        .filter((unit) => !["succeeded", "failed", "cancelled"].includes(unit.status))
        .map((unit) => unit.unitId);
      if (waitingOn.length > 0) return { status: "incomplete" as const, waitingOn };

      const succeeded = children.filter((unit) => unit.status === "succeeded" && unit.resultHash);
      if (input.strategy === "select") {
        // A bad selection must be rejected, not recorded: the reduction is write-once, so a mistaken one would block the
        // legitimate selection forever.
        if (
          typeof input.selectedUnitId !== "string" ||
          !succeeded.some((unit) => unit.unitId === input.selectedUnitId)
        ) {
          throw new ControlStackError("reduction_invalid", "select needs the id of a succeeded child");
        }
      }
      let outcome: "reduced" | "failed" | "inconclusive" = "failed";
      let selected: string | undefined;
      let resultHash: string | undefined;
      if (input.strategy === "all_succeeded") {
        if (succeeded.length === children.length) {
          outcome = "reduced";
          resultHash = stableHash(succeeded.map((unit) => [unit.unitId, unit.resultHash]));
        }
      } else if (input.strategy === "select") {
        const pick = succeeded.find((unit) => unit.unitId === input.selectedUnitId);
        if (pick) {
          outcome = "reduced";
          selected = pick.unitId;
          resultHash = pick.resultHash;
        }
      } else {
        const counts = new Map<string, string[]>();
        for (const unit of succeeded)
          counts.set(unit.resultHash!, [...(counts.get(unit.resultHash!) ?? []), unit.unitId]);
        const ranked = [...counts.entries()].sort((a, b) => b[1].length - a[1].length || byCodeUnit(a[0], b[0]));
        // A strict majority of all children, otherwise there is no result: ties are never broken arbitrarily.
        if (ranked[0] && ranked[0][1].length * 2 > children.length) {
          outcome = "reduced";
          resultHash = ranked[0][0];
          selected = ranked[0][1][0];
        } else outcome = "inconclusive";
      }
      const childrenJson = JSON.stringify(
        children.map((unit) => ({ unitId: unit.unitId, status: unit.status, resultHash: unit.resultHash ?? null }))
      );
      this.store.db
        .prepare(
          `INSERT INTO work_unit_reductions (mission_id, parent_unit_id, strategy, outcome, selected_unit_id, result_hash, children_json, reduction_hash, created_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`
        )
        .run(
          input.missionId,
          input.parentUnitId,
          input.strategy,
          outcome,
          selected ?? null,
          resultHash ?? null,
          childrenJson,
          reductionFingerprint({
            strategy: input.strategy,
            outcome,
            selected: selected ?? null,
            resultHash: resultHash ?? null,
            children: childrenJson
          }),
          now
        );
      this.store.recordMissionEvent(
        input.missionId,
        "child.reduced",
        {
          parentUnitId: input.parentUnitId,
          strategy: input.strategy,
          outcome,
          children: children.length,
          selectedUnitId: selected ?? null,
          resultHash: resultHash ?? null,
          by: auth.kind === "operator" ? { operatorId: auth.operatorId } : { workerId: auth.workerId }
        },
        now
      );
      return {
        status: outcome,
        ...(resultHash ? { resultHash } : {}),
        ...(selected ? { selectedUnitId: selected } : {}),
        recorded: true
      };
    });
    if (refusal) throw refusal;
    return result!;
  }
}

function reductionFingerprint(input: {
  strategy: string;
  outcome: string;
  selected: string | null;
  resultHash: string | null;
  children: string;
}): string {
  return stableHash({ domain: "acs.child-reduction.v1", ...input });
}
