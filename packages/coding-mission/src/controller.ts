import { randomUUID } from "node:crypto";
import type { RecoveryPolicy } from "./recovery-policy.js";
import { readMissionFlightRecord, type MissionFlightRecord } from "./flight-recorder.js";
import { NIMBLE_ROUTING_ALGORITHM_VERSION } from "@agent-control-stack/actor-router";
import { ControlStackError, stableHash } from "@agent-control-stack/shared";
import type { MissionAuthorityPolicy } from "./authority.js";
import type { MissionAuthorityRecord } from "./child-work.js";
import { createGovernedExecution, type GovernedExecution } from "./governed-runtime.js";
import {
  CoderExecutionAdapter,
  deadlineResult,
  type ApplyResult,
  type DispatchEnvelope,
  type ResultEnvelope
} from "./worker-execution.js";
import {
  codingChangeSetHash,
  CodingMissionStore,
  type CodingMissionRecord,
  type CodingMissionState,
  type CodingOperation,
  type ValidationEvidence
} from "./store.js";

const REQUIRED_CHECKS = ["tests", "typecheck", "lint", "format", "repository", "review"] as const;
const MISSION_ID = /^[A-Za-z0-9._:-]{1,128}$/u;
const SHA = /^[a-f0-9]{40}$/u;

export interface ExternalOutcome<T> {
  status: "succeeded" | "unknown" | "absent" | "rejected";
  value?: T;
  code?: string;
}

export interface CodingMissionPorts {
  now(): string;
  deploymentPolicy: {
    requirement(repository: string): { required: boolean; action: string; impact: string };
  };
  planner: {
    decompose(mission: CodingMissionRecord): Array<{ operationId: string; dependsOn: string[]; title: string }>;
  };
  router: {
    route(input: {
      mission: CodingMissionRecord;
      operation: { operationId: string; title: string };
    }): Promise<{ workerId: string; algorithm: string; decision: unknown }>;
  };
  coder: {
    execute(input: {
      mission: CodingMissionRecord;
      operationId: string;
      workerId: string;
      /** The claim's fence. A fencing executor refuses to start or commit work under a token it has revoked. */
      claimToken?: string;
      /** Aborted when a governed dispatch passes its deadline. A cooperative executor should stop; ACS does not wait for it. */
      signal?: AbortSignal;
    }): Promise<ExternalOutcome<{ resultHash: string; files: string[] }>>;
    observe(input: {
      mission: CodingMissionRecord;
      operationId: string;
      claimToken?: string;
    }): Promise<ExternalOutcome<{ resultHash: string; files: string[] }>>;
    /**
     * Revoke the stale claim at the executor: after this resolves as `succeeded`, a worker holding `claimToken` can no
     * longer start the operation or commit its effects. Recovery calls it before it looks at the operation, so "absent"
     * cannot be invalidated by the old holder resuming.
     */
    fence?(input: {
      mission: CodingMissionRecord;
      operationId: string;
      claimToken: string;
    }): Promise<ExternalOutcome<unknown>>;
    /**
     * Declares that running the operation again converges on the same result with no repeated side effect, so a stale
     * holder resuming is harmless. Without `fence` or this declaration, recovery cannot be proven safe and is escalated.
     */
    idempotent?: boolean;
  };
  reconciler: {
    reconcile(input: {
      mission: CodingMissionRecord;
      operations: CodingOperation[];
    }): Promise<ExternalOutcome<{ headSha: string; conflicts: string[] }>>;
  };
  validator: {
    validate(input: { mission: CodingMissionRecord; headSha: string }): Promise<ExternalOutcome<ValidationEvidence>>;
  };
  publisher: {
    publish(input: {
      mission: CodingMissionRecord;
      headSha: string;
    }): Promise<ExternalOutcome<{ prNumber: number; prUrl: string; headSha: string }>>;
    observe(input: {
      mission: CodingMissionRecord;
    }): Promise<ExternalOutcome<{ prNumber: number; prUrl: string; headSha: string }>>;
  };
  baseObserver: { currentBaseSha(repository: string, baseRef: string): Promise<string> };
  admission: {
    acquire(
      mission: CodingMissionRecord
    ): Promise<{ permitId: string } | { denied: "policy" | "capacity"; code: string }>;
  };
  merger: {
    merge(input: {
      mission: CodingMissionRecord;
    }): Promise<ExternalOutcome<{ mergeSha: string; alreadyMerged?: boolean }>>;
    observe(input: { mission: CodingMissionRecord }): Promise<ExternalOutcome<{ mergeSha: string }>>;
  };
  deployer: {
    deploy(input: {
      mission: CodingMissionRecord;
      mergeSha: string;
    }): Promise<ExternalOutcome<{ deploymentId: string }>>;
    observe(input: { mission: CodingMissionRecord }): Promise<ExternalOutcome<{ deploymentId: string }>>;
  };
  verifier: {
    verify(input: {
      mission: CodingMissionRecord;
      operations: CodingOperation[];
    }): Promise<{ passed: boolean; checks: Record<string, string> }>;
  };
  authorityGrant?: {
    covers(mission: CodingMissionRecord, changeSetHash: string): { grantId: string } | undefined;
  };
  /** Running claims younger than this are left to the worker that holds them. */
  claimTtlMs?: number;
  /** Bounds and backoff for recovering stale claims. Defaults are conservative; see recovery-policy.ts. */
  recoveryPolicy?: Partial<RecoveryPolicy>;
  /**
   * Governed execution. When set, the controller runs every operation through the dispatch authority gate
   * (`createGovernedExecution`) and refuses to run a mission whose authority is missing, revoked, expired, for another
   * actor, or whose audit history fails verification. Absent, the controller behaves exactly as before. Needs a database
   * path, not a store instance, because the grant store and the mission store must share one file.
   */
  governance?: { mode: "enforce" };
  onTransition?: (from: CodingMissionState, to: CodingMissionState, missionId: string) => void;
}

export interface AdvanceResult {
  missionId: string;
  state: CodingMissionState;
  version: number;
  progressed: boolean;
  changeSetHash?: string;
  code?: string;
}

export interface ApprovalView {
  missionId: string;
  state: CodingMissionState;
  summary: string;
  repository: string;
  files: string[];
  commits: string[];
  pullRequest?: { number: number; url?: string };
  checks: Record<string, string>;
  review?: string;
  changeSet?: string;
  deploymentRequired: boolean;
  deploymentImpact: string;
  approvalAction?: "APPROVE_CHANGE_SET";
  failureCode?: string;
  mergeSha?: string;
  deploymentId?: string;
}

function succeeded<T>(value: T): ExternalOutcome<T> {
  return { status: "succeeded", value };
}

export class CodingMissionController {
  readonly store: CodingMissionStore;
  private readonly governed: GovernedExecution | undefined;

  constructor(
    dbOrPath: string | CodingMissionStore,
    private readonly ports: CodingMissionPorts
  ) {
    if (ports.governance) {
      if (typeof dbOrPath !== "string") {
        throw new ControlStackError(
          "governed_execution_needs_database_path",
          "governed execution needs a database path: the grant store and the mission store must share one file"
        );
      }
      // Identity is the control plane's: an operator is a registered HUMAN actor, and a worker acts as the actor a human
      // operator bound it to. Nothing here accepts an identity from the worker, the route, or the request.
      this.governed = createGovernedExecution({
        dbPath: dbOrPath,
        verifyOperator: "control-plane",
        resolveActor: "control-plane",
        clock: () => ports.now()
      });
      this.store = this.governed.missions;
    } else {
      this.store = dbOrPath instanceof CodingMissionStore ? dbOrPath : new CodingMissionStore(dbOrPath);
    }
    // Claim admission (recovery backoff) is judged on the control plane's clock, not on a time a caller names.
    this.store.admissionClock = () => Date.parse(this.ports.now());
  }

  close(): void {
    if (this.governed) this.governed.close();
    else this.store.close();
  }

  create(input: {
    missionId: string;
    repository: string;
    baseRef: string;
    baseSha: string;
    summary: string;
  }): CodingMissionRecord {
    if (!MISSION_ID.test(input.missionId)) {
      throw new ControlStackError("coding_mission_id_invalid", "mission identifier is invalid");
    }
    if (!input.repository || input.repository.length > 256 || /[\s@]/.test(input.repository)) {
      throw new ControlStackError("coding_mission_repository_invalid", "repository identity is invalid");
    }
    if (!SHA.test(input.baseSha)) {
      throw new ControlStackError("coding_mission_base_invalid", "base SHA must be a 40-character hex commit");
    }
    const deployment = this.ports.deploymentPolicy.requirement(input.repository);
    return this.store.create({
      ...input,
      branch: `acs/mission/${input.missionId}`,
      deploymentRequired: deployment.required,
      deploymentAction: deployment.action,
      deploymentImpact: deployment.impact,
      now: this.ports.now()
    });
  }

  approvalView(missionId: string): ApprovalView {
    const mission = this.store.require(missionId);
    const operations = this.store.operations(missionId);
    const files = [...new Set(operations.flatMap((operation) => operation.files))].sort();
    return {
      missionId: mission.missionId,
      state: mission.state,
      summary: mission.summary,
      repository: mission.repository,
      files,
      commits: mission.headSha ? [mission.headSha] : [],
      ...(mission.prNumber === undefined
        ? {}
        : { pullRequest: { number: mission.prNumber, ...(mission.prUrl ? { url: mission.prUrl } : {}) } }),
      checks: mission.validation?.checks ?? {},
      ...(mission.validation ? { review: mission.validation.checks.review } : {}),
      ...(mission.changeSetHash ? { changeSet: mission.changeSetHash } : {}),
      deploymentRequired: mission.deploymentRequired,
      deploymentImpact: mission.deploymentImpact,
      ...(mission.state === "WAITING_FOR_APPROVAL" ? { approvalAction: "APPROVE_CHANGE_SET" as const } : {}),
      ...(mission.failureCode ? { failureCode: mission.failureCode } : {}),
      ...(mission.mergeSha ? { mergeSha: mission.mergeSha } : {}),
      ...(mission.deploymentId ? { deploymentId: mission.deploymentId } : {})
    };
  }

  async advance(missionId: string): Promise<AdvanceResult> {
    const mission = this.store.require(missionId);
    // This controller drives the coding profile only; other mission kinds have their own drivers.
    if (mission.kind !== "coding") return this.result(mission, false, "mission_kind_unsupported");
    try {
      switch (mission.state) {
        case "PLANNING":
          return this.plan(mission);
        case "RUNNING":
          return await this.runOne(mission);
        case "RECONCILING":
          return await this.reconcile(mission);
        case "VALIDATING":
          return await this.validate(mission);
        case "PREPARING_CHANGE_SET":
          return this.prepare(mission);
        case "PUBLISHING_PROPOSAL":
          return await this.publish(mission);
        case "WAITING_FOR_APPROVAL":
          return this.applyGrant(mission);
        case "APPROVED":
          return this.beginExecution(mission);
        case "EXECUTING":
          return await this.execute(mission);
        case "VERIFYING":
          return await this.verify(mission);
        case "DEGRADED":
          return this.result(mission, false, mission.failureCode);
        default:
          return this.result(mission, false);
      }
    } catch (error) {
      if (error instanceof ControlStackError && error.code === "coding_mission_version_conflict") {
        const current = this.store.require(missionId);
        return this.result(current, false, error.code);
      }
      if (error instanceof ControlStackError && error.code === "coding_mission_claim_conflict") {
        // A result that arrives after cancellation is stale by construction: the unit is no longer claimable.
        const current = this.store.require(missionId);
        if (current.state === "CANCELLED") return this.result(current, false, "mission_cancelled");
      }
      throw error;
    }
  }

  async runUntilStable(missionId: string): Promise<AdvanceResult> {
    let latest: AdvanceResult | undefined;
    for (let step = 0; step < 64; step += 1) {
      latest = await this.advance(missionId);
      if (!latest.progressed) return latest;
      if (
        latest.state === "WAITING_FOR_APPROVAL" ||
        latest.state === "COMPLETED" ||
        latest.state === "FAILED" ||
        latest.state === "CANCELLED" ||
        latest.state === "DEGRADED"
      ) {
        return latest;
      }
      if (
        latest.code === "in_progress" ||
        latest.code === "unknown_operation" ||
        latest.code === "unknown_pr" ||
        latest.code === "unknown_merge" ||
        latest.code === "unknown_deployment" ||
        latest.code === "admission_deferred"
      ) {
        return latest;
      }
    }
    throw new ControlStackError("coding_mission_budget_exhausted", "coding mission did not reach a stable state");
  }

  async resumeAll(): Promise<AdvanceResult[]> {
    const results: AdvanceResult[] = [];
    for (const mission of this.store.listResumable()) {
      results.push(await this.runUntilStable(mission.missionId));
    }
    return results;
  }

  /** Tamper-evident replay of one mission. Throws coding_mission_not_found for an unknown mission. */
  flightRecord(missionId: string, window: { afterSeq?: number; limit?: number } = {}): MissionFlightRecord {
    if (!this.store.exists(missionId)) {
      throw new ControlStackError("coding_mission_not_found", "coding mission does not exist");
    }
    return readMissionFlightRecord(this.store.db, missionId, window);
  }

  listRecent(limit = 50): ApprovalView[] {
    const capped = Math.min(Math.max(Math.floor(limit), 1), 50);
    return this.store.listRecent(capped).map((mission) => this.approvalView(mission.missionId));
  }

  async approve(
    missionId: string,
    input: { approverId: string; expectedChangeSetHash: string }
  ): Promise<AdvanceResult> {
    if (!input.approverId || input.approverId.length > 128) {
      throw new ControlStackError("coding_mission_approver_invalid", "approver identity is invalid");
    }
    this.recordApproval(missionId, {
      approverId: input.approverId,
      expectedChangeSetHash: input.expectedChangeSetHash
    });
    return this.runUntilStable(missionId);
  }

  recordApproval(
    missionId: string,
    input: { approverId?: string; grantId?: string; expectedChangeSetHash: string }
  ): CodingMissionRecord {
    const mission = this.store.require(missionId);
    const operations = this.store.operations(missionId);
    const hash = codingChangeSetHash(mission, operations);
    if (hash !== mission.changeSetHash || hash !== input.expectedChangeSetHash) {
      throw new ControlStackError("coding_mission_stale_approval", "approval does not match the immutable change set");
    }
    if (mission.approvalId && mission.approvedChangeSetHash === hash) return mission;
    if (mission.state !== "WAITING_FOR_APPROVAL") {
      throw new ControlStackError(
        "coding_mission_not_awaiting_approval",
        "mission is not awaiting change-set approval"
      );
    }
    const approverId = input.grantId ? `grant:${input.grantId}` : input.approverId;
    if (!approverId) throw new ControlStackError("coding_mission_approver_invalid", "approval has no principal");
    const approvalId = `apr_${stableHash({ missionId, hash, approverId }).slice(0, 24)}`;
    const approvalHash = stableHash({
      domain: "acs.coding-approval.v1",
      missionId,
      changeSetHash: hash,
      approverId,
      grantId: input.grantId ?? null
    });
    return this.store.transition(mission, "APPROVED", this.ports.now(), {
      event: "coding_mission.approved",
      approvalId,
      approvalHash,
      approvedChangeSetHash: hash,
      approverId,
      grantId: input.grantId ?? null,
      failureCode: null,
      body: { changeSetHash: hash, approvalId, approverId }
    });
  }

  private plan(mission: CodingMissionRecord): AdvanceResult {
    const operations = this.ports.planner.decompose(mission);
    if (operations.length < 1 || operations.length > 64) {
      throw new ControlStackError("coding_mission_plan_invalid", "coding mission must decompose into 1-64 operations");
    }
    const ids = new Set<string>();
    for (const operation of operations) {
      if (!MISSION_ID.test(operation.operationId) || ids.has(operation.operationId)) {
        throw new ControlStackError("coding_mission_plan_invalid", "operation identifiers must be unique and bounded");
      }
      ids.add(operation.operationId);
    }
    for (const operation of operations) {
      for (const dependency of operation.dependsOn) {
        if (!ids.has(dependency) || dependency === operation.operationId) {
          throw new ControlStackError("coding_mission_plan_invalid", "operation dependency is unknown");
        }
      }
    }
    if (hasCycle(operations)) {
      throw new ControlStackError("coding_mission_plan_invalid", "operation dependencies contain a cycle");
    }
    const next = this.store.replaceOperations(mission, operations, this.ports.now());
    return this.result(next, true);
  }

  private async runOne(mission: CodingMissionRecord): Promise<AdvanceResult> {
    const operations = this.store.operations(mission.missionId);
    const unknown = operations.find((operation) => operation.status === "running" || operation.status === "unknown");
    if (unknown?.status === "running") {
      const ttl = this.ports.claimTtlMs ?? 30_000;
      const claimedAt = unknown.claimedAt ? Date.parse(unknown.claimedAt) : 0;
      if (Date.parse(this.ports.now()) - claimedAt < ttl) return this.result(mission, false, "in_progress");
    }
    if (unknown) return this.recoverOperation(mission, unknown);
    if (operations.some((operation) => operation.status === "conflict")) {
      return this.degrade(mission, "reconciliation_required");
    }
    if (operations.every((operation) => operation.status === "succeeded")) {
      return this.result(
        this.store.transition(mission, "RECONCILING", this.ports.now(), { event: "coding_mission.reconciling" }),
        true
      );
    }
    const eligible = operations.filter(
      (operation) =>
        operation.status === "pending" &&
        operation.dependsOn.every(
          (dependency) => operations.find((candidate) => candidate.operationId === dependency)?.status === "succeeded"
        )
    );
    const nowMs = Date.parse(this.ports.now());
    const ready = eligible
      .filter((operation) => !operation.retryNotBefore || nowMs >= Date.parse(operation.retryNotBefore))
      .sort((left, right) => left.operationId.localeCompare(right.operationId));
    const nextOperation = ready[0];
    // Default deny: a governed controller does not start a mission nobody gave authority to. This waits (nothing is claimed,
    // nothing is degraded) until an operator binds a grant; the binding itself is verified when it is made.
    if (nextOperation && this.governed && !this.hasAuthorityBinding(mission.missionId)) {
      return this.result(mission, false, "authority_required");
    }
    if (!nextOperation) {
      // Units waiting out a recovery backoff are not blocked; the mission simply has nothing to run yet.
      if (eligible.length > 0) return this.result(mission, false, "recovery_backoff");
      return this.degrade(mission, "dependency_blocked");
    }
    const route = await this.ports.router.route({
      mission,
      operation: { operationId: nextOperation.operationId, title: nextOperation.title }
    });
    if (route.algorithm !== NIMBLE_ROUTING_ALGORITHM_VERSION || !route.workerId) {
      throw new ControlStackError("coding_mission_route_unauthoritative", "routing did not come from Nimble");
    }
    const token = randomUUID();
    const claimed = this.store.claim(mission.missionId, nextOperation.operationId, {
      token,
      workerId: route.workerId,
      route,
      claimedAt: this.ports.now()
    });
    if (!claimed) return this.result(this.store.require(mission.missionId), false, "claim_conflict");
    this.store.putEvidence(
      mission.missionId,
      `route:${nextOperation.operationId}`,
      { workerId: route.workerId, algorithm: route.algorithm, decision: route.decision },
      this.ports.now()
    );
    if (this.governed) return this.runGoverned(mission, nextOperation.operationId, route.workerId, token);
    const executed = await this.ports.coder.execute({
      mission,
      operationId: nextOperation.operationId,
      workerId: route.workerId,
      claimToken: token
    });
    return this.acceptCoderResult(mission, nextOperation.operationId, token, executed);
  }

  private hasAuthorityBinding(missionId: string): boolean {
    return this.store.db.prepare("SELECT 1 FROM mission_authority WHERE mission_id = ?").get(missionId) !== undefined;
  }

  /**
   * Bind a mission to a human-issued grant. Verified by the authority ledger (the grant exists, belongs to this mission,
   * is intact, current, unrevoked and unexpired, and still matches the mission's execution inputs). Write-once.
   */
  bindAuthority(
    missionId: string,
    grantId: string,
    options: { policy?: MissionAuthorityPolicy; policyApprovedBy?: string } = {}
  ): MissionAuthorityRecord {
    if (!this.governed) {
      throw new ControlStackError(
        "governed_execution_disabled",
        "governed execution is not enabled on this controller"
      );
    }
    if (!MISSION_ID.test(missionId))
      throw new ControlStackError("coding_mission_id_invalid", "mission identifier is invalid");
    return this.governed.authority.grantMissionAuthority({ missionId, grantId, ...options });
  }

  /** Governed dispatch: audit integrity, then the authority gate, then execution within the deadline, then the result. */
  private async runGoverned(
    mission: CodingMissionRecord,
    operationId: string,
    workerId: string,
    token: string
  ): Promise<AdvanceResult> {
    const governed = this.governed!;
    const lane = "coder" as const;
    // The authority check re-verifies the audit chain whenever another connection has written, and it runs inside the
    // dispatch transaction. Doing it first, outside any transaction, keeps that cost off the write lock; a chain that does
    // not verify refuses the dispatch.
    try {
      governed.items.assertAuditChainIntegrity();
    } catch {
      this.store.recordMissionEvent(
        mission.missionId,
        "authority.denied",
        { operation: "dispatch", unitId: operationId, lane, reason: "audit_integrity_failed" },
        this.ports.now()
      );
      return this.refuseDispatch(mission, operationId);
    }
    let dispatch: DispatchEnvelope;
    try {
      dispatch = governed.dispatcher.beginDispatch({
        missionId: mission.missionId,
        unitId: operationId,
        claimToken: token,
        workerId,
        lane,
        now: this.ports.now()
      });
    } catch (error) {
      // beginDispatch has already committed the denial as evidence. Nothing ran.
      if (error instanceof ControlStackError && error.code === "dispatch_authority_denied") {
        return this.refuseDispatch(mission, operationId);
      }
      throw error;
    }
    const result = await this.executeWithinDeadline(dispatch, token);
    const applied = governed.dispatcher.applyResult({ claimToken: token, result });
    return this.afterGovernedResult(mission.missionId, operationId, applied);
  }

  /** The unit goes back to pending (it never ran) and the mission waits for an operator; it cannot proceed on its own. */
  private refuseDispatch(mission: CodingMissionRecord, operationId: string): AdvanceResult {
    return this.store.transaction(() => {
      this.store.resetClaim(mission.missionId, operationId);
      return this.degrade(this.store.require(mission.missionId), "dispatch_authority_denied");
    });
  }

  /**
   * Runs the executor against the dispatch's deadline. ACS does not wait past it: the executor is signalled to stop and the
   * outcome is recorded as uncertain, because the operation may have started and may still be running.
   */
  private async executeWithinDeadline(dispatch: DispatchEnvelope, token: string): Promise<ResultEnvelope> {
    const adapter = new CoderExecutionAdapter(this.store, this.ports.coder, () => this.ports.now(), token);
    const abort = new AbortController();
    const deadlineAt = dispatch.authority.deadlineAt;
    // A governed dispatch always has a deadline. If one is somehow missing, fail closed rather than run unbounded.
    if (deadlineAt === undefined) return deadlineResult(dispatch, this.ports.now());
    const budgetMs = Math.max(1, Date.parse(deadlineAt) - Date.parse(dispatch.issuedAt));
    let timer: NodeJS.Timeout | undefined;
    const expired = new Promise<"deadline">((resolve) => {
      timer = setTimeout(() => {
        abort.abort();
        resolve("deadline");
      }, budgetMs);
    });
    const execution = adapter.execute(dispatch, abort.signal);
    execution.catch(() => undefined); // an executor that fails after the deadline is not an unhandled rejection
    try {
      const winner = await Promise.race([execution, expired]);
      return winner === "deadline" ? deadlineResult(dispatch, this.ports.now()) : winner;
    } finally {
      clearTimeout(timer);
    }
  }

  private afterGovernedResult(missionId: string, operationId: string, applied: ApplyResult): AdvanceResult {
    const current = () => this.store.require(missionId);
    switch (applied.applied) {
      case "completed":
      case "awaiting_verification":
        return this.result(current(), true);
      case "failed":
      case "retryable": {
        // A changed environment (the legacy "conflict") needs reconciliation; any other failure needs an operator.
        const unit = this.store.workUnits(missionId).find((candidate) => candidate.unitId === operationId);
        return this.degrade(
          current(),
          unit?.failureCategory === "environment_changed" ? "reconciliation_required" : "operation_failed"
        );
      }
      case "unknown":
        return this.result(current(), false, "unknown_operation");
      case "cancelled":
        return this.result(current(), false, "operation_cancelled");
      case "duplicate":
        return this.result(current(), false, "duplicate_result");
      default:
        return this.result(current(), false, applied.applied);
    }
  }

  private async recoverOperation(mission: CodingMissionRecord, operation: CodingOperation): Promise<AdvanceResult> {
    const unsafe = (detail: Record<string, unknown>, code: string, degrade = false): AdvanceResult => {
      this.store.escalateRecovery(
        mission.missionId,
        operation.operationId,
        "recovery_unsafe",
        detail,
        this.ports.now()
      );
      return degrade ? this.degrade(mission, code) : this.result(mission, false, code);
    };

    // Fence the stale holder at the executor before looking: if it were still able to start, "absent" would prove nothing.
    let fenced = false;
    if (this.ports.coder.fence && operation.claimToken) {
      const fence = await this.ports.coder.fence({
        mission,
        operationId: operation.operationId,
        claimToken: operation.claimToken
      });
      if (fence.status !== "succeeded") return unsafe({ reason: "fence_failed", status: fence.status }, "fence_failed");
      fenced = true;
    }

    const observed = await this.ports.coder.observe({
      mission,
      operationId: operation.operationId,
      ...(operation.claimToken ? { claimToken: operation.claimToken } : {})
    });
    if (observed.status === "unknown") {
      // The executor cannot say whether the operation ran. Retrying could repeat a side effect, so an operator is told.
      return unsafe({ observed: "unknown" }, "unknown_operation");
    }
    if (observed.status === "absent") {
      // Without the claim token there is no fence to release, so a stale worker could not be shut out.
      if (!operation.claimToken) return unsafe({ reason: "claim_has_no_fence" }, "recovery_unsafe", true);
      // Absence only proves the operation did not run if the old holder cannot run it now: either the executor fenced it,
      // or the operation is declared idempotent. Otherwise this is not proven safe, and nothing is retried.
      if (!fenced && this.ports.coder.idempotent !== true) {
        return unsafe({ reason: "executor_cannot_fence" }, "recovery_unsafe");
      }
      const claimToken = operation.claimToken;
      // One commit: the unit's failure and the mission's degradation. A crash between them would leave a RUNNING mission
      // with a failed unit that later resumes as "dependency_blocked", losing the poison_work diagnosis.
      return this.store.transaction(() => {
        const decision = this.store.releaseStaleClaim(
          mission.missionId,
          operation.operationId,
          claimToken,
          this.ports.now(),
          this.ports.recoveryPolicy
        );
        if (decision.outcome === "poisoned") return this.degrade(this.store.require(mission.missionId), "poison_work");
        return this.result(this.store.require(mission.missionId), true, "operation_absent");
      });
    }
    if (observed.status === "succeeded" && observed.value) {
      const token = operation.claimToken ?? "reconciled";
      if (!operation.claimToken) {
        this.store.db
          .prepare(`UPDATE coding_operations SET claim_token = ? WHERE mission_id = ? AND operation_id = ?`)
          .run(token, mission.missionId, operation.operationId);
      }
      this.store.completeOperation(mission.missionId, operation.operationId, token, observed.value);
      return this.result(this.store.require(mission.missionId), true, "operation_reconciled");
    }
    return this.degrade(mission, observed.code ?? "operation_rejected");
  }

  private acceptCoderResult(
    mission: CodingMissionRecord,
    operationId: string,
    token: string,
    executed: ExternalOutcome<{ resultHash: string; files: string[] }>
  ): AdvanceResult {
    if (executed.status === "succeeded" && executed.value) {
      this.store.completeOperation(mission.missionId, operationId, token, executed.value);
      return this.result(this.store.require(mission.missionId), true);
    }
    if (executed.code === "conflict") {
      this.store.markOperation(mission.missionId, operationId, "conflict");
      return this.degrade(this.store.require(mission.missionId), "reconciliation_required");
    }
    this.store.markOperation(mission.missionId, operationId, "unknown");
    return this.result(this.store.require(mission.missionId), false, "unknown_operation");
  }

  private async reconcile(mission: CodingMissionRecord): Promise<AdvanceResult> {
    const operations = this.store.operations(mission.missionId);
    const reconciled = await this.ports.reconciler.reconcile({ mission, operations });
    if (reconciled.status === "unknown") return this.degrade(mission, "unknown_reconciliation");
    if (reconciled.status !== "succeeded" || !reconciled.value) {
      return this.degrade(mission, reconciled.code ?? "reconciliation_required");
    }
    if (reconciled.value.conflicts.length > 0) return this.degrade(mission, "reconciliation_required");
    if (!SHA.test(reconciled.value.headSha)) {
      throw new ControlStackError("coding_mission_head_invalid", "reconciled head SHA is invalid");
    }
    const next = this.store.transition(mission, "VALIDATING", this.ports.now(), {
      event: "coding_mission.validating",
      headSha: reconciled.value.headSha
    });
    return this.result(next, true);
  }

  private async validate(mission: CodingMissionRecord): Promise<AdvanceResult> {
    if (!mission.headSha) return this.degrade(mission, "missing_head");
    const validated = await this.ports.validator.validate({ mission, headSha: mission.headSha });
    if (validated.status === "unknown") return this.degrade(mission, "unknown_validation");
    if (validated.status !== "succeeded" || !validated.value) {
      return this.fail(mission, validated.code ?? "validation_failed");
    }
    const checks = validated.value.checks;
    for (const name of REQUIRED_CHECKS) {
      if (checks[name] !== "PASS" && checks[name] !== "FAIL") {
        return this.fail(mission, "validation_incomplete");
      }
    }
    if (REQUIRED_CHECKS.some((name) => checks[name] !== "PASS")) return this.fail(mission, "validation_failed");
    const next = this.store.transition(mission, "PREPARING_CHANGE_SET", this.ports.now(), {
      event: "coding_mission.preparing_change_set",
      validation: validated.value
    });
    this.store.putEvidence(mission.missionId, "validation", validated.value, this.ports.now());
    return this.result(next, true);
  }

  private prepare(mission: CodingMissionRecord): AdvanceResult {
    const operations = this.store.operations(mission.missionId);
    if (operations.some((operation) => operation.status !== "succeeded" || !operation.resultHash)) {
      return this.fail(mission, "missing_operation_evidence");
    }
    this.store.putEvidence(
      mission.missionId,
      "change_set_content",
      codingChangeSetHash({ ...mission, prNumber: undefined, prUrl: undefined }, operations),
      this.ports.now()
    );
    const next = this.store.transition(mission, "PUBLISHING_PROPOSAL", this.ports.now(), {
      event: "coding_mission.publishing"
    });
    return this.result(next, true);
  }

  private async publish(mission: CodingMissionRecord): Promise<AdvanceResult> {
    const published = await this.externalEffect(mission, "pull_request", {
      call: () => this.ports.publisher.publish({ mission, headSha: mission.headSha ?? "" }),
      observe: () => this.ports.publisher.observe({ mission })
    });
    if (published.status === "unknown") return this.result(mission, false, "unknown_pr");
    if (published.status !== "succeeded" || !published.value)
      return this.fail(mission, published.code ?? "publication_failed");
    const current = this.store.require(mission.missionId);
    const withPr: CodingMissionRecord = {
      ...current,
      prNumber: published.value.prNumber,
      prUrl: published.value.prUrl,
      headSha: published.value.headSha
    };
    const operations = this.store.operations(mission.missionId);
    const changeSetHash = codingChangeSetHash(withPr, operations);
    const waiting = this.store.transition(current, "WAITING_FOR_APPROVAL", this.ports.now(), {
      event: "coding_mission.waiting_for_approval",
      headSha: published.value.headSha,
      prNumber: published.value.prNumber,
      prUrl: published.value.prUrl,
      changeSetHash,
      body: { changeSetHash, prNumber: published.value.prNumber, branch: mission.branch }
    });
    return this.applyGrant(waiting);
  }

  private applyGrant(mission: CodingMissionRecord): AdvanceResult {
    if (!mission.changeSetHash) return this.fail(mission, "missing_change_set");
    const grant = this.ports.authorityGrant?.covers(mission, mission.changeSetHash);
    if (!grant) return this.result(mission, false);
    const approved = this.recordApproval(mission.missionId, {
      grantId: grant.grantId,
      expectedChangeSetHash: mission.changeSetHash
    });
    return this.result(approved, true);
  }

  private beginExecution(mission: CodingMissionRecord): AdvanceResult {
    const next = this.store.transition(mission, "EXECUTING", this.ports.now(), { event: "coding_mission.executing" });
    this.ports.onTransition?.("APPROVED", "EXECUTING", mission.missionId);
    return this.result(next, true);
  }

  private async execute(mission: CodingMissionRecord): Promise<AdvanceResult> {
    const fresh = this.store.require(mission.missionId);
    const operations = this.store.operations(fresh.missionId);
    const hash = codingChangeSetHash(fresh, operations);
    if (!fresh.approvedChangeSetHash || hash !== fresh.approvedChangeSetHash) {
      return this.degrade(fresh, "stale_approval");
    }
    const liveBase = await this.ports.baseObserver.currentBaseSha(fresh.repository, fresh.baseRef);
    if (liveBase !== fresh.baseSha) return this.degrade(fresh, "stale_base");
    const permit = await this.ports.admission.acquire(fresh);
    if ("denied" in permit) {
      if (permit.denied === "capacity") return this.result(fresh, false, "admission_deferred");
      return this.fail(fresh, "policy_denied");
    }
    const merged = await this.externalEffect(fresh, "merge", {
      call: () => this.ports.merger.merge({ mission: fresh }),
      observe: () => this.ports.merger.observe({ mission: fresh })
    });
    if (merged.status === "unknown") return this.result(this.store.require(fresh.missionId), false, "unknown_merge");
    if (merged.status !== "succeeded" || !merged.value) {
      const current = this.store.require(fresh.missionId);
      if (merged.code === "stale_head") return this.degrade(current, "stale_head");
      return this.fail(current, merged.code ?? "merge_failed");
    }
    let current = this.store.require(fresh.missionId);
    if (fresh.deploymentRequired) {
      const deployed = await this.externalEffect(current, "deployment", {
        call: () => this.ports.deployer.deploy({ mission: current, mergeSha: merged.value!.mergeSha }),
        observe: () => this.ports.deployer.observe({ mission: current })
      });
      if (deployed.status === "unknown")
        return this.result(this.store.require(fresh.missionId), false, "unknown_deployment");
      if (deployed.status !== "succeeded" || !deployed.value) {
        return this.fail(this.store.require(fresh.missionId), deployed.code ?? "deployment_failed");
      }
      current = this.store.transition(current, "VERIFYING", this.ports.now(), {
        event: "coding_mission.verifying",
        mergeSha: merged.value.mergeSha,
        deploymentId: deployed.value.deploymentId,
        body: { permitId: permit.permitId }
      });
      return this.result(current, true);
    }
    current = this.store.transition(current, "VERIFYING", this.ports.now(), {
      event: "coding_mission.verifying",
      mergeSha: merged.value.mergeSha,
      body: { permitId: permit.permitId }
    });
    return this.result(current, true);
  }

  private async verify(mission: CodingMissionRecord): Promise<AdvanceResult> {
    const fresh = this.store.require(mission.missionId);
    const operations = this.store.operations(fresh.missionId);
    if (operations.some((operation) => operation.status !== "succeeded" || !operation.resultHash)) {
      return this.fail(fresh, "missing_operation_evidence");
    }
    const existing = this.store.evidence<{ passed: boolean; checks: Record<string, string> }>(
      fresh.missionId,
      "verification"
    );
    const verification = existing ?? (await this.ports.verifier.verify({ mission: fresh, operations }));
    if (!existing) this.store.putEvidence(fresh.missionId, "verification", verification, this.ports.now());
    if (!verification.passed) return this.fail(fresh, "verification_failed");
    if (fresh.deploymentRequired && !fresh.deploymentId) return this.fail(fresh, "missing_deployment_evidence");
    if (!fresh.mergeSha) return this.fail(fresh, "missing_merge_evidence");
    if (this.store.effect(fresh.missionId, "completion")?.outcome === "succeeded") {
      return this.result(fresh, false);
    }
    const reserved = this.store.reserveEffect(fresh.missionId, "completion");
    if (reserved === "succeeded") return this.result(this.store.require(fresh.missionId), false);
    const completed = this.store.transition(fresh, "COMPLETED", this.ports.now(), {
      event: "coding_mission.completed",
      body: { changeSetHash: fresh.changeSetHash, mergeSha: fresh.mergeSha, deploymentId: fresh.deploymentId }
    });
    this.store.succeedEffect(completed.missionId, "completion", completed.missionId, {
      mergeSha: completed.mergeSha,
      deploymentId: completed.deploymentId ?? null
    });
    return this.result(completed, true);
  }

  private async externalEffect<T extends { [key: string]: unknown }>(
    mission: CodingMissionRecord,
    kind: string,
    ports: {
      call: () => Promise<ExternalOutcome<T>>;
      observe: () => Promise<ExternalOutcome<T>>;
    }
  ): Promise<ExternalOutcome<T>> {
    const reserved = this.store.reserveEffect(mission.missionId, kind);
    if (reserved === "succeeded") {
      const saved = this.store.effect(mission.missionId, kind);
      return succeeded((saved?.detail ?? {}) as T);
    }
    if (reserved === "unknown") {
      const observed = await ports.observe();
      if (observed.status === "succeeded" && observed.value) {
        this.store.succeedEffect(mission.missionId, kind, externalId(observed.value), observed.value);
        return observed;
      }
      if (observed.status !== "absent") return { status: "unknown", ...(observed.code ? { code: observed.code } : {}) };
      this.store.clearEffect(mission.missionId, kind);
      return this.externalEffect(mission, kind, ports);
    }
    const called = await ports.call();
    if (called.status === "succeeded" && called.value) {
      this.store.succeedEffect(mission.missionId, kind, externalId(called.value), called.value);
    } else if (called.status === "rejected") {
      this.store.clearEffect(mission.missionId, kind);
    }
    return called;
  }

  private degrade(mission: CodingMissionRecord, code: string): AdvanceResult {
    if (mission.state === "DEGRADED" && mission.failureCode === code) return this.result(mission, false, code);
    const next = this.store.transition(mission, "DEGRADED", this.ports.now(), {
      event: "coding_mission.degraded",
      failureCode: code,
      body: { code }
    });
    return this.result(next, true, code);
  }

  private fail(mission: CodingMissionRecord, code: string): AdvanceResult {
    const next = this.store.transition(mission, "FAILED", this.ports.now(), {
      event: "coding_mission.failed",
      failureCode: code,
      body: { code }
    });
    return this.result(next, true, code);
  }

  private result(mission: CodingMissionRecord, progressed: boolean, code?: string): AdvanceResult {
    return {
      missionId: mission.missionId,
      state: mission.state,
      version: mission.version,
      progressed,
      ...(mission.changeSetHash ? { changeSetHash: mission.changeSetHash } : {}),
      ...(code ? { code } : {})
    };
  }
}

function externalId(value: { prNumber?: number; mergeSha?: string; deploymentId?: string }): string {
  return String(value.prNumber ?? value.mergeSha ?? value.deploymentId ?? "effect");
}

function hasCycle(operations: ReadonlyArray<{ operationId: string; dependsOn: string[] }>): boolean {
  const graph = new Map(operations.map((operation) => [operation.operationId, operation.dependsOn]));
  const visiting = new Set<string>();
  const visited = new Set<string>();
  const walk = (id: string): boolean => {
    if (visited.has(id)) return false;
    if (visiting.has(id)) return true;
    visiting.add(id);
    for (const dependency of graph.get(id) ?? []) {
      if (walk(dependency)) return true;
    }
    visiting.delete(id);
    visited.add(id);
    return false;
  };
  return operations.some((operation) => walk(operation.operationId));
}

export { succeeded };
