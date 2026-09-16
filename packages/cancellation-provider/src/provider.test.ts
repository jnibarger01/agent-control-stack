import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import {
  defaultExecutionPlanForWorkItem,
  SqliteWorkItemStore,
  type AuthenticatedCodexSwarmCancellation
} from "@agent-control-stack/work-items";
import { describe, expect, it } from "vitest";
import {
  createProtectedCancellationProviderCapability,
  type ProtectedCancellationProviderAdapter,
  type ProtectedCancellationProviderSession,
  type ProviderLifecycleGuard
} from "./provider-internal.js";
import {
  CancellationProviderError,
  bootstrapTrustedCancellationProvider,
  bootstrapTrustedCancellationProviderInternal,
  productionCancellationProviderAdapterIds,
  type MonotonicWallClock,
  type OpaquePeerContext,
  type ProviderBootstrapDescriptorV1,
  type ProviderFailureV1,
  type ProviderHealthV1,
  type ProviderSessionEpoch,
  type ProviderVerifyInputV1,
  type VerifiedCancellationPrincipalV1
} from "./provider.js";

const hash = (character: string): string => character.repeat(64);

function deferred(): { promise: Promise<void>; resolve: () => void } {
  let resolve!: () => void;
  const promise = new Promise<void>((complete) => {
    resolve = complete;
  });
  return { promise, resolve };
}

class MutableClock implements MonotonicWallClock {
  private wallMs: number;
  private monotonicMs = 0;

  constructor(iso: string) {
    this.wallMs = Date.parse(iso);
  }

  now(): Date {
    return new Date(this.wallMs);
  }

  monotonicNowMs(): number {
    return this.monotonicMs;
  }

  advance(ms: number): void {
    this.wallMs += ms;
    this.monotonicMs += ms;
  }

  jumpWall(ms: number): void {
    this.wallMs += ms;
  }

  advanceMonotonic(ms: number): void {
    this.monotonicMs += ms;
  }
}

interface SymbolicOptions {
  credentialLifetimeMs?: number;
  lifecycleGate?: Promise<void>;
  sessionBindingHash?: string;
  state?: ProviderHealthV1["state"];
  verifyGate?: Promise<void>;
  zeroizationConfirmed?: boolean;
}

class SymbolicProviderSession implements ProtectedCancellationProviderSession {
  readonly providerId = "symbolic-provider";
  readonly adapterId = "test-only/symbolic";
  readonly sessionEpoch = Object.freeze({}) as ProviderSessionEpoch;

  private readonly clock: MutableClock;
  private readonly credentialLifetimeMs: number;
  private readonly lifecycleGate: Promise<void> | undefined;
  private readonly sessionBindingHash: string;
  private readonly verifyGate: Promise<void> | undefined;
  private readonly zeroizationConfirmed: boolean;
  private readonly revokedGenerations = new Set<number>();
  private readonly lifecycleDrainWaiters: Array<() => void> = [];
  private state: ProviderHealthV1["state"];
  private activeGeneration = 1;
  private activeLifecycleGuards = 0;
  private lifecycleChangePending = false;
  private previousGeneration: { generation: number; overlapEndsAt: string } | undefined;

  constructor(clock: MutableClock, options: SymbolicOptions = {}) {
    this.clock = clock;
    this.credentialLifetimeMs = options.credentialLifetimeMs ?? 60_000;
    this.lifecycleGate = options.lifecycleGate;
    this.sessionBindingHash = options.sessionBindingHash ?? hash("e");
    this.state = options.state ?? "ready";
    this.verifyGate = options.verifyGate;
    this.zeroizationConfirmed = options.zeroizationConfirmed ?? true;
  }

  async health(): Promise<ProviderHealthV1> {
    return {
      schemaVersion: "acs.provider-health.v1",
      state: this.state,
      ...(this.state === "ready" ? { activeGeneration: this.activeGeneration } : {})
    };
  }

  async verify(input: ProviderVerifyInputV1): Promise<VerifiedCancellationPrincipalV1 | ProviderFailureV1> {
    if (this.state !== "ready") return { schemaVersion: "acs.provider-failure.v1", kind: "unavailable" };
    const principal = {
      schemaVersion: "acs.verified-cancellation-principal.v1",
      principalId: "actor-canceller",
      credentialProviderId: this.providerId,
      verificationMethod: "symbolic-peer",
      authnAt: input.now,
      credentialExpiresAt: new Date(Date.parse(input.now) + this.credentialLifetimeMs).toISOString(),
      providerGeneration: this.activeGeneration,
      proofBindingHash: hash("b"),
      sessionEpoch: this.sessionEpoch
    } as const;
    await this.verifyGate;
    return principal;
  }

  snapshot() {
    return {
      state: this.state,
      ...(this.state === "ready" ? { activeGeneration: this.activeGeneration } : {}),
      ...(this.previousGeneration === undefined ? {} : { previousGeneration: { ...this.previousGeneration } }),
      revokedGenerations: new Set(this.revokedGenerations),
      sessionEpochBindingHash: this.sessionBindingHash
    };
  }

  acquireLifecycleGuard(): ProviderLifecycleGuard | undefined {
    if (this.lifecycleChangePending) return undefined;
    this.activeLifecycleGuards += 1;
    let released = false;
    return {
      snapshot: this.snapshot(),
      release: () => {
        if (released) return;
        released = true;
        this.activeLifecycleGuards -= 1;
        if (this.activeLifecycleGuards === 0) {
          for (const resolve of this.lifecycleDrainWaiters.splice(0)) resolve();
        }
      }
    };
  }

  private async beginLifecycleChange(): Promise<void> {
    this.lifecycleChangePending = true;
    if (this.activeLifecycleGuards > 0) {
      await new Promise<void>((resolve) => this.lifecycleDrainWaiters.push(resolve));
    }
    await this.lifecycleGate;
  }

  private endLifecycleChange(): void {
    this.lifecycleChangePending = false;
  }

  async beginRotation() {
    await this.beginLifecycleChange();
    try {
      const oldGeneration = this.activeGeneration;
      this.activeGeneration += 1;
      const activatedAt = this.clock.now().toISOString();
      const overlapEndsAt = new Date(this.clock.now().getTime() + 30_000).toISOString();
      this.previousGeneration = { generation: oldGeneration, overlapEndsAt };
      return { oldGeneration, activeGeneration: this.activeGeneration, activatedAt, overlapEndsAt };
    } finally {
      this.endLifecycleChange();
    }
  }

  async revoke(generation: number | "all"): Promise<void> {
    await this.beginLifecycleChange();
    try {
      if (generation === "all") {
        this.revokedGenerations.add(this.activeGeneration);
        if (this.previousGeneration !== undefined) this.revokedGenerations.add(this.previousGeneration.generation);
        this.state = "revoked";
        return;
      }
      this.revokedGenerations.add(generation);
      if (generation === this.activeGeneration) this.state = "revoked";
    } finally {
      this.endLifecycleChange();
    }
  }

  async closeAndZeroize(_deadlineMs: 5000): Promise<Readonly<{ closed: true; zeroizationConfirmed: true }>> {
    this.state = "closed";
    return { closed: true, zeroizationConfirmed: this.zeroizationConfirmed } as Readonly<{
      closed: true;
      zeroizationConfirmed: true;
    }>;
  }
}

class SymbolicAdapter implements ProtectedCancellationProviderAdapter {
  readonly adapterId = "test-only/symbolic";
  readonly testOnly = true;
  readonly session: SymbolicProviderSession;

  constructor(clock: MutableClock, options: SymbolicOptions = {}) {
    this.session = new SymbolicProviderSession(clock, options);
  }

  async open(_descriptor: ProviderBootstrapDescriptorV1): Promise<ProtectedCancellationProviderSession> {
    return this.session;
  }
}

const descriptor: ProviderBootstrapDescriptorV1 = Object.freeze({
  schemaVersion: "acs.trusted-cancellation-provider.v1",
  providerId: "symbolic-provider",
  adapterId: "test-only/symbolic",
  audience: "acs-cancellation",
  operation: "cancel",
  contextTtlSeconds: 30,
  maxClockSkewSeconds: 2,
  rotationOverlapSeconds: 30,
  startupTimeoutMs: 5000
});

const verifyInput = (clock: MutableClock): ProviderVerifyInputV1 => ({
  schemaVersion: "acs.provider-verify-input.v1",
  peerContext: Object.freeze({}) as OpaquePeerContext,
  audience: "acs-cancellation",
  operation: "cancel",
  canonicalRequestHash: hash("a"),
  requestIdHash: hash("c"),
  now: clock.now().toISOString()
});

async function bootstrapSymbolic(clock: MutableClock, options: SymbolicOptions = {}) {
  const adapter = new SymbolicAdapter(clock, options);
  const capability = createProtectedCancellationProviderCapability(adapter);
  const runtime = await bootstrapTrustedCancellationProviderInternal(descriptor, capability, clock, true);
  return { adapter, capability, runtime };
}

async function issueBinding(clock: MutableClock, options: SymbolicOptions = {}) {
  const bootstrapped = await bootstrapSymbolic(clock, options);
  const principal = await bootstrapped.runtime.verify(verifyInput(clock));
  if ("kind" in principal) throw new Error(`unexpected provider failure: ${principal.kind}`);
  const binding = bootstrapped.runtime.sealCurrentBinding(principal, {
    contextHash: hash("d"),
    issuedAt: clock.now().toISOString(),
    expiresAt: new Date(clock.now().getTime() + 30_000).toISOString()
  });
  return { ...bootstrapped, binding, principal };
}

async function cancellableFixture(clock: MutableClock, options: SymbolicOptions) {
  const issued = await issueBinding(clock, options);
  const directory = mkdtempSync(join(tmpdir(), "acs-provider-race-"));
  const dbPath = join(directory, "control.db");
  const store = new SqliteWorkItemStore(dbPath, {
    currentProviderBindingValidator: issued.runtime.currentProviderBindingValidator
  });
  store.registerActor({ id: "actor-canceller", actorType: "HUMAN", displayName: "canceller" });
  const workItem = store.create({
    title: "provider lifecycle race",
    requester: "user",
    requesterSubject: "actor-canceller",
    intent: "test",
    target: { cwd: "/repo", files: ["src/index.ts"] },
    requestedActions: [{ kind: "fs.read", description: "inspect", params: { paths: ["src/index.ts"], write: false } }],
    risk: "low"
  });
  const plan = store.createExecutionPlan({
    workItemId: workItem.id,
    definition: defaultExecutionPlanForWorkItem(workItem),
    createdByActorId: "actor-canceller"
  });
  const admission = store.admitExecutionPlan(
    {
      workItemId: workItem.id,
      planHash: plan.planHash,
      policyVersion: "acs.policy.v1",
      policyDecisionHash: hash("a"),
      requiresApproval: false,
      admittedByActorId: "policy-gate"
    },
    { via: "policy_gate" }
  );
  const attempt = store.createAttempt(
    { workItemId: workItem.id, planHash: plan.planHash, inputHash: hash("b") },
    { via: "domain_service" }
  );
  const lease = store.leaseAttempt(
    {
      attemptId: attempt.attemptId,
      workItemId: workItem.id,
      admissionId: admission.admissionId,
      workerId: "worker-1",
      leaseToken: "x".repeat(32),
      policyVersion: "acs.policy.v1",
      policyDecisionHash: hash("a"),
      ttlMs: 60_000
    },
    { via: "domain_service" }
  );
  store.recordWorkspaceAllocation(
    {
      allocationId: "workspace-provider-race",
      workItemId: workItem.id,
      attemptId: attempt.attemptId,
      leaseId: lease.leaseId,
      workerId: lease.workerId,
      fencingEpoch: lease.fencingEpoch,
      hostPath: `/isolated/${workItem.id}`,
      branch: "acs/provider-race",
      baseRef: "HEAD"
    },
    { via: "domain_service" }
  );
  const cancellation: AuthenticatedCodexSwarmCancellation = {
    requestId: "cancel-provider-race",
    workItemId: workItem.id,
    attemptId: attempt.attemptId,
    leaseId: lease.leaseId,
    fencingEpoch: lease.fencingEpoch,
    authenticatedPrincipalId: "actor-canceller",
    canonicalIntentHash: hash("c"),
    providerBinding: issued.binding
  };
  return { ...issued, cancellation, dbPath, directory, store };
}

function cancellationReceiptCount(dbPath: string): number {
  const db = new DatabaseSync(dbPath, { readOnly: true });
  try {
    const row = db.prepare("SELECT COUNT(*) AS count FROM codex_swarm_cancellation_receipts").get() as {
      count: number;
    };
    return row.count;
  } finally {
    db.close();
  }
}

describe("protected cancellation provider boundary", () => {
  it("keeps production disabled and rejects the test provider before readiness", async () => {
    const clock = new MutableClock("2026-09-16T08:00:00.000Z");
    const adapter = new SymbolicAdapter(clock);
    const capability = createProtectedCancellationProviderCapability(adapter);

    expect(productionCancellationProviderAdapterIds()).toEqual([]);
    await expect(bootstrapTrustedCancellationProvider(descriptor, capability, clock)).rejects.toMatchObject({
      code: "cancellation_provider_unavailable"
    });
  });

  it("makes capabilities and epochs non-serializable", async () => {
    const clock = new MutableClock("2026-09-16T08:00:00.000Z");
    const { capability, runtime } = await bootstrapSymbolic(clock);

    expect(() => JSON.stringify(capability)).toThrow(/process-local/u);
    expect(() => JSON.stringify(runtime.sessionEpoch)).toThrow(/process-local/u);
    expect(Object.keys(capability)).toEqual([]);
  });

  it("rejects descriptor drift from the exact 30s, 2s, and 5s constants", async () => {
    const clock = new MutableClock("2026-09-16T08:00:00.000Z");
    const capability = createProtectedCancellationProviderCapability(new SymbolicAdapter(clock));
    const drifted = { ...descriptor, contextTtlSeconds: 31 } as unknown as ProviderBootstrapDescriptorV1;

    await expect(bootstrapTrustedCancellationProviderInternal(drifted, capability, clock, true)).rejects.toMatchObject({
      code: "cancellation_provider_descriptor_invalid"
    });
  });

  it("fails closed when initial health is not ready", async () => {
    const clock = new MutableClock("2026-09-16T08:00:00.000Z");
    const adapter = new SymbolicAdapter(clock, { state: "degraded" });
    const capability = createProtectedCancellationProviderCapability(adapter);

    await expect(
      bootstrapTrustedCancellationProviderInternal(descriptor, capability, clock, true)
    ).rejects.toMatchObject({
      code: "cancellation_provider_not_ready"
    });
  });

  it("maps an expired provider assertion to the closed expired result", async () => {
    const clock = new MutableClock("2026-09-16T08:00:00.000Z");
    const { runtime } = await bootstrapSymbolic(clock, { credentialLifetimeMs: -2_001 });

    await expect(runtime.verify(verifyInput(clock))).resolves.toEqual({
      schemaVersion: "acs.provider-failure.v1",
      kind: "expired"
    });
  });

  it("re-reads lifecycle state after asynchronous verification", async () => {
    const clock = new MutableClock("2026-09-16T08:00:00.000Z");
    const gate = deferred();
    const { adapter, runtime } = await bootstrapSymbolic(clock, { verifyGate: gate.promise });

    const verification = runtime.verify(verifyInput(clock));
    await Promise.resolve();
    await adapter.session.beginRotation();
    gate.resolve();

    await expect(verification).resolves.toEqual({
      schemaVersion: "acs.provider-failure.v1",
      kind: "invalid"
    });
  });

  it("maps a verified principal to a sealed non-secret binding and synchronous validator", async () => {
    const clock = new MutableClock("2026-09-16T08:00:00.000Z");
    const { binding, runtime } = await issueBinding(clock);

    expect(binding).toEqual({
      contextHash: hash("d"),
      proofBindingHash: hash("b"),
      providerGeneration: 1,
      sessionEpochBindingHash: hash("e")
    });
    const validation = runtime.currentProviderBindingValidator.validateCurrent(binding, clock.now().toISOString());
    expect(validation).toEqual({
      kind: "current"
    });
    expect(validation).not.toBeInstanceOf(Promise);
  });

  it("enforces an exact 30-second context ceiling", async () => {
    const clock = new MutableClock("2026-09-16T08:00:00.000Z");
    const { runtime, principal } = await issueBinding(clock);

    expect(() =>
      runtime.sealCurrentBinding(principal, {
        contextHash: hash("f"),
        issuedAt: clock.now().toISOString(),
        expiresAt: new Date(clock.now().getTime() + 30_001).toISOString()
      })
    ).toThrow(CancellationProviderError);
  });

  it("accepts exactly two seconds of expiry skew and rejects any more", async () => {
    const clock = new MutableClock("2026-09-16T08:00:00.000Z");
    const { binding, runtime } = await issueBinding(clock);

    clock.advance(32_000);
    expect(runtime.currentProviderBindingValidator.validateCurrent(binding, clock.now().toISOString())).toEqual({
      kind: "current"
    });
    clock.advance(1);
    expect(runtime.currentProviderBindingValidator.validateCurrent(binding, clock.now().toISOString())).toEqual({
      kind: "proof_invalid"
    });
  });

  it("fails closed when wall time jumps forward without monotonic elapsed time", async () => {
    const clock = new MutableClock("2026-09-16T08:00:00.000Z");
    const { binding, runtime } = await issueBinding(clock);

    clock.jumpWall(2_001);

    expect(runtime.currentProviderBindingValidator.validateCurrent(binding, clock.now().toISOString())).toEqual({
      kind: "unavailable"
    });
  });

  it("fails closed when wall time rolls back without monotonic elapsed time", async () => {
    const clock = new MutableClock("2026-09-16T08:00:00.000Z");
    const { binding, runtime } = await issueBinding(clock);

    clock.jumpWall(-2_001);

    expect(runtime.currentProviderBindingValidator.validateCurrent(binding, clock.now().toISOString())).toEqual({
      kind: "unavailable"
    });
  });

  it("denies a cancellation without durable mutation while rotation is pending", async () => {
    const clock = new MutableClock(new Date().toISOString());
    const gate = deferred();
    const fixture = await cancellableFixture(clock, { lifecycleGate: gate.promise });
    try {
      const rotation = fixture.runtime.beginRotation();

      expect(fixture.store.cancelCodexSwarmAttempt(fixture.cancellation)).toEqual({
        kind: "denied",
        reason: "codex_swarm_cancel_provider_revoked"
      });
      expect(cancellationReceiptCount(fixture.dbPath)).toBe(0);
      expect(fixture.store.getAttempt(fixture.cancellation.attemptId)?.status).toBe("leased");

      gate.resolve();
      await rotation;
    } finally {
      gate.resolve();
      rmSync(fixture.directory, { force: true, recursive: true });
    }
  });

  it("denies a cancellation without durable mutation while revocation is pending", async () => {
    const clock = new MutableClock(new Date().toISOString());
    const gate = deferred();
    const fixture = await cancellableFixture(clock, { lifecycleGate: gate.promise });
    try {
      const revocation = fixture.runtime.revoke(1);

      expect(fixture.store.cancelCodexSwarmAttempt(fixture.cancellation)).toEqual({
        kind: "denied",
        reason: "codex_swarm_cancel_provider_revoked"
      });
      expect(cancellationReceiptCount(fixture.dbPath)).toBe(0);
      expect(fixture.store.getAttempt(fixture.cancellation.attemptId)?.status).toBe("leased");

      gate.resolve();
      await revocation;
    } finally {
      gate.resolve();
      rmSync(fixture.directory, { force: true, recursive: true });
    }
  });

  it("allows only validation of the prior generation during the exact rotation overlap", async () => {
    const clock = new MutableClock("2026-09-16T08:00:00.000Z");
    const { binding, runtime } = await issueBinding(clock);

    const rotation = await runtime.beginRotation();
    expect(rotation.overlapEndsAt).toBe("2026-09-16T08:00:30.000Z");
    expect(runtime.currentProviderBindingValidator.validateCurrent(binding, clock.now().toISOString())).toEqual({
      kind: "current"
    });
    clock.advance(30_001);
    expect(runtime.currentProviderBindingValidator.validateCurrent(binding, clock.now().toISOString())).toEqual({
      kind: "generation_invalid"
    });
  });

  it("ends rotation overlap by monotonic elapsed time even at the wall-time boundary", async () => {
    const clock = new MutableClock("2026-09-16T08:00:00.000Z");
    const { binding, runtime } = await issueBinding(clock);

    await runtime.beginRotation();
    clock.advance(30_000);
    clock.advanceMonotonic(1);

    expect(runtime.currentProviderBindingValidator.validateCurrent(binding, clock.now().toISOString())).toEqual({
      kind: "generation_invalid"
    });
  });

  it("makes revocation visible before revoke resolves", async () => {
    const clock = new MutableClock("2026-09-16T08:00:00.000Z");
    const { binding, runtime } = await issueBinding(clock);

    await runtime.revoke(1);
    expect(runtime.currentProviderBindingValidator.validateCurrent(binding, clock.now().toISOString())).toEqual({
      kind: "revoked"
    });
    await expect(runtime.verify(verifyInput(clock))).resolves.toEqual({
      schemaVersion: "acs.provider-failure.v1",
      kind: "unavailable"
    });
  });

  it("uses a fresh restart epoch and rejects an old uncommitted binding", async () => {
    const clock = new MutableClock("2026-09-16T08:00:00.000Z");
    const first = await issueBinding(clock);
    const second = await bootstrapSymbolic(clock, { sessionBindingHash: hash("f") });

    expect(second.runtime.sessionEpoch).not.toBe(first.runtime.sessionEpoch);
    expect(
      second.runtime.currentProviderBindingValidator.validateCurrent(first.binding, clock.now().toISOString())
    ).toEqual({
      kind: "session_stale"
    });
  });

  it("fails closed for forged, malformed, and unknown bindings", async () => {
    const clock = new MutableClock("2026-09-16T08:00:00.000Z");
    const { binding, runtime } = await issueBinding(clock);

    expect(
      runtime.currentProviderBindingValidator.validateCurrent(
        { ...binding, proofBindingHash: hash("a") },
        clock.now().toISOString()
      )
    ).toEqual({ kind: "proof_invalid" });
    expect(runtime.currentProviderBindingValidator.validateCurrent(binding, "not-a-time")).toEqual({
      kind: "unavailable"
    });
  });

  it("requires confirmed closure and zeroization and never becomes ready again", async () => {
    const clock = new MutableClock("2026-09-16T08:00:00.000Z");
    const { binding, runtime } = await issueBinding(clock);

    await expect(runtime.closeAndZeroize(5000)).resolves.toEqual({ closed: true, zeroizationConfirmed: true });
    expect(runtime.currentProviderBindingValidator.validateCurrent(binding, clock.now().toISOString())).toEqual({
      kind: "unavailable"
    });
    await expect(runtime.health()).resolves.toEqual({ schemaVersion: "acs.provider-health.v1", state: "closed" });
  });

  it("treats an unconfirmed zeroization result as terminal failure", async () => {
    const clock = new MutableClock("2026-09-16T08:00:00.000Z");
    const { runtime } = await bootstrapSymbolic(clock, { zeroizationConfirmed: false });

    await expect(runtime.closeAndZeroize(5000)).rejects.toMatchObject({
      code: "cancellation_provider_zeroization_failed"
    });
    await expect(runtime.health()).resolves.toEqual({ schemaVersion: "acs.provider-health.v1", state: "closed" });
  });
});
