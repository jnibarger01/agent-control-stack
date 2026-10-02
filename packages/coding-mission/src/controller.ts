import { randomUUID } from "node:crypto";
import { NIMBLE_ROUTING_ALGORITHM_VERSION } from "@agent-control-stack/actor-router";
import { ControlStackError, stableHash } from "@agent-control-stack/shared";
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
    }): Promise<ExternalOutcome<{ resultHash: string; files: string[] }>>;
    observe(input: {
      mission: CodingMissionRecord;
      operationId: string;
    }): Promise<ExternalOutcome<{ resultHash: string; files: string[] }>>;
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

  constructor(
    dbOrPath: string | CodingMissionStore,
    private readonly ports: CodingMissionPorts
  ) {
    this.store = dbOrPath instanceof CodingMissionStore ? dbOrPath : new CodingMissionStore(dbOrPath);
  }

  close(): void {
    this.store.close();
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
    const ready = operations
      .filter(
        (operation) =>
          operation.status === "pending" &&
          operation.dependsOn.every(
            (dependency) => operations.find((candidate) => candidate.operationId === dependency)?.status === "succeeded"
          )
      )
      .sort((left, right) => left.operationId.localeCompare(right.operationId));
    const nextOperation = ready[0];
    if (!nextOperation) return this.degrade(mission, "dependency_blocked");
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
    const executed = await this.ports.coder.execute({
      mission,
      operationId: nextOperation.operationId,
      workerId: route.workerId
    });
    return this.acceptCoderResult(mission, nextOperation.operationId, token, executed);
  }

  private async recoverOperation(mission: CodingMissionRecord, operation: CodingOperation): Promise<AdvanceResult> {
    const observed = await this.ports.coder.observe({ mission, operationId: operation.operationId });
    if (observed.status === "unknown") return this.result(mission, false, "unknown_operation");
    if (observed.status === "absent") {
      this.store.resetClaim(mission.missionId, operation.operationId);
      return this.result(this.store.require(mission.missionId), true, "operation_absent");
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
