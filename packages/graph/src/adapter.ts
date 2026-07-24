import type { GraphNodeDefinition, JsonValue } from "./contract.js";

export interface NodeAdapterContext {
  runId: string;
  graphId: string;
  graphHash: string;
  node: GraphNodeDefinition;
  input: JsonValue | undefined;
  parameters: Record<string, JsonValue>;
  inputs: Record<string, JsonValue[]>;
  inputHash: string;
  attemptNumber: number;
  signal: AbortSignal;
}

export interface NodeAdapter {
  readonly adapterId: string;
  readonly sideEffectFree: boolean;
  execute(context: NodeAdapterContext): Promise<unknown>;
}

export interface FakeNodeAdapterOptions {
  delaysMs?: Readonly<Record<string, number>>;
  behaviors?: Readonly<Record<string, readonly FakeNodeBehavior[]>>;
}

export type FakeNodeBehavior =
  | { kind: "success"; result?: unknown }
  | { kind: "failure"; message?: string; result?: unknown }
  | { kind: "retryable-failure"; message?: string; result?: unknown }
  | { kind: "timeout"; delayMs?: number }
  | { kind: "duplicate-delivery"; result?: unknown };

export interface FakeNodeCall {
  nodeId: string;
  input: JsonValue | undefined;
  inputHash: string;
  inputs: Record<string, JsonValue[]>;
  attemptNumber: number;
  startedAt: string;
  finishedAt: string | null;
}

/**
 * Test-only deterministic adapter admitted by graph v0.1.
 *
 * Results and delays are cloned declarative data. Executable callbacks are
 * intentionally unsupported; callback-driven adapters live only in test helpers
 * and are never admitted by StaticGraphScheduler.
 */
export class FakeNodeAdapter implements NodeAdapter {
  readonly adapterId = "fake";
  readonly sideEffectFree = true;
  readonly calls: FakeNodeCall[] = [];
  readonly invocationCounts: Record<string, number> = Object.create(null) as Record<string, number>;
  maxObservedConcurrency = 0;
  private active = 0;
  private readonly results: Readonly<Record<string, unknown>>;
  private readonly delaysMs: Readonly<Record<string, number>>;
  private readonly behaviors: Readonly<Record<string, readonly FakeNodeBehavior[]>>;

  constructor(results: Readonly<Record<string, unknown>>, options: FakeNodeAdapterOptions = {}) {
    assertDeclarativeResults(results);
    assertDeclarativeBehaviors(options.behaviors ?? {});
    this.results = structuredClone(results);
    this.delaysMs = validateDelays(options.delaysMs ?? {}, new Set(Object.keys(results)));
    this.behaviors = structuredClone(options.behaviors ?? {});
  }

  async execute(context: NodeAdapterContext): Promise<unknown> {
    if (!Object.prototype.hasOwnProperty.call(this.results, context.node.id)) {
      throw new Error(`no fake result declared for node ${context.node.id}`);
    }
    const invocationNumber = (this.invocationCounts[context.node.id] ?? 0) + 1;
    this.invocationCounts[context.node.id] = invocationNumber;
    const call: FakeNodeCall = {
      nodeId: context.node.id,
      input: context.input === undefined ? undefined : structuredClone(context.input),
      inputHash: context.inputHash,
      inputs: structuredClone(context.inputs),
      attemptNumber: context.attemptNumber,
      startedAt: new Date().toISOString(),
      finishedAt: null
    };
    this.calls.push(call);
    this.active += 1;
    this.maxObservedConcurrency = Math.max(this.maxObservedConcurrency, this.active);
    try {
      const behavior = behaviorFor(this.behaviors[context.node.id], invocationNumber);
      if (behavior?.kind === "timeout") {
        await abortableDelay(Math.max(behavior.delayMs ?? 1_000, context.node.timeoutMs + 100), context.signal);
        throw new Error(`fake timeout completed unexpectedly for node ${context.node.id}`);
      }
      const delayMs = this.delaysMs[context.node.id] ?? 0;
      if (delayMs > 0) {
        await abortableDelay(delayMs, context.signal);
      }
      if (context.signal.aborted) {
        throw new Error(`fake execution aborted for node ${context.node.id}`);
      }
      if (behavior?.kind === "failure" || behavior?.kind === "retryable-failure") {
        if (behavior.result !== undefined) {
          return structuredClone(behavior.result);
        }
        return {
          status: "FAILED",
          output: {},
          evidence: [],
          assumptions: [],
          confidence: 1,
          unresolved: [behavior.message ?? `fake ${behavior.kind}`],
          retryable: behavior.kind === "retryable-failure",
          usage: { inputTokens: 0, outputTokens: 0, costUsd: 0, durationMs: 1 }
        };
      }
      if (behavior?.result !== undefined) {
        return structuredClone(behavior.result);
      }
      return structuredClone(this.results[context.node.id]);
    } finally {
      this.active -= 1;
      call.finishedAt = new Date().toISOString();
    }
  }

  /** Execute the same declarative delivery twice for direct duplicate-delivery tests. */
  async duplicateDelivery(context: NodeAdapterContext): Promise<[unknown, unknown]> {
    const first = await this.execute(context);
    const second = await this.execute(context);
    return [structuredClone(first), structuredClone(second)];
  }
}

function assertDeclarativeResults(results: Readonly<Record<string, unknown>>): void {
  try {
    structuredClone(results);
  } catch {
    throw new TypeError("fake results must contain only cloneable declarative data");
  }
}

function validateDelays(
  input: Readonly<Record<string, number>>,
  declaredNodes: ReadonlySet<string>
): Readonly<Record<string, number>> {
  for (const [nodeId, delayMs] of Object.entries(input)) {
    if (!declaredNodes.has(nodeId)) {
      throw new TypeError(`fake delay references undeclared node ${nodeId}`);
    }
    if (!Number.isInteger(delayMs) || delayMs < 0 || delayMs > 86_400_000) {
      throw new TypeError(`fake delay for ${nodeId} must be an integer between 0 and 86400000`);
    }
  }
  return structuredClone(input);
}

function assertDeclarativeBehaviors(behaviors: Readonly<Record<string, readonly FakeNodeBehavior[]>>): void {
  try {
    structuredClone(behaviors);
  } catch {
    throw new TypeError("fake behaviors must contain only cloneable declarative data");
  }
  for (const [nodeId, nodeBehaviors] of Object.entries(behaviors)) {
    if (!Array.isArray(nodeBehaviors)) {
      throw new TypeError(`fake behavior sequence for ${nodeId} must be an array`);
    }
    for (const behavior of nodeBehaviors) {
      if (
        !behavior ||
        typeof behavior !== "object" ||
        !["success", "failure", "retryable-failure", "timeout", "duplicate-delivery"].includes(behavior.kind)
      ) {
        throw new TypeError(`fake behavior for ${nodeId} is invalid`);
      }
      if (
        behavior.kind === "timeout" &&
        behavior.delayMs !== undefined &&
        (!Number.isInteger(behavior.delayMs) || behavior.delayMs < 1 || behavior.delayMs > 86_400_000)
      ) {
        throw new TypeError(`fake timeout for ${nodeId} must be an integer between 1 and 86400000`);
      }
    }
  }
}

function behaviorFor(
  behaviors: readonly FakeNodeBehavior[] | undefined,
  invocationNumber: number
): FakeNodeBehavior | undefined {
  if (!behaviors || behaviors.length === 0) return undefined;
  return behaviors[Math.min(invocationNumber - 1, behaviors.length - 1)];
}

function abortableDelay(milliseconds: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal.aborted) {
      reject(new Error("fake execution aborted"));
      return;
    }
    const onAbort = (): void => {
      clearTimeout(timeout);
      reject(new Error("fake execution aborted"));
    };
    const timeout = setTimeout(() => {
      signal.removeEventListener("abort", onAbort);
      resolve();
    }, milliseconds);
    signal.addEventListener("abort", onAbort, { once: true });
  });
}
