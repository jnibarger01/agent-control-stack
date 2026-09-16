import {
  CODEX_SWARM_ENGINE_ID,
  evidenceMatchesEnvelope,
  swarmExecutionEvidenceSchema,
  type ExecutionEnvelope,
  type SwarmExecutionEvidence
} from "./codex-swarm-envelope.js";

/** Test-only coordinator boundary. It deliberately has no shell, filesystem, network, or MCP dependency. */
export const CODEX_SWARM_TEST_PROVIDER = "in_memory" as const;
const evidenceFreshnessMs = 30_000;
const forbiddenLifecycleKeys = new Set(["succeeded", "approved", "promoted", "granted", "authorized", "accepted"]);

export interface DispatchReservation {
  workItemId: string;
  attemptId: string;
  leaseId: string;
  fencingEpoch: number;
  envelopeHash: string;
  idempotencyKey: string;
}

export interface AttemptAuthority extends Pick<DispatchReservation, "workItemId" | "attemptId" | "leaseId" | "fencingEpoch"> {
  active: boolean;
  revoked: boolean;
  workspace: { allocationId: string; hostPath: string; expectedBaseSha: string };
  admittedPlanHash: string;
}

export interface CodexSwarmAuthorityPort {
  read(binding: Pick<DispatchReservation, "workItemId" | "attemptId" | "leaseId" | "fencingEpoch">): AttemptAuthority | undefined;
  cancel(binding: Pick<DispatchReservation, "workItemId" | "attemptId" | "leaseId" | "fencingEpoch">, requestId: string): void;
}

export interface DispatchReservationPort {
  /** Must execute atomically in durable ACS storage, never in the child process. */
  reserve(tuple: DispatchReservation): { kind: "reserved" } | { kind: "replay" } | { kind: "conflict" };
}

export interface CodexSwarmChildController {
  start(input: { envelope: ExecutionEnvelope }): Promise<void>;
  cancel(input: Pick<DispatchReservation, "attemptId" | "leaseId" | "fencingEpoch">): Promise<void>;
}

export interface CanonicalAuditPort {
  append(event: { name: "execution.codex_swarm.dispatched" | "execution.codex_swarm.cancelled" | "execution.codex_swarm.evidence_quarantined" | "execution.codex_swarm.evidence_verified"; workItemId: string; attemptId: string; reason?: string }): void;
}

export interface IndependentEvidenceVerifier {
  verify(input: { envelope: ExecutionEnvelope; evidence: SwarmExecutionEvidence }): Promise<{ ok: boolean; reason?: string }>;
}

export function assertCodexSwarmTestBackendEnabled(env: NodeJS.ProcessEnv = process.env): void {
  if (env.NODE_ENV === "production") throw new Error("codex_swarm backend is disabled in production");
  if (env.ACS_CODEX_SWARM_TEST_PROVIDER !== CODEX_SWARM_TEST_PROVIDER) {
    throw new Error("codex_swarm backend requires an injected in_memory test provider");
  }
}

export class CodexSwarmCoordinator {
  readonly id = CODEX_SWARM_ENGINE_ID;

  constructor(
    private readonly authority: CodexSwarmAuthorityPort,
    private readonly reservations: DispatchReservationPort,
    private readonly child: CodexSwarmChildController,
    private readonly audit: CanonicalAuditPort,
    private readonly verifier: IndependentEvidenceVerifier,
    private readonly now: () => Date = () => new Date()
  ) {}

  async dispatch(envelope: ExecutionEnvelope): Promise<{ kind: "started" | "replay" }> {
    const binding = bindingFromEnvelope(envelope);
    this.assertCurrent(envelope);
    const reservation = this.reservations.reserve({ ...binding, envelopeHash: envelope.envelopeHash, idempotencyKey: envelope.idempotencyKey });
    if (reservation.kind === "conflict") throw new Error("codex_swarm_dispatch_idempotency_conflict");
    if (reservation.kind === "replay") return { kind: "replay" };
    await this.child.start({ envelope });
    this.audit.append({ name: "execution.codex_swarm.dispatched", workItemId: envelope.acsWorkItemId, attemptId: envelope.acsAttemptId });
    return { kind: "started" };
  }

  async cancel(input: { workItemId: string; attemptId: string; leaseId: string; fencingEpoch: number; requestId: string; authenticated: boolean }): Promise<void> {
    if (!input.authenticated || !input.requestId) throw new Error("codex_swarm_cancel_unauthenticated");
    const authority = this.authority.read(input);
    if (!authority || !authority.active || authority.revoked) throw new Error("codex_swarm_cancel_stale_authority");
    this.authority.cancel(input, input.requestId);
    await this.child.cancel(input);
    this.audit.append({ name: "execution.codex_swarm.cancelled", workItemId: input.workItemId, attemptId: input.attemptId });
  }

  async ingestEvidence(value: unknown, envelope: ExecutionEnvelope): Promise<{ status: "verified" | "quarantined"; reason?: string }> {
    if (containsForbiddenLifecycleKey(value)) return this.quarantine(envelope, "evidence_forbidden_lifecycle_claim");
    const parsed = swarmExecutionEvidenceSchema.safeParse(value);
    if (!parsed.success) return this.quarantine(envelope, "evidence_schema_invalid");
    const echo = evidenceMatchesEnvelope(parsed.data, envelope);
    if (!echo.ok) return this.quarantine(envelope, echo.reason);
    try {
      this.assertCurrent(envelope);
    } catch {
      return this.quarantine(envelope, "evidence_stale_authority");
    }
    const now = this.now().getTime();
    const endedAt = Date.parse(parsed.data.endedAt);
    const startedAt = Date.parse(parsed.data.startedAt);
    if (!Number.isFinite(startedAt) || !Number.isFinite(endedAt) || endedAt < startedAt || now - endedAt > evidenceFreshnessMs) {
      return this.quarantine(envelope, "evidence_stale_or_chronology_invalid");
    }
    const result = await this.verifier.verify({ envelope, evidence: parsed.data });
    if (!result.ok) return this.quarantine(envelope, result.reason ?? "independent_verification_failed");
    this.audit.append({ name: "execution.codex_swarm.evidence_verified", workItemId: envelope.acsWorkItemId, attemptId: envelope.acsAttemptId });
    return { status: "verified" };
  }

  private assertCurrent(envelope: ExecutionEnvelope): void {
    const authority = this.authority.read(bindingFromEnvelope(envelope));
    if (!authority || !authority.active || authority.revoked) throw new Error("codex_swarm_authority_inactive");
    if (
      authority.workspace.allocationId !== envelope.workspace.allocationId ||
      authority.workspace.hostPath !== envelope.workspace.hostPath ||
      authority.workspace.expectedBaseSha !== envelope.workspace.expectedBaseSha ||
      authority.admittedPlanHash !== envelope.admittedPlanHash
    ) {
      throw new Error("codex_swarm_authority_binding_mismatch");
    }
  }

  private quarantine(envelope: ExecutionEnvelope, reason: string): { status: "quarantined"; reason: string } {
    this.audit.append({ name: "execution.codex_swarm.evidence_quarantined", workItemId: envelope.acsWorkItemId, attemptId: envelope.acsAttemptId, reason });
    return { status: "quarantined", reason };
  }
}

function bindingFromEnvelope(envelope: ExecutionEnvelope): Pick<DispatchReservation, "workItemId" | "attemptId" | "leaseId" | "fencingEpoch"> {
  return { workItemId: envelope.acsWorkItemId, attemptId: envelope.acsAttemptId, leaseId: envelope.leaseId, fencingEpoch: envelope.fencingEpoch };
}

function containsForbiddenLifecycleKey(value: unknown, seen = new Set<unknown>()): boolean {
  if (value === null || typeof value !== "object") return false;
  if (seen.has(value)) return true;
  seen.add(value);
  if (Array.isArray(value)) return value.some((entry) => containsForbiddenLifecycleKey(entry, seen));
  for (const [key, nested] of Object.entries(value)) {
    if (forbiddenLifecycleKeys.has(key)) return true;
    if (containsForbiddenLifecycleKey(nested, seen)) return true;
  }
  return false;
}
