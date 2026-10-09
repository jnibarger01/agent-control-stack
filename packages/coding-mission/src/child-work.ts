/**
 * Bounded child work (`request_child_work`), authority derivation and result reduction.
 *
 * An agent never spawns anything. It asks ACS, holding the claim of a running unit, and ACS decides. Everything here
 * runs inside one IMMEDIATE transaction on the durable store, so depth, fan-out, total-children and parallel caps
 * (budget.ts) and the authority narrowing (authority.ts) cannot be bypassed by concurrency or a restart.
 */
import { ControlStackError, stableHash } from "@agent-control-stack/shared";
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
import type { BudgetDecision, MissionBudget } from "./budget.js";
import {
  IN_FLIGHT_WORK_UNIT_STATUSES,
  TERMINAL_MISSION_STATES,
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
  now: string;
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

export class MissionAuthorityLedger {
  constructor(private readonly store: CodingMissionStore) {}

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
    now: string;
  }): MissionAuthorityRecord {
    return this.store.transaction(() => {
      const mission = this.store.require(input.missionId);
      if (TERMINAL_MISSION_STATES.has(mission.state)) {
        throw new ControlStackError("mission_not_active", `mission is ${mission.state}`);
      }
      if (!input.approverId || !input.reason) {
        throw new ControlStackError("mission_authority_invalid", "an approver and a reason are required");
      }
      const problems = validateEnvelope(input.envelope);
      if (isExpired(input.envelope, input.now)) problems.push("authority_expired");
      if (problems.length > 0) throw new ControlStackError("mission_authority_invalid", problems.join(", "));
      const envelope = canonicalEnvelope(input.envelope);
      const policy = { ...input.policy };
      const hash = envelopeHash(envelope);
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
          input.now
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
        input.now
      );
      return this.missionAuthority(input.missionId)!;
    });
  }

  missionAuthority(missionId: string): MissionAuthorityRecord | undefined {
    const row = this.store.db.prepare("SELECT * FROM mission_authority WHERE mission_id = ?").get(missionId) as
      Record<string, string | null> | undefined;
    if (!row) return undefined;
    return {
      missionId,
      envelope: JSON.parse(String(row.envelope_json)) as AuthorityEnvelope,
      envelopeHash: String(row.envelope_hash),
      policy: JSON.parse(String(row.policy_json)) as MissionAuthorityPolicy,
      approverId: String(row.approver_id),
      reason: String(row.reason),
      ...(row.grant_id ? { grantId: String(row.grant_id) } : {}),
      createdAt: String(row.created_at)
    };
  }

  /** The authority a unit runs under: its own derived envelope, or the mission envelope for a root unit. */
  unitAuthority(missionId: string, unitId: string): UnitAuthorityRecord | undefined {
    const row = this.store.db
      .prepare("SELECT * FROM work_unit_authority WHERE mission_id = ? AND unit_id = ?")
      .get(missionId, unitId) as Record<string, string | null> | undefined;
    if (!row) return undefined;
    return {
      missionId,
      unitId,
      ...(row.parent_unit_id ? { parentUnitId: String(row.parent_unit_id) } : {}),
      envelope: JSON.parse(String(row.envelope_json)) as AuthorityEnvelope,
      envelopeHash: String(row.envelope_hash),
      derivedFromHash: String(row.derived_from_hash),
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
      const { missionId, parentUnitId, now } = request;
      const deny = (reasons: string[]): ChildWorkResult => {
        this.store.recordMissionEvent(missionId, "child.denied", { parentUnitId, reasons }, now);
        if (reasons.some((reason) => /authority|action_|resource_|tool_|worker_|expiry|privileged/u.test(reason))) {
          this.store.recordMissionEvent(missionId, "authority.denied", { parentUnitId, reasons }, now);
        }
        return { ok: false, outcome: "denied", reasons };
      };
      this.store.recordMissionEvent(
        missionId,
        "child.requested",
        {
          parentUnitId,
          children: request.children.map((child) => ({ unitId: child.unitId, workType: child.workType }))
        },
        now
      );

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
      if (request.children.length === 0 || request.children.length > 16) return deny(["child_count_invalid"]);
      const missionAuthority = this.missionAuthority(missionId);
      if (!missionAuthority) return deny(["mission_has_no_authority"]);
      const parentRecord = this.unitAuthority(missionId, parentUnitId);
      const parentEnvelope = parentRecord?.envelope ?? missionAuthority.envelope;
      const parentHash = parentRecord?.envelopeHash ?? missionAuthority.envelopeHash;

      const seen = new Set<string>();
      const derived: Array<{ item: ChildWorkItem; envelope: AuthorityEnvelope }> = [];
      const reasons: string[] = [];
      const missionBudget = this.store.budget(missionId);
      for (const item of request.children) {
        const prefix = UNIT_ID.test(item.unitId) ? item.unitId : "invalid_unit_id";
        if (!UNIT_ID.test(item.unitId) || seen.has(item.unitId))
          reasons.push(`${prefix}:child_id_invalid_or_duplicate`);
        seen.add(item.unitId);
        if (!(CHILD_WORK_TYPES as readonly string[]).includes(item.workType))
          reasons.push(`${prefix}:work_type_invalid`);
        if (!item.purpose || item.purpose.length > 512) reasons.push(`${prefix}:purpose_invalid`);
        if (item.requestedBudget && missionBudget) {
          const limits = missionBudget.limits;
          const asks: Array<[number | undefined, number | undefined, string]> = [
            [item.requestedBudget.maxWorkUnits, limits.work_units, "work_units"],
            [item.requestedBudget.maxToolCalls, limits.tool_calls, "tool_calls"],
            [item.requestedBudget.maxModelTokens, limits.model_tokens, "model_tokens"],
            [item.requestedBudget.maxChildDepth, limits.child_depth, "child_depth"],
            [item.requestedBudget.maxChildWorkUnits, limits.child_work_units, "child_work_units"]
          ];
          for (const [asked, cap, name] of asks) {
            if (asked !== undefined && (!Number.isFinite(asked) || asked < 0))
              reasons.push(`${prefix}:budget_invalid:${name}`);
            else if (asked !== undefined && cap !== undefined && asked > cap)
              reasons.push(`${prefix}:budget_exceeds_mission:${name}`);
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

      const created = this.store.addWorkUnits(
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
      if (!created.ok) {
        // addWorkUnits already recorded budget.exhausted; add the child-level denial beside it.
        this.store.recordMissionEvent(missionId, "child.denied", { parentUnitId, reasons: ["budget_exhausted"] }, now);
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
            envelopeHash: envelopeHash(envelope),
            derivedFrom: parentHash
          },
          now
        );
      }
      return { ok: true, created: created.created, authorities };
    });
  }

  /** Cancel every unfinished descendant of a unit. In-flight children are reported as uncertain, not rolled back. */
  cancelChildren(
    missionId: string,
    parentUnitId: string,
    input: { reason: string; now: string }
  ): { cancelled: string[]; uncertain: string[] } {
    return this.store.transaction(() => {
      const units = this.store.workUnits(missionId);
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
            reason: input.reason
          },
          input.now
        );
      }
      return { cancelled, uncertain };
    });
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
    now: string;
  }):
    | { status: "incomplete"; waitingOn: string[] }
    | {
        status: "reduced" | "failed" | "inconclusive";
        resultHash?: string;
        selectedUnitId?: string;
        recorded: boolean;
      } {
    return this.store.transaction(() => {
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
          input.now
        );
      this.store.recordMissionEvent(
        input.missionId,
        "child.reduced",
        { parentUnitId: input.parentUnitId, strategy: input.strategy, outcome, children: children.length },
        input.now
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
