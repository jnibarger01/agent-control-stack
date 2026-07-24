import { randomUUID } from "node:crypto";
import { stableHash } from "@agent-control-stack/shared";
import {
  nodeExecutionResultSchema,
  graphJsonBoundsError,
  type JsonValue,
  redactGraphValue,
  redactJsonValue,
  type GraphDefinition,
  type GraphNodeDefinition,
  type GraphRunState,
  type NodeExecutionResult,
  validateJsonSchema
} from "./contract.js";
import { FakeNodeAdapter, type NodeAdapter, type NodeAdapterContext } from "./adapter.js";
import {
  GraphBudgetAdmissionError,
  GraphLedgerInvariantError,
  GraphLedgerWriteError,
  GraphSchedulerLeaseError,
  SqliteGraphLedger,
  isTerminalNodeState,
  type GraphNodeRecord,
  type GraphRunRecord,
  type RunLeaseToken
} from "./ledger.js";
import { resourcesConflict } from "./resources.js";
import { calculateGraphVerdict, type GraphVerdictAssessment } from "./verdict.js";
import { validateGraph, type ValidatedGraph } from "./validator.js";

export class GraphExecutionError extends Error {
  constructor(
    public readonly code: string,
    message: string
  ) {
    super(message);
    this.name = "GraphExecutionError";
  }
}

export interface GraphExecutionSummary extends GraphVerdictAssessment {
  runId: string;
  state: GraphRunState;
  nodes: GraphNodeRecord[];
}

export interface StaticGraphSchedulerOptions {
  ledger: SqliteGraphLedger;
  adapters: ReadonlyMap<string, NodeAdapter>;
  ownerId?: string;
  leaseTtlMs?: number;
}

type SchedulerLeaseGuard = () => RunLeaseToken;

export class StaticGraphScheduler {
  private readonly ledger: SqliteGraphLedger;
  private readonly adapters: ReadonlyMap<string, NodeAdapter>;
  private readonly adapterExecutors: ReadonlyMap<string, NodeAdapter["execute"]>;
  private readonly ownerId: string;
  private readonly leaseTtlMs: number;

  constructor(options: StaticGraphSchedulerOptions) {
    this.ledger = options.ledger;
    this.adapters = new Map(options.adapters);
    this.ownerId = options.ownerId ?? `scheduler-${randomUUID()}`;
    this.leaseTtlMs = options.leaseTtlMs ?? 30_000;
    if (this.ownerId.length < 1 || this.ownerId.length > 128) {
      throw new GraphExecutionError("INVALID_SCHEDULER_OWNER", "scheduler owner ID must contain 1 to 128 characters");
    }
    if (!Number.isSafeInteger(this.leaseTtlMs) || this.leaseTtlMs < 100) {
      throw new GraphExecutionError("INVALID_SCHEDULER_LEASE_TTL", "scheduler lease TTL must be at least 100ms");
    }
    for (const [key, adapter] of this.adapters) {
      if (key !== adapter.adapterId) {
        throw new GraphExecutionError(
          "ADAPTER_IDENTITY_MISMATCH",
          `adapter map key ${key} does not match ${adapter.adapterId}`
        );
      }
      if (
        key !== "fake" ||
        Object.getPrototypeOf(adapter) !== FakeNodeAdapter.prototype ||
        adapter.execute !== FakeNodeAdapter.prototype.execute ||
        (adapter as FakeNodeAdapter).duplicateDelivery !== FakeNodeAdapter.prototype.duplicateDelivery
      ) {
        throw new GraphExecutionError(
          "UNSUPPORTED_ADAPTER_IMPLEMENTATION",
          "graph v0.1 admits only the built-in inert fake adapter"
        );
      }
    }
    if (this.adapters.size !== 1 || !this.adapters.has("fake")) {
      throw new GraphExecutionError(
        "UNSUPPORTED_ADAPTER_IMPLEMENTATION",
        "graph v0.1 requires exactly one built-in fake adapter"
      );
    }
    this.adapterExecutors = new Map(
      [...this.adapters.entries()].map(([key, adapter]) => [key, adapter.execute.bind(adapter)])
    );
  }

  async start(input: unknown, options: { runId?: string } = {}): Promise<GraphExecutionSummary> {
    this.assertLedgerIntegrity();
    const graph = validateGraph(input, { allowedAdapters: new Set(this.adapters.keys()) });
    this.assertAdapterSafety(graph);
    const admission = this.ledger.createRunWithAdmission(graph, options.runId);
    const run = admission.run;
    const executionGraph =
      admission.decision === "DEDUPLICATED"
        ? validateGraph(run.definition, {
            allowedAdapters: new Set(this.adapters.keys()),
            allowRedacted: true
          })
        : graph;
    executionGraph.allowRedacted = admission.decision === "DEDUPLICATED";
    if (executionGraph.graphHash !== run.graphHash) {
      throw new GraphExecutionError(
        "GRAPH_HASH_MISMATCH",
        `admitted graph ${run.runId} does not match its persisted graph hash`
      );
    }
    this.assertPersistedIntegrity(executionGraph, run.runId);
    if (isTerminalNodeState(run.state)) {
      return this.summary(run.runId);
    }
    return this.withSchedulerLease(run.runId, async (assertLease) => {
      const lease = assertLease();
      const current = this.ledger.getRun(run.runId);
      if (current.state === "PENDING") {
        this.ledger.transitionRun(lease, "RUNNING", "scheduler started");
      } else if (current.state !== "RUNNING") {
        throw new GraphExecutionError("INVALID_RUN_STATE", `cannot start graph run ${run.runId} from ${current.state}`);
      }
      this.reconcileInterruptedNodes(run.runId, assertLease);
      this.assertPersistedIntegrity(executionGraph, run.runId);
      return this.execute(executionGraph, run.runId, assertLease);
    });
  }

  async resume(runId: string): Promise<GraphExecutionSummary> {
    this.assertLedgerIntegrity();
    const admittedRun = this.ledger.getRun(runId);
    const graph = validateGraph(admittedRun.definition, {
      allowedAdapters: new Set(this.adapters.keys()),
      allowRedacted: true
    });
    if (graph.graphHash !== admittedRun.graphHash) {
      throw new GraphExecutionError("GRAPH_HASH_MISMATCH", `persisted graph ${runId} does not match its admitted hash`);
    }
    this.assertAdapterSafety(graph);

    this.assertPersistedIntegrity(graph, runId);
    if (isTerminalNodeState(admittedRun.state)) return this.summary(runId);

    return this.withSchedulerLease(runId, async (assertLease) => {
      assertLease();
      const run = this.ledger.getRun(runId);
      if (isTerminalNodeState(run.state)) {
        return this.summary(runId);
      }
      if (run.state === "PENDING") {
        this.ledger.transitionRun(assertLease(), "RUNNING", "scheduler resumed pending run");
      } else if (run.state !== "RUNNING") {
        throw new GraphExecutionError("INVALID_RUN_STATE", `cannot resume graph run ${runId} from ${run.state}`);
      }

      this.reconcileInterruptedNodes(runId, assertLease);
      this.assertPersistedIntegrity(graph, runId);
      return this.execute(graph, runId, assertLease);
    });
  }

  private async execute(
    graph: ValidatedGraph,
    runId: string,
    assertLease: SchedulerLeaseGuard
  ): Promise<GraphExecutionSummary> {
    assertLease();
    const admittedAt = Date.parse(this.ledger.getRun(runId).createdAt);
    if (!Number.isFinite(admittedAt)) {
      throw new GraphLedgerInvariantError(`graph run ${runId} has an invalid admission timestamp`);
    }
    const deadline = admittedAt + graph.definition.limits.wallClockMs;
    const active = new Map<string, { node: GraphNodeDefinition; promise: Promise<void> }>();

    try {
      while (true) {
        assertLease();
        if (Date.now() >= deadline) {
          await Promise.allSettled([...active.values()].map((entry) => entry.promise));
          this.blockUnfinishedForGraphTimeout(runId, assertLease);
          break;
        }

        this.advancePendingNodes(graph.definition, runId, assertLease);
        const nodes = this.ledger.listNodes(runId);
        if (nodes.every((node) => isTerminalNodeState(node.state))) {
          break;
        }

        let stateChanged = false;
        const byId = new Map(nodes.map((node) => [node.nodeId, node]));
        for (const nodeId of graph.topologicalOrder) {
          if (active.size >= graph.definition.limits.maxWorkers) {
            break;
          }
          const state = byId.get(nodeId);
          const definition = graph.definition.nodes.find((node) => node.id === nodeId)!;
          if (state?.state !== "READY" || active.has(nodeId)) {
            continue;
          }
          if ([...active.values()].some((entry) => resourcesConflict(definition, entry.node))) {
            continue;
          }
          if (state.attemptCount >= definition.retry.maxAttempts) {
            this.ledger.transitionNode(assertLease(), nodeId, "BLOCKED", "attempt limit exhausted");
            stateChanged = true;
            continue;
          }
          assertLease();
          const promise = this.runNode(graph, runId, definition, deadline, assertLease).finally(() => {
            active.delete(nodeId);
          });
          active.set(nodeId, { node: definition, promise });
        }

        if (active.size === 0) {
          if (stateChanged) {
            continue;
          }
          if (nodes.some((node) => node.state === "READY")) {
            await this.waitForRetry(1, deadline, assertLease);
            continue;
          }
          throw new GraphExecutionError("SCHEDULER_DEADLOCK", `graph run ${runId} has no runnable or active nodes`);
        }
        await Promise.race([...active.values()].map((entry) => entry.promise));
      }
    } catch (error) {
      await Promise.allSettled([...active.values()].map((entry) => entry.promise));
      throw error;
    }

    assertLease();
    const assessment = calculateGraphVerdict(graph.definition, this.ledger.listNodes(runId));
    const finalState = runStateForVerdict(assessment.verdict);
    this.ledger.transitionRun(assertLease(), finalState, "verdict aggregated", {
      verdict: assessment.verdict,
      summary: assessment
    });
    return this.summary(runId);
  }

  private blockUnfinishedForGraphTimeout(runId: string, assertLease: SchedulerLeaseGuard): void {
    for (const node of this.ledger.listNodes(runId)) {
      if (node.state === "RUNNING") {
        const outcome = this.ledger.reconcileInterruptedNode(assertLease(), node.nodeId);
        if (outcome === "REQUEUED") {
          this.ledger.transitionNode(assertLease(), node.nodeId, "BLOCKED", "graph wall-clock limit reached");
        }
      } else if (node.state === "PENDING" || node.state === "READY") {
        this.ledger.transitionNode(assertLease(), node.nodeId, "BLOCKED", "graph wall-clock limit reached");
      }
    }
  }

  private reconcileInterruptedNodes(runId: string, assertLease: SchedulerLeaseGuard): void {
    for (const node of this.ledger.listNodes(runId)) {
      assertLease();
      if (node.state === "RUNNING") {
        this.ledger.reconcileInterruptedNode(assertLease(), node.nodeId);
      }
    }
  }

  private advancePendingNodes(definition: GraphDefinition, runId: string, assertLease: SchedulerLeaseGuard): void {
    while (true) {
      const nodes = this.ledger.listNodes(runId);
      const byId = new Map(nodes.map((node) => [node.nodeId, node]));
      let changed = false;
      for (const node of definition.nodes) {
        if (byId.get(node.id)?.state !== "PENDING") {
          continue;
        }
        const incoming = definition.edges.filter((edge) => edge.to.nodeId === node.id);
        if (!incoming.every((edge) => isTerminalNodeState(byId.get(edge.from.nodeId)!.state))) {
          continue;
        }
        const failedRequiredEdge = incoming.find(
          (edge) => edge.required && byId.get(edge.from.nodeId)!.state !== "SUCCEEDED"
        );
        const missingRequiredInput = node.inputs.find(
          (port) =>
            port.required &&
            !incoming.some((edge) => edge.to.port === port.name && byId.get(edge.from.nodeId)!.state === "SUCCEEDED")
        );
        if (failedRequiredEdge) {
          this.ledger.transitionNode(
            assertLease(),
            node.id,
            "BLOCKED",
            `required dependency ${failedRequiredEdge.from.nodeId} did not succeed`
          );
        } else if (missingRequiredInput) {
          this.ledger.transitionNode(
            assertLease(),
            node.id,
            "BLOCKED",
            `required input ${node.id}.${missingRequiredInput.name} has no successful source`
          );
        } else if (node.approval_required || node.approval === "HUMAN") {
          this.ledger.transitionNode(
            assertLease(),
            node.id,
            "BLOCKED",
            "approval required; graph v0.1 has no approval execution path"
          );
        } else {
          this.ledger.transitionNode(assertLease(), node.id, "READY", "dependencies satisfied");
        }
        changed = true;
      }
      if (!changed) {
        return;
      }
    }
  }

  private async runNode(
    graph: ValidatedGraph,
    runId: string,
    node: GraphNodeDefinition,
    graphDeadline: number,
    assertLease: SchedulerLeaseGuard
  ): Promise<void> {
    assertLease();
    const inputs = this.assembleInputs(graph.definition, runId, node);
    const schemaInput = node.dependencies.length === 0 && node.input !== undefined ? node.input : inputs;
    const inputSchemaError = validateJsonSchema(node.input_schema, schemaInput, "$", graph.allowRedacted);
    if (inputSchemaError) {
      this.ledger.transitionNode(
        assertLease(),
        node.id,
        "FAILED",
        `input for ${node.id} violates input_schema: ${inputSchemaError}`
      );
      return;
    }
    const inputHash = nodeInputHash(graph.graphHash, node, inputs);
    const predictedAttemptNumber = this.ledger.getNode(runId, node.id).attemptCount + 1;
    let attempt: ReturnType<SqliteGraphLedger["startAttempt"]>;
    try {
      attempt = this.ledger.startAttempt(assertLease(), node.id, inputHash, node.budget);
    } catch (error) {
      if (error instanceof GraphBudgetAdmissionError) {
        if (error.temporary) {
          await this.waitForRetry(1, graphDeadline, assertLease);
        } else {
          this.ledger.transitionNode(
            assertLease(),
            node.id,
            "BLOCKED",
            "maximum node budget could not be reserved atomically"
          );
        }
        return;
      }
      throw error;
    }
    if (attempt.attemptNumber !== predictedAttemptNumber) {
      throw new GraphLedgerInvariantError(`attempt number changed while starting ${runId}/${node.id}`);
    }

    const controller = new AbortController();
    let timeout: NodeJS.Timeout | undefined;
    try {
      const context: NodeAdapterContext = {
        runId,
        graphId: graph.definition.graphId,
        graphHash: graph.graphHash,
        node,
        input: node.input === undefined ? undefined : structuredClone(node.input),
        parameters: node.parameters as Record<string, JsonValue>,
        inputs,
        inputHash,
        attemptNumber: attempt.attemptNumber,
        signal: controller.signal
      };
      const remainingWallClockMs = Math.max(1, graphDeadline - Date.now());
      const effectiveTimeoutMs = Math.min(node.timeoutMs, remainingWallClockMs);
      const timeoutCode = remainingWallClockMs <= node.timeoutMs ? "GRAPH_TIMEOUT" : "NODE_TIMEOUT";
      const timeoutPromise = new Promise<never>((_, reject) => {
        timeout = setTimeout(() => {
          controller.abort();
          reject(
            new GraphExecutionError(
              timeoutCode,
              timeoutCode === "GRAPH_TIMEOUT"
                ? `graph wall-clock limit reached while running ${node.id}`
                : `node ${node.id} exceeded ${node.timeoutMs}ms`
            )
          );
        }, effectiveTimeoutMs);
      });
      const raw = await Promise.race([this.adapterExecutors.get(node.adapter)!(context), timeoutPromise]);
      assertLease();
      const rawBoundsError = graphJsonBoundsError(raw);
      if (rawBoundsError) {
        this.failAttempt(
          assertLease(),
          node.id,
          attempt.attemptId,
          "MALFORMED_RESULT",
          "adapter result exceeded the graph payload bounds"
        );
        return;
      }
      const parsed = nodeExecutionResultSchema.safeParse(raw);
      if (!parsed.success) {
        this.failAttempt(
          assertLease(),
          node.id,
          attempt.attemptId,
          "MALFORMED_RESULT",
          "adapter result failed schema validation"
        );
        return;
      }
      const result = parsed.data;
      const contractError = validateResultContract(node, result);
      if (contractError) {
        this.failAttempt(assertLease(), node.id, attempt.attemptId, "MALFORMED_RESULT", contractError);
        return;
      }
      if (resultExceedsReservation(node, result)) {
        this.ledger.completeAttempt({
          lease: assertLease(),
          nodeId: node.id,
          attemptId: attempt.attemptId,
          state: "FAILED",
          error: { code: "BUDGET_EXCEEDED", message: "reported usage exceeds the admitted node reservation" }
        });
        return;
      }
      const retryScheduled = this.ledger.completeAttempt({
        lease: assertLease(),
        nodeId: node.id,
        attemptId: attempt.attemptId,
        state: result.status,
        result,
        outputHash: stableHash(result.output),
        retryable: result.retryable
      });
      if (retryScheduled) {
        await this.waitForRetry(node.retry_policy.backoff_ms, graphDeadline, assertLease);
      }
    } catch (error) {
      if (
        error instanceof GraphSchedulerLeaseError ||
        error instanceof GraphLedgerInvariantError ||
        error instanceof GraphLedgerWriteError
      ) {
        throw error;
      }
      assertLease();
      const code =
        error instanceof GraphExecutionError && (error.code === "NODE_TIMEOUT" || error.code === "GRAPH_TIMEOUT")
          ? error.code
          : "ADAPTER_ERROR";
      const message =
        code === "NODE_TIMEOUT"
          ? "node timed out"
          : code === "GRAPH_TIMEOUT"
            ? "graph wall-clock limit reached"
            : "adapter execution failed";
      const retryScheduled = this.failAttempt(
        assertLease(),
        node.id,
        attempt.attemptId,
        code,
        message,
        code === "NODE_TIMEOUT" || code === "GRAPH_TIMEOUT"
      );
      if (retryScheduled) {
        await this.waitForRetry(node.retry_policy.backoff_ms, graphDeadline, assertLease);
      }
    } finally {
      if (timeout) {
        clearTimeout(timeout);
      }
    }
  }

  private failAttempt(
    lease: RunLeaseToken,
    nodeId: string,
    attemptId: string,
    code: string,
    message: string,
    retryable = false
  ): boolean {
    return this.ledger.completeAttempt({
      lease,
      nodeId,
      attemptId,
      state: "FAILED",
      error: { code, message },
      retryable
    });
  }

  private async waitForRetry(
    backoffMs: number,
    graphDeadline: number,
    assertLease: SchedulerLeaseGuard
  ): Promise<void> {
    if (backoffMs <= 0) return;
    const delayMs = Math.min(backoffMs, Math.max(0, graphDeadline - Date.now()));
    if (delayMs > 0) {
      await new Promise<void>((resolve) => {
        setTimeout(resolve, delayMs);
      });
    }
    assertLease();
  }

  private assembleInputs(
    definition: GraphDefinition,
    runId: string,
    node: GraphNodeDefinition
  ): Record<string, JsonValue[]> {
    const inputs: Record<string, JsonValue[]> = {};
    for (const port of node.inputs) {
      inputs[port.name] = [];
    }
    for (const edge of definition.edges.filter((candidate) => candidate.to.nodeId === node.id)) {
      const source = this.ledger.getNode(runId, edge.from.nodeId);
      if (source.state !== "SUCCEEDED") {
        continue;
      }
      const result = assertPersistedResult(source);
      const value = result.output[edge.from.port];
      if (value === undefined) {
        throw new GraphExecutionError(
          "PERSISTED_OUTPUT_MISSING",
          `persisted node ${source.nodeId} lacks output port ${edge.from.port}`
        );
      }
      inputs[edge.to.port]!.push(value as JsonValue);
    }
    return inputs;
  }

  private assertPersistedIntegrity(graph: ValidatedGraph, runId: string): void {
    for (const node of this.ledger.listNodes(runId)) {
      const definition = graph.definition.nodes.find((candidate) => candidate.id === node.nodeId)!;
      if (node.result === null) {
        if (node.state === "SUCCEEDED" || node.outputHash !== null) {
          throw new GraphExecutionError(
            "PERSISTED_RESULT_INVALID",
            `persisted result for ${runId}/${node.nodeId} failed integrity checks`
          );
        }
        continue;
      }
      const parsed = nodeExecutionResultSchema.safeParse(node.result);
      if (
        !parsed.success ||
        parsed.data.status !== node.state ||
        validateResultContract(definition, parsed.data, graph.allowRedacted) ||
        node.outputHash !== stableHash(parsed.data.output)
      ) {
        throw new GraphExecutionError(
          "PERSISTED_RESULT_INVALID",
          `persisted result for ${runId}/${node.nodeId} failed integrity checks`
        );
      }
    }
    for (const attempt of this.ledger.listAttempts(runId)) {
      const definition = graph.definition.nodes.find((candidate) => candidate.id === attempt.nodeId)!;
      const inputs = this.assembleInputs(graph.definition, runId, definition);
      const expectedInputHash = nodeInputHash(graph.graphHash, definition, inputs);
      if (attempt.inputHash !== expectedInputHash) {
        throw new GraphExecutionError(
          "PERSISTED_INPUT_INVALID",
          `persisted input for ${runId}/${attempt.nodeId} attempt ${attempt.attemptNumber} failed integrity checks`
        );
      }
      if (attempt.result !== null) {
        const parsed = nodeExecutionResultSchema.safeParse(attempt.result);
        if (
          !parsed.success ||
          parsed.data.status !== attempt.state ||
          validateResultContract(definition, parsed.data, graph.allowRedacted) ||
          attempt.outputHash !== stableHash(parsed.data.output)
        ) {
          throw new GraphExecutionError(
            "PERSISTED_RESULT_INVALID",
            `persisted result for ${runId}/${attempt.nodeId} attempt ${attempt.attemptNumber} failed integrity checks`
          );
        }
      } else if (attempt.state === "SUCCEEDED" || attempt.outputHash !== null) {
        throw new GraphExecutionError(
          "PERSISTED_RESULT_INVALID",
          `persisted result for ${runId}/${attempt.nodeId} attempt ${attempt.attemptNumber} failed integrity checks`
        );
      }
    }
  }

  private async withSchedulerLease<T>(
    runId: string,
    operation: (assertLease: SchedulerLeaseGuard) => Promise<T>
  ): Promise<T> {
    const { lease } = this.ledger.acquireSchedulerLease(runId, this.ownerId, this.leaseTtlMs);
    let heartbeatFailure: unknown;
    const heartbeat = setInterval(
      () => {
        try {
          this.ledger.heartbeatSchedulerLease(runId, this.ownerId, lease.leaseEpoch, this.leaseTtlMs);
        } catch (error) {
          heartbeatFailure = error;
        }
      },
      Math.max(25, Math.floor(this.leaseTtlMs / 3))
    );
    heartbeat.unref();

    const token: RunLeaseToken = { runId, ownerId: this.ownerId, epoch: lease.leaseEpoch };
    const assertLease = (): RunLeaseToken => {
      if (heartbeatFailure) {
        if (heartbeatFailure instanceof Error) {
          throw heartbeatFailure;
        }
        throw new GraphSchedulerLeaseError(
          `scheduler owner ${this.ownerId}/${lease.leaseEpoch} lost graph run ${runId}`
        );
      }
      this.ledger.assertSchedulerLease(runId, this.ownerId, lease.leaseEpoch);
      return token;
    };

    try {
      return await operation(assertLease);
    } finally {
      clearInterval(heartbeat);
      const current = this.ledger.getSchedulerLease(runId);
      if (
        current?.ownerId === this.ownerId &&
        current.leaseEpoch === lease.leaseEpoch &&
        current.expiresAt > new Date().toISOString()
      ) {
        this.ledger.releaseSchedulerLease(token);
      }
    }
  }

  private assertAdapterSafety(graph: ValidatedGraph): void {
    for (const node of graph.definition.nodes) {
      const adapter = this.adapters.get(node.adapter)!;
      if ((node.sideEffect === "WRITE" || node.sideEffect === "EXTERNAL") && !adapter.sideEffectFree) {
        throw new GraphExecutionError(
          "LIVE_SIDE_EFFECT_ADAPTER_DISABLED",
          `graph v0.1 does not execute write-capable adapter ${node.adapter}`
        );
      }
    }
  }

  private assertLedgerIntegrity(): void {
    const verification = this.ledger.verifyTransitionChain();
    if (!verification.valid) {
      throw new GraphExecutionError(
        "LEDGER_INTEGRITY_FAILURE",
        `graph transition chain failed at record ${verification.checked}`
      );
    }
  }

  private summary(runId: string): GraphExecutionSummary {
    const run: GraphRunRecord = this.ledger.getRun(runId);
    const nodes = this.ledger.listNodes(runId);
    const assessment = calculateGraphVerdict(run.definition, nodes);
    return {
      runId,
      state: run.state,
      nodes,
      ...assessment
    };
  }
}

function resultExceedsReservation(node: GraphNodeDefinition, result: NodeExecutionResult): boolean {
  return (
    result.usage.inputTokens + result.usage.outputTokens > node.budget.maxTokens ||
    result.usage.costUsd > node.budget.maxCostUsd
  );
}

function assertPersistedResult(node: GraphNodeRecord): NodeExecutionResult {
  const parsed = nodeExecutionResultSchema.safeParse(node.result);
  if (!parsed.success || parsed.data.status !== "SUCCEEDED") {
    throw new GraphExecutionError(
      "PERSISTED_RESULT_INVALID",
      `persisted result for ${node.runId}/${node.nodeId} is invalid`
    );
  }
  return parsed.data;
}

function validateResultContract(
  node: GraphNodeDefinition,
  result: NodeExecutionResult,
  allowRedacted = false
): string | null {
  const outputNames = Object.keys(result.output).sort();
  const declaredOutputNames = node.outputs.map((port) => port.name).sort();
  if (result.status === "SUCCEEDED" && JSON.stringify(outputNames) !== JSON.stringify(declaredOutputNames)) {
    return `successful result output ports do not match node ${node.id}`;
  }
  if (result.status === "SUCCEEDED") {
    const schemaError = validateJsonSchema(node.output_schema, result.output, "$", allowRedacted);
    if (schemaError) {
      return `successful result for ${node.id} violates output_schema: ${schemaError}`;
    }
  }
  if (result.status !== "SUCCEEDED" && outputNames.length > 0) {
    return `non-success result for ${node.id} must not claim outputs`;
  }
  if (result.status === "SUCCEEDED") {
    const evidenceKinds = new Set(result.evidence.map((evidence) => evidence.kind));
    const missingEvidence = node.evidenceRequirements.find((kind) => !evidenceKinds.has(kind));
    if (missingEvidence) {
      return `successful result for ${node.id} lacks required evidence ${missingEvidence}`;
    }
  }
  return null;
}

function nodeInputHash(graphHash: string, node: GraphNodeDefinition, inputs: Record<string, JsonValue>): string {
  const payload: Record<string, unknown> = {
    graphHash,
    nodeId: node.id,
    parameters: redactGraphValue(node.parameters),
    inputs: redactGraphValue(inputs)
  };
  if (node.input !== undefined) {
    payload.input = redactJsonValue(node.input);
  }
  return stableHash(payload);
}

function runStateForVerdict(verdict: GraphVerdictAssessment["verdict"]): GraphRunState {
  if (verdict === "PASS") {
    return "SUCCEEDED";
  }
  if (verdict === "BLOCK") {
    return "BLOCKED";
  }
  return "FAILED";
}
