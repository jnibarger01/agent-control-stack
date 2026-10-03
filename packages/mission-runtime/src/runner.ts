import {
  AdmissionError,
  ExecutionAdmissionScheduler,
  type ExecutionAdmissionController
} from "@agent-control-stack/execution-admission";
import { ControlStackError } from "@agent-control-stack/shared";
import { SqliteWorkItemStore } from "@agent-control-stack/work-items";
import { assertReadyToComplete } from "./completion.js";
import { deriveMissionProgress, type MissionProgress } from "./progress.js";
import {
  admissionLaneFor,
  admissionToolFor,
  type DeploymentAuthorization,
  type DeploymentController,
  type LiveReleaseObserver,
  type MissionRouter,
  type MutationApplier,
  type OperationExecutor,
  type OperationReconciler,
  type ProductionObserver
} from "./ports.js";
import { changeSetDigest, deploymentOperationIdentity, executionIdentity, MissionStore } from "./store.js";
import { assertSupportedVerification, evaluateVerification } from "./verification.js";
import type { CreateMissionInput, MissionSnapshot, MissionStatus, OperationRecord } from "./types.js";

export interface MissionRuntimeOptions {
  dbPath: string;
  workerId: string;
  router: MissionRouter;
  executor: OperationExecutor;
  reconciler: OperationReconciler;
  applier: MutationApplier;
  deploymentAuthorization?: DeploymentAuthorization;
  deploymentController?: DeploymentController;
  liveReleaseObserver?: LiveReleaseObserver;
  observer?: ProductionObserver;
  admission?: ExecutionAdmissionController;
  workItems?: SqliteWorkItemStore;
  clock?: () => Date;
  leaseTtlMs?: number;
  onStage?: (stage: string) => void;
}

const RUNNABLE = new Set(["PENDING", "READY", "ROUTED", "ADMITTED"]);

export class MissionRuntime {
  readonly store: MissionStore;
  private readonly options: MissionRuntimeOptions;
  private readonly admission: ExecutionAdmissionController;
  private readonly ownsAdmission: boolean;
  private readonly workItems: SqliteWorkItemStore;
  private readonly ownsWorkItems: boolean;
  private mutex: Promise<void> = Promise.resolve();

  constructor(options: MissionRuntimeOptions) {
    this.options = options;
    this.store = new MissionStore(options.dbPath);
    this.ownsAdmission = options.admission === undefined;
    this.admission = options.admission ?? new ExecutionAdmissionScheduler();
    this.ownsWorkItems = options.workItems === undefined;
    this.workItems = options.workItems ?? new SqliteWorkItemStore(options.dbPath);
  }

  close(): void {
    if (this.ownsAdmission) this.admission.shutdown();
    this.store.close();
    if (this.ownsWorkItems) this.workItems.close();
  }

  resumable(): string[] {
    return this.store.listResumableMissionIds();
  }

  progress(missionId: string): MissionProgress {
    return deriveMissionProgress(this.store.snapshot(missionId));
  }

  createMission(input: CreateMissionInput): MissionSnapshot {
    this.assertPlan(input);
    const now = this.iso();
    const workItem = this.workItems.create({
      title: input.intent.slice(0, 180),
      requester: "system",
      requesterSubject: "mission-runtime",
      intent: input.intent,
      target: {
        repo: input.target.repo,
        cwd: input.target.cwd,
        services: input.target.system ? [input.target.system] : undefined
      },
      requestedActions: [
        {
          kind: input.requiresMutation ? "mission.mutate" : "mission.execute",
          description: input.intent.slice(0, 500),
          params: { mutation: input.requiresMutation }
        }
      ],
      risk: input.requiresMutation ? "high" : "low"
    });
    const snapshot = this.store.insertMission(input, workItem.id, now);
    return snapshot;
  }

  async advance(missionId: string): Promise<MissionProgress> {
    const run = this.mutex.then(() => this.advanceUnlocked(missionId));
    this.mutex = run.then(
      () => undefined,
      () => undefined
    );
    return run;
  }

  async resumeAll(): Promise<MissionProgress[]> {
    const progress: MissionProgress[] = [];
    for (const missionId of this.resumable()) progress.push(await this.advance(missionId));
    return progress;
  }

  recordHumanDecision(
    missionId: string,
    approverId: string,
    decision: "approved" | "rejected",
    reason: string
  ): MissionSnapshot {
    if (!approverId.trim() || approverId === this.options.workerId || approverId === "mission-runtime") {
      throw new ControlStackError(
        "approval_actor_rejected",
        "mission approval requires a human approver distinct from the runtime"
      );
    }
    const snapshot = this.store.snapshot(missionId);
    const head = this.headChangeSet(snapshot);
    if (!head || head.status === "invalidated") {
      throw new ControlStackError("change_set_missing", "approval requires the current change set");
    }
    const now = this.iso();
    if (decision === "rejected") {
      this.store.recordApproval(
        {
          missionId,
          workItemId: snapshot.mission.workItemId,
          changeSetId: head.changeSetId,
          changeSetHash: head.changeSetHash,
          decision: "rejected",
          approverId
        },
        now
      );
      this.move(
        missionId,
        "FAILED",
        { failureCode: "operator_rejection", failureReason: reason },
        `mission.failed:operator_rejection`
      );
      return this.store.snapshot(missionId);
    }
    const grant = this.workItems.recordApproval({
      workItemId: snapshot.mission.workItemId,
      actionHash: head.changeSetHash,
      approvedBy: approverId,
      reason,
      expiresInMs: 24 * 60 * 60 * 1000
    });
    this.store.recordApproval(
      {
        missionId,
        workItemId: snapshot.mission.workItemId,
        changeSetId: head.changeSetId,
        changeSetHash: head.changeSetHash,
        decision: "approved",
        approverId,
        requestHash: grant.requestHash
      },
      now
    );
    this.move(
      missionId,
      "APPROVED",
      { changeSetHash: head.changeSetHash, approverId },
      `mission.approved:${head.changeSetHash}`
    );
    this.stage("after_approval");
    return this.store.snapshot(missionId);
  }

  supersedeMutation(missionId: string, mutation: Record<string, unknown>): void {
    const now = this.iso();
    this.store.replaceProposedMutation(missionId, mutation, now);
    const status = this.store.snapshot(missionId).mission.status;
    if (status === "APPROVED" || status === "READY_FOR_CHANGE_SET") {
      this.move(
        missionId,
        "WAITING_FOR_APPROVAL",
        { reason: "change_set_superseded" },
        `mission.approval_invalidated:${now}`
      );
    }
  }

  private async advanceUnlocked(missionId: string): Promise<MissionProgress> {
    const initial = this.store.snapshot(missionId);
    if (
      initial.mission.status === "COMPLETED" ||
      initial.mission.status === "FAILED" ||
      initial.mission.status === "CANCELLED"
    ) {
      return deriveMissionProgress(initial);
    }
    this.store.recoverExpired(missionId, this.iso());
    const resumable: MissionStatus[] = ["PLANNED", "BLOCKED", "WAITING_FOR_RESULT", "WAITING_FOR_RECONCILIATION"];
    const status = this.store.snapshot(missionId).mission.status;
    if (resumable.includes(status)) {
      this.move(missionId, "RUNNING", { reason: "runner", from: status }, `mission.running:${status}:${this.iso()}`);
    }
    await this.reconcile(missionId);
    await this.dispatchReady(missionId);
    await this.finishTail(missionId);
    return this.progress(missionId);
  }

  private async reconcile(missionId: string): Promise<void> {
    const snapshot = this.store.snapshot(missionId);
    for (const operation of snapshot.operations) {
      if (operation.status !== "UNKNOWN" || !operation.executionId) continue;
      const inspection = await this.options.reconciler.inspect(operation.executionId);
      const now = this.iso();
      if (inspection.kind === "running") {
        this.store.noteReconciliation(operation.operationId, "running", now);
        this.move(
          missionId,
          "WAITING_FOR_RESULT",
          { operationId: operation.operationId },
          `mission.wait_result:${operation.operationId}`
        );
        continue;
      }
      if (inspection.kind === "completed") {
        this.store.noteReconciliation(operation.operationId, "completed", now);
        const stored = this.store.persistResult(
          operation.operationId,
          operation.claimToken ?? "",
          inspection.payload,
          now,
          inspection.observations ?? {}
        );
        await this.verifyOperation(stored, inspection.observations ?? {});
        continue;
      }
      if (inspection.kind === "not_started") {
        this.store.prepareRetry(operation.operationId, now);
        continue;
      }
      this.store.noteReconciliation(operation.operationId, "unavailable", now);
      this.store.markOperationTerminal(
        operation.operationId,
        "BLOCKED",
        "reconciliation_required",
        "executor state is unavailable",
        now
      );
      this.store.block(
        missionId,
        "reconciliation_required",
        `operation ${operation.operationId} cannot be reconciled`,
        now
      );
    }
  }

  private async dispatchReady(missionId: string): Promise<void> {
    const stalled = new Set<string>();
    for (;;) {
      const snapshot = this.store.snapshot(missionId);
      if (
        snapshot.mission.status === "FAILED" ||
        snapshot.mission.status === "BLOCKED" ||
        snapshot.mission.status === "COMPLETED"
      )
        return;
      const byId = new Map(snapshot.operations.map((operation) => [operation.operationId, operation]));
      const verifying = snapshot.operations.find(
        (operation) => operation.status === "VERIFYING" && operation.resultHash
      );
      if (verifying) {
        await this.verifyOperation(verifying, verifying.observations ?? {});
        continue;
      }
      const next = snapshot.operations.find(
        (operation) => !stalled.has(operation.operationId) && this.runnable(operation, byId)
      );
      if (!next) return;
      if (next.status === "PENDING") this.store.markReady(next.operationId, this.iso());
      const fresh = this.store.snapshot(missionId).operations.find((item) => item.operationId === next.operationId);
      if (!fresh || !this.runnable({ ...fresh, status: fresh.status === "PENDING" ? "READY" : fresh.status }, byId)) {
        stalled.add(next.operationId);
        continue;
      }
      const before = `${fresh.status}:${fresh.attemptCount}:${fresh.resultHash ?? ""}`;
      await this.executeOperation(fresh.status === "PENDING" ? { ...fresh, status: "READY" } : fresh);
      const afterOp = this.store.snapshot(missionId).operations.find((item) => item.operationId === next.operationId);
      const after = afterOp ? `${afterOp.status}:${afterOp.attemptCount}:${afterOp.resultHash ?? ""}` : before;
      if (after === before) stalled.add(next.operationId);
    }
  }

  private runnable(operation: OperationRecord, byId: Map<string, OperationRecord>): boolean {
    if (!RUNNABLE.has(operation.status) || operation.resultHash) return false;
    return operation.dependencies.every((dependencyId) => byId.get(dependencyId)?.status === "SUCCEEDED");
  }

  private async executeOperation(operation: OperationRecord): Promise<void> {
    this.stage("before_route");
    let route: Awaited<ReturnType<MissionRouter["assign"]>>;
    try {
      route = await this.options.router.assign({
        missionId: operation.missionId,
        workItemId: this.store.snapshot(operation.missionId).mission.workItemId,
        operationId: operation.operationId,
        requiredCapabilities: operation.requiredCapabilities,
        lane: operation.lane
      });
    } catch {
      this.move(
        operation.missionId,
        "WAITING_FOR_RECONCILIATION",
        { operationId: operation.operationId, reason: "routing_assignment_unconfirmed" },
        `mission.route_reconcile:${operation.operationId}`
      );
      return;
    }
    if (route.kind !== "assigned") {
      this.store.markRouted(operation.operationId, route.evidence, this.iso());
      this.store.markOperationTerminal(
        operation.operationId,
        "BLOCKED",
        "routing_unresolved",
        route.reason,
        this.iso()
      );
      this.store.block(operation.missionId, "routing_unresolved", `no route for ${operation.operationId}`, this.iso());
      return;
    }
    this.store.markRouted(
      operation.operationId,
      {
        routingDecisionId: route.decisionId,
        selectedAgentId: route.selectedAgentId,
        selectedWorkerId: route.selectedWorkerId,
        source: route.source,
        model: route.model,
        confidence: route.confidence,
        threshold: route.threshold,
        ...route.evidence
      },
      this.iso()
    );
    this.stage("after_route");

    const executionId = operation.executionId ?? executionIdentity(operation.missionId, operation.operationId);
    const controller = new AbortController();
    let permit;
    try {
      permit = await this.admission.acquire({
        requestId: executionId,
        lane: admissionLaneFor(operation.lane),
        executorId: route.selectedWorkerId,
        actorId: route.selectedAgentId,
        toolName: admissionToolFor(operation.lane),
        executionClass: "execution",
        enqueuedAt: this.now().getTime(),
        deadlineAt: this.now().getTime() + 30_000,
        signal: controller.signal
      });
    } catch (error) {
      const reason = error instanceof AdmissionError ? error.code : "admission_rejected";
      this.store.markAdmitted(operation.operationId, reason, false, this.iso());
      return;
    }
    this.store.markAdmitted(operation.operationId, permit.permitId, true, this.iso());
    try {
      this.stage("before_dispatch");
      const expiresAt = new Date(this.now().getTime() + (this.options.leaseTtlMs ?? 30_000)).toISOString();
      const claim = this.store.claim(operation.operationId, this.options.workerId, expiresAt, this.iso());
      if (!claim.claimed || !claim.operation.claimToken) return;
      this.stage("after_claim");
      const dispatched = this.store.markDispatched(
        operation.operationId,
        claim.operation.claimToken,
        this.options.workerId,
        executionId,
        this.iso()
      );
      this.stage("after_dispatch");
      let outcome;
      try {
        outcome = await this.options.executor.dispatch({
          missionId: operation.missionId,
          operationId: operation.operationId,
          executionId,
          lane: operation.lane,
          attempt: dispatched.attemptCount,
          operationType: operation.operationType,
          assignment: route
        });
      } catch (error) {
        this.store.markUnknown(
          operation.operationId,
          claim.operation.claimToken,
          error instanceof Error ? error.message : "dispatch failed without a result",
          this.iso()
        );
        this.move(
          operation.missionId,
          "WAITING_FOR_RECONCILIATION",
          { operationId: operation.operationId },
          `mission.reconcile:${operation.operationId}`
        );
        return;
      }
      await this.handleOutcome(dispatched, claim.operation.claimToken, outcome);
    } finally {
      permit.release();
    }
  }

  private async handleOutcome(
    operation: OperationRecord,
    claimToken: string,
    outcome: Awaited<ReturnType<OperationExecutor["dispatch"]>>
  ): Promise<void> {
    const now = this.iso();
    if (outcome.kind === "unknown") {
      this.store.markUnknown(operation.operationId, claimToken, outcome.reason, now);
      this.move(
        operation.missionId,
        "WAITING_FOR_RECONCILIATION",
        { operationId: operation.operationId },
        `mission.unknown:${operation.operationId}`
      );
      return;
    }
    if (outcome.kind === "fatal_failure") {
      this.store.markOperationTerminal(operation.operationId, "FAILED", "execution_failure", outcome.reason, now);
      this.store.fail(operation.missionId, "execution_failure", outcome.reason, now);
      return;
    }
    if (outcome.kind === "retryable_failure") {
      const current = this.store
        .snapshot(operation.missionId)
        .operations.find((item) => item.operationId === operation.operationId)!;
      const retryable =
        current.mutationClass === "none" &&
        current.retryPolicy === "safe_retry" &&
        current.attemptCount < current.maxAttempts;
      if (!retryable) {
        this.store.markOperationTerminal(
          operation.operationId,
          "FAILED",
          "retryable_execution_failure",
          outcome.reason,
          now
        );
        this.store.fail(operation.missionId, "retryable_execution_failure", outcome.reason, now);
        return;
      }
      this.store.requeue(operation.operationId, claimToken, now);
      return;
    }
    const stored = this.store.persistResult(
      operation.operationId,
      claimToken,
      outcome.payload,
      now,
      outcome.observations ?? {}
    );
    this.stage("after_result");
    await this.verifyOperation(stored, outcome.observations ?? {});
  }

  private async verifyOperation(operation: OperationRecord, observations: Record<string, string>): Promise<void> {
    const outcomes = evaluateVerification(
      operation.verification,
      observations,
      operation.resultHash ?? operation.operationId
    );
    const now = this.iso();
    for (const outcome of outcomes) {
      this.store.recordVerification(operation.missionId, operation.operationId, "operation", outcome, now);
    }
    this.stage("after_validation");
    if (outcomes.some((outcome) => outcome.outcome === "unsupported")) {
      this.store.markOperationTerminal(
        operation.operationId,
        "FAILED",
        "unsupported_verification",
        "required verification is not supported",
        now
      );
      this.store.fail(
        operation.missionId,
        "unsupported_verification",
        `operation ${operation.operationId} verification is unsupported`,
        now
      );
      return;
    }
    if (outcomes.some((outcome) => outcome.outcome !== "passed")) {
      this.store.markOperationTerminal(
        operation.operationId,
        "FAILED",
        "verification_failure",
        "verification did not match the expected condition",
        now
      );
      this.store.fail(
        operation.missionId,
        "verification_failure",
        `operation ${operation.operationId} failed verification`,
        now
      );
      return;
    }
    this.store.markOperationTerminal(operation.operationId, "SUCCEEDED", null, null, now);
  }

  private async finishTail(missionId: string): Promise<void> {
    let snapshot = this.store.snapshot(missionId);
    if (
      snapshot.mission.status === "COMPLETED" ||
      snapshot.mission.status === "FAILED" ||
      snapshot.mission.status === "CANCELLED"
    )
      return;
    if (snapshot.operations.some((operation) => operation.status === "FAILED" || operation.status === "BLOCKED")) {
      if (snapshot.operations.some((operation) => operation.status === "FAILED")) {
        this.store.fail(
          missionId,
          snapshot.mission.failureCode ?? "execution_failure",
          snapshot.mission.failureReason ?? "an operation failed",
          this.iso()
        );
      } else {
        this.store.block(
          missionId,
          snapshot.mission.failureCode ?? "mission_blocked",
          snapshot.mission.failureReason ?? "an operation is blocked",
          this.iso()
        );
      }
      return;
    }
    if (snapshot.operations.some((operation) => operation.status === "UNKNOWN")) {
      this.move(
        missionId,
        "WAITING_FOR_RECONCILIATION",
        { reason: "unknown outcome" },
        `mission.reconcile_wait:${missionId}`
      );
      return;
    }
    if (
      snapshot.operations.some((operation) =>
        ["CLAIMED", "DISPATCHED", "VERIFYING", "ROUTED", "ADMITTED"].includes(operation.status)
      )
    ) {
      this.store.noteAwaitingResult(missionId, this.iso());
      return;
    }
    if (!snapshot.operations.every((operation) => operation.status === "SUCCEEDED")) {
      this.move(missionId, "RUNNING", { reason: "work remains" }, `mission.running.remain:${missionId}`);
      return;
    }

    if (snapshot.mission.requiresMutation) {
      snapshot = this.ensureChangeSet(snapshot);
      this.stage("after_change_set");
      const head = this.headChangeSet(snapshot);
      const approval = head
        ? snapshot.approvals.find((item) => item.changeSetHash === head.changeSetHash && item.decision === "approved")
        : undefined;
      const alreadyApplied =
        head !== undefined &&
        snapshot.application?.status === "succeeded" &&
        snapshot.application.changeSetHash === head.changeSetHash;
      if (
        !alreadyApplied &&
        (!head || !approval || !this.workItems.hasApproval(snapshot.mission.workItemId, head.changeSetHash))
      ) {
        if (snapshot.mission.status !== "WAITING_FOR_APPROVAL") {
          this.move(
            missionId,
            "WAITING_FOR_APPROVAL",
            { changeSetHash: head?.changeSetHash },
            `mission.wait_approval:${head?.changeSetHash ?? "none"}`
          );
        }
        return;
      }
      if (snapshot.mission.status === "WAITING_FOR_APPROVAL") {
        this.move(
          missionId,
          "APPROVED",
          { changeSetHash: head.changeSetHash },
          `mission.approved.replay:${head.changeSetHash}`
        );
      }
      const applied = await this.applyChangeSet(this.store.snapshot(missionId), head.changeSetHash);
      if (!applied) return;
      snapshot = this.store.snapshot(missionId);
    }

    if (snapshot.mission.requiresDeployment) {
      const deployed = await this.deploy(this.store.snapshot(missionId));
      if (!deployed) return;
      snapshot = this.store.snapshot(missionId);
    }

    if (snapshot.mission.requiresProductionVerification) {
      const verified = await this.verifyProduction(this.store.snapshot(missionId));
      if (!verified) return;
    }

    this.stage("before_complete");
    const latest = this.store.snapshot(missionId);
    const rejection = safeRejection(latest);
    if (rejection) {
      if (
        rejection.code === "deployment_failure" ||
        rejection.code === "production_verification_failure" ||
        rejection.code === "verification_failure"
      ) {
        this.store.fail(missionId, rejection.code, rejection.reason, this.iso());
      } else {
        this.store.block(missionId, rejection.code, rejection.reason, this.iso());
      }
      return;
    }
    const seal = assertReadyToComplete(latest);
    try {
      this.store.complete(missionId, seal, this.iso());
    } catch (error) {
      if (
        error instanceof ControlStackError &&
        error.code === "mission_conflict" &&
        this.store.snapshot(missionId).mission.status === "COMPLETED"
      ) {
        return;
      }
      throw error;
    }
  }

  private ensureChangeSet(snapshot: MissionSnapshot): MissionSnapshot {
    const head = this.headChangeSet(snapshot);
    if (head && head.status !== "invalidated") return snapshot;
    const derivedFrom = snapshot.operations.map((operation) => ({
      operationId: operation.operationId,
      resultHash: operation.resultHash ?? ""
    }));
    const artifactHashes = snapshot.operations.flatMap((operation) => {
      const hashes = operation.result?.artifactHashes;
      return Array.isArray(hashes) ? hashes.filter((hash): hash is string => typeof hash === "string") : [];
    });
    const proposedMutation = snapshot.mission.proposedMutation ?? {};
    const changeSetHash = changeSetDigest({
      missionId: snapshot.mission.missionId,
      baseRevision: snapshot.mission.baseRevision,
      target: snapshot.mission.target,
      proposedMutation,
      derivedFrom,
      artifactHashes
    });
    const now = this.iso();
    if (
      snapshot.mission.status === "RUNNING" ||
      snapshot.mission.status === "VALIDATING" ||
      snapshot.mission.status === "BLOCKED"
    ) {
      this.move(
        snapshot.mission.missionId,
        "READY_FOR_CHANGE_SET",
        { changeSetHash },
        `mission.ready_change_set:${changeSetHash}`
      );
    }
    this.store.insertChangeSet(
      {
        missionId: snapshot.mission.missionId,
        generation: this.store.nextChangeSetGeneration(snapshot.mission.missionId),
        changeSetHash,
        derivedFrom,
        target: snapshot.mission.target,
        baseRevision: snapshot.mission.baseRevision,
        proposedMutation,
        validationEvidence: snapshot.verifications
          .filter((verification) => verification.stage === "operation" && verification.outcome === "passed")
          .map((verification) => ({
            operationId: verification.operationId,
            kind: verification.kind,
            outcome: verification.outcome,
            ...(verification.evidenceRef ? { evidenceRef: verification.evidenceRef } : {})
          })),
        artifactHashes,
        approvalRequired: true,
        status: "waiting_approval"
      },
      now
    );
    this.move(
      snapshot.mission.missionId,
      "WAITING_FOR_APPROVAL",
      { changeSetHash },
      `mission.wait_approval:${changeSetHash}`
    );
    return this.store.snapshot(snapshot.mission.missionId);
  }

  private async applyChangeSet(snapshot: MissionSnapshot, changeSetHash: string): Promise<boolean> {
    const head = this.headChangeSet(snapshot);
    if (!head || head.changeSetHash !== changeSetHash) return false;
    if (snapshot.application?.status === "succeeded" && snapshot.application.changeSetHash === changeSetHash)
      return true;
    if (!this.workItems.hasApproval(snapshot.mission.workItemId, changeSetHash)) return false;
    const now = this.iso();
    if (snapshot.application?.status === "unknown" || snapshot.application?.status === "started") {
      const inspection = await this.options.applier.inspect(snapshot.application.idempotencyKey);
      if (inspection.kind === "succeeded") {
        this.store.finishApplication(snapshot.mission.missionId, "succeeded", inspection.observedRevision, null, now);
        this.consume(snapshot.mission.workItemId, changeSetHash);
        this.stage("after_apply");
        return true;
      }
      if (inspection.kind === "unknown") {
        this.store.finishApplication(snapshot.mission.missionId, "unknown", null, "apply outcome unknown", now);
        this.move(
          snapshot.mission.missionId,
          "WAITING_FOR_RECONCILIATION",
          { changeSetHash },
          `mission.apply_unknown:${changeSetHash}`
        );
        return false;
      }
    }
    this.move(snapshot.mission.missionId, "APPLYING", { changeSetHash }, `mission.applying:${changeSetHash}`);
    const idempotencyKey = `apply_${changeSetHash}`;
    this.store.startApplication(
      snapshot.mission.missionId,
      head.changeSetId,
      changeSetHash,
      snapshot.mission.baseRevision,
      idempotencyKey,
      this.iso()
    );
    this.stage("after_apply_started");
    const outcome = await this.options.applier.apply({
      idempotencyKey,
      changeSetHash,
      expectedBaseRevision: snapshot.mission.baseRevision,
      mutation: head.proposedMutation
    });
    if (outcome.kind === "succeeded") {
      this.store.finishApplication(snapshot.mission.missionId, "succeeded", outcome.observedRevision, null, this.iso());
      this.consume(snapshot.mission.workItemId, changeSetHash);
      this.stage("after_apply");
      return true;
    }
    if (outcome.kind === "unknown") {
      this.store.finishApplication(snapshot.mission.missionId, "unknown", null, outcome.reason, this.iso());
      this.move(
        snapshot.mission.missionId,
        "WAITING_FOR_RECONCILIATION",
        { changeSetHash },
        `mission.apply_unknown:${changeSetHash}`
      );
      return false;
    }
    const code = outcome.kind === "diverged" ? "revision_diverged" : "apply_failed";
    this.store.finishApplication(snapshot.mission.missionId, "failed", null, outcome.reason, this.iso());
    this.store.fail(snapshot.mission.missionId, code, outcome.reason, this.iso());
    return false;
  }

  private async deploy(snapshot: MissionSnapshot): Promise<boolean> {
    const mission = snapshot.mission;
    if (!mission.deploymentTarget) {
      this.store.fail(mission.missionId, "deployment_failure", "deployment target is missing", this.iso());
      return false;
    }
    const head = this.headChangeSet(snapshot);
    const applied = snapshot.application;
    if (!head || !applied || applied.status !== "succeeded" || applied.changeSetHash !== head.changeSetHash) {
      this.store.fail(
        mission.missionId,
        "deployment_authority_missing",
        "deployment requires the currently approved Change Set to be durably applied",
        this.iso()
      );
      return false;
    }
    const releaseId = applied.observedRevision;
    if (!releaseId) {
      this.store.fail(
        mission.missionId,
        "deployment_release_missing",
        "applied release identity is missing",
        this.iso()
      );
      return false;
    }
    const { deploymentAuthorization, deploymentController, liveReleaseObserver } = this.options;
    if (!deploymentAuthorization || !deploymentController || !liveReleaseObserver) {
      this.store.block(
        mission.missionId,
        "deployment_authority_unavailable",
        "deployment authorization, controller, or independent release observer is unavailable",
        this.iso()
      );
      return false;
    }

    let operation = this.store.getDeploymentOperation(mission.missionId);
    if (operation) {
      if (operation.changeSetHash !== head.changeSetHash || operation.releaseId !== releaseId) {
        this.store.block(
          mission.missionId,
          "deployment_operation_superseded",
          "stored deployment operation does not match the current applied Change Set and release",
          this.iso()
        );
        return false;
      }
      if (operation.status === "SUCCEEDED" && operation.observedReleaseId === operation.releaseId) return true;
      if (operation.status === "FAILED") {
        this.store.fail(mission.missionId, "deployment_failure", "deployment operation previously failed", this.iso());
        return false;
      }

      // Any resumed operation, including PENDING, must be reconciled against
      // the independently observed running release before the controller runs.
      let observed: Awaited<ReturnType<LiveReleaseObserver["observe"]>>;
      try {
        observed = await liveReleaseObserver.observe();
      } catch {
        this.store.setDeploymentOperationStatus(mission.missionId, "UNKNOWN", null, null, this.iso());
        this.waitForDeploymentReconciliation(mission.missionId, operation.id);
        return false;
      }
      if (observed.releaseId === operation.releaseId) {
        this.store.setDeploymentOperationStatus(
          mission.missionId,
          "SUCCEEDED",
          observed.releaseId,
          observed.observedAt,
          this.iso()
        );
        this.stage("after_deploy_observed");
        return true;
      }
      this.store.setDeploymentOperationStatus(
        mission.missionId,
        "UNKNOWN",
        observed.releaseId,
        observed.observedAt,
        this.iso()
      );
      this.waitForDeploymentReconciliation(mission.missionId, operation.id);
      return false;
    }

    const approval = snapshot.approvals.find(
      (item) => item.changeSetHash === head.changeSetHash && item.decision === "approved"
    );
    if (!approval) {
      this.store.block(
        mission.missionId,
        "deployment_approval_missing",
        "deployment requires exact-hash human approval",
        this.iso()
      );
      return false;
    }
    const operationId = deploymentOperationIdentity(mission.missionId, head.changeSetHash, releaseId);
    let authorization: { requestedBy: string; permitId: string };
    try {
      authorization = await deploymentAuthorization.authorize({
        operationId,
        missionId: mission.missionId,
        changeSetId: head.changeSetId,
        changeSetHash: head.changeSetHash,
        releaseId,
        requestedBy: approval.approverId
      });
    } catch {
      this.store.block(
        mission.missionId,
        "deployment_permit_unavailable",
        "ACS did not issue a deployment permit",
        this.iso()
      );
      return false;
    }
    if (!authorization.permitId || authorization.requestedBy !== approval.approverId) {
      this.store.block(
        mission.missionId,
        "deployment_permit_invalid",
        "deployment permit identity is invalid",
        this.iso()
      );
      return false;
    }
    operation = this.store.createDeploymentOperation(
      {
        id: operationId,
        missionId: mission.missionId,
        changeSetHash: head.changeSetHash,
        releaseId,
        requestedBy: authorization.requestedBy,
        permitId: authorization.permitId
      },
      this.iso()
    );
    this.stage("after_deploy_intent");
    this.store.setDeploymentOperationStatus(mission.missionId, "EXECUTING", null, null, this.iso());
    this.stage("after_deploy_executing");
    let result: Awaited<ReturnType<DeploymentController["deploy"]>>;
    try {
      result = await deploymentController.deploy({
        operationId: operation.id,
        changeSetHash: operation.changeSetHash,
        releaseId: operation.releaseId,
        permitId: operation.permitId
      });
    } catch {
      result = { status: "unknown" };
    }
    this.stage("after_deploy_controller");
    if (result.status === "failed") {
      this.store.setDeploymentOperationStatus(mission.missionId, "FAILED", null, null, this.iso());
      this.store.fail(mission.missionId, "deployment_failure", result.reason, this.iso());
      return false;
    }
    if (result.status === "unknown") {
      this.store.setDeploymentOperationStatus(mission.missionId, "UNKNOWN", null, null, this.iso());
      this.waitForDeploymentReconciliation(mission.missionId, operation.id);
      return false;
    }
    let observed: Awaited<ReturnType<LiveReleaseObserver["observe"]>>;
    try {
      observed = await liveReleaseObserver.observe();
    } catch {
      this.store.setDeploymentOperationStatus(mission.missionId, "UNKNOWN", null, null, this.iso());
      this.waitForDeploymentReconciliation(mission.missionId, operation.id);
      return false;
    }
    const matching = observed.releaseId === operation.releaseId;
    this.store.setDeploymentOperationStatus(
      mission.missionId,
      matching ? "SUCCEEDED" : "UNKNOWN",
      observed.releaseId,
      observed.observedAt,
      this.iso()
    );
    this.stage("after_deploy_observed");
    if (!matching) this.waitForDeploymentReconciliation(mission.missionId, operation.id);
    return matching;
  }

  private waitForDeploymentReconciliation(missionId: string, operationId: string): void {
    this.move(
      missionId,
      "WAITING_FOR_RECONCILIATION",
      { deploymentOperationId: operationId },
      `mission.deploy_unknown:${operationId}`
    );
  }

  private async verifyProduction(snapshot: MissionSnapshot): Promise<boolean> {
    const mission = snapshot.mission;
    if (mission.status !== "VERIFYING_PRODUCTION") {
      this.move(
        mission.missionId,
        "VERIFYING_PRODUCTION",
        { reason: "production" },
        `mission.production:${mission.missionId}`
      );
    }
    const observer = this.options.observer;
    if (!observer) {
      this.store.block(
        mission.missionId,
        "production_observer_unavailable",
        "declared production verification cannot run without an observer",
        this.iso()
      );
      return false;
    }
    let failed = false;
    for (const requirement of mission.productionVerification) {
      const observed = await observer.observe({
        missionId: mission.missionId,
        kind: requirement.kind,
        expected: requirement.expected
      });
      const [outcome] = evaluateVerification(
        [requirement],
        { [requirement.kind]: observed.observed },
        snapshot.deployment?.observedVersion ?? mission.missionId
      );
      if (!outcome) continue;
      this.store.recordVerification(mission.missionId, "", "production", outcome, this.iso());
      if (outcome.outcome !== "passed") failed = true;
    }
    if (failed) {
      this.store.fail(
        mission.missionId,
        "production_verification_failure",
        "production verification did not match the expected target state",
        this.iso()
      );
      return false;
    }
    return true;
  }

  private consume(workItemId: string, actionHash: string): void {
    if (!this.workItems.hasApproval(workItemId, actionHash)) return;
    this.workItems.consumeApproval(workItemId, actionHash, this.now());
  }

  private headChangeSet(snapshot: MissionSnapshot) {
    return snapshot.changeSets.find((changeSet) => changeSet.changeSetId === snapshot.mission.changeSetId);
  }

  private move(missionId: string, to: MissionStatus, evidence: Record<string, unknown>, key: string): void {
    const current = this.store.snapshot(missionId).mission.status;
    if (current === to || current === "COMPLETED" || current === "FAILED" || current === "CANCELLED") return;
    try {
      this.store.transition(missionId, to, evidence, this.iso(), key);
    } catch (error) {
      if (!(error instanceof ControlStackError)) throw error;
      if (error.code === "mission_conflict") return;
      if (error.code === "invalid_mission_transition") {
        const live = this.store.snapshot(missionId).mission.status;
        if (live === to || live === "COMPLETED" || live === "FAILED" || live === "CANCELLED") return;
      }
      throw error;
    }
  }

  private stage(stage: string): void {
    this.options.onStage?.(stage);
  }

  private now(): Date {
    return this.options.clock?.() ?? new Date();
  }

  private iso(): string {
    return this.now().toISOString();
  }

  private assertPlan(input: CreateMissionInput): void {
    if (!input.intent.trim()) throw new ControlStackError("mission_plan_invalid", "intent is required");
    if (input.operations.length === 0)
      throw new ControlStackError("mission_plan_invalid", "a mission plan needs operations");
    const keys = new Set<string>();
    for (const operation of input.operations) {
      if (keys.has(operation.key))
        throw new ControlStackError("mission_plan_invalid", `duplicate operation ${operation.key}`);
      keys.add(operation.key);
      assertSupportedVerification(operation.verification, operation.key);
      if (operation.mutationClass !== "none" && operation.retryPolicy !== "fail_closed") {
        throw new ControlStackError(
          "mission_plan_invalid",
          `${operation.key} mutations fail closed on unproven replay`
        );
      }
    }
    for (const operation of input.operations) {
      for (const dependency of operation.dependencies) {
        if (!keys.has(dependency))
          throw new ControlStackError("mission_plan_invalid", `${operation.key} depends on unknown ${dependency}`);
      }
    }
    const visiting = new Set<string>();
    const visited = new Set<string>();
    const byKey = new Map(input.operations.map((operation) => [operation.key, operation]));
    const visit = (key: string): void => {
      if (visited.has(key)) return;
      if (visiting.has(key)) throw new ControlStackError("mission_plan_invalid", `operation cycle at ${key}`);
      visiting.add(key);
      for (const dependency of byKey.get(key)?.dependencies ?? []) visit(dependency);
      visiting.delete(key);
      visited.add(key);
    };
    for (const key of keys) visit(key);
    assertSupportedVerification(input.productionVerification ?? [], "production");
    if (input.requiresMutation && !input.proposedMutation) {
      throw new ControlStackError("mission_plan_invalid", "a mutation mission needs a proposed mutation");
    }
    if (input.requiresDeployment && !input.deploymentTarget) {
      throw new ControlStackError("mission_plan_invalid", "a deployment mission needs a deployment target");
    }
    if (input.requiresProductionVerification && (input.productionVerification ?? []).length === 0) {
      throw new ControlStackError("mission_plan_invalid", "production verification requirements are missing");
    }
  }
}

function safeRejection(snapshot: MissionSnapshot): { code: string; reason: string } | undefined {
  try {
    assertReadyToComplete(snapshot);
    return undefined;
  } catch (error) {
    if (error instanceof ControlStackError) return { code: error.code, reason: error.message };
    throw error;
  }
}

export async function resumeOpenMissions(runtime: MissionRuntime): Promise<MissionProgress[]> {
  return runtime.resumeAll();
}
