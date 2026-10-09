/**
 * Bounded child work (`request_child_work`), authority derivation and result reduction.
 *
 * An agent never spawns anything. It asks ACS, holding the claim of a running unit, and ACS decides. Everything here
 * runs inside one IMMEDIATE transaction on the durable store, so depth, fan-out, total-children and parallel caps
 * (budget.ts) and the authority narrowing (authority.ts) cannot be bypassed by concurrency or a restart.
 */
import { ControlStackError, redactValue, stableHash } from "@agent-control-stack/shared";
import {
  canonicalEnvelope,
  envelopeHash,
  isExpired,
  isSubsetOf,
  narrowAuthority,
  validateEnvelope,
  PRIVILEGED_ACTIONS,
  type AuthorityEnvelope,
  type AuthorityRequest,
  type MissionAuthorityPolicy
} from "./authority.js";
import { budgetToLimits, type BudgetDecision, type BudgetLimits, type MissionBudget } from "./budget.js";
import {
  IN_FLIGHT_WORK_UNIT_STATUSES,
  TERMINAL_MISSION_STATES,
  parseWorkUnitPayload,
  type VerificationPolicy,
  type WorkUnitKind,
  type WorkUnitStatus
} from "./mission-model.js";
import type { CodingMissionStore } from "./store.js";

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
  requestedAuthority?: AuthorityRequest;
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
  | { ok: true; created: string[]; authorities: Record<string, AuthorityEnvelope> }
  | { ok: false; outcome: "denied"; reasons: string[] }
  | { ok: false; outcome: "budget_exhausted"; decision: BudgetDecision };

export interface MissionAuthorityRecord {
  missionId: string;
  envelope: AuthorityEnvelope;
  envelopeHash: string;
  policy: MissionAuthorityPolicy;
  approverId: string;
  reason: string;
  grantId?: string;
  createdAt: string;
}

export interface UnitAuthorityRecord {
  missionId: string;
  unitId: string;
  parentUnitId?: string;
  envelope: AuthorityEnvelope;
  envelopeHash: string;
  derivedFromHash: string;
  purpose?: string;
  createdAt: string;
}

const UNIT_ID = /^[A-Za-z0-9._:-]{1,128}$/u;

/**
 * Verified control-plane approval evidence. The ledger never trusts an approver id or reason asserted by its caller:
 * the composition root supplies the verifier that checks them against the real approval / grant store.
 */
export interface ApprovalVerifier {
  /** True only if `approverId` holds a live approval or grant bound to this mission and covering this envelope. */
  verifyMissionApproval(input: {
    missionId: string;
    approverId: string;
    grantId?: string;
    envelopeHash: string;
    privilegedActions: string[];
  }): boolean;
  /** True only for an authenticated operator who may cancel work they do not hold the claim for. */
  verifyOperator(operatorId: string): boolean;
}

export type CancelAuthorization =
  { kind: "parent_claim"; workerId: string; claimToken: string } | { kind: "operator"; operatorId: string };

export interface LedgerOptions {
  approvals: ApprovalVerifier;
  /** ACS's own clock. Time is never taken from a request. */
  clock?: () => string;
}

const SAFE_REASON = /^[A-Za-z0-9_.:/#-]{1,120}$/u;

/** Denial reasons echo caller input, so they are redacted and bounded before they become durable evidence. */
function durableReasons(reasons: readonly string[]): string[] {
  return reasons.slice(0, 32).map((reason) => {
    const redacted = (redactValue({ reason }) as { reason: string }).reason;
    return SAFE_REASON.test(redacted) && redacted === reason
      ? reason
      : `${redacted.replace(/[^A-Za-z0-9_.:/#[\]-]/gu, "?").slice(0, 80)}#${stableHash(reason).slice(0, 8)}`;
  });
}

export class MissionAuthorityLedger {
  private readonly approvals: ApprovalVerifier;
  private readonly clock: () => string;

  constructor(
    private readonly store: CodingMissionStore,
    options: LedgerOptions
  ) {
    this.approvals = options.approvals;
    this.clock = options.clock ?? (() => new Date().toISOString());
  }

  /**
   * Record the authority a human approved for a mission. Write-once: the envelope and policy can never be widened
   * afterwards. Privileged actions must be named explicitly, and the approver and reason are mandatory.
   */
  grantMissionAuthority(input: {
    missionId: string;
    envelope: AuthorityEnvelope;
    policy?: MissionAuthorityPolicy;
    approverId: string;
    reason: string;
    grantId?: string;
  }): MissionAuthorityRecord {
    let refusal: ControlStackError | undefined;
    const record = this.store.transaction((): MissionAuthorityRecord | undefined => {
      const now = this.clock();
      const mission = this.store.require(input.missionId);
      if (TERMINAL_MISSION_STATES.has(mission.state)) {
        throw new ControlStackError("mission_not_active", `mission is ${mission.state}`);
      }
      if (!input.approverId || !input.reason) {
        throw new ControlStackError("mission_authority_invalid", "an approver and a reason are required");
      }
      const problems = validateEnvelope(input.envelope);
      if (isExpired(input.envelope, now)) problems.push("authority_expired");
      if (problems.length > 0) throw new ControlStackError("mission_authority_invalid", problems.join(", "));
      const envelope = canonicalEnvelope(input.envelope);
      const policy = { ...input.policy };
      const hash = envelopeHash(envelope);
      const privilegedActions = envelope.actions.filter((action) => PRIVILEGED_ACTIONS.has(action));
      if (
        !this.approvals.verifyMissionApproval({
          missionId: input.missionId,
          approverId: input.approverId,
          ...(input.grantId ? { grantId: input.grantId } : {}),
          envelopeHash: hash,
          privilegedActions
        })
      ) {
        this.store.recordMissionEvent(
          input.missionId,
          "authority.denied",
          { reason: "approval_not_verified", approverId: input.approverId.slice(0, 64), envelopeHash: hash },
          now
        );
        // The refusal is evidence, so it is committed first and thrown after the transaction.
        refusal = new ControlStackError(
          "mission_authority_unverified",
          "no verified approval covers this mission authority"
        );
        return undefined;
      }
      const existing = this.missionAuthority(input.missionId);
      if (existing) {
        if (existing.envelopeHash === hash && stableHash(existing.policy) === stableHash(policy)) return existing;
        throw new ControlStackError(
          "mission_authority_exists",
          "mission authority is write-once and cannot be widened"
        );
      }
      this.store.db
        .prepare(
          `INSERT INTO mission_authority (mission_id, envelope_json, envelope_hash, policy_json, approver_id, reason, grant_id, created_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
        )
        .run(
          input.missionId,
          JSON.stringify(envelope),
          hash,
          JSON.stringify(policy),
          input.approverId,
          input.reason,
          input.grantId ?? null,
          now
        );
      this.store.recordMissionEvent(
        input.missionId,
        "authority.granted",
        {
          envelopeHash: hash,
          actions: envelope.actions,
          privileged: envelope.actions.filter((action) => PRIVILEGED_ACTIONS.has(action)),
          expiresAt: envelope.expiresAt,
          approverId: input.approverId,
          reason: input.reason,
          grantId: input.grantId ?? null
        },
        now
      );
      return this.missionAuthority(input.missionId)!;
    });
    if (refusal) throw refusal;
    return record!;
  }

  private integrity(what: string, ok: boolean): void {
    if (!ok) throw new ControlStackError("authority_integrity", `${what} failed its integrity check`);
  }

  /** Reads fail closed: the envelope must be well-formed and must recompute to the stored hash. */
  missionAuthority(missionId: string): MissionAuthorityRecord | undefined {
    const row = this.store.db.prepare("SELECT * FROM mission_authority WHERE mission_id = ?").get(missionId) as
      Record<string, string | null> | undefined;
    if (!row) return undefined;
    let envelope: AuthorityEnvelope;
    let policy: MissionAuthorityPolicy;
    try {
      envelope = JSON.parse(String(row.envelope_json)) as AuthorityEnvelope;
      policy = JSON.parse(String(row.policy_json)) as MissionAuthorityPolicy;
    } catch {
      throw new ControlStackError("authority_integrity", "mission authority is not valid JSON");
    }
    this.integrity(
      "mission authority",
      validateEnvelope(envelope).length === 0 && envelopeHash(envelope) === row.envelope_hash
    );
    return {
      missionId,
      envelope,
      envelopeHash: String(row.envelope_hash),
      policy,
      approverId: String(row.approver_id),
      reason: String(row.reason),
      ...(row.grant_id ? { grantId: String(row.grant_id) } : {}),
      createdAt: String(row.created_at)
    };
  }

  /**
   * The authority a derived unit runs under. Fails closed unless the envelope recomputes to its stored hash, is a subset
   * of its parent's, and is bound to the parent hash it claims to derive from.
   */
  unitAuthority(missionId: string, unitId: string): UnitAuthorityRecord | undefined {
    const row = this.store.db
      .prepare("SELECT * FROM work_unit_authority WHERE mission_id = ? AND unit_id = ?")
      .get(missionId, unitId) as Record<string, string | null> | undefined;
    if (!row) return undefined;
    let envelope: AuthorityEnvelope;
    try {
      envelope = JSON.parse(String(row.envelope_json)) as AuthorityEnvelope;
    } catch {
      throw new ControlStackError("authority_integrity", "unit authority is not valid JSON");
    }
    this.integrity(
      "unit authority",
      validateEnvelope(envelope).length === 0 && envelopeHash(envelope) === row.envelope_hash
    );
    const parentUnitId = row.parent_unit_id ? String(row.parent_unit_id) : undefined;
    const parent = parentUnitId ? this.unitAuthority(missionId, parentUnitId) : undefined;
    const parentEnvelope = parent?.envelope ?? this.missionAuthority(missionId)?.envelope;
    const parentHash = parent?.envelopeHash ?? this.missionAuthority(missionId)?.envelopeHash;
    this.integrity(
      "unit authority derivation",
      parentEnvelope !== undefined && parentHash === row.derived_from_hash && isSubsetOf(envelope, parentEnvelope)
    );
    return {
      missionId,
      unitId,
      ...(parentUnitId ? { parentUnitId } : {}),
      envelope,
      envelopeHash: String(row.envelope_hash),
      derivedFromHash: String(row.derived_from_hash),
      ...(row.purpose ? { purpose: String(row.purpose) } : {}),
      createdAt: String(row.created_at)
    };
  }

  /**
   * ACS-owned `request_child_work`. All-or-nothing: if any child is denied nothing is created. A denial is durable
   * evidence (`child.denied`, `authority.denied`) so an escalation attempt can be reconstructed afterwards. Time comes
   * from ACS's clock; the request cannot supply it.
   */
  requestChildWork(request: ChildWorkRequest): ChildWorkResult {
    return this.store.transaction(() => {
      const { missionId, parentUnitId } = request;
      const now = this.clock();
      // The requester is recorded as claimed until the durable claim confirms it.
      let requester: Record<string, unknown> = { workerId: request.workerId, verified: false };
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
            children: request.children
              .slice(0, 16)
              .map((child) => ({ unitId: String(child.unitId).slice(0, 64), workType: child.workType }))
          },
          now
        );
      };
      const deny = (reasons: string[]): ChildWorkResult => {
        emitRequested();
        const safe = durableReasons(reasons);
        this.store.recordMissionEvent(missionId, "child.denied", { parentUnitId, requester, reasons: safe }, now);
        if (
          reasons.some((reason) =>
            /authority|action_|resource_|tool_|worker_|expiry|privileged|integrity/u.test(reason)
          )
        ) {
          this.store.recordMissionEvent(missionId, "authority.denied", { parentUnitId, requester, reasons: safe }, now);
        }
        return { ok: false, outcome: "denied", reasons };
      };

      const mission = this.store.get(missionId);
      if (!mission || TERMINAL_MISSION_STATES.has(mission.state)) return deny(["mission_not_active"]);
      const units = this.store.workUnits(missionId);
      const parent = units.find((unit) => unit.unitId === parentUnitId);
      if (!parent) return deny(["parent_unit_not_found"]);
      // Only the worker holding the parent's live claim may ask. A stale, wrong or forged identity is refused.
      if (
        (parent.status !== "running" && parent.status !== "checkpointed") ||
        parent.claimToken !== request.claimToken ||
        parent.workerId !== request.workerId
      ) {
        return deny(["claim_mismatch"]);
      }
      requester = {
        workerId: request.workerId,
        verified: true,
        parentAttempt: parent.attempt,
        claimFence: stableHash(request.claimToken).slice(0, 16)
      };
      emitRequested();
      if (request.children.length === 0 || request.children.length > 16) return deny(["child_count_invalid"]);

      let missionAuthority: MissionAuthorityRecord | undefined;
      let parentEnvelope: AuthorityEnvelope;
      let parentHash: string;
      try {
        missionAuthority = this.missionAuthority(missionId);
        if (!missionAuthority) return deny(["mission_has_no_authority"]);
        // A root unit runs under the mission envelope. A derived unit must have its own verified envelope: a missing
        // row is never treated as a root, or a unit created outside request_child_work would inherit the whole mission.
        const parentRecord = parent.parentUnitId ? this.unitAuthority(missionId, parentUnitId) : undefined;
        if (parent.parentUnitId && !parentRecord) return deny(["parent_authority_missing"]);
        parentEnvelope = parentRecord?.envelope ?? missionAuthority.envelope;
        parentHash = parentRecord?.envelopeHash ?? missionAuthority.envelopeHash;
      } catch (error) {
        if (error instanceof ControlStackError && error.code === "authority_integrity")
          return deny(["authority_integrity_failure"]);
        throw error;
      }

      const existingIds = new Set(units.map((unit) => unit.unitId));
      const batchIds = new Set(request.children.map((child) => String(child.unitId)));
      const seen = new Set<string>();
      const derived: Array<{ item: ChildWorkItem; envelope: AuthorityEnvelope }> = [];
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
        if (typeof item.purpose !== "string" || !item.purpose || item.purpose.length > 512)
          reasons.push(`${prefix}:purpose_invalid`);
        // Everything addWorkUnits would reject is checked here, so a bad payload or graph is a durable denial.
        if (item.workType in KIND_FOR_WORK_TYPE) {
          try {
            parseWorkUnitPayload(KIND_FOR_WORK_TYPE[item.workType], item.payload ?? {});
          } catch {
            if (item.payload !== undefined || KIND_FOR_WORK_TYPE[item.workType] !== "coding")
              reasons.push(`${prefix}:payload_invalid`);
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
        const narrowed = narrowAuthority({
          parent: parentEnvelope,
          policy: missionAuthority.policy,
          ...(item.requestedAuthority ? { requested: item.requestedAuthority } : {}),
          now
        });
        if (!narrowed.ok) {
          for (const reason of narrowed.reasons) reasons.push(`${prefix}:${reason}`);
          continue;
        }
        // The invariant, asserted rather than assumed.
        if (!isSubsetOf(narrowed.envelope, parentEnvelope)) reasons.push(`${prefix}:narrowing_invariant_violated`);
        else derived.push({ item, envelope: narrowed.envelope });
      }
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
          now
        );
      } catch (error) {
        // addWorkUnits validates its whole batch before it writes anything, so these codes never leave a partial insert.
        if (error instanceof ControlStackError && /^work_unit_/u.test(error.code)) return deny([error.code]);
        throw error;
      }
      if (!created.ok) {
        const safe = durableReasons(["budget_exhausted"]);
        this.store.recordMissionEvent(missionId, "child.denied", { parentUnitId, requester, reasons: safe }, now);
        return { ok: false, outcome: "budget_exhausted", decision: created.decision };
      }
      const insert = this.store.db.prepare(
        `INSERT INTO work_unit_authority (mission_id, unit_id, parent_unit_id, envelope_json, envelope_hash, derived_from_hash, requested_json, purpose, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`
      );
      const authorities: Record<string, AuthorityEnvelope> = {};
      for (const { item, envelope } of derived) {
        insert.run(
          missionId,
          item.unitId,
          parentUnitId,
          JSON.stringify(envelope),
          envelopeHash(envelope),
          parentHash,
          JSON.stringify({ authority: item.requestedAuthority ?? null, budget: item.requestedBudget ?? null }),
          item.purpose,
          now
        );
        authorities[item.unitId] = envelope;
        this.store.recordMissionEvent(
          missionId,
          "child.admitted",
          {
            parentUnitId,
            unitId: item.unitId,
            workType: item.workType,
            requester,
            envelopeHash: envelopeHash(envelope),
            derivedFrom: parentHash
          },
          now
        );
      }
      return { ok: true, created: created.created, authorities };
    });
  }

  /**
   * Cancel every unfinished descendant of a unit. The caller must either hold the parent's live claim or be an
   * authenticated operator, so a stale worker cannot cancel work owned by a newer claimant. In-flight children are
   * reported as uncertain, not rolled back.
   */
  cancelChildren(
    missionId: string,
    parentUnitId: string,
    input: { reason: string; authorization: CancelAuthorization }
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
          ? this.approvals.verifyOperator(auth.operatorId)
          : parent.claimToken === auth.claimToken &&
            parent.workerId === auth.workerId &&
            ["running", "checkpointed", "verifying"].includes(parent.status);
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
        if (!descendants.has(unit.unitId) || ["succeeded", "cancelled", "failed"].includes(unit.status)) continue;
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
   * finish time), recorded once, and never partial: while any child is unfinished nothing is written.
   */
  reduceChildren(input: {
    missionId: string;
    parentUnitId: string;
    strategy: "all_succeeded" | "select" | "majority_result";
    selectedUnitId?: string;
  }):
    | { status: "incomplete"; waitingOn: string[] }
    | {
        status: "reduced" | "failed" | "inconclusive";
        resultHash?: string;
        selectedUnitId?: string;
        recorded: boolean;
      } {
    return this.store.transaction(() => {
      const now = this.clock();
      const existing = this.store.db
        .prepare("SELECT * FROM work_unit_reductions WHERE mission_id = ? AND parent_unit_id = ?")
        .get(input.missionId, input.parentUnitId) as Record<string, string | null> | undefined;
      if (existing) {
        return {
          status: String(existing.outcome) as "reduced" | "failed" | "inconclusive",
          ...(existing.result_hash ? { resultHash: String(existing.result_hash) } : {}),
          ...(existing.selected_unit_id ? { selectedUnitId: String(existing.selected_unit_id) } : {}),
          recorded: false
        };
      }
      const children = this.store
        .workUnits(input.missionId)
        .filter((unit) => unit.parentUnitId === input.parentUnitId)
        .sort((left, right) => left.unitId.localeCompare(right.unitId));
      if (children.length === 0)
        throw new ControlStackError("reduction_no_children", "unit has no child work to reduce");
      const waitingOn = children
        .filter((unit) => !["succeeded", "failed", "cancelled"].includes(unit.status))
        .map((unit) => unit.unitId);
      if (waitingOn.length > 0) return { status: "incomplete", waitingOn };

      const succeeded = children.filter((unit) => unit.status === "succeeded" && unit.resultHash);
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
        const ranked = [...counts.entries()].sort((a, b) => b[1].length - a[1].length || a[0].localeCompare(b[0]));
        // A strict majority of all children, otherwise there is no result: ties are never broken arbitrarily.
        if (ranked[0] && ranked[0][1].length * 2 > children.length) {
          outcome = "reduced";
          resultHash = ranked[0][0];
          selected = ranked[0][1][0];
        } else outcome = "inconclusive";
      }
      this.store.db
        .prepare(
          `INSERT INTO work_unit_reductions (mission_id, parent_unit_id, strategy, outcome, selected_unit_id, result_hash, children_json, created_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
        )
        .run(
          input.missionId,
          input.parentUnitId,
          input.strategy,
          outcome,
          selected ?? null,
          resultHash ?? null,
          JSON.stringify(
            children.map((unit) => ({ unitId: unit.unitId, status: unit.status, resultHash: unit.resultHash ?? null }))
          ),
          now
        );
      this.store.recordMissionEvent(
        input.missionId,
        "child.reduced",
        { parentUnitId: input.parentUnitId, strategy: input.strategy, outcome, children: children.length },
        now
      );
      return {
        status: outcome,
        ...(resultHash ? { resultHash } : {}),
        ...(selected ? { selectedUnitId: selected } : {}),
        recorded: true
      };
    });
  }
}
